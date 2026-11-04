const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM } = require('jsdom');

const source = readFileSync(join(__dirname, '..', 'chatgpt-better-ui.user.js'), 'utf8');
const workForm = id => `<div id="${id}"><form data-thread-find-composer="true"><div contenteditable="true" role="textbox" data-composer-markdown=""><p>Draft</p></div><button type="submit" aria-label="Send">Send</button></form></div>`;
const windowData = (seconds, used = 20, reset = seconds) => ({
    limit_window_seconds: seconds, used_percent: used, reset_after_seconds: reset
});
const plus = (used = 20) => ({ rate_limit: {
    primary_window: windowData(18000, used), secondary_window: windowData(604800, used)
} });
const pro = (used = 20) => ({ rate_limit: {
    primary_window: windowData(604800, used), secondary_window: null
} });

function setup(t, { html = workForm('chat-a'), hidden = false, online = true } = {}) {
    const dom = new JSDOM(html, { url: 'https://chatgpt.com/c/test', runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    const { document } = window;
    const requests = [], timers = new Map();
    let now = 1800000000000, serial = 0;
    const stats = { documentScans: 0, layoutReads: 0, gaugeMutations: 0 };
    window.Date.now = () => now;
    window.Headers = Headers;
    window.AbortController = AbortController;
    Object.defineProperty(document, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' });
    Object.defineProperty(window.navigator, 'onLine', { get: () => online });
    const queryAll = document.querySelectorAll.bind(document);
    document.querySelectorAll = selector => { stats.documentScans++; return queryAll(selector); };

    // jsdom has no layout. Model CSS-hidden ancestors explicitly; real browser
    // layout, native editor transactions and pixel appearance need a smoke test.
    window.HTMLElement.prototype.getClientRects = function () {
        stats.layoutReads++;
        if (!this.isConnected || this.closest('[hidden], [inert]')) {return [];}
        for (let node = this; node; node = node.parentElement) {
            if (window.getComputedStyle(node).display === 'none') {return [];}
        }
        return [{}];
    };
    const schedule = (fn, delay, interval = 0) => {
        const id = ++serial;
        timers.set(id, { fn, at: now + Math.max(0, Number(delay) || 0), interval });
        return id;
    };
    window.setTimeout = (fn, delay) => schedule(fn, delay);
    window.setInterval = (fn, delay) => schedule(fn, delay, Math.max(1, delay));
    window.clearTimeout = window.clearInterval = id => timers.delete(id);
    window.fetch = (input, init = {}) => {
        let resolve, reject;
        const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
        const request = { input, init, resolve, reject, at: now, promise };
        requests.push(request);
        init.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
        return promise;
    };
    async function flush() {
        for (let i = 0; i < 20; i++) {await Promise.resolve();}
    }
    async function tick(milliseconds = 0) {
        await flush();
        const until = now + milliseconds;
        let turns = 0;
        for (;;) {
            const next = [...timers].filter(([, value]) => value.at <= until)
                .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!next) {break;}
            if (++turns > 10000) {throw new Error('Runaway timer');}
            const [id, timer] = next;
            timers.delete(id);
            now = timer.at;
            if (timer.interval) {timers.set(id, { ...timer, at: now + timer.interval });}
            timer.fn();
            await flush();
        }
        now = until;
        await flush();
    }
    function response(data, status, headers) {
        return {
            ok: status >= 200 && status < 300, status, headers: new Headers(headers),
            json: async () => {
                if (data instanceof Error) {throw data;}
                return JSON.parse(JSON.stringify(data));
            },
            clone: () => response(data, status, headers)
        };
    }
    async function respond(index, data, status = 200, headers = {}) {
        if (!requests[index]) {throw new Error(`No request ${index}; count=${requests.length}`);}
        requests[index].resolve(response(data, status, headers));
        await flush();
    }
    const gauge = key => document.getElementById('tm-work-usage-gauges')?.shadowRoot.querySelector(`[data-window="${key}"]`);
    const status = () => document.getElementById('tm-work-usage-gauges')?.shadowRoot.querySelector('.status').textContent;
    function watchGauges() {
        const root = document.getElementById('tm-work-usage-gauges').shadowRoot;
        new window.MutationObserver(records => {stats.gaugeMutations += records.length;})
            .observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    window.eval(source);
    t.after(() => {timers.clear(); dom.window.close();});
    return { window, document, requests, stats, tick, flush, respond, gauge, status, watchGauges,
        now: () => now,
        async visibility(value) {hidden = value; document.dispatchEvent(new window.Event('visibilitychange')); await tick();},
        async connection(value) {online = value; window.dispatchEvent(new window.Event(value ? 'online' : 'offline')); await tick();},
        value: key => gauge(key)?.querySelector('.value').textContent,
        pageFetch: (init = {}) => window.fetch('/backend-api/wham/usage', init)
    };
}
module.exports = { setup, workForm, windowData, plus, pro };
