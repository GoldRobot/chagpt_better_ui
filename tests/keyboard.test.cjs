const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers.cjs');

function press(h, target, options = {}, type = 'keydown') {
    const event = new h.window.KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event;
}
function clickCount(h, selector) {
    let clicks = 0;
    h.document.querySelector(selector).addEventListener('click', event => {event.preventDefault(); clicks++;});
    return () => clicks;
}

for (const [name, markup, editorSelector] of [
    ['regular', '<form><div id="prompt-textarea" contenteditable="true"><span>Draft</span></div><button id="send" data-testid="send-button">Send</button></form>', '#prompt-textarea'],
    ['Work', '<form data-thread-find-composer><div data-composer-markdown role="textbox" contenteditable="true"><span>Draft</span></div><button id="send" type="submit" aria-label="Send">Send</button></form>', '[contenteditable]']
]) {
    test(`${name}: Enter replays Shift+Enter and Ctrl/Cmd+Enter sends once`, t => {
        const h = setup(t, { html: markup });
        const editor = h.document.querySelector(editorSelector);
        const replayed = [];
        for (const type of ['keydown', 'keyup']) {
            editor.addEventListener(type, event => {if(event.shiftKey) {replayed.push(event.type);}});
        }
        assert.equal(press(h, editor.querySelector('span')).defaultPrevented, true);
        assert.deepEqual(replayed, ['keydown', 'keyup']);
        const clicks = clickCount(h, '#send');
        press(h, editor, { ctrlKey: true }); press(h, editor, { ctrlKey: true, repeat: true });
        assert.equal(clicks(), 1);
        press(h, editor, { metaKey: true }); assert.equal(clicks(), 2);
        assert.equal(press(h, editor, {}, 'keypress').defaultPrevented, true);
        assert.equal(press(h, editor, {}, 'keyup').defaultPrevented, true);
    });
}

test('Shift/Alt+Enter and IME composition keep native handling', t => {
    const h = setup(t, { html: '<form><div id="prompt-textarea" contenteditable="true"></div></form>' });
    const editor = h.document.getElementById('prompt-textarea');
    for (const options of [{ shiftKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }]) {
        assert.equal(press(h, editor, options).defaultPrevented, false);
    }
});

test('unrelated Lexical editors and noneditable descendants are left alone', t => {
    const h = setup(t, { html: '<form><div id="other" data-lexical-editor="true" contenteditable="true"></div></form><div id="prompt-textarea" contenteditable="true"><span contenteditable="false" id="mention">Mention</span></div>' });
    for (const id of ['other', 'mention']) {
        assert.equal(press(h, h.document.getElementById(id)).defaultPrevented, false);
        assert.equal(press(h, h.document.getElementById(id), { ctrlKey: true }).defaultPrevented, false);
    }
});

test('specific send control takes priority over an earlier generic submit button', t => {
    const h = setup(t, { html: '<form><button id="generic" type="submit">Other action</button><div id="prompt-textarea" contenteditable="true"></div><button id="send" data-testid="send-button">Send</button></form>' });
    const generic = clickCount(h, '#generic'), send = clickCount(h, '#send');
    press(h, h.document.getElementById('prompt-textarea'), { ctrlKey: true });
    assert.equal(send(), 1); assert.equal(generic(), 0);
});

test('hidden controls are skipped; disabled Send does not fall back to another submit', t => {
    const h = setup(t, { html: '<form><button id="hidden" data-testid="send-button" style="display:none">Send</button><button id="disabled" data-testid="send-button" disabled>Send</button><div id="prompt-textarea" contenteditable="true"></div><button id="generic" type="submit">Other action</button></form>' });
    const hidden = clickCount(h, '#hidden'), generic = clickCount(h, '#generic'), send = clickCount(h, '#disabled');
    const editor = h.document.getElementById('prompt-textarea');
    press(h, editor, { ctrlKey: true });
    assert.equal(hidden(), 0); assert.equal(generic(), 0); assert.equal(send(), 0);
    h.document.getElementById('disabled').disabled = false;
    press(h, editor, { ctrlKey: true }); assert.equal(send(), 1);
});

test('missing local send controls never activate a different form or requestSubmit', t => {
    const h = setup(t, { html: '<form id="local"><div id="prompt-textarea" contenteditable="true"></div></form><form><button id="elsewhere" data-testid="send-button">Send</button></form>' });
    const elsewhere = clickCount(h, '#elsewhere'); let submissions = 0;
    h.document.getElementById('local').requestSubmit = () => {submissions++;};
    const editor = h.document.getElementById('prompt-textarea');
    press(h, editor, { ctrlKey: true });
    h.document.body.append(editor);
    press(h, editor, { ctrlKey: true });
    assert.equal(elsewhere(), 0); assert.equal(submissions, 0);
});
