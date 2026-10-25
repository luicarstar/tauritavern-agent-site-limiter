// TT's Agent APIs share these method objects with the host prompt-assembly bridge.
// Rewrite connection snapshots, never model ids, names, chat settings or prompts.
export class SiteRouter {
    constructor({ api, relay, saved, persist }) {
        this.api = api; this.relay = relay; this.saved = saved; this.persist = persist;
        this.rules = saved.siteRules || [];
        this.routes = saved.routeIndex || [];
        this.pending = new Map();
        this.rawSave = api.llmConnections.save.bind(api.llmConnections);
        saved.nativeOriginals ||= {};
    }
    hasRule(value) {
        try { const origin = new URL(this.unwrap(value)).origin; return this.rules.some(x => x.enabled && x.origin === origin); }
        catch { return false; }
    }
    unwrap(value) {
        const normalized = String(value || '').replace(/\/+$/, '');
        return this.routes.find(x => x.proxyBaseUrl === normalized)?.upstream || normalized;
    }
    async routeUrl(value, format = 'openai_compat', websocket = false) {
        const upstream = this.unwrap(value);
        if (!this.hasRule(upstream)) return upstream;
        if (websocket) throw new Error('此站点已限流；请关闭 Responses WebSocket 后使用 HTTP/SSE');
        let route = this.routes.find(x => x.upstream === upstream && x.format === format);
        if (!route) {
            const key = upstream + '|' + format;
            if (!this.pending.has(key)) {
                this.pending.set(key, (async () => {
                    const created = await this.relay('/api/routes', { upstream, format, name: new URL(upstream).host });
                    if (!this.routes.some(x => x.id === created.id)) this.routes.push(created);
                    this.saved.routeIndex = this.routes;
                    await this.persist();
                    return created;
                })().finally(() => this.pending.delete(key)));
            }
            route = await this.pending.get(key);
        }
        return route.proxyBaseUrl;
    }
    async settings(value) {
        if (!value || value.chat_completion_source !== 'custom' || !value.custom_url) return value;
        const result = { ...value };
        result.custom_url = await this.routeUrl(value.custom_url, value.custom_api_format || 'openai_compat', value.custom_openai_responses_websocket === true);
        return result;
    }
    async snapshot(value) {
        if (!value) return value;
        const result = { ...value };
        if (value.generationParameters) result.generationParameters = await this.settings(value.generationParameters);
        return result;
    }
    async frozen(value) {
        if (!value?.currentModelConnection?.settings) return value;
        return { ...value, currentModelConnection: { ...value.currentModelConnection,
            settings: await this.settings(value.currentModelConnection.settings) } };
    }
    async saveConnection(input) {
        const connection = structuredClone(input?.connection || input);
        if (connection.provider?.chatCompletionSource !== 'custom' || !connection.endpoint?.baseUrl) return this.rawSave(input);
        const originalUrl = this.unwrap(connection.endpoint.baseUrl);
        const original = { ...connection, endpoint: { ...connection.endpoint, baseUrl: originalUrl } };
        const routedUrl = await this.routeUrl(originalUrl, connection.provider.customApiFormat || 'openai_compat', connection.adapterHints?.openaiResponsesMode === 'websocket');
        if (routedUrl !== originalUrl || this.saved.nativeOriginals[connection.id]) {
            // Store the latest user-owned connection before replacing its transport URL.
            this.saved.nativeOriginals[connection.id] = original;
            await this.persist();
        }
        connection.endpoint.baseUrl = routedUrl;
        return this.rawSave(connection);
    }
    async reconcile() {
        const { connections } = await this.api.llmConnections.list();
        for (const summary of connections) {
            if (summary.id.startsWith('model-target-ttlim-')) continue;
            const { connection } = await this.api.llmConnections.load(summary.id);
            if (connection) await this.saveConnection(connection);
        }
    }
    async configure(rules) {
        const result = await this.relay('/api/sites', rules);
        this.rules = result.sites.map(({ origin, enabled, concurrency, rpm, smooth }) => ({ origin, enabled, concurrency, rpm, smooth }));
        this.routes = result.routes;
        this.saved.siteRules = this.rules; this.saved.routeIndex = this.routes;
        await this.persist();
        await this.reconcile();
        return result;
    }
    install() {
        if (this.api.llmConnections.save.__ttSiteLimiter) throw new Error('站点限流路由已安装');
        const replacement = input => this.saveConnection(input);
        replacement.__ttSiteLimiter = true;
        this.api.llmConnections.save = replacement;
        const assembly = this.api.agent.promptAssembly;
        for (const method of ['buildCurrentModelConnectionSnapshot','applyCurrentModelConnectionSnapshot','buildSnapshot']) {
            if (typeof assembly?.[method] !== 'function') throw new Error(`当前 TT 缺少 Agent 接口：${method}`);
        }
        const capture = assembly.buildCurrentModelConnectionSnapshot.bind(assembly);
        assembly.buildCurrentModelConnectionSnapshot = async input => capture({ ...input, settings: await this.settings(input.settings) });
        const apply = assembly.applyCurrentModelConnectionSnapshot.bind(assembly);
        assembly.applyCurrentModelConnectionSnapshot = async input => this.settings(await apply(input));
        const build = assembly.buildSnapshot.bind(assembly);
        assembly.buildSnapshot = async input => {
            const routed = { ...input };
            for (const key of ['settings','presetSettings','preset_settings']) if (input[key]) routed[key] = await this.settings(input[key]);
            const result = await build(routed);
            return { ...result, promptSnapshot: await this.snapshot(result.promptSnapshot),
                frozenRunInputSnapshot: await this.frozen(result.frozenRunInputSnapshot) };
        };
        if (typeof this.api.agent.startRunWithPromptSnapshot === 'function') {
            const start = this.api.agent.startRunWithPromptSnapshot.bind(this.api.agent);
            this.api.agent.startRunWithPromptSnapshot = async input => start({ ...input,
                promptSnapshot: await this.snapshot(input.promptSnapshot),
                ...(input.frozenRunInputSnapshot ? { frozenRunInputSnapshot: await this.frozen(input.frozenRunInputSnapshot) } : {}) });
        }
    }
}
