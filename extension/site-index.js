import { SiteRouter } from './site-router.js';
import { originalTarget, targetConnection, bindingFor, profileCopy } from './model.js';

const NS = 'tt-agent-limiter', fields = {};
let api, ctx, config, saved, router, panel, busy = false, currentStatus;
let persistTail = Promise.resolve();
function persist() {
    const value = structuredClone(saved);
    persistTail = persistTail.catch(() => {}).then(() => api.extension.store.setJson({ namespace: NS, key: 'settings', value }));
    return persistTail;
}
function message(value, error = false) { fields.message.textContent = value; fields.message.classList.toggle('ttal-error', error); }
async function relay(endpoint, data) {
    if (!config.adminToken) throw new Error('请先运行安装插件.ps1，配对本机服务');
    const response = await fetch(config.baseUrl + endpoint, { method: data === undefined ? 'GET' : 'POST',
        headers: { 'x-tt-limiter-token': config.adminToken, ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(6000), cache: 'no-store' });
    const dataOut = await response.json();
    if (!response.ok) throw new Error(dataOut.error?.message || `HTTP ${response.status}`);
    return dataOut;
}
function sourceList() {
    const cm = ctx.extensionSettings.connectionManager || {};
    return [...(cm.modelTargets || []), ...(cm.profiles || [])]
        .filter(x => !String(x.id).startsWith('ttlim-'))
        .filter((x,i,a) => a.findIndex(y => y.id === x.id) === i);
}
function discoveredSites() {
    const values = [...sourceList().map(x => x['api-url']), ctx.chatCompletionSettings?.custom_url,
        ...(currentStatus?.routes || []).map(x => x.upstream)];
    const sites = new Set();
    for (const value of values) {
        try { const u = new URL(router.unwrap(value)); if (['http:','https:'].includes(u.protocol) && u.origin !== config.baseUrl) sites.add(u.origin); } catch {}
    }
    return [...sites].sort();
}
function ruleFrom(row) {
    return { origin: row.dataset.origin, enabled: row.querySelector('[data-rule="enabled"]').checked,
        concurrency: Number(row.querySelector('[data-rule="concurrency"]').value),
        rpm: Number(row.querySelector('[data-rule="rpm"]').value), smooth: row.querySelector('[data-rule="smooth"]').checked };
}
function drawRules(rules) {
    fields.sites.replaceChildren();
    for (const rule of rules) {
        const row = document.createElement('div'); row.className = 'ttal-site'; row.dataset.origin = rule.origin;
        row.innerHTML = `<label class="ttal-check"><input type="checkbox" data-rule="enabled"><strong></strong></label>
            <div class="ttal-grid"><label>RPM（0 = 不限）<input type="number" class="text_pole" min="0" max="100000" data-rule="rpm"></label>
            <label>请求并发数<input type="number" class="text_pole" min="1" max="128" data-rule="concurrency"></label></div>
            <label class="ttal-check"><input type="checkbox" data-rule="smooth">均匀发送</label><p class="ttal-hint" data-site-status></p>`;
        row.querySelector('strong').textContent = rule.origin;
        for (const key of ['enabled','smooth']) row.querySelector(`[data-rule="${key}"]`).checked = rule[key];
        for (const key of ['rpm','concurrency']) row.querySelector(`[data-rule="${key}"]`).value = rule[key];
        fields.sites.append(row);
    }
}
function renderCounters(status) {
    fields.status.textContent = `服务在线 · 按站点计数 · 请求中 ${status.active} · 排队 ${status.queued}`;
    fields.status.classList.remove('ttal-error');
    for (const row of fields.sites.querySelectorAll('[data-origin]')) {
        const site = status.sites.find(x => x.origin === row.dataset.origin);
        row.querySelector('[data-site-status]').textContent = site?.enabled
            ? `最近 60 秒 ${site.requestsLastMinute} 次 · 请求中 ${site.active} · 排队 ${site.queued}` : '未启用此站点的限流';
    }
}
async function refresh() { currentStatus = await relay('/api/status'); renderCounters(currentStatus); }
async function refreshProfiles() {
    const { profiles } = await api.agent.profiles.list();
    const selected = fields.profile.value; fields.profile.replaceChildren();
    for (const profile of profiles) {
        const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.displayName || profile.id; fields.profile.append(option);
    }
    if ([...fields.profile.options].some(x => x.value === selected)) fields.profile.value = selected;
    if (fields.profile.value) fields.children.value = (await api.agent.profiles.load(fields.profile.value)).profile.delegation.maxConcurrentInvocations;
}
async function syncSavedModels() {
    const cm = ctx.extensionSettings.connectionManager ||= { profiles: [], modelTargets: [] };
    const targets = cm.modelTargets ||= [];
    let count = 0;
    for (const source of sourceList()) {
        try {
            const target = originalTarget(source);
            await api.llmConnections.save(targetConnection(target));
            if (!targets.some(x => x.id === target.id)) { targets.push(target); count++; }
        } catch (error) { if (source.api?.startsWith('custom')) throw error; }
    }
    ctx.saveSettingsDebounced();
    return count;
}
async function migrateLegacy() {
    if (saved.siteMigrationDone) return;
    const cm = ctx.extensionSettings.connectionManager;
    const oldTargets = (cm?.modelTargets || []).filter(x => x.id.startsWith('ttlim-'));
    saved.legacyBackup ||= { bindings: structuredClone(saved.bindings || {}), modelTargets: structuredClone(oldTargets) };
    await persist();
    const { profiles } = await api.agent.profiles.list();
    const referenced = new Set();
    let activeChanged = false;
    for (const item of profiles) {
        if (item.id === 'default-writer') continue;
        const { profile } = await api.agent.profiles.load(item.id);
        if (!profile.model.connectionRef?.startsWith('model-target-ttlim-')) continue;
        const backup = saved.bindings?.[profile.id];
        if (backup && profile.model.connectionRef === backup.managedRef) {
            profile.model = structuredClone(backup.model);
            if (profile.delegation.maxConcurrentInvocations === backup.managedChildCount) profile.delegation.maxConcurrentInvocations = backup.childCount;
        } else {
            const old = oldTargets.find(x => 'model-target-' + x.id === profile.model.connectionRef);
            const source = sourceList().find(x => old?.id.endsWith('-' + String(x.id).toLowerCase()));
            if (!source) { referenced.add(profile.model.connectionRef); continue; }
            profile.model = { ...bindingFor(originalTarget(source)), modelId: profile.model.modelId };
        }
        await api.agent.profiles.save(profile);
        // Return an untouched generated writer to the original active Profile.
        if (profile.id === 'ttlim-writer' && backup?.created) {
            const { profile: builtin } = await api.agent.profiles.load('default-writer');
            const compare = p => JSON.stringify(Object.fromEntries(
                Object.entries(p).filter(([k]) => !['id','displayName','sourceTrace'].includes(k))
                    .sort(([a],[b]) => a.localeCompare(b))));
            if (compare(profile) === compare(builtin)) {
                const active = await api.extension.store.tryGetJson({ namespace: 'agent-system', key: 'settings' });
                if (active.value?.activeProfileId === profile.id) {
                    await api.extension.store.updateJson({ namespace: 'agent-system', key: 'settings', value: {
                        activeProfileId: saved.activeBefore || 'default-writer', editingProfileId: saved.activeBefore || 'default-writer' } });
                    activeChanged = true;
                }
            }
        }
    }
    if (cm) { cm.modelTargets = cm.modelTargets.filter(x => !x.id.startsWith('ttlim-') || referenced.has('model-target-' + x.id)); ctx.saveSettingsDebounced(); }
    saved.siteMigrationDone = true; saved.activeReloadNeeded = activeChanged; await persist();
}
async function guarded(action) {
    if (busy) return; busy = true;
    const buttons = [...panel.querySelectorAll('button')]; buttons.forEach(x => x.disabled = true);
    try { await action(); } catch (error) { message(error.message, true); }
    finally { buttons.forEach(x => x.disabled = false); busy = false; }
}
function mount(container) {
    panel = document.createElement('div'); panel.id = 'tt-agent-limiter'; panel.className = 'ttal-panel';
    panel.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>Agent 站点限流</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content">
        <p data-field="status">连接本机服务…</p><p class="ttal-hint">保持原来的模型选择。同一站点的不同模型、主 Agent、子 Agent 和重试共用额度；各站点独立计数。</p>
        <div data-field="sites"></div>
        <label>添加站点<input class="text_pole" data-field="newSite" placeholder="https://api.example.com"></label>
        <div class="ttal-buttons"><button class="menu_button" data-action="add">添加</button><button class="menu_button" data-action="discover">发现已保存连接中的站点</button>
        <button class="menu_button" data-action="save">保存站点规则</button><button class="menu_button" data-action="refresh">刷新状态</button></div>
        <p class="ttal-hint">站点按协议、域名和端口区分；同一站点的不同 API 路径合并计数。关闭站点规则后恢复直连，已发送的请求继续完成。</p>
        <details><summary>子 Agent 数量与模型列表</summary><label>主 Agent<select class="text_pole" data-field="profile"></select></label>
        <label>子 Agent 并发上限<input class="text_pole" data-field="children" type="number" min="1" max="128" value="3"></label>
        <button class="menu_button" data-action="children">保存子 Agent 上限</button><button class="menu_button" data-action="sync">同步已保存模型</button>
        <p class="ttal-hint">同步会把普通 API 连接加入 Agent 模型列表，使用原名称，不添加“限流”前缀。</p></details>
        <button class="menu_button" data-action="reload">重新加载 TT 界面</button><p data-field="message" role="status" aria-live="polite"></p></div></div>`;
    for (const field of panel.querySelectorAll('[data-field]')) fields[field.dataset.field] = field;
    container.append(panel);
    fields.profile.addEventListener('change', () => guarded(async () => {
        fields.children.value = (await api.agent.profiles.load(fields.profile.value)).profile.delegation.maxConcurrentInvocations;
    }));
    for (const button of panel.querySelectorAll('[data-action]')) button.addEventListener('click', () => guarded(async () => {
        const action = button.dataset.action;
        if (action === 'save') {
            await router.configure([...fields.sites.children].map(ruleFrom)); await refresh(); message('站点规则已保存，后续 Agent 请求自动应用。');
        } else if (action === 'refresh') { await refresh(); message('已刷新。'); }
        else if (action === 'add' || action === 'discover') {
            const rules = [...fields.sites.children].map(ruleFrom);
            const origins = action === 'discover' ? discoveredSites() : [new URL(fields.newSite.value.includes('://') ? fields.newSite.value : 'https://' + fields.newSite.value).origin];
            for (const origin of origins) if (!rules.some(x => x.origin === origin)) rules.push({ origin, enabled: true, concurrency: 2, rpm: 30, smooth: true });
            drawRules(rules); message('已添加，请保存站点规则。');
        } else if (action === 'sync') { const count = await syncSavedModels(); message(`新增 ${count} 个模型，使用原连接名称。`); }
        else if (action === 'reload') location.reload();
        else if (action === 'children') {
            const count = Number(fields.children.value);
            if (!Number.isInteger(count) || count < 1 || count > 128) throw new Error('子 Agent 上限必须为 1–128 的整数');
            let { profile } = await api.agent.profiles.load(fields.profile.value);
            if (profile.id === 'default-writer') profile = profileCopy(profile);
            profile.delegation.maxConcurrentInvocations = count;
            profile.delegation.maxInvocationsPerRun = Math.max(profile.delegation.maxInvocationsPerRun,count);
            await api.agent.profiles.save(profile); await refreshProfiles(); fields.profile.value = profile.id;
            message('子 Agent 上限已保存。内置配置会创建可编辑副本，可在 Agent System 中选择。');
        }
    }));
}
async function main() {
    const host = window.__TAURITAVERN__; if (!host) return;
    await (host.ready ?? window.__TAURITAVERN_MAIN_READY__); api = host.api; ctx = window.SillyTavern.getContext();
    config = await (await fetch(new URL('./client-config.json', import.meta.url), { cache: 'no-store' })).json();
    saved = (await api.extension.store.tryGetJson({ namespace: NS, key: 'settings' })).value || {};
    // A new page has already read the active Profile saved during the previous migration.
    if (saved.siteMigrationDone && saved.activeReloadNeeded) { saved.activeReloadNeeded = false; await persist(); }
    router = new SiteRouter({ api, relay, saved, persist }); router.install();
    if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, {once:true}));
    const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!container) throw new Error('未找到扩展设置容器'); mount(container);
    drawRules(router.rules); await refreshProfiles();
    try {
        currentStatus = await relay('/api/status');
        if (currentStatus.version !== '0.2.0') throw new Error('请先重新启动本机限流服务，升级至 0.2.0');
        router.routes = [...router.routes, ...currentStatus.routes.filter(x => !router.routes.some(y=>y.id===x.id))];
        const rules = saved.siteRules || (currentStatus.siteMode ? currentStatus.sites.map(({origin,enabled,concurrency,rpm,smooth})=>({origin,enabled,concurrency,rpm,smooth}))
            : discoveredSites().map(origin => ({ origin, enabled:true, ...currentStatus.limits })));
        await router.configure(rules);
        await syncSavedModels(); await migrateLegacy();
        drawRules(router.rules); await refreshProfiles(); await refresh();
        message(saved.activeReloadNeeded ? '已改为按站点自动限流，旧模型选择已还原。请再重新加载一次界面。' : '站点自动限流已启用，继续选择原来的模型即可。');
    } catch (error) { fields.status.textContent = '本机限流服务未就绪'; fields.status.classList.add('ttal-error'); message(error.message,true); }
    let polling = false;
    setInterval(async () => {
        if (polling || busy || document.hidden || !panel.querySelector('.inline-drawer-content').getClientRects().length) return;
        polling = true; try { await refresh(); } catch { fields.status.textContent = '限流服务未连接'; fields.status.classList.add('ttal-error'); } finally { polling = false; }
    }, 3000);
}
main().catch(error => { console.error('[TT Site Limiter]',error); window.toastr?.error?.(`Agent 站点限流：${error.message}`); });
