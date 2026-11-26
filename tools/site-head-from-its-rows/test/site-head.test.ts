import test from 'node:test';
import assert from 'node:assert/strict';
import { siteHeadMarkup, siteHeadProblems, withSiteHead, type SiteHeadData } from '../do-work/site-head.ts';
import { readSiteHead } from '../reads/read-the-site-head.ts';

const data = (): SiteHeadData => ({
  purposes: { measure: 'Measure visits', ads: 'Run advertising tags' },
  consent: {
    default: 'denied',
    storage_types: ['analytics_storage', 'ad_storage'],
    cookie: { name: 'site_consent', max_age_seconds: 31536000 },
    banner: { label: 'Cookie choice', message: 'We measure visits and run advertising tags only if you accept.', accept: 'Accept', decline: 'Decline' },
  },
  head: [{ kind: 'inline', purpose: 'measure', text: 'window.example=1;' }, { kind: 'script', purpose: 'ads', src: 'https://tags.example/t.js' }],
  body_start: [{ kind: 'noscript', purpose: 'ads', src: 'https://tags.example/ns' }],
});

test('the consent default is the first script in the head, then the style, the declared parts in order, then the bar', () => {
  const { head, bodyStart } = siteHeadMarkup(data());
  const at = (needle: string) => head.indexOf(needle);
  assert.ok(at("gtag('consent','default'") > -1);
  assert.ok(at("gtag('consent','default'") < at('window.example=1;'));
  assert.ok(at('window.example=1;') < at('https://tags.example/t.js'));
  assert.ok(at('https://tags.example/t.js') < at('We measure visits'), 'the bar comes after the declared parts');
  assert.match(head, /We measure visits and run advertising tags only if you accept\./);
  assert.match(head, /^<script>window\.dataLayer/, 'nothing precedes the consent default');
  assert.match(bodyStart, /<noscript><iframe src="https:\/\/tags\.example\/ns"/);
});

test('every storage type starts denied and a kept granted choice is the only thing that grants before Accept', () => {
  const { head } = siteHeadMarkup(data());
  assert.match(head, /"analytics_storage":"denied","ad_storage":"denied"/);
  assert.match(head, /site_consent/);
});

test('a site without consent, with a default that is not denied, or a bad part is refused with every problem listed', () => {
  assert.match(siteHeadProblems({ ...data(), consent: undefined }).join(' '), /consent. is missing/);
  const bad = data();
  bad.consent.default = 'granted';
  bad.head.push({ kind: 'script', purpose: 'ads', src: 'http://not-secure.example/t.js' }, { kind: 'inline', purpose: 'unknown', text: '</script><b>' });
  const problems = siteHeadProblems(bad);
  assert.ok(problems.some(line => /must be "denied"/.test(line)));
  assert.ok(problems.some(line => /needs an https src/.test(line)));
  assert.ok(problems.some(line => /not a declared purpose/.test(line)));
  assert.ok(problems.some(line => /would end or open its script/.test(line)));
  assert.throws(() => siteHeadMarkup(bad), /The site head parts are refused/);
});

test('the markup is placed first in the head and just inside the body of a page; a page with neither is refused', () => {
  const lt = String.fromCharCode(60);
  const page = `${lt}html>${lt}head>${lt}title>T${lt}/title>${lt}/head>${lt}body class="a">Hello${lt}/body>${lt}/html>`;
  const markup = { head: 'HEAD', bodyStart: 'BODY' };
  const placed = withSiteHead(page, markup);
  assert.ok(placed.indexOf('HEAD') < placed.indexOf('title'));
  assert.ok(placed.indexOf('BODY') < placed.indexOf('Hello'));
  assert.throws(() => withSiteHead('plain', markup), /no head or body/);
});

const rowsFor = (heads: Record<string, unknown>[], parts: Record<string, unknown>[]) => async (sql: string) => (/from site_head /.test(sql) ? heads : parts);

test('the read answers the markup from the rows, in place order, and refuses an unknown site or broken rows by name', async () => {
  const d = data();
  const answer = await readSiteHead({ database: 'd', site: 's' }, rowsFor([{ purposes: d.purposes, consent: d.consent }], [
    { area: 'head', kind: 'inline', purpose: 'measure', text: 'window.example=1;', src: null },
    { area: 'head', kind: 'script', purpose: 'ads', text: null, src: 'https://tags.example/t.js' },
    { area: 'body_start', kind: 'noscript', purpose: 'ads', text: null, src: 'https://tags.example/ns' },
  ]));
  assert.match(answer.head, /^<script>window\.dataLayer/);
  assert.match(answer.body_start, /tags\.example\/ns/);
  assert.deepEqual(answer.read_from, ['site_head', 'site_head_parts'], 'it says the tables it read, so a server keeps it until one changes');
  await assert.rejects(readSiteHead({ database: 'd', site: 'x' }, rowsFor([], [])), /no site_head row for x/);
  await assert.rejects(readSiteHead({ database: 'd', site: 's' }, rowsFor([{ purposes: {}, consent: d.consent }], [])), /refused/);
  await assert.rejects(readSiteHead({ database: 'd', site: '' }, rowsFor([], [])), /Give site/);
});
