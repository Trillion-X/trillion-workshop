// tools/what-a-paste-becomes/show/paste-sources.ts in a real browser: a paste from another editor keeps its structure by that
// source's rules falling through to the default ones (show/paste-sources.json). The conversion assertions are Trillion-X/trillion
// test/paste-and-row-clipboard-browser.test.mjs's, moved unchanged; its document editor, composer and board clipboard checks stay
// with those callers in Trillion. The file is loaded as the page's own module (types stripped by Node), so nothing is bundled.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { launchChromium } from '../../../test-helpers/chromium.mjs';

const source = readFileSync(new URL('../show/paste-sources.ts', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../show/paste-sources.json', import.meta.url), 'utf8');
const moduleText = `${stripTypeScriptTypes(source).replace(/^import settings from .*$/m, `const settings = ${settings};`)}
window.__paste = { pastedMarkdown, pasteSourceOf, tableRows };`;

const GOOGLE_DOCS = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-12ab"><h2 dir="ltr"><span>Launch plan</span></h2><p dir="ltr"><span style="font-weight:700;">Owner</span><span> is Ada</span></p><ul><li><p>First</p></li><li><p>Second</p></li></ul></b>';
const WORD = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><body><p class="MsoListParagraph"><span style="mso-list:Ignore">·<span>&nbsp;</span></span>Buy milk<o:p></o:p></p><p class="MsoNormal">Plain line</p></body></html>';
const NOTION = '<!-- notionvc: 0c1f --><details><summary>Toggle</summary><p>Hidden words</p></details><p>See <a href="https://example.com/doc">the doc</a></p>';

test('pastes from other editors keep their structure', { timeout: 90_000 }, async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '' }));
    await page.goto('http://localhost/paste');
    await page.addScriptTag({ content: moduleText, type: 'module' });
    await page.waitForFunction(() => Boolean(window.__paste));
    const converted = await page.evaluate(([google, word, notion]) => ({
      google: window.__paste.pastedMarkdown(google), word: window.__paste.pastedMarkdown(word), notion: window.__paste.pastedMarkdown(notion),
      plain: window.__paste.pastedMarkdown('<p>Just words</p>'), empty: window.__paste.pastedMarkdown('   '),
      script: window.__paste.pastedMarkdown('<p>ok</p><script>window.__ran = true</script>'), ran: Boolean(window.__ran),
      table: window.__paste.tableRows('<table><tr><th>Name</th><th>Size</th></tr><tr><td>A</td><td><b>2</b></td></tr></table>'),
      noTable: window.__paste.tableRows('<p>none</p>'),
    }), [GOOGLE_DOCS, WORD, NOTION]);
    assert.equal(converted.google.source, 'google-docs');
    assert.equal(converted.google.markdown, '## Launch plan\n\n**Owner** is Ada\n\n- First\n- Second', 'the wrapping <b> is not bold; the bold span is');
    assert.equal(converted.word.source, 'microsoft-word');
    assert.equal(converted.word.markdown, '- Buy milk\n\nPlain line', 'the bullet glyph Word marks to ignore is dropped');
    assert.equal(converted.notion.source, 'notion');
    assert.match(converted.notion.markdown, /\*\*Toggle\*\*\n+Hidden words/);
    assert.match(converted.notion.markdown, /See \[the doc\]\(https:\/\/example\.com\/doc\)/);
    assert.deepEqual(converted.plain, { source: null, markdown: 'Just words' }, 'an editor no signature names falls to the default rules');
    assert.equal(converted.empty, null, 'nothing to read keeps the plain text');
    assert.equal(converted.script.markdown, 'ok');
    assert.equal(converted.ran, false, 'nothing pasted is ever run');
    assert.equal(converted.table[0][0], 'Name');
    assert.equal(converted.table.length, 2);
    assert.equal(converted.noTable, null);
  } finally { await browser.close(); }
});
