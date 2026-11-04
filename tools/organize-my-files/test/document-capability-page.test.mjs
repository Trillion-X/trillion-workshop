import test from 'node:test';
import assert from 'node:assert/strict';
import { documentPageHtml } from '../parts/ui/show/document-page/document-page-html.mjs';
import { placedCapabilityCss } from '../../screen-look/show/public-app-capability.mjs';

test('a public form composes into the real document frame without owning controls', () => {
  const html = documentPageHtml({title:'Contact',article:{title:'Get in touch',markdown:'<script>private</script>'},placements:['contact-form','contact-form']});
  assert.equal((html.match(/data-trillion-placement=/g)||[]).length,1);
  assert.match(html, /id="contact-form" data-trillion-placement="contact-form"/);
  assert.match(html, /src="\/capabilities\/runtime.js"/);
  assert.doesNotMatch(html, /<input|<textarea|<script>private/);
  assert.match(html, /&lt;script&gt;private/);
  assert.ok(html.indexOf('data-trillion-placement') < html.indexOf('</main>'));
});

test('untrusted mount names cannot become markup or script addresses', () => {
  for(const id of ['../private','a" onclick="x','https://other.test','x','a'.repeat(81)]) {
    assert.throws(()=>documentPageHtml({placements:[id]}),TypeError);
  }
  assert.doesNotMatch(documentPageHtml({placements:[]}),/capabilities\/runtime/);
});

test('the same capability surface inherits the consuming look in every state', () => {
  for(const token of ['--text-primary','--text-secondary','--bg-surface','--border-primary','--border-focus','--error-text']) assert.ok(placedCapabilityCss.includes(`var(${token},`));
});
