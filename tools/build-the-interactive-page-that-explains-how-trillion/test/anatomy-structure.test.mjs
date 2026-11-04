import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { plateHtml } from '../parts/ui/show/anatomy/iso-kit.mjs';
import { explainerPage, explainerScript } from '../parts/ui/show/anatomy/explainer-page.mjs';
import { selectorMachine } from '../parts/ui/show/anatomy/selector-machine.mjs';

const data = JSON.parse(readFileSync(new URL('../records/trillion-anatomy-explainer.json', import.meta.url), 'utf8'));

test('figure renderer refuses decorative fields instead of silently displaying or dropping them', () => {
 const body = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" role="img" aria-label="A force changing a spring"><g><path class="iso-line" d="M0 0L8 8"/><text aria-label="Teaching label">Force &amp; response</text></g></svg>';
 for (const field of ['fig','title','hint','readout','keys','caption','eyebrow','subtitle','helperText']) {
  assert.throws(() => plateHtml({ body, [field]: 'The ball and strings deform together during contact. This is an illustrative model, with deformation exaggerated to make the interaction visible.' }), /Unsupported figure fields/);
 }
 const html = plateHtml({ body, label: 'Ball and strings' });
 assert.match(html, /aria-label="Ball and strings"/);
 assert.match(html, /A force changing a spring/);
 assert.match(html, /Force &amp; response/);
 assert.doesNotMatch(html, /figcaption|iso-plate-corner|iso-legend/);
});

test('figure body boundary rejects non-SVG structure and active markup, then accepts valid teaching SVG', () => {
 const good = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" role="img" aria-label="A stage model"><g><path class="iso-line" d="M0 0L8 8"/><text aria-label="Stage label">Place the card &amp; select a tool</text></g></svg>';
 for (const body of [
  '<figcaption>Synthetic forbidden caption</figcaption>',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" role="img" aria-label="Model"><figcaption>Synthetic forbidden caption</figcaption></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" role="img" aria-label="Model" onload="run()"></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" role="img" aria-label="Model"><foreignObject><p>HTML</p></foreignObject></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" role="img" aria-label="Model"><path d="M0 0" onmouseover="run()"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" role="img" aria-label="Model"><g></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" role="img" aria-label="Model"><path d="M0 0" style="stroke:url(https://example.invalid/paint)"/></svg>',
 ]) assert.throws(() => plateHtml({ body }), /passive anatomy vocabulary/);
 const rendered = plateHtml({ body: good });
 assert.match(rendered, /aria-label="A stage model"/);
 assert.match(rendered, /aria-label="Stage label"/);
 assert.match(rendered, /Place the card &amp; select a tool/);
});

test('plate preserves the physical renderer passive vocabulary without requiring a local pilot or upstream checkout', () => {
 const body = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 760" role="img" aria-label="Racket contact"><defs><filter id="shadow"><feGaussianBlur stdDeviation="6"/></filter><radialGradient id="felt-sphere" cx="31%" cy="25%" r="73%"><stop offset="0" stop-color="#e5ef98"/><stop offset="1" stop-color="#5a702e"/></radialGradient></defs><ellipse cx="30" cy="40" rx="12" ry="4" fill="#182920" opacity=".2" filter="url(#shadow)"/><g class="graphite" data-part="hoop"><path d="M0 0L8 8" fill="none" stroke="#f4f3c4" stroke-width="2.4" stroke-linecap="round"/></g></svg>';
 const html = plateHtml({ body });
 assert.ok(html.includes(body));
 assert.match(html, /filter="url\(#shadow\)"/);
 assert.match(html, /data-part="hoop"/);
});

test('the actual explainer consumer retains its teaching and controls with no secondary copy slots', () => {
 const machine = selectorMachine();
 const html = explainerPage(data, machine);
 assert.match(html, /data-phase="0"/);
 assert.ok(html.includes(data.phases[0].copy));
 assert.ok(html.includes(data.sections[0].copy));
 assert.match(html, /aria-live="polite"/);
 assert.doesNotMatch(html, /figcaption|iso-plate-corner|data-readout|Choose a stage|class="promise"|class="intro"/);
 assert.doesNotThrow(() => new Function(explainerScript(data, machine)));
 for (const field of ['caption','figure_title','promise','intro','eyebrow','subtitle','helperText']) {
  assert.throws(() => explainerPage({ ...data, [field]: 'Extra copy' }, machine), /Unsupported explainer fields/);
 }
 for (const part of ['example','phases','sections']) {
  const altered = structuredClone(data);
  const target = Array.isArray(altered[part]) ? altered[part][0] : altered[part];
  target.subtitle = 'Extra copy';
  assert.throws(() => explainerPage(altered, machine), /Unsupported .* fields/);
 }
});
