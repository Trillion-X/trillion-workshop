// The look resolver answers concrete values and a stylesheet that carries only the faces the look names, from a made-up
// look and made-up face bytes (no one person's look or font is in the repository).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lookDocumentCss, lookFontFacesCss, lookVariablesCss } from '../read-data/look-document-css.js';

const command = resolve(import.meta.dirname, '../do-work/resolve-a-look.mjs');

const look = {
  id: 'harbour',
  name: 'Harbour',
  tokens: [
    { key: 'black-pure', kind: 'color', value: '#eef2f0', css_variable: '--black-pure' },
    { key: 'text-primary', kind: 'color', value: '#1d2b2a', css_variable: '--text-primary' },
    { key: 'accent-primary', kind: 'color', value: '#0f7a6b', css_variable: '--accent-primary' },
    { key: 'displayFontFamily', kind: 'text', value: 'Tidewater Serif' },
    { key: 'defaultPrimaryFontFamily', kind: 'text', value: 'Quay Sans' },
  ],
};

test('a look resolves to concrete values, and a face the look does not name is left out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'screen-looks-'));
  writeFileSync(join(dir, 'tidewater.woff2'), Buffer.from('made-up face bytes'));
  writeFileSync(join(dir, 'unused.woff2'), Buffer.from('another face'));
  writeFileSync(join(dir, 'request.json'), JSON.stringify({
    look,
    faces: [
      { family: 'Tidewater Serif', weight: 600, file: 'tidewater.woff2' },
      { family: 'Not In The Look', file: 'unused.woff2' },
      { family: 'Quay Sans', file: 'missing.woff2' },
    ],
  }));
  const out = JSON.parse(execFileSync(process.execPath, [command, join(dir, 'request.json'), '--css', join(dir, 'look.css')], { encoding: 'utf8' }).trim().split('\n').pop());
  assert.equal(out.palette['--accent-primary'], '#0f7a6b');
  assert.deepEqual(out.faces_written, ['Tidewater Serif 600 normal']);
  assert.deepEqual(out.faces_missing, ['missing.woff2']);
  const css = readFileSync(join(dir, 'look.css'), 'utf8');
  assert.match(css, /@font-face\{font-family:'Tidewater Serif';src:url\(data:font\/woff2;base64,/);
  assert.doesNotMatch(css, /Not In The Look/);
  assert.match(css, /:root\{[^}]*--accent-primary:#0f7a6b/);
});

test('a value that could end the rule or the style element is never written', () => {
  const css = lookVariablesCss({ '--good': '#123456', '--bad': 'red;}</style>', '--worse': 'url(x)', 'not-a-variable': '#000' });
  assert.equal(css, ':root{--good:#123456}');
});

test('a face with an unsafe family or data is refused', () => {
  const palette = { '--font-display': 'Evil, serif' };
  assert.equal(lookFontFacesCss(palette, [{ family: 'Evil', data: 'abc";}' }]), '');
  assert.equal(lookFontFacesCss({ '--font-display': "x'}, serif" }, [{ family: "x'}", data: 'AAAA' }]), '');
  assert.match(lookDocumentCss(palette, [{ family: 'Evil', data: 'AAAA' }]), /^@font-face/);
});

test('a request without look tokens says what to send', () => {
  const dir = mkdtempSync(join(tmpdir(), 'screen-looks-'));
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ look: {} }));
  assert.throws(() => execFileSync(process.execPath, [command, join(dir, 'request.json')], { stdio: 'pipe' }), /look\.tokens/);
});
