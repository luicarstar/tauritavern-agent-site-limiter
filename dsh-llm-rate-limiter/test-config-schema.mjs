/**
 * Config-schema contract test for DSH 0.1.7.
 *
 * The plugin's settings UI exists only if its exported `Config` declares
 * volatile fields: `dsh-settings`'s `describe()` drops any entry whose
 * `volatileForm(schema)` is `undefined` (`lib/index.js:419`), and
 * the browser page's `whileServed` watches exactly that namespace list.
 * This suite pins the three properties that contract rests on:
 *
 *   1. the plugin's Config yields a NON-EMPTY volatile form;
 *   2. `models` is volatile as ONE BLOCK, so nested per-model paths stay
 *      writable (`isVolatilePath` stops at the volatile node) while a
 *      volatile `inner` would be rejected outright;
 *   3. a Config with no volatile field really is dropped — the regression
 *      guard for anyone who deletes a `.volatile()` mark.
 *
 * Layers 2 and 3 use the REAL `dsh-settings` helpers when that package is
 * resolvable from here (the normal case for a development install), and fall
 * back to an equivalent local implementation in CI, where DSH is absent.
 *
 * Run: node test-config-schema.mjs
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import Schema from "@deepseek-ai/schemastery";
import { Config } from "./lib/types/config.js";
import { apply, name, SETTINGS_NS } from "./lib/index.js";

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed += 1; console.log("  \u2713 " + label); }
  else { failed += 1; console.log("  \u2717 " + label + (detail === undefined ? "" : " — " + detail)); }
}
function eq(label, actual, expected) {
  check(label, actual === expected, "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}

/* ── resolve the real dsh-settings helpers, or use an equivalent ─────── */

const require = createRequire(import.meta.url);

/** Same resolution ladder as test-status-route.mjs: best-effort, never fatal. */
function resolveReal(spec) {
  const candidates = [];
  try { return require.resolve(spec); } catch { /* fall through */ }
  if (process.env.DSH_REAL_PACKAGES) candidates.push(process.env.DSH_REAL_PACKAGES);
  const home = process.env.DSH_HOME ?? (process.env.USERPROFILE ? process.env.USERPROFILE + "\\.dsh" : undefined);
  if (home !== undefined) {
    candidates.push(home + "\\profiles\\web\\node_modules");
    candidates.push(home + "\\profiles\\node_modules");
  }
  if (process.env.APPDATA) {
    candidates.push(process.env.APPDATA + "\\npm\\node_modules");
    // The global npm tree nests DSH's own deps one level down.
    candidates.push(process.env.APPDATA + "\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules");
  }
  for (const dir of candidates) {
    try { return createRequire(dir + "\\__probe__.js").resolve(spec); } catch { /* keep looking */ }
  }
  return undefined;
}

/**
 * Locate `dsh-settings`'s PRIVATE schema module.
 *
 * It is deliberately NOT listed in the package's `exports` map (which exposes
 * only `.`, `./types`, and `./src/*`), so a bare
 * `require.resolve("@deepseek-ai/dsh-settings/lib/types/schema.js")` always
 * fails with MODULE_NOT_FOUND — we must resolve the package ROOT and append
 * the file path ourselves.
 *
 * @returns a file:// URL importable by dynamic `import`, or undefined.
 */
function resolveSchemaModule() {
  const pkgJson = resolveReal("@deepseek-ai/dsh-settings/package.json");
  if (pkgJson === undefined) return undefined;
  const schemaPath = join(dirname(pkgJson), "lib", "types", "schema.js");
  if (!existsSync(schemaPath)) return undefined;
  // Node's ESM loader rejects native Windows paths ("D:\...") with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME; it needs a file:// URL.
  return pathToFileURL(schemaPath).href;
}

/**
 * The framework's own `volatileForm` / `isVolatilePath`
 * (`dsh-settings/lib/types/schema.js`), or a stand-in with identical
 * semantics when the package is not installed.
 */
async function loadHelpers(url) {
  if (url === undefined) return undefined;
  try {
    const m = await import(url);
    if (typeof m.volatileForm !== "function" || typeof m.isVolatilePath !== "function") return undefined;
    return { volatileForm: m.volatileForm, isVolatilePath: m.isVolatilePath, real: true };
  } catch { return undefined; }
}

/** Local mirror of the framework logic, used only when the real one is absent. */
function localPlainSchema(schema) {
  const result = new Schema(schema.toJSON());
  const walk = (node) => {
    delete node.meta.volatile;
    for (const child of Object.values(node.dict ?? {})) walk(child);
    if (node.inner) walk(node.inner);
    for (const child of node.list ?? []) walk(child);
  };
  walk(result);
  return result;
}
const localHelpers = {
  real: false,
  volatileForm(schema) {
    if (schema.meta.volatile) return localPlainSchema(schema);
    if (schema.type === "object") {
      const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = localHelpers.volatileForm(child);
        return field === undefined ? [] : [[key, field]];
      }));
      return Object.keys(dict).length === 0 ? undefined : Schema.object(dict);
    }
    return undefined;
  },
  isVolatilePath(schema, path) {
    if (schema.meta.volatile) return true;
    const [key, ...rest] = path;
    const child = key === undefined ? undefined : schema.dict?.[key];
    return child !== undefined && localHelpers.isVolatilePath(child, rest);
  },
};

const helpers = (await loadHelpers(resolveSchemaModule())) ?? localHelpers;
console.log(helpers.real
  ? "  \u25cf using the real @deepseek-ai/dsh-settings schema helpers"
  : "  \u25cb @deepseek-ai/dsh-settings not resolvable — using equivalent local helpers");
// The real helpers exercise the framework's exact code path. Say so loudly if
// we silently fell back, so a stale local install is never mistaken for proof.
if (!helpers.real) {
  console.log("    (set DSH_REAL_PACKAGES to a node_modules dir holding @deepseek-ai/dsh-settings to use the real one)");
}

/* ══ 1. the plugin exports its Config to Cordis ══════════════════════ */
console.log("\n[1] Config export surface");
check("Config is exported from the plugin entry", typeof apply === "function");
check("Config is a standard-schema object", typeof Config["~standard"] === "object");
eq("plugin name unchanged", name, "llm-rate-limiter");
eq("settings namespace unchanged (matches the patch row id)", SETTINGS_NS, "llm-rate-limiter");

const validated = Config["~standard"].validate({
  models: { "deepseek/deepseek-chat": { maxRpm: 3 } },
});
check("an empty-ish config validates", validated.issues === undefined, JSON.stringify(validated.issues));
const parsed = validated.value;

/* ══ 2. every editable leaf is a live reference ═════════════════════ */
console.log("\n[2] volatile references");
for (const field of ["enabled", "strategy", "defaults", "models", "onThrottled", "maxQueueWaitMs"]) {
  const ref = parsed[field];
  check("'" + field + "' is a live reference", ref !== null && typeof ref === "object" && typeof ref.get === "function");
}
eq("enabled reads back its default", parsed.enabled.get(), true);
eq("strategy reads back its default", parsed.strategy.get(), "token-bucket");
eq("onThrottled reads back its default", parsed.onThrottled.get(), "queue");
eq("maxQueueWaitMs reads back its default", parsed.maxQueueWaitMs.get(), 60_000);
eq("defaults is one plain object", JSON.stringify(parsed.defaults.get()),
  JSON.stringify({ maxConcurrent: 5, maxRpm: 60, burstSize: 10, refillRate: 1 }));
eq("models is one plain object", JSON.stringify(parsed.models.get()),
  JSON.stringify({ "deepseek/deepseek-chat": { maxRpm: 3 } }));

/* ══ 3. the volatile form (this is the settings UI's field list) ═════ */
console.log("\n[3] volatileForm — what the settings page will show");
const form = helpers.volatileForm(Config);
check("volatileForm(Config) is defined (an undefined form drops the entry)", form !== undefined);
if (form !== undefined) {
  const keys = Object.keys(form.dict ?? {});
  eq("every declared field appears in the form", keys.slice().sort().join(","),
    ["defaults", "enabled", "maxQueueWaitMs", "models", "onThrottled", "strategy"].join(","));
}

/* ══ 4. nested paths under the whole-block volatile dict ════════════ */
console.log("\n[4] nested per-model paths stay writable");
// This is the load-bearing case for the custom UI: the card writes
// ["models", key, "maxRpm"], a path INSIDE the volatile models block.
// isVolatilePath returns true the moment it reaches models and never
// inspects descendants (dsh-settings/lib/index.js:153-158), so the write is
// accepted even though volatileForm projected models as one opaque block.
check("whole-block: models/key/maxRpm is a volatile path",
  helpers.isVolatilePath(Config, ["models", "deepseek/deepseek-chat", "maxRpm"]) === true);
check("whole-block: models/key is a volatile path",
  helpers.isVolatilePath(Config, ["models", "deepseek/deepseek-chat"]) === true);
check("whole-block: models itself is a volatile path",
  helpers.isVolatilePath(Config, ["models"]) === true);
check("a top-level scalar is a volatile path",
  helpers.isVolatilePath(Config, ["enabled"]) === true);
check("a nested default is a volatile path",
  helpers.isVolatilePath(Config, ["defaults", "maxRpm"]) === true);
check("an unknown path is NOT volatile",
  helpers.isVolatilePath(Config, ["nope"]) === false);

/* ══ 5. the rejected shape: a volatile dict inner ═══════════════════ */
console.log("\n[5] dict(inner.volatile()) is rejected");
{
  // schemastery's standard-schema `validate` catches ValidationError and
  // REPORTS it as `issues` rather than throwing
  // (`schemastery/lib/index.mjs:56-65`), so the refusal surfaces here as a
  // non-empty issue list naming the whole-block requirement.
  const Inner = Schema.object({ maxRpm: Schema.number() });
  const bad = Schema.dict(Inner.volatile()).default({})["~standard"].validate({ "a/b": { maxRpm: 1 } });
  check("a volatile dict inner is refused", Array.isArray(bad.issues) && bad.issues.length > 0,
    JSON.stringify(bad.issues));
  const message = bad.issues?.[0]?.message ?? "";
  check("the refusal names the whole-block requirement",
    /without an enclosing volatile field/.test(message), message);
  check("the refusal is reported at the dict's key position",
    JSON.stringify(bad.issues?.[0]?.path) === JSON.stringify(["*"]), JSON.stringify(bad.issues?.[0]?.path));

  // Nesting it inside an object prefixes the path, which is what the plan
  // recorded for the plugin's own shape ($.models.*).
  const nested = Schema.object({ models: Schema.dict(Inner.volatile()) })["~standard"]
    .validate({ models: { "a/b": { maxRpm: 1 } } });
  check("nested, the refusal is prefixed with the field path",
    /\$\.models\.\*/.test(nested.issues?.[0]?.message ?? ""), JSON.stringify(nested.issues));

  // The shape the plugin actually uses must be accepted.
  const good = Schema.dict(Inner).default({}).volatile()["~standard"].validate({ "a/b": { maxRpm: 1 } });
  check("the whole-block shape validates cleanly", good.issues === undefined, JSON.stringify(good.issues));
  const collected = Schema.object({ models: Schema.dict(Inner).default({}).volatile() })["~standard"]
    .validate({ models: { "a/b": { maxRpm: 1 } } });
  check("the whole-block shape is clean nested too", collected.issues === undefined, JSON.stringify(collected.issues));
  eq("the nested dict reads back as a plain object",
    JSON.stringify(collected.value.models.get()), JSON.stringify({ "a/b": { maxRpm: 1 } }));
}

/* ══ 6. regression: no volatile field => the entry is dropped ═══════ */
console.log("\n[6] regression — an all-ordinary Config is dropped");
{
  const Plain = Schema.object({
    enabled: Schema.boolean().default(true),
    models: Schema.dict(Schema.object({ maxRpm: Schema.number() })).default({}),
  });
  eq("a Config with no .volatile() has NO volatile form", helpers.volatileForm(Plain), undefined);
  check("...which is exactly what makes describe() drop the entry",
    helpers.volatileForm(Plain) === undefined);

  // One mark is enough to bring it back — the minimum viable change.
  const Partial = Schema.object({
    enabled: Schema.boolean().default(true).volatile(),
    models: Schema.dict(Schema.object({ maxRpm: Schema.number() })).default({}),
  });
  check("one volatile field is enough to keep the entry", helpers.volatileForm(Partial) !== undefined);
}

/* ══ 7. the shipped Config keeps all six marks ══════════════════════ */
console.log("\n[7] the plugin's own marks are complete");
{
  // Deleting any one .volatile() mark in lib/types/config.js must fail here.
  const expected = ["enabled", "strategy", "defaults", "models", "onThrottled", "maxQueueWaitMs"];
  const missing = expected.filter((field) => Config.dict?.[field]?.meta?.volatile !== true);
  eq("every field in the plugin's Config is marked volatile", missing.join(","), "");
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exitCode = failed === 0 ? 0 : 1;
