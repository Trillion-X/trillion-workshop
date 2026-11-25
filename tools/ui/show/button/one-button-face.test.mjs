// A button face has one owner: tools/ui/show/button/Button.tsx, painted by the worn look. On Nov 24 2026 a school's sales page
// drew a green header button and a dark gradient call to action from the marketing page's own Button and CtaButton, beside
// the sign-in page's and the members area's button: three faces, three owners, each moved into the Workshop whole and never
// merged. This refuses a fourth. A face is a class-variance list named for a button, a component named ...Button that draws
// a raw button or anchor without the one Button, or a sheet rule for a ...-button, ...-btn or ...-cta class that paints a
// background. The faces still to move are faces-not-yet-moved.json, which may only shrink.
// Also: the face sheet a page without the Workshop's part sheet wears (./button-face-css.mjs) is painted by the look it is
// given, and only the Button wears it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buttonFaceCss } from './button-face-css.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..', '..');
const known = JSON.parse(readFileSync(path.join(here, 'faces-not-yet-moved.json'), 'utf8'));
const owner = 'tools/ui/show/button/';

const files = execFileSync('git', ['-C', repo, 'ls-files', '-c', 'tools'], { encoding: 'utf8', maxBuffer: 1 << 30 })
  .split('\n')
  .filter(file => /\.(tsx|jsx|ts|css|mjs|html)$/.test(file) && !file.startsWith(owner) && !/(^|\/)(node_modules|dist)\//.test(file) && !/\.(test|spec)\.[^.]+$/.test(file) && statSync(path.join(repo, file), { throwIfNoEntry: false })?.isFile());

const RAW_ELEMENT = /<(?:button|a)[\s>]/;
const USES_THE_BUTTON = /from\s+["'][^"']*(?:\/button\/Button|\/button\/index|\/button|coss\/ui\/button)["']/;

function componentFaces(file, text) {
  const lists = [...text.matchAll(/(?:const|let|var)\s+(\w*button\w*)\s*=\s*cva\(/gi)].map(match => match[1]);
  const components = RAW_ELEMENT.test(text) && !USES_THE_BUTTON.test(text) ? [...text.matchAll(/(?:function|const)\s+([A-Z]\w*Button)\b/g)].map(match => match[1]) : [];
  return [...lists, ...components];
}

function sheetFaces(text) {
  return [...text.matchAll(/\.([a-z][\w-]*-(?:button|btn|cta)(?:--[\w-]+)?)\s*(?:,[^{]*)?\{([^}]*)\}/g)].filter(match => /background/.test(match[2])).map(match => match[1]);
}

test('no button face is drawn outside the one Button but the ones still to move', () => {
  const found = { components: {}, sheets: {} };
  for (const file of files) {
    const text = readFileSync(path.join(repo, file), 'utf8');
    if (/\.(tsx|jsx|ts)$/.test(file)) { const faces = componentFaces(file, text); if (faces.length) found.components[file] = faces; }
    if (/\.(css|tsx|ts|mjs|html)$/.test(file)) { const faces = sheetFaces(text); if (faces.length) found.sheets[file] = faces; }
  }
  for (const kind of ['components', 'sheets']) {
    const fresh = Object.keys(found[kind]).filter(file => !(file in known[kind]));
    assert.deepEqual(fresh.map(file => `${file}: ${found[kind][file].join(', ')}`), [], `a new button face outside tools/ui/show/button/Button.tsx (${kind}). Draw it with the one Button: variant and size for its face, href for a link, render for another element. Never add it to faces-not-yet-moved.json.`);
    const moved = Object.keys(known[kind]).filter(file => !(file in found[kind]));
    assert.deepEqual(moved, [], `these no longer draw their own button face: take them out of faces-not-yet-moved.json (${kind}), so the list shrinks.`);
  }
});

test('the check finds a face of each kind it refuses', () => {
  assert.deepEqual(componentFaces('x.tsx', "export function CtaButton({ href }) { return <a href={href}>Go</a>; }"), ['CtaButton']);
  assert.deepEqual(componentFaces('x.tsx', "const buttonVariants = cva('a', {});"), ['buttonVariants']);
  assert.deepEqual(componentFaces('x.tsx', "import { Button } from '../button/Button';\nexport function SaveButton() { return <Button>Save</Button>; }"), []);
  assert.deepEqual(sheetFaces('.site-header-cta { background: #008652; } .page-cta { color: red; }'), ['site-header-cta']);
});

test("the face sheet is painted by the look it is given, and only the Button wears it", async () => {
  const look = ':root{--button-primary-bg:#123456;--button-primary-text:#fff;--radius-control:9px;--surface-base:#eee}';
  const css = await buttonFaceCss({ lookCss: look });
  const worn = css.match(/:where\(\[data-button-face\]\)\{([^}]*)\}/)?.[1] ?? '';
  assert.match(worn, /--button-primary-bg:#123456/);
  assert.match(worn, /--radius-control:9px/);
  assert.doesNotMatch(worn, /--surface-base/, 'a look name the face never reads stays off the page');
  assert.doesNotMatch(css, /(^|[\n}])\s*:root\s*\{[^}]*--button-primary-bg/, 'the look is never set on the page root');
  assert.match(css, /bg-\\\[var\\\(--button-primary-bg\\\)\\\]/, 'the strong face is compiled');
  const other = await buttonFaceCss({ lookCss: ':root{--button-primary-bg:#abcdef}' });
  assert.match(other, /--button-primary-bg:#abcdef/, "another site's look gives its own colour");
  await assert.rejects(() => buttonFaceCss({ lookCss: '' }), /look CSS/);
});
