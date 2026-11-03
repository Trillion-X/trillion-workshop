// The docs site builder (parts/docs-site) works for a product that has nothing to do with Trillion, refuses a broken
// manifest with every problem in plain words, and never names a product of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDocsSite } from '../parts/docs-site/do-work/build-docs-site.mjs';

const manifest = {
  site: { name: 'Harbour Rowing Club', description: 'Training plans, boat bookings and safety for members.', url: 'https://docs.harbourrowing.example/', navbar: { primary: { label: 'Book a boat', href: 'https://harbourrowing.example/book' } } },
  navigation: [
    { tab: 'Members', groups: [{ group: 'Start', pages: ['index', 'safety/capsize'] }] },
    { tab: 'Coaches', groups: [{ group: 'Plans', pages: ['plans/winter'] }] },
  ],
  pages: [
    { route: 'index', title: 'Welcome', description: 'What to do on your first morning.', body: 'Arrive ten minutes early.' },
    { route: 'safety/capsize', title: 'If you capsize', description: 'Stay with the boat.', body: '<Steps>\n  <Step title="Stay with the boat">It floats.</Step>\n</Steps>' },
    { route: 'plans/winter', title: 'Winter plan', description: 'Eight weeks of base fitness.', body: 'Three sessions a week.' },
  ],
  palettes: { light: { sea: '#0369a1', paper: '#f8fafc' }, dark: { sea: '#38bdf8', paper: '#020617' } },
  roles: { accent: 'sea', page: 'paper' },
  variable_prefix: 'harbour',
};

test('any manifest becomes every file of a Mintlify site', () => {
  const { files, problems } = buildDocsSite(manifest);
  assert.deepEqual(problems, []);
  const byPath = Object.fromEntries(files.map(file => [file.path, file.text]));
  assert.deepEqual(Object.keys(byPath).sort(), ['docs.json', 'index.mdx', 'llms.txt', 'plans/winter.mdx', 'safety/capsize.mdx', 'theme.css', 'theme.js']);
  const docs = JSON.parse(byPath['docs.json']);
  assert.equal(docs.name, 'Harbour Rowing Club');
  assert.equal(docs.colors.primary, '#0369a1');
  assert.deepEqual(docs.background.color, { light: '#f8fafc', dark: '#020617' });
  assert.deepEqual(docs.navigation.tabs.map(tab => tab.tab), ['Members', 'Coaches']);
  assert.match(byPath['theme.css'], /--harbour-sea: #0369a1;/);
  assert.match(byPath['llms.txt'], /- \[If you capsize\]\(https:\/\/docs\.harbourrowing\.example\/safety\/capsize\): Stay with the boat\./);
  assert.match(byPath['safety/capsize.mdx'], /^---\ntitle: "If you capsize"\ndescription: "Stay with the boat."\n---\n\n<Steps>/);
  assert.deepEqual(buildDocsSite(manifest), buildDocsSite(manifest), 'the same manifest always gives the same files');
});

test('a broken manifest gets every problem at once and no files', () => {
  const { files, problems } = buildDocsSite({ site: { name: 'x' }, navigation: [{ tab: 'T', groups: [{ group: 'G', pages: ['a', 'a', 'Bad Route'] }] }], pages: [{ route: 'a', title: 'A' }], palettes: { light: { c: '#000' } }, roles: { accent: 'c' } });
  assert.deepEqual(files, []);
  for (const expected of ['site.description is missing', 'site.url is missing', 'a is listed more than once', 'a has no description', 'a has no body', 'Bad Route is not a page address', 'palettes.dark is missing', 'roles.page is missing']) {
    assert.ok(problems.some(problem => problem.startsWith(expected)), `${expected}: ${problems.join(' | ')}`);
  }
});

test('the builder names no product of its own', () => {
  const source = readFileSync(new URL('../parts/docs-site/do-work/build-docs-site.mjs', import.meta.url), 'utf8').replace(/^\/\/.*$/gm, '');
  assert.doesNotMatch(source, /trillion|needle|gettrillion/i);
});
