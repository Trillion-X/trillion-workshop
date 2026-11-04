// test/screen-look-design-tokens.test.mjs
// The design tokens a look carries (F-0286 density, F-0287 focus ring, F-0288 ink, F-0289 placeholders that wait,
// F-0290 radius ladder, F-0291 motion and view transitions), resolved by the one palette resolver and proved in a real
// browser: computed styles, and screenshots written to TRILLION_LOOK_PROOF_DIR when it is set.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { launchChromium } from '../../headless-browser/launch.mjs';
import looks from '../src/workspace/looks.json' with { type: 'json' };
import { resolveScreenLookPalette } from '../../screen-look/read-data/resolve-screen-look-palette.js';

const root = new URL('..', import.meta.url).pathname;
const proof = process.env.TRILLION_LOOK_PROOF_DIR;
const theme = id => looks.themes.find(row => row.payload.id === id).payload;
const withToken = (payload, key, value) => ({ ...payload, tokens: payload.tokens.map(token => (token.key === key ? { ...token, value } : token)) });
const css = name => readFileSync(join(root, 'parts/screen-look/show', name), 'utf8');

test('density is one multiplier over every space, control height and icon', () => {
  const standard = resolveScreenLookPalette(theme('trillion'));
  const compact = resolveScreenLookPalette(withToken(theme('trillion'), 'density', 'compact'));
  const comfortable = resolveScreenLookPalette(withToken(theme('trillion'), 'density', 'comfortable'));
  assert.equal(standard['--density-scale'], '1');
  assert.equal(standard['--control-height-md'], '32px');
  assert.equal(compact['--control-height-md'], '28px');
  assert.equal(comfortable['--control-height-md'], '36px');
  assert.equal(parseFloat(comfortable['--space-4']) / parseFloat(standard['--space-4']), 1.125);
  assert.equal(resolveScreenLookPalette(withToken(theme('trillion'), 'density', 'nonsense'))['--density-scale'], '1');
  console.log('density readback', JSON.stringify({ standard: standard['--space-4'], compact: compact['--space-4'], comfortable: comfortable['--space-4'] }));
});

test('the radius ladder is a fixed ladder times the one corner control, and the ink ladder follows the look text', () => {
  const small = resolveScreenLookPalette(withToken(theme('trillion'), 'defaultBorderRadius', 8));
  const large = resolveScreenLookPalette(withToken(theme('trillion'), 'defaultBorderRadius', 24));
  assert.equal(small['--radius-3xl'], '8px');
  assert.equal(large['--radius-3xl'], '24px');
  assert.equal(large['--corner-radius-scale'], '1.5');
  const steps = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl'].map(step => parseFloat(large[`--radius-${step}`]));
  assert.deepEqual([...steps].sort((a, b) => a - b), steps);
  const trillion = resolveScreenLookPalette(theme('trillion')), black = resolveScreenLookPalette(theme('trillion-black'));
  assert.notEqual(trillion['--ink-5'], black['--ink-5']);
  assert.equal(trillion['--text-secondary'], trillion['--ink-8']);
  console.log('radius readback', JSON.stringify({ r8: small['--radius-3xl'], r24: large['--radius-3xl'], scale: large['--corner-radius-scale'] }));
});

// Every wait on the page is bounded: page.evaluate has no timeout of its own, and a page-side promise that never settles
// (a timer callback that threw, for one) would hold the shared browser for ever. The hang this replaced was exactly that:
// a timer read an element that a second mount into a cleared host had never drawn.
const WAIT_MS = 10000;
const bounded = (promise, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${WAIT_MS}ms: ${label}`)), WAIT_MS).unref())]);
const ask = (page, label, fn, arg) => bounded(page.evaluate(fn, arg), label);

async function inPage(check) {
  const { outputFiles } = await build({
    absWorkingDir: root,
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import { resolveScreenLookPalette } from './parts/screen-look/read-data/resolve-screen-look-palette.js';
      import looks from './src/workspace/looks.json';
      import { mountScreenState } from './parts/ui/show/screen-state';
      import { withViewTransition } from './src/workspace/view-transition.mjs';
      window.wear = (id, overrides = {}) => {
        const payload = looks.themes.find(row => row.payload.id === id).payload;
        const tokens = payload.tokens.map(token => (token.key in overrides ? { ...token, value: overrides[token.key] } : token));
        const palette = resolveScreenLookPalette({ ...payload, tokens });
        for (const [name, value] of Object.entries(palette)) document.documentElement.style.setProperty(name, value);
      };
      window.loading = () => { document.getElementById('host').replaceChildren(); const host = document.createElement('div'); document.getElementById('host').append(host); mountScreenState(host, { status: 'loading', label: 'Loading the things', layout: 'rows' }); };
      window.crossfade = change => withViewTransition(change);
    ` },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': 'document.baseURI' },
    loader: { '.css': 'empty', '.wasm': 'empty' }, external: ['node:*'], logLevel: 'error',
    plugins: [{ name: 'no-tours', setup(builder) {
      builder.onResolve({ filter: /^trillion-walkthroughs$/ }, () => ({ path: 'tours', namespace: 'no-tours' }));
      builder.onLoad({ filter: /.*/, namespace: 'no-tours' }, () => ({ contents: 'export default [];', loader: 'js' }));
    } }],
  });
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 420 } });
    page.setDefaultTimeout(WAIT_MS);
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${css('surfaces.css')}\n${css('media-loading.css')}\n${css('loading-mark.css')}\nbody{font:14px system-ui;background:var(--bg-primary);color:var(--text-primary);margin:16px}.primary{background:var(--button-primary-bg);color:var(--button-primary-text);border:0;border-radius:var(--radius-control);height:var(--control-height-md);padding:0 var(--space-4);font:inherit}.row{display:flex;gap:var(--space-3);align-items:center}</style></head><body><div class="row"><button class="primary" id="go">Open</button><button class="primary" id="plain" style="background:transparent;color:inherit;border:1px solid var(--border-primary)">Later</button></div><div id="host" style="margin-top:12px"></div></body></html>` }));
    await page.goto('http://localhost/');
    await page.addScriptTag({ content: outputFiles[0].text });
    await check(page);
  } finally { await browser.close(); }
}
const shot = (page, name) => proof ? (mkdirSync(proof, { recursive: true }), page.screenshot({ path: join(proof, `${name}.png`) })) : null;

test('the focus ring reads on the accent-filled primary button in every look', { timeout: 60000 }, async () => {
  await inPage(async page => {
    for (const id of ['trillion', 'trillion-black', 'midnight', 'paper']) {
      await ask(page, 'page step', look => window.wear(look), id);
      await page.keyboard.press('Tab');
      const seen = await ask(page, 'page step', () => {
        const button = document.getElementById('go'); button.focus({ focusVisible: true });
        const style = getComputedStyle(button), root = getComputedStyle(document.documentElement);
        return { outline: style.outlineColor, fill: style.backgroundColor, width: style.outlineWidth, ring: root.getPropertyValue('--focus-ring-color').trim(), ink: root.getPropertyValue('--text-primary').trim() };
      });
      assert.notEqual(seen.outline, seen.fill, `${id}: the ring is not the fill`);
      assert.equal(seen.width, '2px');
      if (id === 'trillion') {
        // Before: the ring drawn in the accent, the old border-focus (the same red as the button fill, so it vanished).
        await ask(page, 'page step', () => { document.documentElement.style.setProperty('--focus-ring-color', 'var(--accent-primary)'); document.getElementById('go').blur(); document.getElementById('go').focus({ focusVisible: true }); });
        await shot(page, 'focus-ring-trillion-before-accent-ring');
        await ask(page, 'page step', () => { document.documentElement.style.removeProperty('--focus-ring-color'); window.wear('trillion'); document.getElementById('go').blur(); document.getElementById('go').focus({ focusVisible: true }); });
        await shot(page, 'focus-ring-trillion-after-ink-ring');
      }
      console.log('focus readback', id, JSON.stringify(seen));
    }
  });
});

test('density changes the real controls, and the corner scale moves the ladder', { timeout: 60000 }, async () => {
  await inPage(async page => {
    const heights = {};
    for (const density of ['compact', 'standard', 'comfortable']) {
      await ask(page, 'page step', value => window.wear('trillion', { density: value }), density);
      heights[density] = await ask(page, 'page step', () => document.getElementById('go').getBoundingClientRect().height);
      await shot(page, `density-${density}`);
    }
    assert.deepEqual(heights, { compact: 28, standard: 32, comfortable: 36 });
    console.log('density heights', JSON.stringify(heights));
  });
});

test('a loading block waits the look\'s reveal delay, then shows; reduced motion only shortens the animation', { timeout: 60000 }, async () => {
  await inPage(async page => {
    await ask(page, 'page step', () => window.wear('trillion'));
    assert.equal(await ask(page, 'page step', () => getComputedStyle(document.documentElement).getPropertyValue('--placeholder-reveal-delay').trim()), '300ms');
    await ask(page, 'page step', () => window.loading());
    const opacityAt = ms => ask(page, `opacity at ${ms}ms`, wait => new Promise(done => setTimeout(() => {
      const block = document.querySelector('.shared-media-loading');
      done(block ? Number(getComputedStyle(block).opacity) : -1);
    }, wait)), ms);
    const early = await opacityAt(60);
    await shot(page, 'placeholder-at-60ms-before-reveal');
    const late = await opacityAt(900);
    await shot(page, 'placeholder-at-960ms-after-reveal');
    assert.equal(early, 0, 'nothing shows before the reveal delay');
    assert.ok(late > 0.5, `the block has appeared (${late})`);
    // A slower look reveals later: the delay is the look's, not a literal.
    await ask(page, 'slower look', () => { document.documentElement.style.setProperty('--placeholder-reveal-delay', '2s'); window.loading(); });
    assert.equal(await opacityAt(700), 0, 'a look with a 2s delay still shows nothing at 700ms');
    console.log('placeholder readback', JSON.stringify({ early, late }));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await ask(page, 'page step', () => getComputedStyle(document.documentElement).getPropertyValue('--motion-scale').trim()), '0.001');
    assert.equal(await ask(page, 'page step', () => (document.querySelector('[data-slot=skeleton]') ? getComputedStyle(document.querySelector('[data-slot=skeleton]')).animationName : 'missing')), 'none');
  });
});

test('a screen change crossfades through a view transition when motion is wanted, and always runs', { timeout: 60000 }, async () => {
  await inPage(async page => {
    await ask(page, 'page step', () => window.wear('trillion'));
    const result = await ask(page, 'page step', async () => {
      let ran = 0;
      const transition = window.crossfade(() => { ran += 1; document.getElementById('host').textContent = 'Second screen'; });
      if (transition) await Promise.race([transition.finished, new Promise((_, no) => setTimeout(() => no(new Error('view transition never finished')), 8000))]);
      return { ran, animated: Boolean(transition), text: document.getElementById('host').textContent, duration: getComputedStyle(document.documentElement).getPropertyValue('--motion-sheet').trim() };
    });
    assert.deepEqual({ ran: result.ran, text: result.text }, { ran: 1, text: 'Second screen' });
    assert.equal(result.animated, true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await ask(page, 'page step', () => { let ran = 0; const transition = window.crossfade(() => { ran += 1; }); return { ran, animated: Boolean(transition) }; });
    assert.deepEqual(reduced, { ran: 1, animated: false });
    console.log('view transition readback', JSON.stringify({ wanted: result, reduced }));
  });
});

test('F-0292: on a dark look raised surfaces are lighter steps with a lit hairline, not black shadows on black', { timeout: 60000 }, async () => {
  await inPage(async page => {
    await ask(page, 'cards', () => {
      window.wear('trillion-black');
      const host = document.getElementById('host');
      for (const [name, style] of [['before', 'background:var(--bg-primary);box-shadow:0 8px 32px rgba(0,0,0,.6)'], ['after', 'background:var(--surface-2);box-shadow:var(--elevation-2);border-radius:var(--radius-card)']]) {
        const card = document.createElement('div');
        card.id = `card-${name}`; card.textContent = name === 'before' ? 'Before: black shadow on black' : 'After: surface step, lit edge';
        card.setAttribute('style', `${style};padding:24px;margin:16px 0;border-radius:12px;color:var(--text-primary)`);
        host.append(card);
      }
    });
    const seen = await ask(page, 'read cards', () => {
      const root = getComputedStyle(document.documentElement);
      return { ground: root.getPropertyValue('--bg-primary').trim(), step1: root.getPropertyValue('--surface-1').trim(), step3: root.getPropertyValue('--surface-3').trim(), edge: root.getPropertyValue('--surface-edge').trim(), shadow: getComputedStyle(document.getElementById('card-after')).boxShadow, fill: getComputedStyle(document.getElementById('card-after')).backgroundColor, groundFill: getComputedStyle(document.body).backgroundColor };
    });
    assert.notEqual(seen.fill, seen.groundFill, 'the raised card is a lighter step than the ground');
    assert.match(seen.shadow, /inset/, 'the card carries a lit top edge');
    assert.match(seen.edge, /rgba\(255, 255, 255, 0\.08\)|rgba\(255,255,255,0\.08\)/);
    await shot(page, 'dark-elevation-before-after');
    console.log('elevation readback', JSON.stringify(seen));
  });
});

test('F-0293: a type role carries size, line height, tracking and weight together', { timeout: 60000 }, async () => {
  await inPage(async page => {
    const seen = await ask(page, 'type role', () => {
      window.wear('trillion');
      const host = document.getElementById('host');
      const title = document.createElement('p');
      title.id = 'role';
      title.textContent = 'A title set from one role';
      title.setAttribute('style', 'font-size:var(--type-title-1-size);line-height:var(--type-title-1-leading);letter-spacing:var(--type-title-1-tracking);font-weight:var(--type-title-1-weight);margin:0');
      const body = document.createElement('p');
      body.id = 'body-role';
      body.textContent = 'Body text set from its own role, with its own leading and tracking.';
      body.setAttribute('style', 'font-size:var(--type-body-size);line-height:var(--type-body-leading);letter-spacing:var(--type-body-tracking);font-weight:var(--type-body-weight)');
      host.append(title, body);
      const read = id => { const style = getComputedStyle(document.getElementById(id)); return { size: style.fontSize, line: style.lineHeight, tracking: style.letterSpacing, weight: style.fontWeight }; };
      return { title: read('role'), body: read('body-role'), vars: getComputedStyle(document.documentElement).getPropertyValue('--type-title-1-tracking').trim() };
    });
    assert.equal(seen.title.weight, '600');
    assert.notEqual(seen.title.tracking, 'normal');
    assert.ok(parseFloat(seen.title.tracking) < 0, 'larger roles tighten');
    assert.notEqual(seen.title.line, seen.body.line);
    await shot(page, 'type-roles');
    console.log('type role readback', JSON.stringify(seen));
  });
});
