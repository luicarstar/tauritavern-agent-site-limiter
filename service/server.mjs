import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { RequestLimiter, DEFAULT_LIMITS, validateLimits } from './limiter.mjs';

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
    'origin', 'referer', 'cookie', 'set-cookie', 'x-tt-limiter-token']);
const FORMATS = new Set(['openai_compat', 'openai_responses', 'claude_messages',
    'gemini_generate_content', 'gemini_interactions']);
const ALLOWED_ORIGINS = new Set(['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost']);

function equal(a, b) {
    const aa = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
export function normalizeUpstream(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('上游地址必须是无账号、查询参数和片段的 HTTP(S) Base URL');
    }
    return url.href.replace(/\/+$/, '');
}
export function validateSiteRules(input) {
    if (!Array.isArray(input) || input.length > 200) throw new Error('站点规则必须是数组，最多 200 项');
    const seen = new Set();
    return input.map(rule => {
        const origin = new URL(normalizeUpstream(rule.origin)).origin;
        if (seen.has(origin)) throw new Error('同一站点只能有一条规则');
        seen.add(origin);
        if (typeof rule.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
        return { origin, enabled: rule.enabled, ...validateLimits(rule) };
    });
}
function cleanHeaders(headers) {
    const blocked = new Set(HOP_HEADERS);
    String(headers.connection || '').split(',').forEach(x => blocked.add(x.trim().toLowerCase()));
    return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}
async function body(req, limit) {
    const buffers = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) { const e = new Error('请求体过大'); e.status = 413; throw e; }
        buffers.push(chunk);
    }
    return Buffer.concat(buffers);
}
function json(res, status, value) {
    if (res.destroyed || res.writableEnded) return;
    const bytes = Buffer.from(JSON.stringify(value));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'content-length': bytes.length, 'cache-control': 'no-store' });
    res.end(bytes);
}
export function saveState(file, state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
}
export function createRelay({ state, stateFile, windowMs = 60000 } = {}) {
    if (!state || typeof state.adminToken !== 'string' || state.adminToken.length < 32) throw new Error('Invalid admin token');
    state.limits = validateLimits(state.limits || DEFAULT_LIMITS);
    state.routes ||= [];
    const epochOffset = Date.now() - performance.now();
    const persist = () => { if (stateFile) saveState(stateFile, state); };
    const limiter = new RequestLimiter(state.limits, { windowMs,
        history: (state.recentStarts || []).map(t => t - epochOffset),
        onStart: starts => {
            state.recentStarts = starts.map(t => t + epochOffset);
            // Small accounting journal contains timestamps only, never payloads or keys.
            persist();
        },
    });
    if (state.siteRules !== undefined) state.siteRules = validateSiteRules(state.siteRules);
    state.siteStarts ||= {};
    const siteLimiters = new Map();
    const noLimits = { concurrency: 128, rpm: 0, smooth: false };
    function siteLimiter(site) {
        const rule = state.siteRules?.find(r => r.origin === site && r.enabled);
        if (!siteLimiters.has(site)) {
            siteLimiters.set(site, new RequestLimiter(rule || noLimits, { windowMs,
                history: (state.siteStarts[site] || []).map(t => t - epochOffset),
                onStart: starts => { state.siteStarts[site] = starts.map(t => t + epochOffset); persist(); },
            }));
        }
        return siteLimiters.get(site);
    }
    function siteViews() {
        return (state.siteRules || []).map(rule => ({ ...rule, ...siteLimiter(rule.origin).snapshot() }));
    }
    let origin;
    const controllers = new Set();
    const routeView = route => ({ id: route.id, name: route.name, upstream: route.upstream,
        format: route.format, proxyBaseUrl: `${origin}/r/${route.id}/${route.token}${new URL(route.upstream).pathname.replace(/\/+$/, '')}` });
    const status = () => {
        const all = [limiter.snapshot(), ...[...siteLimiters.values()].map(x => x.snapshot())];
        return { service: 'tt-agent-limiter', version: '0.2.0', pid: process.pid,
            ...limiter.snapshot(),
            ...Object.fromEntries(['active','queued','requestsLastMinute','totalSinceStart'].map(key => [key,all.reduce((n,x)=>n+x[key],0)])),
            siteMode: state.siteRules !== undefined, sites: siteViews(), routes: state.routes.map(routeView) };
    };

    async function handler(req, res) {
        const allowedHosts = new Set([`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`]);
        if (!allowedHosts.has(req.headers.host)) return json(res, 403, { error: { message: 'Invalid Host' } });
        const browserOrigin = req.headers.origin;
        if (browserOrigin && !ALLOWED_ORIGINS.has(browserOrigin) && browserOrigin !== origin) {
            return json(res, 403, { error: { message: 'Origin denied' } });
        }
        if (browserOrigin) {
            res.setHeader('access-control-allow-origin', browserOrigin);
            res.setHeader('vary', 'Origin');
            res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
            res.setHeader('access-control-allow-headers', 'content-type, x-tt-limiter-token');
            res.setHeader('access-control-allow-private-network', 'true');
        }
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        const url = new URL(req.url, origin);
        if (url.pathname === '/health' && req.method === 'GET') {
            return json(res, 200, { service: 'tt-agent-limiter', version: '0.2.0' });
        }
        if (url.pathname.startsWith('/api/')) {
            if (!equal(req.headers['x-tt-limiter-token'], state.adminToken)) return json(res, 401, { error: { message: 'Unauthorized' } });
            if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, status());
            if (req.method === 'POST' && url.pathname === '/api/sites') {
                const rules = validateSiteRules(JSON.parse((await body(req, 65536)).toString()));
                const previous = state.siteRules;
                state.siteRules = rules;
                try { persist(); } catch (error) { state.siteRules = previous; throw error; }
                for (const [site, bucket] of siteLimiters) {
                    const rule = rules.find(r => r.origin === site && r.enabled);
                    bucket.configure(rule || noLimits);
                }
                for (const rule of rules) siteLimiter(rule.origin);
                return json(res, 200, status());
            }
            if (req.method === 'POST' && url.pathname === '/api/limits') {
                const limits = validateLimits(JSON.parse((await body(req, 4096)).toString()));
                const previous = state.limits;
                state.limits = limits;
                try { persist(); } catch (error) { state.limits = previous; throw error; }
                limiter.configure(limits);
                return json(res, 200, status());
            }
            if (req.method === 'POST' && url.pathname === '/api/routes') {
                const input = JSON.parse((await body(req, 16384)).toString());
                const upstream = normalizeUpstream(input.upstream);
                const u = new URL(upstream);
                if (u.hostname === '127.0.0.1' && Number(u.port) === server.address().port) throw new Error('不能将限流服务自身设为上游');
                if (!FORMATS.has(input.format)) throw new Error('不支持的 API 格式');
                let route = state.routes.find(r => r.upstream === upstream && r.format === input.format);
                if (!route) {
                    if (state.routes.length >= 200) throw new Error('路由数量已达上限');
                    route = { id: crypto.randomBytes(8).toString('hex'), token: crypto.randomBytes(24).toString('hex'),
                        name: String(input.name || u.host).slice(0, 160), upstream, format: input.format };
                    state.routes.push(route);
                    try { persist(); } catch (error) { state.routes.pop(); throw error; }
                }
                return json(res, 200, routeView(route));
            }
            return json(res, 404, { error: { message: 'Unknown API' } });
        }
        const match = /^\/r\/([a-f0-9]+)\/([a-f0-9]+)(\/.*)?$/.exec(url.pathname);
        const route = match && state.routes.find(r => r.id === match[1] && equal(r.token, match[2]));
        if (!route) return json(res, 404, { error: { message: 'Unknown route' } });
        if (req.method !== 'POST') return json(res, 405, { error: { message: 'Only model POST requests are supported' } });
        const tail = match[3] || '/';
        const upstream = new URL(route.upstream);
        const basePath = upstream.pathname.replace(/\/+$/, '');
        if (!tail.startsWith(basePath + '/') || /%2f|%5c|%2e/i.test(tail) || tail.includes('\\')) {
            return json(res, 400, { error: { message: 'Invalid upstream path' } });
        }
        const suffix = tail.slice(basePath.length);
        if (!/^\/(chat\/completions|responses|messages|(?:v1(?:beta)?\/)?(?:models\/[^/]+:(?:streamGenerateContent|generateContent)|interactions))$/.test(suffix)) {
            return json(res, 400, { error: { message: 'Unsupported model endpoint' } });
        }
        const controller = new AbortController();
        controllers.add(controller);
        const cancel = () => { if (!res.writableFinished) controller.abort(); };
        req.on('aborted', cancel);
        res.on('close', cancel);
        let release;
        try {
            const bytes = await body(req, 64 * 1024 * 1024);
            const bucket = state.siteRules === undefined ? limiter : siteLimiter(upstream.origin);
            release = await bucket.acquire(controller.signal);
            if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
            const destination = new URL(upstream.origin + tail + url.search);
            const headers = cleanHeaders(req.headers);
            headers['content-length'] = bytes.length;
            headers['accept-encoding'] = 'identity';
            await new Promise((resolve, reject) => {
                const transport = destination.protocol === 'https:' ? https : http;
                const outgoing = transport.request(destination, { method: 'POST', headers, signal: controller.signal }, response => {
                    // Reject redirects rather than passing Location to TT's HTTP client.
                    if (response.statusCode >= 300 && response.statusCode < 400) {
                        response.resume();
                        reject(new Error('上游返回重定向，请在连接中填写最终 Base URL'));
                        return;
                    }
                    res.writeHead(response.statusCode, cleanHeaders(response.headers));
                    res.flushHeaders();
                    pipeline(response, res).then(resolve, reject);
                });
                outgoing.setTimeout(10 * 60000, () => outgoing.destroy(new Error('上游连接空闲超时')));
                outgoing.on('error', reject);
                outgoing.end(bytes);
            });
        } catch (error) {
            if (error.name !== 'AbortError' && !res.headersSent) {
                json(res, error.status || 502, { error: { message: `TT Agent 限流：${error.message}` } });
            } else if (!res.destroyed) res.destroy();
        } finally {
            release?.();
            controllers.delete(controller);
            req.off('aborted', cancel);
            res.off('close', cancel);
        }
    }
    const server = http.createServer((req, res) => {
        handler(req, res).catch(error => {
            if (!res.headersSent) json(res, error.status || 400, { error: { message: error.message } });
            else res.destroy();
        });
    });
    server.requestTimeout = 120000;
    server.headersTimeout = 30000;
    server.on('upgrade', (_req, socket) => {
        socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n');
    });
    return { server, limiter, status, state,
        async listen(port = 19377) {
            await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
            origin = `http://127.0.0.1:${server.address().port}`;
            return origin;
        },
        async close() {
            limiter.close();
            for (const bucket of siteLimiters.values()) bucket.close();
            for (const c of controllers) c.abort();
            server.closeIdleConnections();
            const done = new Promise(resolve => server.close(resolve));
            server.closeAllConnections();
            await done;
        },
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const stateFile = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '../runtime/state.json'));
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''));
    const relay = createRelay({ state, stateFile });
    await relay.listen(state.port || 19377);
    console.log(`TT Agent Limiter 0.2.0 listening on 127.0.0.1:${relay.server.address().port}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await relay.close(); process.exit(0); });
}
