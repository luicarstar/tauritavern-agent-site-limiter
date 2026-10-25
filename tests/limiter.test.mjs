import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestLimiter } from '../service/limiter.mjs';

function clock() {
    let time = 0, seq = 0;
    const timers = new Map();
    return {
        now: () => time,
        schedule: (fn, delay) => { const id = ++seq; timers.set(id, { at: time + delay, fn }); return id; },
        unschedule: id => timers.delete(id),
        tick(ms) {
            const end = time + ms;
            while (true) {
                const next = [...timers.entries()].filter(([,t]) => t.at <= end).sort((a,b) => a[1].at-b[1].at)[0];
                if (!next) break;
                time = next[1].at; timers.delete(next[0]); next[1].fn();
            }
            time = end;
        },
    };
}
test('FIFO concurrency, idempotent release, queued cancellation and no phantom RPM', async () => {
    const c = clock(), q = new RequestLimiter({ concurrency: 1, rpm: 0, smooth: false }, c);
    const release = await q.acquire();
    const cancel = new AbortController();
    const cancelled = q.acquire(cancel.signal);
    const rejected = assert.rejects(cancelled, { name: 'AbortError' });
    const next = q.acquire();
    assert.equal(q.snapshot().queued, 2);
    cancel.abort(); await rejected;
    release(); release();
    const done = await next;
    assert.equal(q.snapshot().active, 1);
    assert.equal(q.snapshot().requestsLastMinute, 2);
    done(); q.close();
});
test('strict rolling window including changing RPM while requests are queued', async () => {
    const c = clock(), q = new RequestLimiter({ concurrency: 8, rpm: 3, smooth: false }, c);
    (await q.acquire())(); c.tick(1000); (await q.acquire())(); c.tick(1000); (await q.acquire())();
    q.configure({ concurrency: 8, rpm: 1, smooth: false });
    let sent = false;
    const waiting = q.acquire().then(x => { sent = true; return x; });
    c.tick(58000); await Promise.resolve(); assert.equal(sent, false);
    c.tick(2000); const release = await waiting;
    assert.equal(sent, true); assert.equal(q.snapshot().requestsLastMinute, 1);
    release(); q.close();
});
test('smooth pacing, live limit increase and accounting when RPM is disabled', async () => {
    const c = clock(), q = new RequestLimiter({ concurrency: 3, rpm: 2, smooth: true }, c);
    (await q.acquire())();
    let sent = false;
    const p = q.acquire().then(x => { sent = true; return x; });
    c.tick(29999); await Promise.resolve(); assert.equal(sent, false);
    c.tick(1); (await p)();
    q.configure({ concurrency: 3, rpm: 0, smooth: true });
    (await q.acquire())();
    q.configure({ concurrency: 3, rpm: 2, smooth: false });
    assert.equal(q.snapshot().requestsLastMinute, 3);
    q.close();
});
test('queue timeout and close reject pending calls and clean the queue', async () => {
    const c = clock(), q = new RequestLimiter({ concurrency: 1, rpm: 0, smooth: false }, { ...c, maxWaitMs: 100 });
    const release = await q.acquire();
    const waiting = assert.rejects(q.acquire(), /排队超时/);
    c.tick(100); await waiting;
    const closed = assert.rejects(q.acquire(), { name: 'AbortError' });
    q.close(); await closed; release();
    assert.equal(q.snapshot().active, 0);
});
