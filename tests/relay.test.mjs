import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRelay } from '../service/server.mjs';

const token = 'test-token-012345678901234567890123456789';
async function fixture(t, limits = { concurrency: 2, rpm: 0, smooth: false }, windowMs = 60000) {
    const seen = []; let active = 0, peak = 0;
    const upstream = http.createServer(async (req, res) => {
        const chunks = []; for await (const c of req) chunks.push(c);
        const data = JSON.parse(Buffer.concat(chunks));
        seen.push({ url: req.url, auth: req.headers.authorization, key: req.headers['x-goog-api-key'],
            anthropic: req.headers['x-api-key'], body: data, at: performance.now() });
        active++; peak = Math.max(peak, active);
        let closed = false;
        res.on('close', () => { if (!closed) { closed = true; active--; } });
        if (data.redirect) { res.writeHead(302, { location: 'https://other.invalid/steal' }); res.end(); return; }
        if (data.fail) { res.writeHead(429, { 'retry-after': '3' }); res.end('{"error":{"message":"limited"}}'); return; }
        res.writeHead(200, { 'content-type': data.stream ? 'text/event-stream' : 'application/json' });
        res.flushHeaders();
        if (data.stream) res.write('data: {"part":1}\n\n');
        setTimeout(() => { if (!res.destroyed) res.end(data.stream ? 'data: [DONE]\n\n' : '{"ok":true}'); }, data.delay || 20);
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const relay = createRelay({ state: { adminToken: token, limits, routes: [] }, windowMs });
    const origin = await relay.listen(0);
    t.after(async () => { await relay.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); });
    const admin = async (p, data) => {
        const r = await fetch(origin+p, { method: data === undefined ? 'GET':'POST',
            headers: { 'x-tt-limiter-token': token, 'content-type':'application/json' },
            ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
        assert.equal(r.status, 200, await r.clone().text()); return r.json();
    };
    const route = await admin('/api/routes', { name: 'test', upstream: `http://127.0.0.1:${upstream.address().port}/v1`, format: 'openai_compat' });
    const call = (data = {}, suffix = '/chat/completions', signal) => fetch(route.proxyBaseUrl+suffix, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-secret',
            'x-goog-api-key': 'fixture-gemini', 'x-api-key': 'fixture-claude' },
        body: JSON.stringify(data), signal,
    });
    return { relay, origin, admin, route, call, seen, peak: () => peak };
}
test('actual upstream concurrency is bounded until SSE finishes; auth/body preserved', async t => {
    const f = await fixture(t, { concurrency: 1, rpm: 0, smooth: false });
    const first = await f.call({ stream: true, delay: 120, model: 'model-a', tools: [{type:'function'}] });
    const reader = first.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /part/);
    const second = f.call({ model: 'model-b' });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(f.seen.length, 1);
    while (!(await reader.read()).done) {}
    await (await second).text();
    assert.equal(f.peak(), 1); assert.equal(f.seen.length, 2);
    assert.equal(f.seen[0].auth, 'Bearer fixture-secret');
    assert.deepEqual(f.seen[0].body.tools, [{type:'function'}]);
});
test('strict RPM across multiple models/routes; no built-in retry', async t => {
    const f = await fixture(t, { concurrency: 4, rpm: 2, smooth: false }, 150);
    await Promise.all([f.call({model:'a'}).then(r=>r.text()), f.call({model:'b'}).then(r=>r.text()), f.call({fail:true}).then(r=>r.text())]);
    assert.equal(f.seen.length, 3);
    assert.ok(f.seen[2].at - f.seen[0].at >= 140);
    assert.equal(f.relay.status().totalSinceStart, 3);
});
test('queued and in-flight cancellation release capacity without sending queued work', async t => {
    const f = await fixture(t, { concurrency: 1, rpm: 0, smooth: false });
    const running = new AbortController();
    const first = await f.call({stream:true,delay:1500}, '/chat/completions', running.signal);
    const queue = new AbortController();
    const pending = assert.rejects(f.call({model:'cancel-me'}, '/chat/completions', queue.signal));
    await new Promise(r=>setTimeout(r,20)); queue.abort(); await pending;
    running.abort(); await assert.rejects(first.text());
    await (await f.call({model:'after-cancel'})).text();
    assert.deepEqual(f.seen.map(x=>x.body.model), [undefined,'after-cancel']);
});
test('admin authentication, browser origin, route tokens, path and redirects', async t => {
    const f = await fixture(t);
    assert.equal((await fetch(f.origin+'/api/status')).status, 401);
    assert.equal((await fetch(f.origin+'/api/status', {headers:{origin:'https://evil.invalid','x-tt-limiter-token':token}})).status, 403);
    const cors = await fetch(f.origin+'/api/status',{headers:{origin:'http://tauri.localhost','x-tt-limiter-token':token}});
    assert.equal(cors.headers.get('access-control-allow-origin'), 'http://tauri.localhost');
    assert.equal((await fetch(f.route.proxyBaseUrl+'/not-a-model',{method:'POST',body:'{}'})).status,400);
    assert.equal((await fetch(f.origin+'/r/bad/bad/v1/chat/completions',{method:'POST',body:'{}'})).status,404);
    const redirect = await f.call({redirect:true}); assert.equal(redirect.status,502);
    assert.equal(redirect.headers.get('location'),null);
});
test('Claude, Responses and Gemini URL/query plus headers stay intact', async t => {
    const f = await fixture(t);
    for (const suffix of ['/messages','/responses','/models/gemini-3:generateContent?alt=sse','/interactions']) {
        const response = await f.call({model:'native',contents:[{parts:[{text:'hi'}]}]},suffix);
        assert.equal(response.status,200); await response.text();
    }
    assert.equal(f.seen[2].url,'/v1/models/gemini-3:generateContent?alt=sse');
    assert.equal(f.seen[2].key,'fixture-gemini'); assert.equal(f.seen[0].anthropic,'fixture-claude');
});
test('site quotas combine paths/models/formats and separate different origins', async t => {
    const f=await fixture(t, {concurrency:5,rpm:0,smooth:false},200);
    const primaryOrigin=new URL(f.route.upstream).origin;
    const second=http.createServer((_req,res)=>{res.writeHead(200);res.end('{"ok":true}');});
    second.listen(0,'127.0.0.1');await once(second,'listening');
    t.after(async()=>{second.closeAllConnections();await new Promise(r=>second.close(r));});
    const otherOrigin=`http://127.0.0.1:${second.address().port}`;
    await f.admin('/api/sites',[
        {origin:primaryOrigin,enabled:true,concurrency:1,rpm:1,smooth:false},
        {origin:otherOrigin,enabled:true,concurrency:1,rpm:1,smooth:false},
    ]);
    const sameSite=await f.admin('/api/routes',{name:'same-site-other-path',upstream:primaryOrigin+'/v2',format:'claude_messages'});
    const otherSite=await f.admin('/api/routes',{name:'other-site',upstream:otherOrigin+'/v1',format:'openai_compat'});
    const post=url=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{"model":"different-model"}'}).then(r=>r.text());
    await (await f.call({model:'first'})).text();
    const start=performance.now();let sameFinished=false;
    const pending=post(sameSite.proxyBaseUrl+'/messages').then(()=>{sameFinished=true;});
    await post(otherSite.proxyBaseUrl+'/chat/completions');
    assert.equal(sameFinished,false);assert.ok(performance.now()-start<150);
    await pending;
    assert.ok(f.seen[1].at-f.seen[0].at>=190);
    const status=await f.admin('/api/status');assert.equal(status.sites.length,2);
    assert.equal(status.sites.find(x=>x.origin===primaryOrigin).totalSinceStart,2);
    assert.equal(status.sites.find(x=>x.origin===otherOrigin).totalSinceStart,1);
});
