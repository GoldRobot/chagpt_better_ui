const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers.cjs');

test('link rules cover assistant/user/citation/file anchors and exclude navigation/buttons', async t => {
    const h = setup(t, { html: `
        <nav><a id="nav" href="/">Navigation</a></nav>
        <div data-markdown-text-style="assistant-message">
          <a id="plain" href="https://example.com">Plain</a>
          <a id="citation" data-testid="chatgpt-citation" href="https://example.com">Source</a>
          <a id="file" href="/library?file_id=example">Example file</a>
          <a id="button" role="button" href="#">Action</a>
          <a id="nested" href="https://example.com"><span id="accent" data-appearance="inline-mention" style="color:green">Accent</span></a>
        </div>
        <div data-markdown-text-tone="user-message"><a id="user" href="https://example.com">User</a></div>
        <div data-message-author-role="assistant"><div class="markdown"><a id="regular" href="https://example.com">Regular</a></div></div>
    ` });
    await h.tick();
    const style = h.document.getElementById('tm-chat-message-link-styles');
    assert.ok(style?.sheet);
    const rules = [...style.sheet.cssRules];
    const underline = rules.find(rule => rule.style?.getPropertyValue('text-decoration-line') === 'underline');
    for (const id of ['plain', 'citation', 'file', 'accent', 'user', 'regular']) {
        assert.equal(h.document.getElementById(id).matches(underline.selectorText), true, id);
    }
    for (const id of ['nav', 'button', 'nested']) {
        assert.equal(h.document.getElementById(id).matches(underline.selectorText), false, id);
    }
    assert.match(underline.style.getPropertyValue('background-color'), /currentColor/i);
    const outer = rules.find(rule => rule.style?.getPropertyValue('background-color') === 'transparent');
    assert.equal(h.document.getElementById('nested').matches(outer.selectorText), true);
    // A CSS rule, not a one-time node rewrite, covers new streamed messages.
    h.document.querySelector('[data-markdown-text-style]').insertAdjacentHTML('beforeend', '<a id="later" href="https://example.com">Later</a>');
    assert.equal(h.document.getElementById('later').matches(underline.selectorText), true);
    assert.equal(h.document.getElementById('plain').href, 'https://example.com/');
});
