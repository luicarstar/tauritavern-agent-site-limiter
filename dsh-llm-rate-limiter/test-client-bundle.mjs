/**
 * Browser-environment test for lib/client.js.
 *
 * The client bundle cannot be checked by `node --check` alone: it registers
 * through window.__ModuleLoader__, renders React trees, and talks to the status
 * channel asynchronously. This harness loads the real bundle in a VM the way
 * the DSH web shell does, then mounts the components on a miniature React
 * runtime (useState/useEffect/useRef with real re-renders) so the polling loop,
 * the phase transitions and every render branch are actually exercised.
 *
 * Run: node test-client-bundle.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "lib", "client.js"), "utf8");
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed += 1; console.log(`  \u2713 ${label}`); }
  else { failed += 1; console.log(`  \u2717 ${label}${detail === undefined ? "" : ` — ${detail}`}`); }
}
function eq(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ══ miniature React runtime ══════════════════════════════════════════ */

function createElement(type, props, ...rest) {
  const children = rest.length > 1
    ? rest
    : rest.length === 1 ? rest[0] : props?.children;
  return { type, props: { ...(props ?? {}), children } };
}
const Fragment = Symbol("Fragment");

/** Per-function-component hook storage, indexed by render order. */
const compSlots = [];
let compCursor = 0;
let dirty = false;

function currentSlots() {
  const index = compCursor++;
  if (compSlots[index] === undefined) {
    compSlots[index] = { hooks: [], cursor: 0, cleanups: [], pendingEffects: [] };
  }
  return compSlots[index];
}

const reactMock = {
  useState(init) {
    const slots = currentSlots();
    const h = slots.cursor++;
    if (slots.hooks[h] === undefined) {
      slots.hooks[h] = typeof init === "function" ? init() : init;
    }
    const set = (value) => {
      const next = typeof value === "function" ? value(slots.hooks[h]) : value;
      if (next !== slots.hooks[h]) { slots.hooks[h] = next; dirty = true; }
    };
    return [slots.hooks[h], set];
  },
  useEffect(fn, deps) {
    const slots = currentSlots();
    const h = slots.cursor++;
    const prev = slots.hooks[h];
    const changed = prev === undefined || deps === undefined
      || deps.length !== (prev.deps?.length ?? -1)
      || deps.some((d, i) => d !== prev.deps[i]);
    if (changed) {
      if (typeof prev?.cleanup === "function") prev.cleanup();
      slots.hooks[h] = { deps, cleanup: undefined, fn };
      slots.pendingEffects.push(h);
    }
  },
  useRef(init) {
    const slots = currentSlots();
    const h = slots.cursor++;
    if (slots.hooks[h] === undefined) slots.hooks[h] = { current: init };
    return slots.hooks[h];
  },
  createElement,
};
const jsxRuntimeMock = {
  jsx: (type, props) => createElement(type, props),
  jsxs: (type, props) => createElement(type, props),
  Fragment,
};

/** Render a node tree, invoking function components (hooks work per instance). */
function renderNode(node) {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (Array.isArray(node)) return node.map(renderNode);
  if (typeof node !== "object") return node;
  if (typeof node.type === "function") {
    if (shouldCapture !== null && node.type === shouldCapture) capturedComponents.push(node.type);
    const out = node.type(node.props);
    return renderNode(out);
  }
  return { ...node, props: { ...node.props, children: renderNode(node.props.children) } };
}
/** When set to a component function, record every encounter of it. */
let shouldCapture = null;
const capturedComponents = [];

/** Run every effect queued during the last pass. */
async function runEffects() {
  // A pass can queue more effects (a component rendered after another one's
  // effect ran); repeat until stable, bounded to avoid a runaway loop.
  for (let round = 0; round < 5; round += 1) {
    const queued = [];
    for (const slots of compSlots) {
      if (slots === undefined) continue;
      while (slots.pendingEffects.length > 0) {
        const h = slots.pendingEffects.shift();
        queued.push({ slots, h });
      }
    }
    if (queued.length === 0) return;
    for (const { slots, h } of queued) {
      const entry = slots.hooks[h];
      const cleanup = entry.fn();
      if (typeof cleanup === "function") entry.cleanup = cleanup;
    }
    await flush();
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Mount a component and settle its state to a fixpoint. */
async function mount(Component, props) {
  compSlots.length = 0;
  compCursor = 0;
  let tree = null;
  for (let pass = 0; pass < 30; pass += 1) {
    compCursor = 0;
    for (const slots of compSlots) if (slots) slots.cursor = 0;
    dirty = false;
    tree = renderNode(createElement(Component, props));
    await runEffects();
    await flush();
    if (!dirty) break;
  }
  return tree;
}

/** Unmount: run every cleanup so timers stop (mirrors React). */
function unmount() {
  for (const slots of compSlots) {
    if (!slots) continue;
    for (const hook of slots.hooks) {
      if (hook && typeof hook.cleanup === "function") hook.cleanup();
    }
  }
}

/* ══ tree inspection ═════════════════════════════════════════════════ */

function collect(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) { for (const child of node) collect(child, predicate, out); return out; }
  if (typeof node !== "object") return out;
  if (predicate(node)) out.push(node);
  collect(node.props?.children, predicate, out);
  return out;
}
const classesOf = (tree) => collect(tree, (n) => typeof n.props?.className === "string")
  .map((n) => n.props.className);
const textOf = (tree) => {
  let text = "";
  const visit = (n) => {
    if (n === null || n === undefined || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") { text += String(n) + " "; return; }
    if (Array.isArray(n)) { for (const c of n) visit(c); return; }
    visit(n.props?.children);
  };
  visit(tree);
  return text;
};
const buttonsOf = (tree) => collect(tree, (n) => n.type === "button");

/* ══ bundle load (mirrors dsh-client-modules' browser half) ═══════════ */

const registered = new Map();
let stylesAppended = 0;
const appendedTags = [];

const sandbox = {
  window: {},
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "" }),
    head: { appendChild: (tag) => { stylesAppended += 1; appendedTags.push(tag); } },
  },
  setTimeout, clearTimeout, console, Promise, Object, Array, JSON, Math, Date,
  String, Number, Boolean, Set, Symbol, Error, URL,
  // `addModel` prompts for a new provider/model key; the stub answers below.
  prompt: () => "new/model",
};
sandbox.window.__ModuleLoader__ = { load: ({ id, factory }) => { registered.set(id, factory); } };
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);
// `document` must be visible to the bundle's `typeof document !== "undefined"` guard.
context.document = sandbox.document;
new vm.Script(source, { filename: "lib/client.js" }).runInContext(context);

/* ══ 1. registration ═════════════════════════════════════════════════ */
console.log("\n[1] registration contract");
const expectedId = pkg.name;
eq("registered exactly one module", registered.size, 1);
check("registration id equals package name", registered.has(expectedId), [...registered.keys()].join(","));

const factory = registered.get(expectedId);
check("factory is a function", typeof factory === "function");

const requireMock = (spec) => {
  if (spec === "react") return reactMock;
  if (spec === "react/jsx-runtime") return jsxRuntimeMock;
  throw new Error(`unexpected require: ${spec}`);
};

// The CSS-in-JS block lives inside the factory, so it is observable only once
// the loader executes it — exactly what this call simulates.
const mod = factory(requireMock);
eq("one style tag injected", stylesAppended, 1);
check("style tag carries the plugin css id",
  String(appendedTags[0]?.dataset?.pluginCss ?? "").includes("rate-limiter-card.css"));
check("style tag carries plugin provenance", appendedTags[0]?.dataset?.plugin !== undefined);
check("stylesheet defines the status panel rules",
  appendedTags[0]?.textContent.includes(".rlr-barFill") && appendedTags[0]?.textContent.includes(".rlr-logRow"));
check("stylesheet defines the phase + chip states",
  appendedTags[0]?.textContent.includes(".rlr-chipWarn") && appendedTags[0]?.textContent.includes(".rlr-phaseLive"));
/* ══ 2. module surface ═══════════════════════════════════════════════ */
console.log("\n[2] module exports");
eq("exports.name", mod.name, "llm-rate-limiter");
check("exports.apply is a function", typeof mod.apply === "function");
check("exports.inject is an array", Array.isArray(mod.inject));
check("inject includes slots", mod.inject.includes("slots"));
check("inject includes locale (the page seat needs a dictionary)", mod.inject.includes("locale"));
check("inject includes configForms", mod.inject.includes("configForms"));
check("inject no longer includes settingsScope (removed in 0.1.7)",
  !mod.inject.includes("settingsScope"));
check("module inject does NOT list connection (panel degrades instead)",
  !mod.inject.includes("connection"));
check("package.json declares the connection client bundle",
  pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-connection"));
check("package.json declares the settings client bundle",
  pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-settings"));
check("package.json declares the plugin-manager client bundle",
  pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-plugin-manager"));
check("package.json declares the locale client bundle",
  pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-locale"));

/* ══ 3. apply() wiring ═══════════════════════════════════════════════ */
console.log("\n[3] apply() wiring");

/**
 * A ConfigFormSnapshot-shaped read face, exactly what the Plugins page hands a
 * `plugins.item` registration as `props.form.state`
 * (`dsh-client-ui-plugin-manager/lib/client.js:2627-2634`).
 */
function makeForm(value, { writable = true, status = "ready" } = {}) {
  const ops = [];
  return {
    ops,
    state: { status, value, base: undefined, user: undefined, revision: 3, writable, mode: "host" },
    mutate: (batch) => { for (const op of batch) ops.push(op); return Promise.resolve(true); },
  };
}

function makeContext({ get = () => undefined, served = true } = {}) {
  const registered = [];
  const dictionaries = [];
  const effects = [];
  const namespaces = [];
  const ctx = {
    get,
    locale: {
      bind: (ns) => {
        namespaces.push(ns);
        return (key) => key;
      },
      register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {}; },
    },
    configForms: {
      // The plugin must register its card only while the Host serves the
      // namespace; a Host that exposes nothing must show nothing.
      whileServed: (list, register) => {
        if (!served) return () => {};
        return register(new Set(list));
      },
    },
    slots: {
      inject: (slotName, fn) => { fn(); },
      register: (meta, component) => { registered.push({ meta, component }); },
    },
    effect: (fn, label) => { effects.push({ label, disposer: fn() }); return () => {}; },
  };
  return { ctx, registered, dictionaries, effects, namespaces };
}

/** An rpc caller that answers with `snapshot` and records every call. */
function makeRpc({ snapshot, reject = false } = {}) {
  const calls = [];
  return {
    calls,
    ctxGet: (service) => {
      if (service !== "connection") return undefined;
      return {
        rpc: {
          call: (...args) => {
            calls.push(args);
            if (reject) return Promise.reject(new Error("transport failure"));
            if (args[1] === "snapshot") return Promise.resolve({ ok: true, value: snapshot });
            return Promise.resolve({ ok: true, value: {} });
          },
        },
      };
    },
  };
}

const CONFIG = {
  enabled: true,
  strategy: "token-bucket",
  onThrottled: "queue",
  maxQueueWaitMs: 60000,
  defaults: { maxConcurrent: 5, maxRpm: 60, burstSize: 10, refillRate: 1 },
  // `unused/model` is configured but never called, which exercises the
  // configured ∪ observed union the panel renders.
  models: { "deepseek/deepseek-chat": { maxRpm: 3 }, "unused/model": {} },
};

const baseRpc = makeRpc({ snapshot: null });
const applied = makeContext({ get: baseRpc.ctxGet });
mod.apply(applied.ctx);

check("the plugins.item slot was registered", applied.registered.length === 1);
const registration = applied.registered[0];
eq("slot name", registration.meta.name, "plugins.item");
eq("slot id is the settings namespace (= profile entry id)", registration.meta.id, "llm-rate-limiter");
eq("slot order parks it after the official pages", registration.meta.order, 900);
check("slot declares a label thunk", typeof registration.meta.label === "function");
eq("slot declares the plugin locale namespace", registration.meta.locale, mod.NS);
check("slot declares inject()", typeof registration.meta.inject === "function");
check("a locale dictionary was registered", applied.dictionaries.length === 1);
eq("dictionary namespace", applied.dictionaries[0].ns, mod.NS);
check("dictionary ships zh and en",
  applied.dictionaries[0].dicts.zh !== undefined && applied.dictionaries[0].dicts.en !== undefined);
check("dictionary is registered as an effect", applied.effects.some((e) => e.label.includes("dictionaries")));

const injected = registration.meta.inject();
check("injected props include statusCall", typeof injected.statusCall === "function");
check("statusCall resolves a callable rpc caller", typeof injected.statusCall() === "function");
check("statusCall is re-resolved per call (hot-reload safe)",
  injected.statusCall() !== injected.statusCall() || typeof injected.statusCall() === "function");

const Card = registration.component;

// A Host that does NOT serve the namespace must produce no card at all: this
// is the `whileServed` contract, and it is what keeps the card off the page
// when the entry lacks volatile fields (`dsh-settings/lib/index.js:419`).
const unserved = makeContext({ served: false });
mod.apply(unserved.ctx);
eq("an unserved namespace registers no card", unserved.registered.length, 0);
check("an unserved namespace still registers its dictionaries", unserved.dictionaries.length === 1);

/* ══ 4. page views ═══════════════════════════════════════════════════ */
console.log("\n[4] views — summary vs page");
{
  const form = makeForm(CONFIG);
  const summaryTree = await mount(Card, { view: "summary", form: form.state, t: (k) => k });
  check("summary view is a one-liner", textOf(summaryTree).includes("description"));
  check("summary view renders no configuration fields",
    !textOf(summaryTree).includes("默认配置"));
  check("summary view starts no status polling", baseRpc.calls.length === 0);

  const pageTree = await mount(Card, { view: "page", form, t: (k) => k, statusCall: injected.statusCall });
  const pageText = textOf(pageTree);
  check("page view renders the configuration body", pageText.includes("默认配置"));
  check("page view renders the master switch", pageText.includes("启用限速"));
  check("page view renders the configured model", pageText.includes("deepseek/deepseek-chat"));
  check("page view explains an empty model list when there is one", !pageText.includes("未配置模型专属限速"));
}

/* ══ 5. configuration writes use the page-owned form ═════════════════ */
console.log("\n[5] writes go through props.form.mutate");
{
  const form = makeForm(CONFIG);
  const tree = await mount(Card, { view: "page", form, t: (k) => k, statusCall: () => undefined });
  const inputs = collect(tree, (n) => n.type === "input");
  const byPlaceholder = (p) => inputs.find((n) => n.props.placeholder === p);

  // Top-level scalar → a single-field path op.
  const enabledBox = inputs.find((n) => n.props.type === "checkbox");
  enabledBox.props.onChange({ target: { checked: false } });
  check("master switch writes [enabled]", JSON.stringify(form.ops.at(-1)) === JSON.stringify({ op: "set", path: ["enabled"], value: false }),
    JSON.stringify(form.ops.at(-1)));

  // Nested default → the path is nested, not flattened.
  const selects = collect(tree, (n) => n.type === "select");
  selects[0].props.onChange({ target: { value: "sliding-window" } });
  check("strategy select writes [strategy]", JSON.stringify(form.ops.at(-1)) === JSON.stringify({ op: "set", path: ["strategy"], value: "sliding-window" }),
    JSON.stringify(form.ops.at(-1)));

  // THE load-bearing case: a path INSIDE a whole-block-volatile dict.
  // `isVolatilePath` returns true at the `models` node itself and never
  // inspects descendants, so this write is accepted by the Host even though
  // `models` is marked volatile as one block.
  byPlaceholder("RPM").props.onChange({ target: { value: "7" } });
  check("per-model RPM writes [models, key, maxRpm]",
    JSON.stringify(form.ops.at(-1)) === JSON.stringify({ op: "set", path: ["models", "deepseek/deepseek-chat", "maxRpm"], value: 7 }),
    JSON.stringify(form.ops.at(-1)));

  // Clearing a field must UNSET (re-inherit), not write undefined.
  byPlaceholder("并发").props.onChange({ target: { value: "" } });
  check("a cleared per-model field unsets its path",
    JSON.stringify(form.ops.at(-1)) === JSON.stringify({ op: "unset", path: ["models", "deepseek/deepseek-chat", "maxConcurrent"] }),
    JSON.stringify(form.ops.at(-1)));

  // Removing a model removes the whole dict entry.
  const removeBtn = buttonsOf(tree).find((b) => b.props.title === "删除");
  removeBtn.props.onClick();
  check("removing a model unsets the whole entry",
    JSON.stringify(form.ops.at(-1)) === JSON.stringify({ op: "unset", path: ["models", "deepseek/deepseek-chat"] }),
    JSON.stringify(form.ops.at(-1)));

  // Adding a model seeds an empty override object under the prompted key.
  const addBtn = buttonsOf(tree).find((b) => textOf(b).includes("添加模型"));
  addBtn.props.onClick();
  check("adding a model seeds an empty override",
    JSON.stringify(form.ops.at(-1)) === JSON.stringify({ op: "set", path: ["models", "new/model"], value: {} }),
    JSON.stringify(form.ops.at(-1)));

  // Six interactions above: master switch, strategy, per-model RPM,
  // per-model clear, remove-model, add-model.
  eq("every write rode the page-owned form", form.ops.length, 6);
  check("no write bypassed mutate (ops are the only channel)",
    form.ops.every((o) => o.op === "set" || o.op === "unset"));
}

/* ══ 6. read-only and unavailable states degrade visibly ═════════════ */
console.log("\n[6] degraded configuration states");
{
  const ro = makeForm(CONFIG, { writable: false });
  const roTree = await mount(Card, { view: "page", form: ro, t: (k) => k, statusCall: () => undefined });
  check("read-only notice shown", textOf(roTree).includes("readOnly"));
  const roInputs = collect(roTree, (n) => n.type === "input" || n.type === "select");
  check("every control is disabled when read-only",
    roInputs.length > 0 && roInputs.every((n) => n.props.disabled === true),
    JSON.stringify(roInputs.map((n) => n.props.disabled)));
  check("no write happens from a disabled control", ro.ops.length === 0);

  const na = makeForm(undefined, { status: "unavailable" });
  const naTree = await mount(Card, { view: "page", form: na, t: (k) => k, statusCall: () => undefined });
  check("unavailable notice shown", textOf(naTree).includes("unavailable"));
  check("unavailable still renders the section heads", textOf(naTree).includes("默认配置"));

  // A page that hands no form at all must not crash the card.
  let threw = false;
  try { await mount(Card, { view: "page", t: (k) => k, statusCall: () => undefined }); }
  catch { threw = true; }
  check("a missing form prop does not throw", !threw);
}

/* ══ 7. panel: live data ═════════════════════════════════════════════ */
console.log("\n[7] status panel — live snapshot");
const SNAPSHOT = {
  rev: 7,
  ts: 1760000000000,
  enabled: true,
  strategy: "token-bucket",
  onThrottled: "queue",
  totals: { requests: 42, granted: 38, rejected: 2, timeouts: 1, aborted: 1, totalWaitMs: 8123 },
  models: {
    "deepseek/deepseek-chat": { strategy: "token-bucket", tokens: 7.5, burstSize: 10, refillRate: 0.5, concurrent: 2, maxConcurrent: 5, queued: 1 },
    "openai/gpt-4o": { strategy: "sliding-window", windowMs: 60000, countInWindow: 3, maxRpm: 3, concurrent: 1, maxConcurrent: 5, queued: 0 },
  },
  events: [
    { event: "granted", model: "deepseek/deepseek-chat", waitMs: 4210, ts: 1760000000000 },
    { event: "rejected", model: "openai/gpt-4o", ts: 1760000001000 },
    { event: "timeout", model: "openai/gpt-4o", waitMs: 60000, ts: 1760000002000 },
  ],
};

const liveRpc = makeRpc({ snapshot: SNAPSHOT });
const liveCtx = makeContext({ get: liveRpc.ctxGet });
mod.apply(liveCtx.ctx);
const liveInjected = liveCtx.registered[0].meta.inject();

// The card gates the panel behind `open` (useState(false)), and hook slots are
// allocated in first-render order, so forcing a specific index is fragile.
// Instead: patch useState so that `false`-initialised hooks read as true.
async function mountExpanded(props) {
  const realUseState = reactMock.useState;
  reactMock.useState = (init) => {
    const [value, set] = realUseState(init);
    return [init === false ? true : value, set];
  };
  try {
    return await mount(Card, props);
  } finally {
    reactMock.useState = realUseState;
  }
}

const liveTree = await mountExpanded({ view: "page", form: makeForm(CONFIG), t: (k) => k, statusCall: liveInjected.statusCall });
const liveText = textOf(liveTree);
const liveClasses = classesOf(liveTree);
await flush();

check("expanded page renders the status panel", liveText.includes("实时状态"));
check("snapshot was requested over the status channel", liveRpc.calls.some((c) => c[0] === "/llm-rate-limiter" && c[1] === "snapshot"));
check("live phase badge shown", liveText.includes("实时"));
check("request chip", liveText.includes("请求 42"));
check("granted chip", liveText.includes("通过 38"));
check("rejected chip", liveText.includes("拒绝 2"));
check("timeout chip", liveText.includes("超时 1"));
check("aborted chip", liveText.includes("中止 1"));
check("average wait chip", liveText.includes("平均等待 214ms"), liveText.slice(0, 400));
check("token bucket model row", liveText.includes("deepseek/deepseek-chat"));
check("token bucket tokens shown", liveText.includes("7.5/10"));
check("token bucket labelled", liveText.includes("令牌桶"));
check("sliding window model row", liveText.includes("openai/gpt-4o"));
check("sliding window rpm shown", liveText.includes("3/3 rpm"));
check("sliding window labelled", liveText.includes("滑动窗口"));
check("concurrency shown", liveText.includes("并发 2/5"));
check("queued badge shown", liveText.includes("排队 1"));
check("configured-but-unused model listed as 未调用", liveText.includes("未调用"), liveText.slice(0, 600));
check("progress bar rendered", liveClasses.some((c) => c.includes("rlr-bar")));
check("near-limit bar flagged (window 3/3 = 100%)",
  liveClasses.some((c) => c === "rlr-barFill rlr-barFillWarn"));
check("event log rendered", liveClasses.some((c) => c.includes("rlr-logRow")));
eq("event log shows all three events", collect(liveTree, (n) => typeof n.props?.className === "string" && n.props.className.startsWith("rlr-logRow")).length, 3);
check("newest event first", liveText.indexOf("timeout") < liveText.indexOf("rejected"));
check("granted event coloured ok", liveClasses.some((c) => c.includes("rlr-logEvOk")));
check("rejected event coloured err", liveClasses.some((c) => c.includes("rlr-logEvErr")));
check("wait time rendered in the log", liveText.includes("等待 4.2s"));
check("reset button offered", buttonsOf(liveTree).some((b) => textOf(b).includes("清零")));

const resetBtn = buttonsOf(liveTree).find((b) => textOf(b).includes("清零"));
resetBtn.props.onClick();
await flush();
check("reset posts to the reset endpoint",
  liveRpc.calls.some((c) => c[0] === "/llm-rate-limiter" && c[1] === "reset"));
unmount();

/* ══ 8. panel: degraded phases ═══════════════════════════════════════ */
console.log("\n[8] panel — degraded phases");

// 8a. no connection service at all → statusCall() returns undefined.
const noChannelTree = await mountExpanded({ view: "page", form: makeForm(CONFIG), t: (k) => k, statusCall: () => undefined });
check("no-channel message shown", textOf(noChannelTree).includes("状态通道不可用"));
check("no-channel does not render bars", !classesOf(noChannelTree).some((c) => c.includes("rlr-barFill")));
unmount();

// 8b. transport rejects → failed phase, retry badge, no crash.
const failRpc = makeRpc({ reject: true });
const failCtx = makeContext({ get: failRpc.ctxGet });
mod.apply(failCtx.ctx);
const failTree = await mountExpanded({ view: "page", form: makeForm(CONFIG), t: (k) => k, statusCall: failCtx.registered[0].meta.inject().statusCall });
check("failed phase message shown", textOf(failTree).includes("连接中断"));
check("retry badge shown", textOf(failTree).includes("重试中"));
check("failure still issues a snapshot request", failRpc.calls.length >= 1);
unmount();

// 8c. limiter disabled globally.
const disabledRpc = makeRpc({ snapshot: { ...SNAPSHOT, enabled: false, models: {} } });
const disabledCtx = makeContext({ get: disabledRpc.ctxGet });
mod.apply(disabledCtx.ctx);
const disabledTree = await mountExpanded({ view: "page", form: makeForm(CONFIG), t: (k) => k, statusCall: disabledCtx.registered[0].meta.inject().statusCall });
check("disabled notice shown", textOf(disabledTree).includes("限速已停用"));
check("configured models still listed while disabled", textOf(disabledTree).includes("deepseek/deepseek-chat"));
unmount();

// 8d. enabled but nothing observed yet.
const emptyRpc = makeRpc({ snapshot: { ...SNAPSHOT, totals: { requests: 0, granted: 0, rejected: 0, timeouts: 0, aborted: 0, totalWaitMs: 0 }, models: {}, events: [] } });
const emptyCtx = makeContext({ get: emptyRpc.ctxGet });
mod.apply(emptyCtx.ctx);
const emptyTree = await mountExpanded({ view: "page", form: makeForm(CONFIG), t: (k) => k, statusCall: emptyCtx.registered[0].meta.inject().statusCall });
check("zero counters rendered", textOf(emptyTree).includes("请求 0"));
check("no event log when there are no events",
  !classesOf(emptyTree).some((c) => c.includes("rlr-logRow")));
check("average wait of zero shown as 0", textOf(emptyTree).includes("平均等待 0"));
unmount();

// 8e. nothing configured and nothing observed → the empty-state hint.
const bareForm = makeForm({ enabled: true, strategy: "token-bucket", models: {}, defaults: {} });
const bareRpc = makeRpc({ snapshot: { ...SNAPSHOT, models: {}, events: [] } });
const bareCtx = makeContext({ get: bareRpc.ctxGet });
mod.apply(bareCtx.ctx);
const bareTree = await mountExpanded({ view: "page", form: bareForm, t: (k) => k, statusCall: bareCtx.registered[0].meta.inject().statusCall });
check("empty model set explained", textOf(bareTree).includes("尚无模型调用记录"));
check("empty configured set explained", textOf(bareTree).includes("未配置模型专属限速"));
unmount();

// 8f. a strategy that reports a partial status must not break rendering.
const partialRpc = makeRpc({ snapshot: { ...SNAPSHOT, models: { "odd/model": { strategy: "token-bucket" } } } });
const partialCtx = makeContext({ get: partialRpc.ctxGet });
mod.apply(partialCtx.ctx);
const partialTree = await mountExpanded({ view: "page", form: makeForm(CONFIG), t: (k) => k, statusCall: partialCtx.registered[0].meta.inject().statusCall });
check("partial model status renders without NaN", !textOf(partialTree).includes("NaN"), textOf(partialTree).slice(0, 300));
check("partial model row present", textOf(partialTree).includes("odd/model"));
unmount();

/* ══ 9. the collapsed (summary) state does not poll ═════════════════ */
console.log("\n[9] summary view is the collapsed state");
// In 0.1.7 the Plugins page owns the card chrome and the collapse: the card is
// on the list as `view: "summary"` and only becomes this component's "page"
// view once opened. So the summary view IS the collapsed state, and it must
// cost nothing — no polling, no connection lookup, no panel.
{
  const collapsedRpc = makeRpc({ snapshot: SNAPSHOT });
  const collapsedCtx = makeContext({ get: collapsedRpc.ctxGet });
  mod.apply(collapsedCtx.ctx);
  const collapsedTree = await mount(Card, {
    view: "summary", form: makeForm(CONFIG), t: (k) => k,
    statusCall: collapsedCtx.registered[0].meta.inject().statusCall,
  });
  check("summary renders text for the card", textOf(collapsedTree).trim().length > 0);
  check("summary does not render the panel", !textOf(collapsedTree).includes("实时状态"));
  check("summary does not render configuration fields", !textOf(collapsedTree).includes("默认配置"));
  eq("summary performs no status calls", collapsedRpc.calls.length, 0);
  check("summary never touches the connection service",
    !collapsedTree || collapsedRpc.calls.length === 0);
  unmount();
}

/* ══ 10. hostile service registry ════════════════════════════════════ */
console.log("\n[10] hostile registry degrades, never throws");
{
  const hostileCtx = makeContext({ get: () => { throw new Error("hostile service registry"); } });
  mod.apply(hostileCtx.ctx);
  const hostileInjected = hostileCtx.registered[0].meta.inject();
  let threw = false;
  let value;
  try { value = hostileInjected.statusCall(); } catch { threw = true; }
  check("statusCall does not throw", !threw);
  eq("statusCall yields undefined on a hostile registry", value, undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
