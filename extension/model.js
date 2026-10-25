const FORMATS = {
    custom: 'openai_compat', custom_openai_responses: 'openai_responses',
    custom_claude_messages: 'claude_messages', custom_gemini_generate_content: 'gemini_generate_content',
    custom_gemini_interactions: 'gemini_interactions',
};
const VALID_FORMATS = new Set(Object.values(FORMATS));
export function sourceModel(source) {
    if (source.mode !== 'cc' || !Object.hasOwn(FORMATS, source.api)) {
        throw new Error('此版本支持自定义 API 连接（OpenAI / Responses / Claude / Gemini 格式）。请先在 API 连接管理中保存为自定义连接。');
    }
    const upstream = String(source['api-url'] || '').trim().replace(/\/+$/, '');
    const u = new URL(upstream);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
        throw new Error('连接的 Base URL 无效');
    }
    const model = String(source.model || '').trim();
    if (!model) throw new Error('连接没有模型名称');
    const format = source['custom-api-format'] || FORMATS[source.api];
    if (!VALID_FORMATS.has(format)) throw new Error('不支持的 API 格式');
    const hints = structuredClone(source.adapterHints || {});
    if (hints.openaiResponsesMode === 'websocket' || source.custom_openai_responses_websocket) {
        throw new Error('请先关闭此连接的 Responses WebSocket，限流服务支持 HTTP 与 SSE');
    }
    if (source['prompt-post-processing']) hints.promptPostProcessing = source['prompt-post-processing'];
    if (source.proxy && source.proxy !== 'None') {
        throw new Error('此连接还绑定了反代预设；请先保存直接填写最终上游 Base URL 的自定义连接，避免改变反代认证。');
    }
    const secretRef = source.secretRef || (source['secret-id'] ? { key: 'api_key_custom', id: source['secret-id'] } : null);
    return { upstream, model, format, hints, secretRef };
}
export function managedTarget(source, route) {
    const parsed = sourceModel(source);
    const sourceId = String(source.id || 'saved').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 60);
    return {
        schemaVersion: 1, kind: 'tauritavern.modelTarget', mode: 'cc',
        id: `ttlim-${route.id}-${sourceId}`,
        name: `限流 · ${source.name || parsed.model}`, api: source.api,
        model: parsed.model, 'custom-api-format': parsed.format,
        'api-url': route.proxyBaseUrl,
        ...(parsed.secretRef ? { secretRef: structuredClone(parsed.secretRef) } : {}),
        adapterHints: parsed.hints,
    };
}
export function targetConnection(target) {
    return {
        schemaVersion: 1, kind: 'tauritavern.llmConnection', id: `model-target-${target.id}`,
        displayName: target.name, description: 'TT Agent Limiter managed connection',
        provider: { chatCompletionSource: 'custom', customApiFormat: target['custom-api-format'] },
        endpoint: { baseUrl: target['api-url'], sourceSpecific: {} },
        auth: target.secretRef ? { secretRef: structuredClone(target.secretRef) } : {},
        routing: {}, adapterHints: structuredClone(target.adapterHints || {}), capabilities: {},
    };
}
export function bindingFor(target) {
    return { mode: 'connectionRef', connectionRef: `model-target-${target.id}`, modelId: target.model };
}
export function originalTarget(source) {
    if (source.kind === 'tauritavern.modelTarget') return structuredClone(source);
    const parsed = sourceModel(source);
    const id = String(source.id || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id) throw new Error('连接缺少稳定 ID');
    return { schemaVersion: 1, kind: 'tauritavern.modelTarget', mode: 'cc', id,
        name: source.name || parsed.model, api: source.api, model: parsed.model,
        'api-url': parsed.upstream, 'custom-api-format': parsed.format,
        ...(parsed.secretRef ? { secretRef: structuredClone(parsed.secretRef) } : {}), adapterHints: parsed.hints };
}
export function profileCopy(profile, id = `ttlim-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`) {
    const copy = structuredClone(profile);
    copy.id = id;
    copy.displayName = `${profile.displayName || profile.id} · 限流`;
    delete copy.sourceTrace;
    return copy;
}
