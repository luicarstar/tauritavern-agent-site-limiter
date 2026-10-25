/* eslint-disable */
/**
 * dsh-llm-rate-limiter — Client (browser) entry point.
 *
 * Registers the rate limiter's configuration page in the Plugins page's
 * `plugins.item` slot (DSH 0.1.7+). The page draws the card chrome — icon,
 * title, crumb, and the "open" navigation — and asks the entry for two views:
 *
 *   - `view: "summary"` → the one-line description on the card;
 *   - `view: "page"`    → the configuration body plus the live status panel.
 *
 * Configuration values and the write channel come from the page itself
 * (`props.form.state` / `props.form.mutate`), not from a plugin-owned
 * `settingsScope`: `dsh-settings` projects the Host entry's volatile Config
 * fields into one shared form per entry, and the page owns that form.
 *
 * Browser format: CJS-style factory registered via window.__ModuleLoader__.load
 * (loaded as a plain <script>, so NO top-level ESM `export` allowed).
 *
 * @module dsh-llm-rate-limiter/client
 */
window.__ModuleLoader__.load({
	id: "@leaf233/dsh-llm-rate-limiter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// ── React imports (browser module system provides them) ──────────────
		let react, jsx, jsxs;
		react = require("react");
		({ jsx, jsxs } = require("react/jsx-runtime"));

		// ── Shared constants ──
		/**
		 * Settings namespace = the Host profile entry's id (its
		 * `cordis.patch.yml` row id). `dsh-settings` keys every form by
		 * `entry.options.id`, so this constant must match the row id.
		 */
		const name = "llm-rate-limiter";
		/** Locale dictionary namespace owned by this plugin. */
		const NS = "settings.llmRateLimiter";
		/** Static fiber inject: every service this bundle reads. */
		// [dsh-fix 2026-10-25] "remote"/"remote.session" are needed for the
		// model-catalog dropdown (same services the model picker injects).
		const inject = ["slots", "locale", "remote", "remote.session"];

		/* ── locale dictionaries ─────────────────────────────────────────── */
		const zh = {
			title: "LLM 调用限速",
			description: "按模型限制 LLM 请求频率，超出限制的请求排队等待",
			unavailable: "该插件当前未加载，暂时无法配置。",
			readOnly: "本部署的设置为只读。",
		};
		const en = {
			title: "LLM rate limiter",
			description: "Limit per-model LLM request rates; throttled calls wait in queue",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			readOnly: "This deployment stores settings read-only.",
		};

		/* ── CSS-in-JS (design tokens, injected once) ────────────────────── */
		(() => {
			const styles = [
				".rlr-page{display:flex;flex-direction:column;gap:4px;list-style:none;margin:0}",
				".rlr-status{color:var(--dsw-alias-label-tertiary);margin:8px 0 4px;font-size:12px;line-height:1.5}",
				".rlr-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:6px 0}",
				".rlr-label{min-width:140px;font-size:13px;color:var(--dsw-alias-label-secondary)}",
				".rlr-input{width:80px;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-surface-s2);color:var(--dsw-alias-label-primary);font-size:13px}",
				".rlr-select{padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-surface-s2);color:var(--dsw-alias-label-primary);font-size:13px}",
				".rlr-btn{height:30px;padding:0 12px;border-radius:15px;border:none;cursor:pointer;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary-foreground);background:var(--dsh-alias-button-primary-fill,#4f46e5)}",
				".rlr-btnSec{height:26px;padding:0 10px;border-radius:13px;border:none;cursor:pointer;font-size:12px;background:var(--dsw-alias-button-secondary-fill);color:var(--dsw-alias-label-primary)}",
				".rlr-danger{height:26px;padding:0 8px;border-radius:13px;border:none;cursor:pointer;font-size:11px;background:var(--dsw-alias-state-error-primary);color:#fff}",
				".rlr-modelRow{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l4);gap:8px;margin:4px 0}",
				".rlr-modelName{font-size:13px;font-weight:500;font-family:monospace}",
				".rlr-modelMeta{display:flex;gap:12px;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
				".rlr-section{display:flex;flex-direction:column;gap:4px;margin-top:2px}",
				".rlr-sectHead{margin:10px 0 0;font-size:14px;font-weight:500}",
				// ── status panel ──
				".rlr-statusHead{display:flex;align-items:center;gap:8px;margin:10px 0 0}",
				".rlr-statusTitle{font-size:14px;font-weight:500;flex:1}",
				".rlr-chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}",
				".rlr-chip{font-size:11px;padding:2px 8px;border-radius:10px;background:var(--dsw-alias-surface-s2);color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}",
				".rlr-chipOk{background:var(--dsw-alias-state-success-primary,#16a34a);color:#fff}",
				".rlr-chipWarn{background:var(--dsw-alias-state-warning-primary,#d97706);color:#fff}",
				".rlr-chipErr{background:var(--dsw-alias-state-error-primary,#dc2626);color:#fff}",
				".rlr-phase{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
				".rlr-phaseLive{color:var(--dsw-alias-state-success-primary,#16a34a)}",
				".rlr-phaseFailed{color:var(--dsw-alias-state-error-primary,#dc2626)}",
				".rlr-models{display:flex;flex-direction:column;gap:4px;margin:6px 0}",
				".rlr-mRow{display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l4)}",
				".rlr-mName{font-size:12px;font-family:monospace;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".rlr-mKind{font-size:10px;padding:1px 6px;border-radius:8px;background:var(--dsw-alias-surface-s2);color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
				".rlr-mMeta{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}",
				".rlr-mIdle{opacity:.55}",
				".rlr-bar{width:90px;height:6px;border-radius:3px;background:var(--dsw-alias-surface-s2);overflow:hidden;flex:none}",
				".rlr-barFill{height:100%;background:var(--dsw-alias-brand-primary,#4f46e5);transition:width .3s}",
				".rlr-barFillWarn{background:var(--dsw-alias-state-warning-primary,#d97706)}",
				".rlr-log{display:flex;flex-direction:column;gap:1px;margin:6px 0;font-family:monospace;font-size:11px}",
				".rlr-logRow{display:flex;gap:8px;padding:1px 4px;border-radius:4px;color:var(--dsw-alias-label-tertiary)}",
				".rlr-logRowNew{background:var(--dsw-alias-surface-s2)}",
				".rlr-logEv{min-width:66px}",
				".rlr-logEvOk{color:var(--dsw-alias-state-success-primary,#16a34a)}",
				".rlr-logEvWarn{color:var(--dsw-alias-state-warning-primary,#d97706)}",
				".rlr-logEvErr{color:var(--dsw-alias-state-error-primary,#dc2626)}",
				".rlr-logMs{min-width:56px;text-align:right}",
			].join("\n");
			const tagId = "@dsh-llm-rate-limiter/rate-limiter-card.css";
			if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-llm-rate-limiter";
				tag.dataset.pluginCss = tagId;
				tag.textContent = styles;
				document.head.appendChild(tag);
			}
		})();

		/* ── helpers ─────────────────────────────────────────────────────── */
		function readNum(cfg, key, field) {
			return cfg.models?.[key]?.[field] ?? cfg.defaults?.[field] ?? 0;
		}

		/* ── status channel access (dsh-context defensive idiom) ─────────── */
		const STATUS_CHANNEL = "/llm-rate-limiter";

		/**
		 * The connection's bound generic-RPC caller, or undefined when the
		 * service is absent or hostile. Every read is guarded, so this can
		 * never throw — a missing channel degrades the panel, not the page.
		 */
		function rpcCallOf(ctx) {
			try {
				const rpc = ctx.get("connection")?.rpc;
				const fn = rpc?.call;
				if (rpc && typeof fn === "function") return fn.bind(rpc);
			} catch {}
			return undefined;
		}

		/** Format a duration in ms for the chips/log (compact). */
		function fmtMs(ms) {
			if (!Number.isFinite(ms) || ms <= 0) return "0";
			if (ms < 1000) return Math.round(ms) + "ms";
			if (ms < 60_000) return (ms / 1000).toFixed(1) + "s";
			return Math.round(ms / 60_000) + "m";
		}

		/** Human label for a strategy id. */
		function strategyLabel(id) {
			return id === "sliding-window" ? "滑动窗口" : "令牌桶";
		}

		/** Tunable polling cadence: first retry delay doubles up to 8s. */
		const POLL_MS = 1000;
		const POLL_MAX_MULTIPLIER = 8;

		/* ── React component: live status panel ──────────────────────────── */
		function RateLimiterStatus({ statusCall, cfg }) {
			const [snap, setSnap] = react.useState(null);
			const [phase, setPhase] = react.useState("connecting");
			const prevRev = react.useRef(-1);
			const [highlight, setHighlight] = react.useState(false);

			react.useEffect(() => {
				const call = statusCall();
				if (call === undefined) {
					setPhase("no-channel");
					return undefined;
				}
				let stop = false;
				let timer = null;
				let failures = 0;

				const tick = async () => {
					try {
						const r = await call(STATUS_CHANNEL, "snapshot", {});
						if (stop) return;
						if (r?.ok !== true || !r.value) throw new Error("bad envelope");
						setSnap(r.value);
						setPhase("live");
						failures = 0;
					} catch {
						if (stop) return;
						failures += 1;
						setPhase("failed");
					}
					if (stop) return;
					const multiplier = Math.min(2 ** Math.min(failures, 3), POLL_MAX_MULTIPLIER);
					timer = setTimeout(tick, POLL_MS * multiplier);
				};

				tick();
				return () => {
					stop = true;
					if (timer) clearTimeout(timer);
				};
			}, [statusCall]);

			// Flash newly arrived events when `rev` advances between polls.
			react.useEffect(() => {
				if (!snap) return undefined;
				if (prevRev.current === -1) { prevRev.current = snap.rev; return undefined; }
				if (snap.rev === prevRev.current) return undefined;
				prevRev.current = snap.rev;
				setHighlight(true);
				const t = setTimeout(() => setHighlight(false), 700);
				return () => clearTimeout(t);
			}, [snap]);

			// ── non-live phases ──
			if (phase === "no-channel") {
				return jsx("div", { className: "rlr-status", children: "状态通道不可用（需要 DSH web 组合）" });
			}
			if (phase === "connecting" && !snap) {
				return jsx("div", { className: "rlr-status", children: "正在连接状态通道…" });
			}
			if (!snap) {
				return jsx("div", { className: "rlr-status", children: "连接中断，重试中…" });
			}

			const t = snap.totals ?? {};
			const avgWait = t.granted > 0 ? (t.totalWaitMs ?? 0) / t.granted : 0;
			const live = phase === "live";

			function onReset() {
				const call = statusCall();
				if (call === undefined) return;
				Promise.resolve(call(STATUS_CHANNEL, "reset", {})).catch(() => undefined);
			}

			// Union of configured models and models that have actually been used.
			const snapModels = snap.models ?? {};
			const keys = Array.from(new Set([...Object.keys(cfg.models ?? {}), ...Object.keys(snapModels)]));

			const chips = [
				{ label: "请求 " + (t.requests ?? 0) },
				{ label: "通过 " + (t.granted ?? 0), tone: "ok" },
				(t.rejected ?? 0) > 0 && { label: "拒绝 " + t.rejected, tone: "err" },
				(t.timeouts ?? 0) > 0 && { label: "超时 " + t.timeouts, tone: "warn" },
				(t.aborted ?? 0) > 0 && { label: "中止 " + t.aborted, tone: "warn" },
				{ label: "平均等待 " + fmtMs(avgWait) },
			].filter(Boolean);

			const events = Array.isArray(snap.events) ? snap.events.slice().reverse() : [];

			return jsxs("div", { className: "rlr-section", children: [
				jsxs("div", { className: "rlr-statusHead", children: [
					jsx("span", { className: "rlr-statusTitle", children: "📊 实时状态" }),
					jsx("span", {
						className: "rlr-phase" + (live ? " rlr-phaseLive" : " rlr-phaseFailed"),
						children: live ? "● 实时" : "○ 重试中",
					}),
					jsx("button", { type: "button", className: "rlr-btnSec", onClick: onReset, children: "清零" }),
				] }),

				snap.enabled === false
					? jsx("div", { className: "rlr-status", children: "限速已停用" })
					: null,

				jsx("div", { className: "rlr-chips", children: chips.map((c, i) =>
					jsx("span", {
						key: i,
						className: "rlr-chip" + (c.tone === "ok" ? " rlr-chipOk" : c.tone === "warn" ? " rlr-chipWarn" : c.tone === "err" ? " rlr-chipErr" : ""),
						children: c.label,
					}),
				) }),

				keys.length === 0
					? jsx("div", { className: "rlr-status", children: "尚无模型调用记录" })
					: jsx("div", { className: "rlr-models", children: keys.map((key) => {
						const m = snapModels[key];
						if (!m) {
							return jsxs("div", { key, className: "rlr-mRow rlr-mIdle", children: [
								jsx("span", { className: "rlr-mName", children: key }),
								jsx("span", { className: "rlr-mMeta", children: "未调用" }),
							] });
						}
						const isBucket = m.strategy !== "sliding-window";
						const numerator = isBucket ? (m.tokens ?? 0) : (m.countInWindow ?? 0);
						const denominator = isBucket ? (m.burstSize ?? 0) : (m.maxRpm ?? 0);
						const pct = denominator > 0 ? Math.min(100, Math.round((numerator / denominator) * 100)) : 0;
						// A nearly empty bucket / a nearly full window both mean "close to throttling".
						const nearLimit = isBucket ? pct <= 20 : pct >= 80;
						return jsxs("div", { key, className: "rlr-mRow", children: [
							jsx("span", { className: "rlr-mName", title: key, children: key }),
							jsx("span", { className: "rlr-mKind", children: strategyLabel(m.strategy) }),
							jsx("span", { className: "rlr-bar", children:
								jsx("span", { className: "rlr-barFill" + (nearLimit ? " rlr-barFillWarn" : ""), style: { width: pct + "%" } }),
							}),
							jsx("span", { className: "rlr-mMeta", children:
								(isBucket ? numerator + "/" + denominator : numerator + "/" + denominator + " rpm"),
							}),
							jsx("span", { className: "rlr-mMeta", children: "并发 " + (m.concurrent ?? 0) + "/" + (m.maxConcurrent ?? 0) }),
							(m.queued ?? 0) > 0
								? jsx("span", { className: "rlr-chip rlr-chipWarn", children: "排队 " + m.queued })
								: null,
						] });
					}) }),

				events.length > 0
					? jsx("div", { className: "rlr-log", children: events.map((e, i) => {
						const good = e.event === "granted" || e.event === "completed";
						const bad = e.event === "rejected";
						const d = new Date(e.ts ?? Date.now());
						const hh = String(d.getHours()).padStart(2, "0");
						const mm = String(d.getMinutes()).padStart(2, "0");
						const ss = String(d.getSeconds()).padStart(2, "0");
						return jsxs("div", {
							className: "rlr-logRow" + (highlight && i === 0 ? " rlr-logRowNew" : ""),
							children: [
								jsx("span", { children: hh + ":" + mm + ":" + ss }),
								jsx("span", { className: "rlr-logEv " + (good ? "rlr-logEvOk" : bad ? "rlr-logEvErr" : "rlr-logEvWarn"), children: e.event }),
								jsx("span", { className: "rlr-mName", title: e.model, children: e.model }),
								(e.waitMs ?? 0) > 0
									? jsx("span", { className: "rlr-logMs", children: "等待 " + fmtMs(e.waitMs) })
									: null,
							],
						});
					}) })
					: null,
			] });
		}

		/* ── React component: the settings page (summary + page views) ───── */
		/**
		 * Render the one-liner or the configuration body, as the Plugins page
		 * asks. Configuration values arrive in `props.form.state` (a
		 * `ConfigFormSnapshot`: `{status, value, base, user, revision,
		 * writable, mode}`) and writes go through `props.form.mutate(ops)` with
		 * the same `{op:'set'|'unset', path, value}` operations the Host
		 * validated before. The page owns the form, so it re-renders this entry
		 * whenever the settings mirror changes — the component keeps no
		 * subscription of its own.
		 *
		 * @param props - `view`, the page-owned `form`, and the injected
		 *   `statusCall` (plus the framework's `t` locale seat).
		 */
		function RateLimiterCard(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;

			if (props.view === "summary") return jsx("span", { children: t("description") });

			const form = props.form;
			const snap = form?.state;
			const statusCall = props.statusCall;

			// [dsh-fix 2026-10-25] the page-owned form depends on the describe
			// mirror reporting this namespace, which does not happen on every
			// host — the card then shows defaults and every control silently
			// no-ops. Fetch the real config through the plugin's own channel
			// and route mutations the same way; form.mutate stays as a
			// fallback when the channel is unavailable.
			const [liveCfg, setLiveCfg] = react.useState(null);
			react.useEffect(() => {
				const call = statusCall && statusCall();
				if (call === undefined) return undefined;
				let stop = false;
				call(STATUS_CHANNEL, "config", {}).then((r) => {
					if (!stop && r !== null && r !== void 0 && r.ok === true && r.value) setLiveCfg(r.value);
				}).catch(() => undefined);
				return () => { stop = true; };
			}, [statusCall]);
			const cfg = liveCfg !== null ? liveCfg : (snap?.status === "ready" && snap.value ? snap.value : {});
			const writable = snap === undefined ? true : snap.writable !== false;

			/** Queue one atomic namespace mutation; failures leave the form as-is. */
			function push(ops) {
				const call = statusCall && statusCall();
				if (call !== undefined) {
					call(STATUS_CHANNEL, "mutate", { ops }).then((r) => {
						if (r !== null && r !== void 0 && r.ok === true && r.value) setLiveCfg(r.value);
					}).catch(() => undefined);
					return;
				}
				if (!form || typeof form.mutate !== "function") return;
				try {
					Promise.resolve(form.mutate(ops)).catch(() => undefined);
				} catch {}
			}
			const setPath = (path, value) => push([{ op: "set", path, value }]);
			const unsetPath = (path) => push([{ op: "unset", path }]);

			const modelKeys = Object.keys(cfg.models ?? {});

			// [dsh-fix 2026-10-25] window.prompt() is NOT implemented in Electron
			// renderers — the click silently returned and "添加模型" appeared to
			// do nothing. Inline row instead, with a model dropdown pulled from
			// the Host catalog (remote.session.modelCatalog); falls back to a
			// text input when the catalog cannot be fetched.
			const [newModel, setNewModel] = react.useState(null);
			const [catalog, setCatalog] = react.useState(null); // null=未加载, "failed", string[]
			react.useEffect(() => {
				if (newModel === null || catalog !== null) return undefined;
				const call = props.catalogCall && props.catalogCall();
				if (call === undefined) { setCatalog("failed"); return undefined; }
				let stop = false;
				call().then((r) => {
					if (stop) return;
					if (r === null || r === void 0 || r.ok !== true || !r.value || !Array.isArray(r.value.groups)) { setCatalog("failed"); return; }
					const keys = [];
					for (const group of r.value.groups) {
						for (const model of group.models || []) keys.push(group.id + "/" + model.id);
					}
					if (!stop) setCatalog(keys.length > 0 ? keys : "failed");
				}).catch(() => { if (!stop) setCatalog("failed"); });
				return () => { stop = true; };
			}, [newModel, catalog]);
			function addModel() {
				setNewModel("");
			}
			function confirmAddModel() {
				const key = String(newModel ?? "").trim();
				if (key) setPath(["models", key], {});
				setNewModel(null);
			}
			function removeModel(key) {
				unsetPath(["models", key]);
			}
			function setModelField(key, field, value) {
				const path = ["models", key, field];
				if (value === undefined || value === "") unsetPath(path);
				else setPath(path, value);
			}
			function setDefault(field, value) {
				setPath(["defaults", field], value);
			}
			function setTop(field, value) {
				setPath([field], value);
			}

			return jsxs("div", { className: "rlr-page", children: [
				/* ── unavailable / read-only notices ── */
				snap?.status === "unavailable"
					? jsx("div", { className: "rlr-status", children: t("unavailable") })
					: null,
				snap !== undefined && !writable
					? jsx("div", { className: "rlr-status", children: t("readOnly") })
					: null,

				/* ── 实时状态面板 ── */
				jsx(RateLimiterStatus, { statusCall, cfg }),

				/* ── 启用开关 ── */
				jsxs("div", { className: "rlr-row", children: [
					jsx("label", { children: [
						jsx("input", { type: "checkbox", checked: cfg.enabled ?? true, disabled: !writable, onChange: (e) => setTop("enabled", e.target.checked) }),
						" 启用限速",
					] }),
				] }),
				/* ── 默认配置 ── */
				jsxs("div", { className: "rlr-section", children: [
					jsx("div", { className: "rlr-sectHead", children: "默认配置" }),
					jsxs("div", { className: "rlr-row", children: [
						jsx("span", { className: "rlr-label", children: "策略" }),
						jsxs("select", { className: "rlr-select", value: cfg.strategy ?? "token-bucket", disabled: !writable, onChange: (e) => setTop("strategy", e.target.value), children: [
							jsx("option", { value: "token-bucket", children: "令牌桶 (Token Bucket)" }),
							jsx("option", { value: "sliding-window", children: "滑动窗口 (Sliding Window)" }),
						] }),
					] }),
					jsxs("div", { className: "rlr-row", children: [
						jsx("span", { className: "rlr-label", children: "最大并发数" }),
						jsx("input", { type: "number", min: 1, className: "rlr-input", disabled: !writable, value: cfg.defaults?.maxConcurrent ?? 5, onChange: (e) => setDefault("maxConcurrent", Number(e.target.value) || 1) }),
					] }),
					jsxs("div", { className: "rlr-row", children: [
						jsx("span", { className: "rlr-label", children: "每分钟最大请求数" }),
						jsx("input", { type: "number", min: 1, className: "rlr-input", disabled: !writable, value: cfg.defaults?.maxRpm ?? 60, onChange: (e) => setDefault("maxRpm", Number(e.target.value) || 1) }),
					] }),
					cfg.strategy !== "sliding-window" && jsxs(react.Fragment, { children: [
						jsxs("div", { className: "rlr-row", children: [
							jsx("span", { className: "rlr-label", children: "突发容量" }),
							jsx("input", { type: "number", min: 1, className: "rlr-input", disabled: !writable, value: cfg.defaults?.burstSize ?? 10, onChange: (e) => setDefault("burstSize", Number(e.target.value) || 1) }),
						] }),
						jsxs("div", { className: "rlr-row", children: [
							jsx("span", { className: "rlr-label", children: "补充速率 (个/秒)" }),
							jsx("input", { type: "number", min: 0.1, step: 0.1, className: "rlr-input", disabled: !writable, value: cfg.defaults?.refillRate ?? 1, onChange: (e) => setDefault("refillRate", Number(e.target.value) || 0.1) }),
						] }),
					] }),
				] }),
				/* ── 模型专属配置 ── */
				jsxs("div", { className: "rlr-section", children: [
					jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" }, children: [
						jsx("div", { className: "rlr-sectHead", children: "模型专属配置" }),
						jsx("button", { className: "rlr-btn", disabled: !writable, onClick: addModel, children: "+ 添加模型" }),
					] }),
					newModel !== null && jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6, margin: "6px 0" }, children: [
						Array.isArray(catalog)
							? jsxs("select", { className: "rlr-select", style: { flex: 1 }, value: newModel, onChange: (e) => setNewModel(e.target.value), children: [
								jsx("option", { value: "", children: "选择模型…" }),
								catalog.filter((k) => !(k in (cfg.models ?? {}))).map((k) => jsx("option", { value: k, children: k }, k)),
							] })
							: catalog === "failed"
								? jsx("input", { className: "rlr-input", style: { flex: 1 }, placeholder: "provider/model（目录拉取失败，手动填写）", value: newModel, autoFocus: true, onChange: (e) => setNewModel(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") confirmAddModel(); if (e.key === "Escape") setNewModel(null); } })
								: jsx("input", { className: "rlr-input", style: { flex: 1 }, disabled: true, placeholder: "正在拉取模型列表…", value: "" }),
						jsx("button", { className: "rlr-btn", disabled: !String(newModel).trim(), onClick: confirmAddModel, children: "添加" }),
						jsx("button", { className: "rlr-btnSec", onClick: () => setNewModel(null), children: "取消" }),
					] }),
					modelKeys.length === 0 && newModel === null && jsx("p", { className: "rlr-status", children: "未配置模型专属限速，所有模型使用默认值。" }),
					modelKeys.map((key) => jsxs("div", { className: "rlr-modelRow", key, children: [
						jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 4, flex: 1 }, children: [
							jsx("span", { className: "rlr-modelName", children: key }),
							jsxs("div", { className: "rlr-modelMeta", children: [
								jsx("span", { children: "并发: " + readNum(cfg, key, "maxConcurrent") }),
								jsx("span", { children: "RPM: " + readNum(cfg, key, "maxRpm") }),
								cfg.strategy !== "sliding-window" && jsx("span", { children: "突发: " + readNum(cfg, key, "burstSize") }),
							] }),
							jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 4 }, children: [
								jsx("input", { type: "number", min: 1, className: "rlr-input", disabled: !writable, style: { width: 60 }, title: "并发", placeholder: "并发", value: cfg.models?.[key]?.maxConcurrent ?? "", onChange: (e) => setModelField(key, "maxConcurrent", e.target.value === "" ? undefined : Number(e.target.value) || 1) }),
								jsx("input", { type: "number", min: 1, className: "rlr-input", disabled: !writable, style: { width: 60 }, title: "RPM", placeholder: "RPM", value: cfg.models?.[key]?.maxRpm ?? "", onChange: (e) => setModelField(key, "maxRpm", e.target.value === "" ? undefined : Number(e.target.value) || 1) }),
								cfg.strategy !== "sliding-window" && jsx("input", { type: "number", min: 1, className: "rlr-input", disabled: !writable, style: { width: 60 }, title: "突发", placeholder: "突发", value: cfg.models?.[key]?.burstSize ?? "", onChange: (e) => setModelField(key, "burstSize", e.target.value === "" ? undefined : Number(e.target.value) || 1) }),
								jsx("button", { className: "rlr-btnSec", disabled: !writable, onClick: () => { const v = cfg.models?.[key]?.enabled; setModelField(key, "enabled", v === false ? undefined : false); }, children: cfg.models?.[key]?.enabled === false ? "已禁用" : "禁用" }),
							] }),
						] }),
						jsx("button", { className: "rlr-danger", disabled: !writable, onClick: () => removeModel(key), title: "删除", children: "✕" }),
					] })),
				] }),
				/* ── 被限速时的行为 ── */
				jsxs("div", { className: "rlr-section", children: [
					jsx("div", { className: "rlr-sectHead", children: "被限速时的行为" }),
					jsxs("div", { className: "rlr-row", children: [
						jsx("label", { style: { display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }, children: [
							jsx("input", { type: "radio", name: "rl-on-throttle", disabled: !writable, checked: cfg.onThrottled !== "reject", onChange: () => setTop("onThrottled", "queue") }),
							"排队等待",
						] }),
						jsx("label", { style: { display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }, children: [
							jsx("input", { type: "radio", name: "rl-on-throttle", disabled: !writable, checked: cfg.onThrottled === "reject", onChange: () => setTop("onThrottled", "reject") }),
							"拒绝请求",
						] }),
					] }),
					cfg.onThrottled !== "reject" && jsxs("div", { className: "rlr-row", children: [
						jsx("span", { className: "rlr-label", children: "最大排队等待 (ms)" }),
						jsx("input", { type: "number", min: 1000, step: 1000, className: "rlr-input", disabled: !writable, value: cfg.maxQueueWaitMs ?? 60000, onChange: (e) => setTop("maxQueueWaitMs", Number(e.target.value) || 60000) }),
					] }),
				] }),
			] });
		}

		/* ── Plugin registration ── */
		/**
		 * Mount the configuration page while the Host serves this entry's
		 * namespace, and register the plugin's own dictionaries.
		 *
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "llm-rate-limiter: dictionaries");

			// [dsh-fix 2026-10-25] 0.2.1-rc.3 上 whileServed 的 describe mirror 未把本命名空间
			// 回送给客户端，卡片被整体隐藏。改为无条件注册：状态面板走插件自己的
			// /llm-rate-limiter 通道（已验证可用），配置兜底走 profile 的 cordis.patch.yml。
			const registerCard = () => ctx.slots.inject("plugins.item", () => ctx.slots.register({
				name: "plugins.item",
				id: name,
				// Official `plugins.item` occupants take 10/20/30/40; 900 parks
				// this third-party card after all of them.
				order: 900,
				label: () => t("title"),
				locale: NS,
				// `statusCall` is resolved per render (never cached) so a
				// late-arriving or hot-reloaded connection service is picked up
				// without re-registering the page.
				// [dsh-fix 2026-10-25] `catalogCall` pulls the Host model
				// catalog (the same remote.session.modelCatalog the model
				// picker uses) so the add-model row can offer a dropdown
				// instead of free text.
				inject: () => ({
					statusCall: () => rpcCallOf(ctx),
					catalogCall: () => {
						try {
							const session = ctx.remote && ctx.remote.session;
							return session && typeof session.modelCatalog === "function" ? session.modelCatalog.bind(session) : undefined;
						} catch {
							return undefined;
						}
					},
				}),
			}, RateLimiterCard));
			ctx.effect(() => registerCard(), "llm-rate-limiter: plugins page");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		exports.NS = NS;
		return module.exports;
	},
});
