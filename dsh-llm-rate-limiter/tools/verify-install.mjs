/**
 * Real-runtime check: does the INSTALLED plugin (through the web profile's
 * junction) load under the actual DSH module resolution rules, and does its
 * patch/channel surface match what the framework expects?
 *
 * This is the last gate before publishing: it resolves the plugin exactly as
 * DSH does (package name → node_modules → package.json metadata → patch name →
 * client bundle id) using the live install, not the source tree.
 *
 * Run: node tools/verify-install.mjs   (from the plugin directory)
 */
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const PROFILE = "C:\\Users\\91298\\.dsh\\profiles\\web";
const SCOPED = "@leaf233/dsh-llm-rate-limiter";
const WORKSPACE = "D:\\dsh工作区1\\dsh-llm-rate-limiter";

let passed = 0;
let failed = 0;
const check = (label, cond, detail) => {
  if (cond) { passed += 1; console.log(`  \u2713 ${label}`); }
  else { failed += 1; console.log(`  \u2717 ${label}${detail === undefined ? "" : ` — ${detail}`}`); }
};

// The profile half of this script describes a LOCAL install, so it can only be
// verified where one exists. When the profile does not carry the plugin (a
// fresh checkout, CI, or after the plugin was uninstalled) the install half is
// SKIPPED rather than failed — the source-tree half below still runs, and the
// process exits 2, matching tools/verify-live-route.mjs's convention.
const profilePkgPath = join(PROFILE, "package.json");
let profileInstalled = false;
if (existsSync(profilePkgPath)) {
  try {
    const probe = JSON.parse(readFileSync(profilePkgPath, "utf8"));
    profileInstalled = (probe.dsh?.profile?.bundles ?? []).includes(SCOPED) ||
      SCOPED in (probe.dependencies ?? {});
  } catch { profileInstalled = false; }
}

console.log("\n[profile] install layout");
if (!profileInstalled) {
  console.log("  \u25cb skipped — the plugin is not installed in " + PROFILE);
  console.log("    (run `dsh plugin add <profile> .` to exercise the install half)");
}

if (profileInstalled) {
check("bundles lists the scoped name", profilePkg.dsh.profile.bundles.includes(SCOPED));
check("dependencies has the scoped key", SCOPED in profilePkg.dependencies, profilePkg.dependencies[SCOPED]);
const nmPath = join(PROFILE, "node_modules", "@leaf233", "dsh-llm-rate-limiter");
check("node_modules entry exists", existsSync(nmPath));
if (existsSync(nmPath)) {
  check("entry resolves to this workspace", realpathSync(nmPath).toLowerCase() === WORKSPACE.toLowerCase(), realpathSync(nmPath));
}
}  // end of the install-only half

console.log("\n[resolution] the specifier DSH will import");
/** The profile's resolved host entry, when one is installed (see the import half). */
let hostEntry;
if (!profileInstalled) {
  console.log("  \u25cb skipped — nothing is installed to resolve");
} else {
const require = createRequire(join(PROFILE, "package.json"));
try { hostEntry = require.resolve(SCOPED); check("host entry resolves", true, hostEntry); }
catch (err) { check("host entry resolves", false, err.code + ": " + String(err.message).split("\n")[0]); }
let clientEntry;
try { clientEntry = require.resolve(SCOPED + "/client"); check("client bundle resolves", true, clientEntry); }
catch (err) { check("client bundle resolves", false, err.code + ": " + String(err.message).split("\n")[0]); }
}

console.log("\n[metadata] what the framework reads");
const pkg = JSON.parse(readFileSync(join(WORKSPACE, "package.json"), "utf8"));
check("package name is scoped", pkg.name === SCOPED, pkg.name);
check("version is 0.3.0", pkg.version === "0.3.0", pkg.version);
check("dsh.client.platform = web", pkg.dsh?.client?.platform === "web");
check("client bundle dependency declared",
  pkg.dsh?.client?.inject?.includes("@deepseek-ai/dsh-client-connection"),
  JSON.stringify(pkg.dsh?.client?.inject));
check("settings bundle dependency declared",
  pkg.dsh?.client?.inject?.includes("@deepseek-ai/dsh-client-ui-settings"));
check("plugin-manager bundle declared (plugins.item owner)",
  pkg.dsh?.client?.inject?.includes("@deepseek-ai/dsh-client-ui-plugin-manager"),
  JSON.stringify(pkg.dsh?.client?.inject));
check("locale bundle declared (the page needs a dictionary seat)",
  pkg.dsh?.client?.inject?.includes("@deepseek-ai/dsh-client-locale"));
// The dead `dsh.compatibility.dshReleases` field is gone; the real gate is
// `evaluatePluginCompatibility()` (dsh-app-boot/lib/index.js:286-313), which
// reads only peerDependencies matching @deepseek-ai/dsh / dsh-*.
check("dead dshReleases field removed", pkg.dsh?.compatibility === undefined,
  JSON.stringify(pkg.dsh?.compatibility));
// The gate is a dsh-* SUBPACKAGE peer, not the `@deepseek-ai/dsh` umbrella:
// `evaluatePluginCompatibility()` treats both identically (verified against the
// real exported function), but the umbrella drags the entire DSH tree into a
// consumer's dependency graph (~777 KB lockfile vs ~26 KB here). This matches
// the shipped convention — dsh-free-search, dsh-context, and dsh-model-relay all
// gate on dsh-* subpackages.
check("DSH peer range declares the 0.1.7 floor",
  pkg.peerDependencies?.["@deepseek-ai/dsh-settings"] === ">=0.1.7-rc.1",
  pkg.peerDependencies?.["@deepseek-ai/dsh-settings"]);
check("the umbrella @deepseek-ai/dsh is NOT a peer (it would pull the whole tree)",
  pkg.peerDependencies?.["@deepseek-ai/dsh"] === undefined,
  pkg.peerDependencies?.["@deepseek-ai/dsh"]);
check("schemastery peer requires the volatile-capable release",
  pkg.peerDependencies?.["@deepseek-ai/schemastery"] === ">=3.18.4",
  pkg.peerDependencies?.["@deepseek-ai/schemastery"]);
check("schemastery dependency pinned to the volatile-capable release",
  pkg.dependencies?.["@deepseek-ai/schemastery"] === "^3.18.4",
  pkg.dependencies?.["@deepseek-ai/schemastery"]);
check("exports[./client] declared", typeof pkg.exports?.["./client"] === "string");
check("patch declared", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");

const patch = readFileSync(join(WORKSPACE, "cordis.patch.yml"), "utf8");
const patchName = (patch.split(/\r?\n/).find((l) => /^\s*name:/.test(l)) ?? "")
  .replace(/^\s*name:\s*/, "").replace(/^['"]|['"]$/g, "").trim();
check("patch name equals package name", patchName === SCOPED, patchName);
check("patch keeps the stable plugin id", /id:\s*llm-rate-limiter/.test(patch));

const clientSource = readFileSync(join(WORKSPACE, "lib", "client.js"), "utf8");
const loadId = clientSource.match(/__ModuleLoader__\.load\(\{\s*id:\s*["']([^"']+)["']/)?.[1] ?? "";
check("client bundle id equals package name", loadId === SCOPED, loadId);

console.log("\n[import] the plugin actually evaluates in this Node");
// Prefer the profile junction when one exists (that is the specifier DSH will
// actually import); otherwise evaluate the source tree directly, so this half
// runs everywhere, installed or not.
const entryToImport = hostEntry !== undefined
  ? hostEntry
  : join(WORKSPACE, "lib", "index.js");
try {
  const mod = await import(new URL(`file:///${entryToImport.replace(/\\/g, "/")}`).href);
  check("host module imports", typeof mod.apply === "function");
  check("host plugin name unchanged", mod.name === "llm-rate-limiter", String(mod.name));
  check("settings namespace unchanged", mod.SETTINGS_NS === "llm-rate-limiter");
  // 0.1.7 reads configuration from the entry's own Config, so the schema must
  // be exported on the plugin object for Cordis to build volatile references.
  check("Config schema exported for Cordis", typeof mod.Config?.["~standard"] === "object",
    typeof mod.Config);
  check("Config declares volatile fields (else dsh-settings drops the entry)",
    mod.Config?.dict?.enabled?.meta?.volatile === true &&
      mod.Config?.dict?.models?.meta?.volatile === true);
  const statusRpc = await import(new URL(`file:///${join(WORKSPACE, "lib", "status-rpc.js").replace(/\\/g, "/")}`).href);
  check("status channel constant exported", statusRpc.CHANNEL === "/llm-rate-limiter", statusRpc.CHANNEL);
  check("channel name passes the framework pattern", /^\/[A-Za-z0-9._~-]+$/.test(statusRpc.CHANNEL));
  // v0.2.1 fallback carrier surface (the DSH 0.1.5-rc.3 regression fix).
  check("createChannelRoute exported", typeof statusRpc.createChannelRoute === "function");
  check("endpointFromPath exported", typeof statusRpc.endpointFromPath === "function");
  const fallbackRoute = statusRpc.createChannelRoute({
    channel: statusRpc.CHANNEL, handler: async () => ({ ok: true, value: {} }), reject: () => undefined,
  });
  check("fallback route is a prefix route on the channel",
    fallbackRoute.kind === "prefix" && fallbackRoute.path === statusRpc.CHANNEL,
    `${fallbackRoute.kind} ${fallbackRoute.path}`);
} catch (err) {
  check("host module imports", false, err.message.split("\n")[0]);
}

console.log("\n[shipped files] what npm will publish");
for (const f of ["lib/index.js", "lib/client.js", "lib/status-rpc.js", "cordis.patch.yml"]) {
  check(`shipped: ${f}`, existsSync(join(WORKSPACE, f)));
}
check("status-rpc is covered by the files field",
  (pkg.files ?? []).some((pattern) => pattern === "lib/" || pattern === "lib/status-rpc.js" || pattern === "lib"),
  JSON.stringify(pkg.files));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed !== 0) process.exitCode = 1;
else if (!profileInstalled) {
  // Source-tree checks passed; the install half never ran. Exit 2 so the
  // caller can tell "verified" from "verified what it could" — the same
  // contract as tools/verify-live-route.mjs.
  console.log("partial: the install half was skipped (no installed profile)");
  process.exitCode = 2;
}
