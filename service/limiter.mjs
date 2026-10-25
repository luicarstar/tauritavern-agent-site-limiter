export const DEFAULT_LIMITS = Object.freeze({ concurrency: 2, rpm: 30, smooth: true });

export function validateLimits(input) {
    const { concurrency, rpm, smooth } = input;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 128) {
        throw new Error('请求并发数必须是 1–128 的整数');
    }
    if (!Number.isInteger(rpm) || rpm < 0 || rpm > 100000) {
        throw new Error('RPM 必须是 0–100000 的整数，0 表示不限');
    }
    if (typeof smooth !== 'boolean') throw new Error('smooth 必须是布尔值');
    return { concurrency, rpm, smooth };
}

function aborted() { return new DOMException('Request cancelled', 'AbortError'); }

// A permit covers an HTTP request, including its streaming body, never an Agent run.
// Keeping permits for entire runs could deadlock a parent waiting for its children.
export class RequestLimiter {
    constructor(limits = DEFAULT_LIMITS, {
        windowMs = 60000,
        now = () => performance.now(),
        schedule = setTimeout,
        unschedule = clearTimeout,
        maxQueue = 512,
        maxWaitMs = 15 * 60000,
        history = [],
        onStart = () => {},
    } = {}) {
        this.limits = validateLimits(limits);
        this.windowMs = windowMs;
        this.now = now;
        this.schedule = schedule;
        this.unschedule = unschedule;
        this.maxQueue = maxQueue;
        this.maxWaitMs = maxWaitMs;
        this.onStart = onStart;
        this.active = 0;
        this.queue = [];
        this.starts = history.filter(t => Number.isFinite(t) && t > now() - windowMs);
        this.total = 0;
        this.timer = null;
        this.closed = false;
    }
    configure(limits) { this.limits = validateLimits(limits); this.pump(); }
    prune() {
        const cutoff = this.now() - this.windowMs;
        while (this.starts.length && this.starts[0] <= cutoff) this.starts.shift();
    }
    snapshot() {
        this.prune();
        return { limits: { ...this.limits }, active: this.active, queued: this.queue.length,
            requestsLastMinute: this.starts.length, totalSinceStart: this.total };
    }
    acquire(signal) {
        if (signal?.aborted || this.closed) return Promise.reject(aborted());
        if (this.queue.length >= this.maxQueue) return Promise.reject(new Error('限流队列已满'));
        return new Promise((resolve, reject) => {
            const item = { resolve, reject, signal, queuedAt: this.now(), cancel: null };
            item.cancel = () => {
                const index = this.queue.indexOf(item);
                if (index < 0) return;
                this.queue.splice(index, 1);
                signal?.removeEventListener('abort', item.cancel);
                reject(aborted());
                this.pump();
            };
            signal?.addEventListener('abort', item.cancel, { once: true });
            this.queue.push(item);
            this.pump();
        });
    }
    pump() {
        if (this.timer !== null) this.unschedule(this.timer);
        this.timer = null;
        if (this.closed) return;
        this.prune();
        while (this.queue.length) {
            const item = this.queue[0];
            const age = this.now() - item.queuedAt;
            if (age >= this.maxWaitMs || item.signal?.aborted) {
                this.queue.shift();
                item.signal?.removeEventListener('abort', item.cancel);
                item.reject(item.signal?.aborted ? aborted() : new Error('限流排队超时'));
                continue;
            }
            let wait = 0;
            const { concurrency, rpm, smooth } = this.limits;
            if (rpm > 0 && this.starts.length >= rpm) {
                // Correct even after a live reduction in RPM.
                wait = this.starts[this.starts.length - rpm] + this.windowMs - this.now();
            }
            if (rpm > 0 && smooth && this.starts.length) {
                wait = Math.max(wait, this.starts.at(-1) + this.windowMs / rpm - this.now());
            }
            if (this.active >= concurrency || wait > 0) {
                const delay = Math.min(this.maxWaitMs - age, wait > 0 ? wait : this.maxWaitMs);
                this.timer = this.schedule(() => this.pump(), Math.max(1, Math.ceil(delay)));
                this.timer?.unref?.();
                return;
            }
            this.queue.shift();
            item.signal?.removeEventListener('abort', item.cancel);
            this.active++;
            this.starts.push(this.now());
            this.total++;
            try { this.onStart([...this.starts]); } catch { /* diagnostics are outside scheduling */ }
            let released = false;
            item.resolve(() => {
                if (released) return;
                released = true;
                this.active--;
                this.pump();
            });
        }
    }
    close() {
        this.closed = true;
        if (this.timer !== null) this.unschedule(this.timer);
        this.timer = null;
        for (const item of this.queue.splice(0)) {
            item.signal?.removeEventListener('abort', item.cancel);
            item.reject(aborted());
        }
    }
}
