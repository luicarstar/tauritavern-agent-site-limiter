/**
 * dsh-llm-rate-limiter — Host (server-side) entry point.
 *
 * Intercepts the `llm/stream` waterfall and enforces per-model rate limits.
 *
 * Configuration is the profile ENTRY's own `config` (this module's exported
 * {@link Config} schema), read through the volatile references Cordis builds
 * for it. `dsh-settings` projects the volatile fields of every active entry
 * into a form the browser can edit, so the plugin ships no settings service
 * of its own. (DSH 0.1.5 had a `ctx.settings.register()` namespace API; 0.1.7
 * removed it, and its browser half dropped `settingsScope` for `configForms`.
 * The migration record lives in CHANGELOG.md under `[0.3.0]`.)
 *
 * The `llm/stream` waterfall signature is:
 *   (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
 *
 * where `options` always has `.provider` (string) and `.model` (string).
 *
 * @module dsh-llm-rate-limiter
 */

import { TokenBucketStrategy } from "./strategies/token-bucket.js";
import { SlidingWindowStrategy } from "./strategies/sliding-window.js";
import { Config } from "./types/config.js";
import { CHANNEL, createChannelRoute, createStatusChannel } from "./status-rpc.js";

const name = "llm-rate-limiter";
/**
 * Settings namespace / profile entry id.
 *
 * `dsh-settings` keys every form by `entry.options.id` (`lib/index.js:432`),
 * which is the `id` this plugin's `cordis.patch.yml` row declares. Renaming
 * that row id therefore renames this namespace too — keep the two in step.
 */
const SETTINGS_NS = "llm-rate-limiter";

/** Maximum retained events in the status ring (bounded memory). */
const EVENT_RING_LIMIT = 64;
/** Events carried by one snapshot (the panel shows these). */
const SNAPSHOT_EVENT_COUNT = 8;

/* ── Helpers ─────────────────────────────────────────────────────────── */

/** Built-in defaults, used when a reference yields nothing (or no config at all). */
const FALLBACK = {
  enabled: true,
  strategy: "token-bucket",
  defaults: { maxConcurrent: 5, maxRpm: 60, burstSize: 10, refillRate: 1 },
  models: {},
  onThrottled: "queue",
  maxQueueWaitMs: 60_000,
};

/**
 * Read one volatile reference from the parsed Config.
 *
 * The loader mutates volatile references IN PLACE when only raw config values
 * changed (`cordis-plugin-loader/lib/index.js:393` `_commitVolatile()`), so
 * the reference object stays valid for the plugin's whole lifetime and its
 * `get()` always yields the current value. Call this at each use rather than
 * caching the unwrapped value.
 *
 * @param ref - a `.volatile()` field of the parsed Config, or undefined when
 *   the entry was mounted with no config at all.
 * @param fallback - value used when the reference is absent.
 * @returns the current plain value.
 */
function read(ref, fallback) {
  if (ref === undefined || ref === null) return fallback;
  if (typeof ref.get === "function") {
    const value = ref.get();
    return value === undefined || value === null ? fallback : value;
  }
  return ref;
}

/**
 * Merge defaults + per-model overrides into a flat config object that both
 * strategy constructors understand.
 *
 * @param cfg - plain config object (`{ enabled, strategy, defaults, models, ... }`).
 * @param key - `"provider/model"` of the call being limited.
 */
function resolveModelConfig(cfg, key) {
  const o = cfg.models?.[key] ?? {};
  const d = cfg.defaults ?? {};
  const maxRpm = o.maxRpm ?? d.maxRpm ?? 60;
  // When a model overrides maxRpm but not refillRate, derive refillRate from
  // the model's maxRpm — this is the most common case ("set maxRpm=3").
  // When model doesn't override maxRpm, use the defaults' refillRate as-is.
  const refillRate = o.refillRate ?? (o.maxRpm != null ? o.maxRpm / 60 : d.refillRate ?? (maxRpm / 60));
  return {
    maxConcurrent: o.maxConcurrent ?? d.maxConcurrent ?? 5,
    maxRpm,
    burstSize:     o.burstSize     ?? d.burstSize     ?? 10,
    refillRate,
    windowMs:      d.windowMs      ?? 60_000,
  };
}

/**
 * Ensure a rate-limiting strategy instance exists (or is updated) for `key`.
 */
function ensureLimiter(limiters, key, cfg) {
  const merged = resolveModelConfig(cfg, key);
  const existing = limiters.get(key);
  if (existing) {
    existing.update(merged);
    return existing;
  }
  const strategy = cfg.strategy === "sliding-window"
    ? new SlidingWindowStrategy(merged)
    : new TokenBucketStrategy(merged);
  limiters.set(key, strategy);
  return strategy;
}

/**
 * Build a terminal StreamChunk for rate-limiting failures.
 * Uses `kind: "aborted"` when the caller's AbortSignal fired, so the agent
 * loop treats it as a cancellation rather than a retryable error.
 * Otherwise uses `kind: "error"` with `RATE_LIMIT` code, which the
 * `dsh-llm-retry` plugin can catch and back off.
 */
function terminalChunk(modelKey, signal) {
  const aborted = signal?.aborted === true;
  return {
    type: "finish",
    reason: aborted
      ? { kind: "aborted", failure: { code: "RATE_LIMIT", message: `Rate limit: ${modelKey} (aborted)` } }
      : { kind: "error", failure: { code: "RATE_LIMIT", message: `Rate limit exceeded for ${modelKey}` } },
  };
}

/* ── Plugin entry ────────────────────────────────────────────────────── */

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {object} [config] - parsed Config; volatile fields are live references.
 */
function apply(ctx, config) {
  const logger = ctx.logger?.("rate-limiter");

  /**
   * Snapshot the whole config as one plain object, reading each reference at
   * call time. Derived settings are not cached: a volatile-only change updates
   * the references in place without re-running `apply`.
   */
  function readConfig() {
    return {
      enabled: read(config?.enabled, FALLBACK.enabled),
      strategy: read(config?.strategy, FALLBACK.strategy),
      defaults: read(config?.defaults, FALLBACK.defaults),
      models: read(config?.models, FALLBACK.models),
      onThrottled: read(config?.onThrottled, FALLBACK.onThrottled),
      maxQueueWaitMs: read(config?.maxQueueWaitMs, FALLBACK.maxQueueWaitMs),
    };
  }

  /** @type {Map<string, TokenBucketStrategy | SlidingWindowStrategy>} */
  const limiters = new Map();

  // ── Live statistics (read by the status RPC channel) ───────
  // Counters are plain numbers so a snapshot is always JSON-safe.
  const totals = {
    requests: 0,
    granted: 0,
    rejected: 0,
    timeouts: 0,
    aborted: 0,
    totalWaitMs: 0,
  };
  /** Bumped on every recorded event and on reset — the panel's change cursor. */
  let rev = 0;
  /** Bounded ring of recent events (newest last). */
  const eventRing = [];

  function recordEvent(event) {
    eventRing.push({ ...event, ts: Date.now() });
    if (eventRing.length > EVENT_RING_LIMIT) eventRing.shift();
    rev += 1;
  }

  /** Build the JSON-safe snapshot served on the "snapshot" endpoint. */
  function buildSnapshot() {
    const cfg = readConfig();
    const models = {};
    for (const [key, limiter] of limiters) {
      try {
        models[key] = limiter.getStatus();
      } catch {
        // A strategy that cannot report status must not break the whole panel.
      }
    }
    return {
      rev,
      ts: Date.now(),
      enabled: cfg.enabled !== false,
      strategy: cfg.strategy,
      onThrottled: cfg.onThrottled,
      totals: { ...totals },
      models,
      events: eventRing.slice(-SNAPSHOT_EVENT_COUNT),
    };
  }

  /** Zero every counter and drop retained events (the panel's clear button). */
  function resetTotals() {
    for (const key of Object.keys(totals)) totals[key] = 0;
    eventRing.length = 0;
    rev += 1;
  }

  // ── Settings presentation (dynamic inject) ─────────────────
  // This plugin ships its own browser page, so it opts out of any
  // schema-generated page. Wrapped in ctx.inject so a host WITHOUT a settings
  // service still runs the limiter — the callback simply never runs. The
  // optional child ctx names the plugin fiber the policy belongs to, which is
  // why `ctx.fiber` is passed explicitly (`dsh-settings/lib/index.js:370`).
  ctx.inject(["settings"], (scopedCtx) => {
    if (typeof scopedCtx.settings?.configure !== "function") return; // older/foreign settings seam: keep running
    scopedCtx.effect(
      () => scopedCtx.settings.configure({ auto: false }, ctx.fiber),
      "rate-limiter: settings presentation",
    );
  });

  // ── Status channel (dynamic inject) ────────────────────────
  // Same defensive shape as the settings wiring: on a host without a
  // connection service the callback never runs and the plugin stays silent.
  // Either path below registers inside an effect owned by this fiber, so
  // unloading the plugin withdraws the channel automatically.
  //
  // Two mounting paths exist, and both speak the same wire protocol, so the
  // browser half never needs to know which one is live:
  //
  //   1. connection.rpc.handle(channel, handler) — the framework's generic
  //      channel registry (preferred: the framework owns the route, the
  //      request validation, and the withdrawal).
  //
  //   2. a self-registered prefix route reusing connection.requestRejection()
  //      — the fallback for hosts where path 1 is broken. DSH 0.1.5-rc.3
  //      changed dsh-client-connection's own `inject` from
  //      ["webServer", "credentials"] to ["credentials"] while its
  //      HostConnectionService.register() still dereferences
  //      `owner.webServer`, and Cordis rebinds a cross-fiber service's `ctx`
  //      to the *reader's* fiber — so rpc.handle() throws
  //      'cannot get property "webServer" without inject'. Registering the
  //      route on our own fiber (which injects webServer below) avoids that
  //      while still using the framework's own 403/401 fence.
  //      Still unfixed in 0.1.7-rc.1 (dsh-client-connection/lib/index.js:798
  //      keeps `inject = ["credentials"]`), so the fallback still fires.
  ctx.inject(["connection"], (scopedCtx) => {
    const connection = scopedCtx.get("connection");
    // [dsh-fix 2026-10-25] "config"/"mutate" endpoints: host-side settings
    // mutation, bypassing the browser describe mirror entirely.
    async function mutateConfig(ops) {
      const settings = ctx.get("settings");
      if (!settings || typeof settings.mutate !== "function") {
        throw new Error("settings service unavailable on this host");
      }
      await settings.mutate(SETTINGS_NS, ops);
    }
    const channel = createStatusChannel({ buildSnapshot, resetTotals, readConfig, mutateConfig });

    // ── Path 1: the framework's generic channel registry ──
    const handle = typeof connection?.rpc?.handle === "function"
      ? connection.rpc.handle.bind(connection.rpc)
      : undefined;

    if (handle !== undefined) {
      try {
        scopedCtx.effect(() => {
          const unregister = handle(CHANNEL, channel);
          return () => { unregister(); };
        }, "rate-limiter: status rpc channel");
        logger?.info("rate limiter status channel mounted via connection.rpc (%s)", CHANNEL);
        return;
      } catch (err) {
        logger?.warn(
          "connection.rpc channel registration failed (%s); falling back to a self-registered route",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // ── Path 2: self-registered route (needs webServer on THIS fiber) ──
    // The fence is mandatory: without connection.requestRejection() we would
    // be publishing an unauthenticated route, so we refuse to mount at all.
    // Probing once here turns a broken fence into a mount-time refusal instead
    // of a per-request surprise.
    try {
      if (typeof connection?.requestRejection !== "function") {
        logger?.warn("connection.requestRejection unavailable; status channel not mounted");
        return;
      }
      connection.requestRejection({ headers: {} });
    } catch (err) {
      logger?.warn(
        "connection.requestRejection unusable (%s); refusing to mount an unfenced status route",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    scopedCtx.inject(["webServer"], (webCtx) => {
      const webServer = webCtx.get("webServer");
      if (typeof webServer?.register !== "function") return; // no web carrier: degrade silently

      try {
        webCtx.effect(() => webServer.register(createChannelRoute({
          channel: CHANNEL,
          handler: channel,
          reject: (req) => connection.requestRejection(req),
        })), "rate-limiter: status route (self-registered)");
      } catch (err) {
        logger?.warn("status channel registration failed: %s", err instanceof Error ? err.message : String(err));
        return;
      }

      logger?.info("rate limiter status channel mounted via self-registered route (%s)", CHANNEL);
    });
  });

  // ── LLM stream interceptor ─────────────────────────────────
  // Reads the live Config on every call, so a settings edit that reaches the
  // loader takes effect on the next request without a restart.
  const disposeLlmListener = ctx.on("llm/stream", async function* rateLimitInterceptor(options, next) {
    const cfg = readConfig();

    if (!cfg.enabled) {
      yield* next();
      return;
    }

    const modelKey = `${options.provider}/${options.model}`;

    // Per-model opt-out: `enabled: false` skips this model entirely.
    if (cfg.models?.[modelKey]?.enabled === false) {
      yield* next();
      return;
    }

    const limiter = ensureLimiter(limiters, modelKey, cfg);
    totals.requests += 1;

    // ── Phase 1: acquire ────────────────────────────────────────
    let slotTaken = false;
    if (cfg.onThrottled === "reject") {
      // Non-blocking check — if at capacity, yield a terminal chunk immediately.
      // acquireNonBlocking deducts a token AND takes a concurrent slot, so
      // reject mode still enforces the frequency limit, not just concurrency.
      const permit = limiter.acquireNonBlocking();
      if (!permit.granted) {
        totals.rejected += 1;
        recordEvent({ event: "rejected", model: modelKey });
        logger?.warn("model %C rejected — rate limit reached", modelKey);
        yield terminalChunk(modelKey, options.signal);
        return;
      }
      // permit granted → slot already taken by acquireNonBlocking; skip acquireSlot.
      slotTaken = true;
      totals.granted += 1;
      recordEvent({ event: "granted", model: modelKey, waitMs: 0 });
    } else {
      // Queue mode — park until a slot opens.
      const permit = await limiter.acquire({
        signal: options.signal,
        timeoutMs: cfg.maxQueueWaitMs ?? 60_000,
      });
      if (!permit.granted) {
        const aborted = options.signal?.aborted === true;
        if (aborted) {
          totals.aborted += 1;
          recordEvent({ event: "aborted", model: modelKey, waitMs: permit.waitMs ?? 0 });
        } else {
          totals.timeouts += 1;
          recordEvent({ event: "timeout", model: modelKey, waitMs: permit.waitMs ?? 0 });
        }
        logger?.warn(
          "model %C %s after %d ms",
          modelKey, aborted ? "aborted" : "queue timeout", permit.waitMs,
        );
        yield terminalChunk(modelKey, options.signal);
        return;
      }
      // Queue mode: acquire() does NOT take a concurrent slot.
      // We must call acquireSlot() before the actual call.
      slotTaken = false;
      totals.granted += 1;
      totals.totalWaitMs += permit.waitMs ?? 0;
      recordEvent({ event: "granted", model: modelKey, waitMs: permit.waitMs ?? 0 });
    }

    // ── Phase 2: run the real LLM call ─────────────────────────
    if (!slotTaken) limiter.acquireSlot();
    try {
      yield* next();
    } finally {
      limiter.releaseSlot();
      recordEvent({ event: "completed", model: modelKey });
    }
  });

  // ── Teardown ──
  ctx.effect(() => () => {
    disposeLlmListener();
    for (const limiter of limiters.values()) limiter.dispose();
    limiters.clear();
  }, "rate-limiter: dispose llm/stream listener");

  logger?.info("rate limiter active — llm/stream interceptor registered");
}

export { apply, name, SETTINGS_NS, Config };
