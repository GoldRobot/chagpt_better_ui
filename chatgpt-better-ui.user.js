// ==UserScript==
// @name         ChatGPT Enter Fix - Regular and Work
// @namespace    local.chatgpt.enter-fix
// @version      1.1.11
// @description  Enter adds a newline; Ctrl+Enter sends. Includes live Work session and weekly usage gauges.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://github.com/GoldRobot/chagpt_better_ui/raw/refs/heads/master/chatgpt-better-ui.user.js
// @downloadURL  https://github.com/GoldRobot/chagpt_better_ui/raw/refs/heads/master/chatgpt-better-ui.user.js
// @license      MIT
// ==/UserScript==

(() => {
    'use strict';
    if (location.hostname !== 'chatgpt.com') {return;}
    if (window.__tmChatGPTEnterFix) {return;}
    window.__tmChatGPTEnterFix = true;

    const selector = [
        '#prompt-textarea[contenteditable="true"]',
        '[data-testid="prompt-textarea"][contenteditable="true"]',
        '[contenteditable="true"][data-lexical-editor="true"]',
        'form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]',
            'form[data-thread-find-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]'
    ].join(',');
    let replaying = false;

    function isEditor(event) {
        return event.target instanceof Element && event.target.matches(selector);
    }

    function stop(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    window.addEventListener('keydown', event => {
        if (replaying || event.isComposing || event.key !== 'Enter' || !isEditor(event)) {return;}
        if (event.altKey || (event.shiftKey && !event.ctrlKey && !event.metaKey)) {return;}
        stop(event);
        const editor = event.target;

        if (event.ctrlKey || event.metaKey) {
            const form = editor.closest('form');
            const button = (form || document).querySelector([
                'button[data-testid="send-button"]',
                'button[data-testid*="send"]',
                'button[aria-label="Send message"]',
                'button[aria-label="Send"]',
                'button[type="submit"]'
            ].join(','));
            if (button) {
                if (!button.disabled && button.getAttribute('aria-disabled') !== 'true') {button.click();}
            } else if (form && typeof form.requestSubmit === 'function') {
                form.requestSubmit();
            }
            return;
        }

        replaying = true;
        try {
            for (const type of ['keydown', 'keyup']) {
                editor.dispatchEvent(new KeyboardEvent(type, {
                    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                    shiftKey: true, bubbles: true, cancelable: true
                }));
            }
        } finally {
            replaying = false;
        }
    }, { capture: true, passive: false });

    function blockOtherEnter(event) {
        if (replaying || event.isComposing || event.key !== 'Enter' || !isEditor(event)) {return;}
        if (event.altKey || (event.shiftKey && !event.ctrlKey && !event.metaKey)) {return;}
        stop(event);
    }

    window.addEventListener('keypress', blockOtherEnter, { capture: true, passive: false });
    window.addEventListener('keyup', blockOtherEnter, { capture: true, passive: false });
})();

// Work usage gauges. Endpoint and response shape verified from the supplied HAR.
// Session headers are reused in memory, only for same-origin usage requests.
// No credentials, usage records, or identifiers are written to persistent storage.
(() => {
    'use strict';
    if (location.hostname !== 'chatgpt.com' || window.__tmWorkUsageGauges) {return;}
    window.__tmWorkUsageGauges = true;

    const endpoint = '/backend-api/wham/usage';
    const workSelector = 'form[data-thread-find-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]';
    const originalFetch = window.fetch.bind(window);
    const copiedHeaders = [
        'authorization', 'chatgpt-account-id', 'originator',
        'x-openai-web-frontend', 'x-openai-codex-window-type',
        'x-openai-rate-limit-join-workspace', 'x-openai-codex-pricing-chooser'
    ];
    const sessionHeaders = new Headers();
    let account = '';
    let generation = 0;
    let headersRevision = 0;
    let usage = null;
    let updatedAt = 0;
    let lastAttempt = 0;
    let pending = null;
    let activeController = null;
    let notice = 'Connecting…';
    let scheduleId = null;
    let expiryAttempt = 0;

    function normalizeWindow(value, receivedAt) {
        if (!value || typeof value.used_percent !== 'number' || !Number.isFinite(value.used_percent)) {return null;}
        const resetAt = typeof value.reset_at === 'number' && Number.isFinite(value.reset_at)
            ? value.reset_at * 1000
            : typeof value.reset_after_seconds === 'number' && Number.isFinite(value.reset_after_seconds)
                ? receivedAt + Math.max(0, value.reset_after_seconds) * 1000 : null;
        return {
            remaining: Math.max(0, Math.min(100, 100 - value.used_percent)),
            seconds: value.limit_window_seconds,
            resetAt
        };
    }

    function receive(data, requestAccount = '', requestGeneration = generation) {
        if (requestGeneration !== generation || !data || typeof data.rate_limit !== 'object' || !data.rate_limit) {return false;}
        const responseAccount = typeof data.account_id === 'string' ? data.account_id : '';
        if (account && responseAccount && responseAccount !== account) {return false;}
        if (requestAccount && account && requestAccount !== account) {return false;}
        if (!account && responseAccount) {account = responseAccount;}
        const receivedAt = Date.now();
        usage = {
            session: normalizeWindow(data.rate_limit.primary_window, receivedAt),
            week: normalizeWindow(data.rate_limit.secondary_window, receivedAt)
        };
        updatedAt = receivedAt;
        notice = '';
        render();
        return true;
    }

    function observeRequest(input, init) {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
        if (url.origin !== location.origin || !url.pathname.startsWith('/backend-api/')) {return null;}
        const headers = new Headers(init?.headers ?? (typeof input === 'object' ? input.headers : undefined));
        const incomingAccount = headers.get('chatgpt-account-id');
        let changed = false;
        if (incomingAccount && incomingAccount !== account) {
            generation++;
            account = incomingAccount;
            usage = null;
            updatedAt = 0;
            for (const name of copiedHeaders) {sessionHeaders.delete(name);}
            activeController?.abort();
            notice = 'Connecting…';
            changed = true;
            render();
        }
        for (const name of copiedHeaders) {
            const value = headers.get(name);
            if (value && value !== sessionHeaders.get(name)) {
                sessionHeaders.set(name, value);
                changed = true;
            }
        }
        if (changed) {
            headersRevision++;
            window.setTimeout(() => {
                if (host.isConnected && (!usage || Date.now() - lastAttempt > 30000)) {refresh();}
            }, 0);
        }
        return { isUsage: url.pathname === endpoint, account, generation };
    }

    // Observe the app's own requests without changing their arguments or responses.
    window.fetch = function (input, init) {
        let context = null;
        try { context = observeRequest(input, init); } catch { /* Preserve the original fetch behavior. */ }
        const responsePromise = originalFetch(input, init);
        if (context?.isUsage) {
            responsePromise.then(response => {
                if (response.ok) {return response.clone().json().then(data => receive(data, context.account, context.generation));}
            }).catch(() => {});
        }
        return responsePromise;
    };

    function duration(milliseconds) {
        const minutes = Math.max(0, Math.ceil(milliseconds / 60000));
        const days = Math.floor(minutes / 1440);
        const hours = Math.floor((minutes % 1440) / 60);
        if (days) {return `${days}d ${hours}h`;}
        if (hours) {return `${hours}h ${minutes % 60}m`;}
        return `${minutes}m`;
    }

    const host = document.createElement('div');
    host.id = 'tm-work-usage-gauges';
    host.style.cssText = 'display:block;width:100%;margin:0 0 6px;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
        <style>
            :host{font:12px/1.3 system-ui,sans-serif;color:inherit;color-scheme:inherit}
            .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
            .gauge{display:block;position:relative;isolation:isolate;overflow:hidden;min-width:132px;box-sizing:border-box;padding:1px 9px;border-radius:6px;
                color:inherit;text-decoration:none;cursor:pointer;
                border:1px solid color-mix(in srgb,currentColor 16%,transparent);
                background:Canvas}
            .heading{position:relative;z-index:1;display:flex;justify-content:space-between;gap:12px;align-items:baseline}
            .name{opacity:.7;font-size:11px;white-space:nowrap}.value{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
            .track{position:absolute;inset:0;z-index:0;pointer-events:none}
            .fill{height:100%;opacity:.18;background:#10a37f;transition:width .25s ease}
            .status{opacity:.65;max-width:170px;font-size:11px}.status[data-stale=true]{color:#be8b23;opacity:1}
            .gauge:hover{background:color-mix(in srgb,Canvas 94%,CanvasText 6%)}
            .gauge:focus-visible{outline:2px solid #10a37f;outline-offset:2px}
        </style>
        <div class="row" aria-label="Work usage limits">
            <a class="gauge" data-window="session" href="/settings/usage" target="_blank" rel="noopener noreferrer" aria-label="Open usage dashboard for session allowance"><div class="heading"><span class="name">Session</span><span class="value">—</span></div><div class="track" role="progressbar" aria-label="Session allowance remaining" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:0"></div></div></a>
            <a class="gauge" data-window="week" href="/settings/usage" target="_blank" rel="noopener noreferrer" aria-label="Open usage dashboard for weekly allowance"><div class="heading"><span class="name">Weekly</span><span class="value">—</span></div><div class="track" role="progressbar" aria-label="Weekly allowance remaining" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:0"></div></div></a>
            <span class="status" role="status">Connecting…</span>
        </div>`;
    const status = shadow.querySelector('.status');

    function render() {
        const now = Date.now();
        for (const key of ['session', 'week']) {
            const gauge = shadow.querySelector(`[data-window="${key}"]`);
            const windowData = usage?.[key];
            const expired = windowData?.resetAt !== null && windowData?.resetAt <= now;
            const known = Boolean(windowData) && !expired;
            const remaining = known ? windowData.remaining : 0;
            gauge.querySelector('.value').textContent = known ? `${Math.round(remaining)}%` : '—';
            gauge.querySelector('.fill').style.width = `${remaining}%`;
            gauge.querySelector('.fill').style.background = remaining <= 20 ? '#e05b55' : remaining <= 40 ? '#c99528' : '#10a37f';
            const track = gauge.querySelector('.track');
            if (known) {track.setAttribute('aria-valuenow', String(remaining));}
            else {track.removeAttribute('aria-valuenow');}
            const label = key === 'session' ? 'Session' : 'Weekly';
            const countdown = known && windowData.resetAt ? duration(windowData.resetAt - now) : '';
            gauge.querySelector('.name').textContent = countdown
                ? `${label} · ${countdown}` : label;
            gauge.title = known && windowData.resetAt
                ? `Open usage dashboard. Resets ${new Date(windowData.resetAt).toLocaleString()}`
                : usage && !windowData ? 'Open usage dashboard. Usage window not reported.' : 'Open usage dashboard';
            gauge.setAttribute('aria-label', `${label} allowance: ${known ? `${Math.round(remaining)}% remaining.` : 'Not reported.'} Open usage dashboard.`);
        }
        const stale = Boolean(updatedAt) && now - updatedAt > 180000;
        const expired = usage && Object.values(usage).some(w => w?.resetAt && w.resetAt <= now);
        const visibleNotice = notice === 'Refreshing…' && usage ? '' : notice;
        status.textContent = visibleNotice || (expired ? 'Reset pending refresh' : stale ? 'Stale usage' : updatedAt ? '' : 'Connecting…');
        status.hidden = !status.textContent;
        status.dataset.stale = String(Boolean(stale || expired));
    }

    function refresh() {
        if (pending || !host.isConnected) {return pending;}
        lastAttempt = Date.now();
        const requestGeneration = generation;
        const requestHeadersRevision = headersRevision;
        const requestAccount = account;
        const controller = new AbortController();
        activeController = controller;
        const timeout = window.setTimeout(() => controller.abort(), 15000);
        const headers = new Headers(sessionHeaders);
        headers.set('accept', 'application/json');
        notice = 'Refreshing…';
        render();
        pending = (async () => {
            try {
                const response = await originalFetch(endpoint, {
                    method: 'GET', credentials: 'same-origin', cache: 'no-store', headers, signal: controller.signal
                });
                if (!response.ok) {
                    if (requestGeneration === generation) {notice = response.status === 401 || response.status === 403
                        ? 'Waiting for app sign-in' : `Usage unavailable (${response.status})`;}
                    return;
                }
                if (!receive(await response.json(), requestAccount, requestGeneration) && requestGeneration === generation) {
                    notice = 'Usage format unavailable';
                }
            } catch {
                if (requestGeneration === generation) {notice = usage ? 'Refresh failed · last known usage' : 'Usage unavailable · retrying';}
            } finally {
                window.clearTimeout(timeout);
                if (activeController === controller) {activeController = null;}
                pending = null;
                render();
                if ((requestGeneration !== generation || requestHeadersRevision !== headersRevision) && host.isConnected) {
                    window.setTimeout(refresh, 0);
                }
            }
        })();
        return pending;
    }

    function mount() {
        scheduleId = null;
        const editor = Array.from(document.querySelectorAll(workSelector)).find(node => !node.closest('[aria-hidden="true"], [hidden]'));
        const form = editor?.closest('form');
        if (!form || form.closest('[aria-hidden="true"]')) {
            if (host.isConnected) {host.remove();}
            return;
        }
        const firstMount = !host.isConnected;
        if (host.parentNode !== form.parentNode || host.nextSibling !== form) {form.before(host);}
        render();
        if (firstMount) {refresh();}
    }

    function scheduleMount() {
        if (scheduleId === null) {scheduleId = window.setTimeout(mount, 100);}
    }
    new MutationObserver(scheduleMount).observe(document, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['aria-hidden', 'hidden']
    });
    scheduleMount();
    window.setInterval(() => {
        render();
        const expired = usage && Object.values(usage).some(w => w?.resetAt && w.resetAt <= Date.now());
        if (expired && host.isConnected && document.visibilityState !== 'hidden' && Date.now() - expiryAttempt > 30000) {
            expiryAttempt = Date.now();
            refresh();
        }
    }, 15000);
    window.setInterval(() => {
        if (host.isConnected && document.visibilityState !== 'hidden') {refresh();}
    }, 60000);
    function refreshWhenVisible() {
        scheduleMount();
        if (host.isConnected && document.visibilityState !== 'hidden' && Date.now() - lastAttempt > 15000) {refresh();}
    }
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refreshWhenVisible);
})();
