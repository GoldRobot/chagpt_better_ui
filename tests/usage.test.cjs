const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, workForm, windowData, plus, pro } = require('./helpers.cjs');

test('Plus, Pro, swapped windows and explicit absence', async t => {
    const h = setup(t); await h.tick(100); await h.respond(0, plus(35));
    assert.equal(h.value('session'), '65%'); assert.equal(h.value('week'), '65%');
    h.pageFetch(); await h.respond(1, pro(12));
    assert.equal(h.gauge('session').hidden, true); assert.equal(h.value('week'), '88%');
    h.pageFetch(); await h.respond(2, { rate_limit: { primary_window: windowData(604800, 40), secondary_window: windowData(18000, 10) } });
    assert.equal(h.value('session'), '90%'); assert.equal(h.gauge('session').hidden, false);
    h.pageFetch(); await h.respond(3, { rate_limit: { primary_window: null, secondary_window: null } });
    assert.equal(h.gauge('session').hidden, true); assert.equal(h.gauge('week').hidden, true);
    assert.equal(h.status(), 'No usage limits reported');
});

test('older app result cannot overwrite a newer script result', async t => {
    const h = setup(t); await h.tick(100); await h.respond(0, plus());
    h.pageFetch(); // Held longer than the bounded wait for app requests.
    await h.tick(60000); assert.equal(h.requests.length, 3);
    await h.respond(2, plus(30)); await h.respond(1, plus(20));
    assert.equal(h.value('week'), '70%');
});

test('older script result and error cannot overwrite a newer app result', async t => {
    const h = setup(t); await h.tick(100);
    h.pageFetch(); await h.respond(1, pro(25)); await h.respond(0, {}, 401);
    assert.equal(h.value('week'), '75%'); assert.equal(h.status(), '');
});

test('requests reuse fresh app readings and wait for an in-flight app request', async t => {
    const h = setup(t); h.pageFetch(); await h.tick(100);
    assert.equal(h.requests.length, 1);
    await h.respond(0, pro()); await h.tick(59999); assert.equal(h.requests.length, 1);
    await h.tick(1); assert.equal(h.requests.length, 2);
});

test('in-flight app response wait is bounded', async t => {
    const h = setup(t); h.pageFetch(); await h.tick(14999); assert.equal(h.requests.length, 1);
    await h.tick(1); assert.equal(h.requests.length, 2);
    await h.respond(1, pro()); await h.respond(0, pro(10));
    assert.equal(h.value('week'), '80%');
});

test('mounting and credential changes do not poll in hidden or offline tabs', async t => {
    const h = setup(t, { hidden: true }); await h.tick(100);
    h.window.fetch('/backend-api/example', { headers: { authorization: 'Bearer synthetic-test' } });
    await h.tick(60000); assert.equal(h.requests.length, 1);
    await h.connection(false); await h.visibility(false); await h.tick(100);
    assert.equal(h.requests.length, 1);
    await h.connection(true); assert.equal(h.requests.length, 2);
    await h.respond(1, pro());
    await h.visibility(true); await h.tick(120000); assert.equal(h.requests.length, 2);
    await h.visibility(false); assert.equal(h.requests.length, 3);
});

test('focus and remount reuse a recent successful response', async t => {
    const h = setup(t); await h.tick(100); await h.respond(0, pro());
    h.window.dispatchEvent(new h.window.Event('focus'));
    h.document.getElementById('tm-work-usage-gauges').remove(); await h.tick(200);
    assert.ok(h.gauge('week')); assert.equal(h.requests.length, 1);
});

test('HTTP failures retain data, honor Retry-After and progressively back off', async t => {
    const h = setup(t); await h.tick(100); await h.respond(0, pro());
    await h.tick(60000); await h.respond(1, {}, 429, { 'retry-after': '180' });
    assert.equal(h.value('week'), '80%'); assert.match(h.status(), /429/);
    await h.tick(179999); assert.equal(h.requests.length, 2);
    await h.tick(1); assert.equal(h.requests.length, 3);
    await h.respond(2, {}, 503); await h.tick(119999); assert.equal(h.requests.length, 3);
    await h.tick(1); assert.equal(h.requests.length, 4);
    await h.respond(3, pro(30)); await h.tick(60000); assert.equal(h.requests.length, 5);
});

test('Retry-After HTTP-date is respected', async t => {
    const h = setup(t); await h.tick(100);
    const until = new Date(h.now() + 300000).toUTCString();
    await h.respond(0, {}, 429, { 'retry-after': until });
    await h.tick(299000); assert.equal(h.requests.length, 1);
    await h.tick(1000); assert.equal(h.requests.length, 2);
});

test('very long Retry-After values do not overflow into immediate retry loops', async t => {
    const h = setup(t); await h.tick(100);
    await h.respond(0, {}, 429, { 'retry-after': '3000000' });
    await h.tick(86400000); assert.equal(h.requests.length, 1);
});

test('fresh sign-in headers allow recovery from an authentication failure', async t => {
    const h = setup(t); await h.tick(100); await h.respond(0, {}, 401);
    const init = { headers: { authorization: 'Bearer synthetic-test', 'chatgpt-account-id': 'synthetic-account' } };
    const promise = h.window.fetch('/backend-api/example', init);
    assert.equal(promise, h.requests[1].promise); assert.equal(h.requests[1].init, init);
    await h.tick(); assert.equal(h.requests.length, 3);
    assert.equal(h.requests[2].init.headers.get('authorization'), 'Bearer synthetic-test');
    await h.respond(2, { ...pro(), account_id: 'synthetic-account' });
    assert.equal(h.status(), ''); assert.equal(h.value('week'), '80%');
});

test('no Work composer means no gauge polling, and other fetches retain their behavior', async t => {
    const h = setup(t, { html: '<p>No composer on this page</p>' });
    await h.tick(120000); assert.equal(h.requests.length, 0);
    const init = { method: 'POST', body: 'example' };
    const promise = h.window.fetch('/backend-api/example', init);
    assert.equal(promise, h.requests[0].promise); assert.equal(h.requests[0].init, init);
    await h.respond(0, { example: true });
    assert.deepEqual(await (await promise).json(), { example: true });
});

test('request timeout recovers automatically', async t => {
    const h = setup(t); await h.tick(15100);
    assert.equal(h.requests[0].init.signal.aborted, true);
    assert.match(h.status(), /retrying/);
    await h.tick(60000); assert.equal(h.requests.length, 2);
    await h.respond(1, pro()); assert.equal(h.value('week'), '80%');
});

test('missing, malformed, duplicate and unknown windows are not treated as absent', async t => {
    const h = setup(t); await h.tick(100); await h.respond(0, plus());
    h.pageFetch(); await h.respond(1, { rate_limit: { primary_window: windowData(18000, null), secondary_window: windowData(604800, 30) } });
    assert.equal(h.gauge('session').hidden, false); assert.equal(h.value('session'), '—');
    assert.equal(h.value('week'), '70%'); assert.match(h.status(), /Session unavailable/);
    h.pageFetch(); await h.respond(2, { rate_limit: { secondary_window: windowData(604800, 40) } });
    assert.equal(h.gauge('session').hidden, false); assert.match(h.status(), /format unavailable/);
    h.pageFetch(); await h.respond(3, { rate_limit: { primary_window: windowData(86400), secondary_window: windowData(604800) } });
    assert.match(h.status(), /Unsupported usage window/); assert.equal(h.gauge('session').hidden, false);
    h.pageFetch(); await h.respond(4, { rate_limit: { primary_window: windowData(604800), secondary_window: windowData(604800, 90) } });
    assert.equal(h.value('week'), '—'); assert.match(h.status(), /Weekly unavailable/);
});

test('invalid JSON or top-level data leaves last known usage visible with an error', async t => {
    const h = setup(t); await h.tick(100); await h.respond(0, pro());
    h.pageFetch(); await h.respond(1, new Error('Invalid JSON'));
    assert.equal(h.value('week'), '80%'); assert.match(h.status(), /format unavailable/);
    h.pageFetch(); await h.respond(2, null);
    assert.equal(h.value('week'), '80%'); assert.match(h.status(), /format unavailable/);
});

test('zero remaining is valid; expired windows refresh and never assume a full allowance', async t => {
    const h = setup(t); await h.tick(100);
    await h.respond(0, { rate_limit: { primary_window: windowData(604800, 100, 10), secondary_window: null } });
    assert.equal(h.value('week'), '0%');
    await h.tick(10000); assert.equal(h.requests.length, 2);
    await h.respond(1, { rate_limit: { primary_window: windowData(604800, 100, 0), secondary_window: null } });
    assert.equal(h.value('week'), '—'); assert.match(h.status(), /Reset pending/);
    await h.tick(30000); assert.equal(h.requests.length, 3);
});

test('switching accounts rejects old responses and clears previous usage', async t => {
    const h = setup(t); await h.tick(100); await h.respond(0, { ...pro(), account_id: 'account-a' });
    h.pageFetch({ headers: { 'chatgpt-account-id': 'account-a' } });
    h.pageFetch({ headers: { 'chatgpt-account-id': 'account-b' } });
    await h.respond(2, { ...pro(40), account_id: 'account-b' });
    await h.respond(1, { ...pro(1), account_id: 'account-a' });
    assert.equal(h.value('week'), '60%');
});

test('CSS-hidden cached chats, new composers and removed hosts remount correctly', async t => {
    const h = setup(t, { html: workForm('chat-a') + '<section style="display:none">' + workForm('chat-b') + '</section>' });
    await h.tick(100); await h.respond(0, pro());
    const host = () => h.document.getElementById('tm-work-usage-gauges');
    assert.equal(host().parentElement.id, 'chat-a');
    h.document.getElementById('chat-a').style.display = 'none';
    h.document.getElementById('chat-b').parentElement.style.display = '';
    await h.tick(100); assert.equal(host().parentElement.id, 'chat-b');
    h.document.getElementById('chat-b').parentElement.remove(); await h.tick(100); assert.equal(host(), null);
    h.document.body.insertAdjacentHTML('beforeend', workForm('chat-c')); await h.tick(100);
    assert.equal(host().parentElement.id, 'chat-c'); assert.equal(h.requests.length, 1);
});

test('inert and contenteditable changes are detected', async t => {
    const h = setup(t); await h.tick(100); await h.respond(0, pro());
    const wrap = h.document.getElementById('chat-a');
    wrap.setAttribute('inert', ''); await h.tick(100); assert.equal(h.gauge('week'), undefined);
    wrap.removeAttribute('inert'); await h.tick(100); assert.equal(h.value('week'), '80%');
    const editor = wrap.querySelector('[contenteditable]');
    editor.setAttribute('contenteditable', 'false'); await h.tick(100); assert.equal(h.gauge('week'), undefined);
    editor.setAttribute('contenteditable', 'true'); await h.tick(100); assert.equal(h.value('week'), '80%');
});

test('unrelated mutations cause no composer scans or gauge writes; unchanged countdowns do not redraw', async t => {
    const h = setup(t, { html: '<aside id="sidebar"></aside>' + workForm('chat-a') });
    await h.tick(100); await h.respond(0, pro()); h.watchGauges();
    const before = { ...h.stats };
    for (let i = 0; i < 100; i++) {
        h.document.getElementById('sidebar').className = 'state-' + i;
        await h.tick(10);
    }
    assert.deepEqual(h.stats, before);
    await h.tick(14000); assert.equal(h.stats.gaugeMutations, 0);
});
