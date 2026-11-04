// ==UserScript==
// @name         ChatGPT Enter Fix - Regular and Work
// @namespace    local.chatgpt.enter-fix
// @version      1.1.18
// @description  Enter adds a newline; Ctrl+Enter sends. Includes Work usage gauges and clearer chat links.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/GoldRobot/chagpt_better_ui/master/chatgpt-better-ui.user.js
// @downloadURL  https://raw.githubusercontent.com/GoldRobot/chagpt_better_ui/master/chatgpt-better-ui.user.js
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
        'form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]',
        'form[data-thread-find-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]'
    ].join(',');
    let replaying = false;

    function getEditor(event) {
        if (!(event.target instanceof Element) || event.target.closest('[contenteditable="false"]')) {return null;}
        return event.target.closest(selector);
    }

    function visible(node) {
        if (node.closest('[hidden], [inert], [aria-hidden="true"]') || !node.getClientRects().length) {return false;}
        const visibility = window.getComputedStyle(node).visibility;
        return visibility !== 'hidden' && visibility !== 'collapse';
    }

    function send(editor) {
        const scope = editor.closest('form, [data-chatgpt-composer], [data-thread-find-composer], [data-testid="composer"]');
        if (!scope) {return;}
        // Query each priority separately; a comma-separated query uses DOM order.
        for (const buttonSelector of [
            'button[data-testid="send-button"]',
            'button[aria-label="Send message"]',
            'button[aria-label="Send"]',
            'button[type="submit"]'
        ]) {
            const button = Array.from(scope.querySelectorAll(buttonSelector)).find(visible);
            if (!button) {continue;}
            // A disabled Send button must not fall through to another submit action.
            if (!button.disabled && button.getAttribute('aria-disabled') !== 'true') {button.click();}
            return;
        }
    }

    function stop(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    window.addEventListener('keydown', event => {
        if (replaying || event.isComposing || event.keyCode === 229 || event.key !== 'Enter') {return;}
        const editor = getEditor(event);
        if (!editor) {return;}
        if (event.altKey || (event.shiftKey && !event.ctrlKey && !event.metaKey)) {return;}
        stop(event);
        if (event.ctrlKey || event.metaKey) {
            if (!event.repeat) {send(editor);}
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
        if (replaying || event.isComposing || event.keyCode === 229 || event.key !== 'Enter' || !getEditor(event)) {return;}
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
    let usage = null;
    let requestSerial = 0;
    let settledSerial = 0;
    let activeRequest = null;
    const observedRequests = new Map();
    let nextPollAt = 0;
    let pollTimer = null;
    let failureCount = 0;
    let failureStatus = 0;
    let notice = 'Connecting…';
    let scheduleId = null;
    let activeEditor = null;
    const editors = new Set();
    const pollInterval = 60000;
    const requestTimeout = 15000;
    const labels = { session: 'Session', week: 'Weekly' };

    function normalizeWindow(value, receivedAt) {
        if (!value || typeof value.used_percent !== 'number' || !Number.isFinite(value.used_percent)
            || value.used_percent < 0 || value.used_percent > 100) {return null;}
        const resetAt = typeof value.reset_at === 'number' && Number.isFinite(value.reset_at)
            ? value.reset_at * 1000
            : typeof value.reset_after_seconds === 'number' && Number.isFinite(value.reset_after_seconds)
                ? receivedAt + Math.max(0, value.reset_after_seconds) * 1000 : null;
        return {
            remaining: Math.max(0, Math.min(100, 100 - value.used_percent)),
            resetAt,
            receivedAt
        };
    }

    function normalizeLimits(rateLimit, receivedAt) {
        const windows = { session: null, week: null };
        const issues = new Set();
        const seen = new Set();
        let unclassified = false;
        for (const value of [rateLimit.primary_window, rateLimit.secondary_window]) {
            // Only an explicit null means the account has no such window.
            if (value === null) {continue;}
            const seconds = value?.limit_window_seconds;
            const key = seconds === 18000 ? 'session' : seconds === 604800 ? 'week' : null;
            if (!key) {
                issues.add(typeof seconds === 'number' ? 'Unsupported usage window' : 'Usage format unavailable');
                unclassified = true;
                continue;
            }
            const normalized = seen.has(key) ? null : normalizeWindow(value, receivedAt);
            seen.add(key);
            if (!normalized) {issues.add(`${labels[key]} unavailable`);}
            // Keep an unreadable known window visible as an em dash.
            windows[key] = normalized || { remaining: null, resetAt: null, receivedAt: 0 };
        }
        if (unclassified) {
            // An unknown record is not evidence that a previous allowance vanished.
            for (const key of Object.keys(windows)) {
                if (!seen.has(key) && usage?.[key]) {
                    windows[key] = { remaining: null, resetAt: null, receivedAt: 0 };
                }
            }
        }
        return { windows, issues: Array.from(issues) };
    }

    function requestContext() {
        return { id: ++requestSerial, generation, account, deadline: Date.now() + requestTimeout };
    }

    function isCurrent(context) {
        return context.generation === generation && context.id > settledSerial
            && (!context.account || !account || context.account === account);
    }

    function retryDelay(response, base = pollInterval) {
        const delay = Math.min(base * (2 ** Math.min(failureCount++, 5)), 900000);
        const retryAfter = response?.headers?.get('retry-after');
        if (!retryAfter) {return delay;}
        const seconds = Number(retryAfter);
        const serverDelay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
            : Math.max(0, Date.parse(retryAfter) - Date.now());
        return Math.max(delay, Number.isFinite(serverDelay) ? serverDelay : 0);
    }

    function failed(context, message, response) {
        if (!isCurrent(context)) {return;}
        settledSerial = context.id;
        failureStatus = response?.status || 0;
        notice = message;
        nextPollAt = Date.now() + retryDelay(response);
        render();
    }

    function receive(data, context) {
        if (!isCurrent(context)) {return;}
        const responseAccount = typeof data.account_id === 'string' ? data.account_id : '';
        if (account && responseAccount && responseAccount !== account) {
            failed(context, 'Waiting for current account usage');
            return;
        }
        if (!data.rate_limit || typeof data.rate_limit !== 'object' || Array.isArray(data.rate_limit)) {
            failed(context, 'Usage format unavailable');
            return;
        }
        const receivedAt = Date.now();
        const { windows, issues } = normalizeLimits(data.rate_limit, receivedAt);
        if (!account && responseAccount) {account = responseAccount;}
        settledSerial = context.id;
        usage = windows;
        failureStatus = 0;
        const resetTimes = Object.values(windows).map(value => value?.resetAt).filter(value => value !== null && value !== undefined);
        const expired = resetTimes.some(value => value <= receivedAt);
        if (issues.length || expired) {
            notice = issues.length ? issues.join(' · ') : 'Reset pending refresh';
            nextPollAt = receivedAt + retryDelay(null, expired && !issues.length ? 30000 : pollInterval);
        } else {
            failureCount = 0;
            notice = Object.values(windows).some(Boolean) ? '' : 'No usage limits reported';
            nextPollAt = Math.min(receivedAt + pollInterval, ...resetTimes);
        }
        render();
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
            settledSerial = 0;
            failureCount = 0;
            failureStatus = 0;
            nextPollAt = 0;
            for (const name of copiedHeaders) {sessionHeaders.delete(name);}
            observedRequests.clear();
            activeRequest?.controller.abort();
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
        if (changed && (failureStatus === 401 || failureStatus === 403)) {
            failureCount = 0;
            failureStatus = 0;
            nextPollAt = 0;
        }
        const context = url.pathname === endpoint ? requestContext() : null;
        if (context) {observedRequests.set(context.id, context);}
        if (changed || context) {schedulePoll();}
        return context;
    }

    async function consume(response, context) {
        if (!isCurrent(context)) {return;}
        if (!response.ok) {
            failed(context, response.status === 401 || response.status === 403
                ? 'Waiting for app sign-in' : `Usage unavailable (${response.status})`, response);
            return;
        }
        try {
            const data = await response.json();
            if (!data || typeof data !== 'object') {throw new Error('Invalid usage');}
            receive(data, context);
        } catch {
            failed(context, 'Usage format unavailable');
        }
    }

    // Observe the app's own requests without changing their arguments or responses.
    window.fetch = function (input, init) {
        let context = null;
        try { context = observeRequest(input, init); } catch { /* Preserve the original fetch behavior. */ }
        const responsePromise = originalFetch(input, init);
        if (context) {
            responsePromise.then(response => {
                return consume(response.clone(), context);
            }).catch(() => {
                failed(context, usage ? 'Refresh failed · last known usage' : 'Usage unavailable · retrying');
            }).finally(() => {
                observedRequests.delete(context.id);
                schedulePoll();
            });
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
            .gauge[hidden]{display:none}
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
    const gaugeNodes = Object.fromEntries(Object.keys(labels).map(key => {
        const gauge = shadow.querySelector(`[data-window="${key}"]`);
        return [key, {
            gauge, value: gauge.querySelector('.value'), fill: gauge.querySelector('.fill'),
            track: gauge.querySelector('.track'), name: gauge.querySelector('.name'), previous: {}
        }];
    }));

    function setText(node, value) {
        if (node.textContent !== value) {node.textContent = value;}
    }

    function render() {
        if (!host.isConnected || document.visibilityState === 'hidden') {return;}
        const now = Date.now();
        for (const key of ['session', 'week']) {
            const nodes = gaugeNodes[key];
            const { gauge, previous } = nodes;
            const windowData = usage?.[key];
            const expired = windowData?.resetAt != null && windowData.resetAt <= now;
            const known = typeof windowData?.remaining === 'number' && !expired;
            const remaining = known ? windowData.remaining : 0;
            const label = labels[key];
            const countdown = known && windowData.resetAt ? duration(windowData.resetAt - now) : '';
            const title = known && windowData.resetAt
                ? `Open usage dashboard. Resets ${new Date(windowData.resetAt).toLocaleString()}`
                : 'Open usage dashboard';
            const hidden = !windowData;
            if (hidden !== previous.hidden) {gauge.hidden = hidden;}
            setText(nodes.value, known ? `${Math.round(remaining)}%` : '—');
            setText(nodes.name, countdown ? `${label} · ${countdown}` : label);
            if (remaining !== previous.remaining) {
                nodes.fill.style.width = `${remaining}%`;
                nodes.fill.style.background = remaining <= 20 ? '#e05b55' : remaining <= 40 ? '#c99528' : '#10a37f';
            }
            if (known !== previous.known || remaining !== previous.remaining) {
                if (known) {nodes.track.setAttribute('aria-valuenow', String(remaining));}
                else {nodes.track.removeAttribute('aria-valuenow');}
                gauge.setAttribute('aria-label', `${label} allowance: ${known ? `${Math.round(remaining)}% remaining.` : 'Unavailable.'} Open usage dashboard.`);
            }
            if (title !== previous.title) {gauge.title = title;}
            nodes.previous = { hidden, remaining, known, title };
        }
        const stale = usage && Object.values(usage).some(w => w?.receivedAt && now - w.receivedAt > 180000);
        const expired = usage && Object.values(usage).some(w => w?.resetAt && w.resetAt <= now);
        const visibleNotice = navigator.onLine === false ? (usage ? 'Offline · last known usage' : 'Offline') : notice;
        setText(status, visibleNotice || (expired ? 'Reset pending refresh' : stale ? 'Stale usage' : usage ? '' : 'Connecting…'));
        const hidden = !status.textContent;
        if (status.hidden !== hidden) {status.hidden = hidden;}
        const staleValue = String(Boolean(stale || expired));
        if (status.dataset.stale !== staleValue) {status.dataset.stale = staleValue;}
    }

    function canPoll() {
        return host.isConnected && document.visibilityState !== 'hidden' && navigator.onLine !== false
            && activeEditor && isVisibleEditor(activeEditor);
    }

    function schedulePoll() {
        window.clearTimeout(pollTimer);
        pollTimer = null;
        if (!canPoll() || activeRequest) {return;}
        const now = Date.now();
        let due = nextPollAt;
        for (const [id, context] of observedRequests) {
            if (context.generation !== generation || id <= settledSerial || context.deadline <= now) {
                observedRequests.delete(id);
            } else {
                // Give the app's own usage request time to supply a fresh reading.
                due = Math.max(due, context.deadline);
            }
        }
        // Long server Retry-After dates must not overflow a browser's timer.
        pollTimer = window.setTimeout(poll, Math.min(2147483647, Math.max(0, due - now)));
    }

    async function poll() {
        pollTimer = null;
        if (!canPoll() || activeRequest) {return;}
        if (Date.now() < nextPollAt || Array.from(observedRequests.values()).some(context =>
            context.generation === generation && context.id > settledSerial && context.deadline > Date.now())) {
            schedulePoll();
            return;
        }
        const context = requestContext();
        const controller = new AbortController();
        const request = { context, controller };
        activeRequest = request;
        const timeout = window.setTimeout(() => controller.abort(), requestTimeout);
        const headers = new Headers(sessionHeaders);
        headers.set('accept', 'application/json');
        try {
            const response = await originalFetch(endpoint, {
                method: 'GET', credentials: 'same-origin', cache: 'no-store', headers, signal: controller.signal
            });
            await consume(response, context);
        } catch {
            failed(context, usage ? 'Refresh failed · last known usage' : 'Usage unavailable · retrying');
        } finally {
            window.clearTimeout(timeout);
            if (activeRequest === request) {activeRequest = null;}
            schedulePoll();
        }
    }

    function isVisibleEditor(node) {
        if (!node.isConnected || node.closest('[aria-hidden="true"], [hidden], [inert]')) {return false;}
        // Work keeps inactive chats mounted under display:none containers.
        // Layout rectangles account for CSS hiding anywhere in the ancestor chain.
        if (!node.getClientRects().length) {return false;}
        const style = window.getComputedStyle(node);
        return style.visibility !== 'hidden' && style.visibility !== 'collapse';
    }

    function mount() {
        scheduleId = null;
        for (const editor of editors) {
            if (!editor.isConnected || !editor.matches(workSelector)) {editors.delete(editor);}
        }
        const editor = editors.has(activeEditor) && isVisibleEditor(activeEditor)
            ? activeEditor : Array.from(editors).find(isVisibleEditor);
        const form = editor?.closest('form');
        if (!form) {
            activeEditor = null;
            if (host.isConnected) {host.remove();}
            schedulePoll();
            return;
        }
        activeEditor = editor;
        if (host.parentNode !== form.parentNode || host.nextSibling !== form) {form.before(host);}
        render();
        schedulePoll();
    }

    function scheduleMount() {
        if (scheduleId === null) {scheduleId = window.setTimeout(mount, 100);}
    }
    function discoverEditors(root) {
        let changed = false;
        const found = root.matches?.(workSelector) ? [root] : [];
        found.push(...root.querySelectorAll(workSelector));
        for (const editor of found) {
            if (!editors.has(editor)) {editors.add(editor); changed = true;}
        }
        return changed;
    }

    function containsEditor(node) {
        return Array.from(editors).some(editor => node === editor || node.contains(editor));
    }

    new MutationObserver(records => {
        let changed = false;
        for (const record of records) {
            if (record.type === 'attributes') {
                if (containsEditor(record.target)) {changed = true;}
                if (['contenteditable', 'data-thread-find-composer', 'data-composer-markdown'].includes(record.attributeName)) {
                    if (discoverEditors(record.target)) {changed = true;}
                }
            } else {
                for (const node of record.removedNodes) {
                    if (node === host || (node.nodeType === 1 && (node.contains(host) || containsEditor(node)))) {changed = true;}
                }
                for (const node of record.addedNodes) {
                    if (node.nodeType === 1 && node !== host && discoverEditors(node)) {changed = true;}
                }
                const form = activeEditor?.closest('form');
                if (form && record.target === form.parentNode && host.nextSibling !== form) {changed = true;}
            }
        }
        if (changed) {scheduleMount();}
    }).observe(document, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['aria-hidden', 'hidden', 'inert', 'style', 'class', 'contenteditable', 'data-thread-find-composer', 'data-composer-markdown']
    });
    discoverEditors(document);
    scheduleMount();
    window.setInterval(render, 15000);
    function refreshWhenVisible() {
        scheduleMount();
        render();
        schedulePoll();
    }
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refreshWhenVisible);
    window.addEventListener('online', refreshWhenVisible);
    window.addEventListener('offline', refreshWhenVisible);
})();

// Make text links easier to recognize in rendered chat messages.
(() => {
    'use strict';
    if (location.hostname !== 'chatgpt.com') {return;}

    function installLinkStyles() {
        if (document.getElementById('tm-chat-message-link-styles')) {return;}
        const roots = [
            '[data-markdown-text-style="assistant-message"]',
            '[data-markdown-text-tone="user-message"]',
            '[data-message-author-role] .markdown',
            '[data-message-author-role="user"] .whitespace-pre-wrap'
        ];
        const links = ':is(' + roots.join(',') + ') a[href]:not([role="button"])';
        const inlineMention = '[data-appearance="inline-mention"]';
        const plainLinks = links + ':not(:has(> ' + inlineMention + '))';
        const mentionLinks = links + ':has(> ' + inlineMention + ')';
        const surfaces = ':is(' + plainLinks + ', ' + links + ' > ' + inlineMention + ')';
        const hoverSurfaces = ':is(' + plainLinks + ':hover, ' + links + ':hover > ' + inlineMention + ')';
        const focusSurfaces = ':is(' + plainLinks + ':focus-visible, ' + links + ':focus-visible > ' + inlineMention + ')';
        const style = document.createElement('style');
        style.id = 'tm-chat-message-link-styles';
        // Work colors the inner mention, not necessarily its anchor. Paint that
        // element so currentColor follows the actual text across appearance changes.
        // Keep citation dimensions and all native navigation/preview behavior.
        style.textContent = `
            ${surfaces} {
                text-decoration-line: underline !important;
                text-decoration-style: solid !important;
                text-decoration-thickness: 1.5px !important;
                text-underline-offset: 3px !important;
                background-color: color-mix(in srgb, currentColor 14%, transparent) !important;
                border-radius: 4px;
                box-decoration-break: clone;
                -webkit-box-decoration-break: clone;
            }
            ${mentionLinks} {
                background-color: transparent !important;
                text-decoration: none !important;
                padding: 0;
            }
            ${surfaces}:not([data-testid="chatgpt-citation"]) {
                padding: 1px 3px;
            }
            ${links}[data-testid="chatgpt-citation"] {
                background-color: color-mix(in srgb, currentColor 14%, transparent) !important;
            }
            ${hoverSurfaces} {
                background-color: color-mix(in srgb, currentColor 20%, transparent) !important;
                text-decoration-thickness: 2px !important;
            }
            ${focusSurfaces} {
                background-color: color-mix(in srgb, currentColor 20%, transparent) !important;
                outline: 2px solid currentColor;
                outline-offset: 2px;
            }
        `;
        (document.head || document.documentElement).append(style);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', installLinkStyles, { once: true });
    } else {
        installLinkStyles();
    }
})();

