import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attachDomain, checkedDomain, checkedName, letGo, nameFromPage, nameFromTitle, nameSite, publishSite, readOrigins, readTold, siteAddresses } from '../read-data/site-addresses.mjs';

const INSTALL = 'a'.repeat(32);
const OTHER = 'c'.repeat(32);
const ACCOUNT = 'b'.repeat(64);
const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);

// A made-up files door: list_files, find_file, read_file and pieces written under one upload id, as the engine's.
function door(files = {}) {
  const stored = new Map(Object.entries(files).map(([name, text]) => [name, Buffer.from(text)]));
  const uploads = new Map();
  const media = new Map();
  return {
    stored, media,
    async files(method, input) {
      switch (method) {
        case 'list_files': {
          const base = input.folder.endsWith('/') ? input.folder : `${input.folder}/`;
          const under = [...stored.keys()].filter(name => name.startsWith(base));
          return { names: under.filter(name => !name.slice(base.length).includes('/')).map(name => ({ name })),
            folders: [...new Set(under.map(name => name.slice(base.length)).filter(rest => rest.includes('/')).map(rest => `${base}${rest.split('/')[0]}`))] };
        }
        case 'find_file': return { names: [input.name_or_identity] };
        case 'read_file': {
          const bytes = stored.get(input.name_or_identity);
          const part = bytes.subarray(input.offset, input.offset + 65536);
          return { byte_length: bytes.length, bytes_returned: part.length, encoding: 'base64', content: part.toString('base64') };
        }
        case 'write_file_start': uploads.set(input.upload_id, []); media.set(input.name, input.media_type); return { next_offset: 0 };
        case 'write_file_piece': uploads.get(input.upload_id).push(Buffer.from(input.content_base64, 'base64')); return {};
        case 'write_file_finish': stored.set(input.name, Buffer.concat(uploads.get(input.upload_id))); return { name: input.name };
        default: throw new Error(`no ${method}`);
      }
    },
  };
}
const list = files => JSON.parse(files.stored.get('/installations/origins.json').toString()).origins;

test('a name is checked as the old names were, and made from a page title', () => {
  assert.equal(checkedName(' Field-Notes '), 'field-notes');
  for (const bad of ['ab', 'www', 'app', 'a--b', '0123456789abcdef0123', 'x'.repeat(41), '-ab', 'a_b']) assert.throws(() => checkedName(bad), bad);
  assert.equal(nameFromTitle('Café Ünïcode: the  Best shop!'), 'cafe-unicode-the-best');
  assert.equal(nameFromTitle('www'), null);
  assert.equal(nameFromPage('<title>Field Notes | Home</title>'), 'field-notes');
  assert.equal(nameFromPage('<title>Www</title>'), null, 'a reserved word is no name');
});

test('a domain is the person\'s own, in its one form, never a name under the names host', () => {
  assert.equal(checkedDomain('Shop.Example.COM.'), 'shop.example.com');
  for (const bad of ['https://shop.example.com', 'shop.example.com/x', 'shop.example.com:443', 'localhost', '1.2.3.4', 'x.trillion.run', 'trillion.run', 'a..b.com'])
    assert.throws(() => checkedDomain(bad), bad);
});

test('publishing keeps each file under its installation with its media type and suggests a name', async () => {
  const files = door();
  const published = await publishSite({ files: { 'index.html': '<title>Field Notes</title>', 'img/logo.svg': '<svg/>' } }, { door: files, newId: () => INSTALL });
  assert.deepEqual(published, { installation: INSTALL, files: 2, bytes: 32, llms: false, suggested_name: 'field-notes' });
  assert.equal(files.stored.get(`/installations/${INSTALL}/img/logo.svg`).toString(), '<svg/>');
  assert.equal(files.media.get(`/installations/${INSTALL}/index.html`), 'text/html; charset=utf-8');
  await assert.rejects(publishSite({ files: { 'about.html': 'x' } }, { door: files }), /index.html/);
  await assert.rejects(publishSite({ files: { 'index.html': 'x', '../x.html': 'y' } }, { door: files }), /invalid/);
  const fromCopy = door({ '/Copies/site.json': JSON.stringify({ files: { 'index.html': '<h1>copied</h1>' } }) });
  assert.equal((await publishSite({ site: '/Copies/site.json', installation: OTHER }, { door: fromCopy })).installation, OTHER);
  assert.equal(fromCopy.stored.get(`/installations/${OTHER}/index.html`).toString(), '<h1>copied</h1>');
});

test('a site with an address lists its pages for AI apps at /llms.txt when it is published again', async () => {
  const files = door({ [`/installations/${INSTALL}/index.html`]: 'x' });
  await nameSite({ installation: INSTALL, name: 'field-notes' }, { door: files });
  const again = await publishSite({ installation: INSTALL, files: { 'index.html': '<title>Field Notes</title>', 'about.html': '<title>About us</title>', 'logo.svg': '<svg/>' } }, { door: files });
  assert.equal(again.llms, true);
  assert.equal(files.stored.get(`/installations/${INSTALL}/llms.txt`).toString(), '# field-notes.trillion.run\n\n> Public pages of https://field-notes.trillion.run/\n\n## Pages\n\n'
    + '- [About us](https://field-notes.trillion.run/about.html)\n- [Field Notes](https://field-notes.trillion.run/)\n');
  const own = await publishSite({ installation: INSTALL, files: { 'index.html': 'x', 'llms.txt': 'mine' } }, { door: files });
  assert.equal(own.llms, false, 'a site that ships its own keeps it');
});

test('a renamed site keeps every earlier name pointing at its new name, never a chain', async () => {
  const files = door({ [`/installations/${INSTALL}/index.html`]: 'x', [`/installations/${OTHER}/index.html`]: 'y' });
  await assert.rejects(nameSite({ installation: 'f'.repeat(32), name: 'first-name' }, { door: files }), /publish the site first/);
  const first = await nameSite({ installation: INSTALL, name: 'first-name' }, { door: files });
  assert.equal(first.address, 'https://first-name.trillion.run/');
  await nameSite({ installation: INSTALL, title: 'Second Name' }, { door: files });
  const third = await nameSite({ installation: INSTALL, name: 'third-name' }, { door: files });
  assert.deepEqual(third.renamed_from, ['https://second-name.trillion.run/']);
  assert.deepEqual(list(files), [
    { host: 'first-name.trillion.run', installation: INSTALL, moved_to: 'third-name.trillion.run' },
    { host: 'second-name.trillion.run', installation: INSTALL, moved_to: 'third-name.trillion.run' },
    { host: 'third-name.trillion.run', installation: INSTALL },
  ]);
  // Back to its first name: the first is live again and the others move to it.
  await nameSite({ installation: INSTALL, name: 'first-name' }, { door: files });
  assert.deepEqual(list(files).map(origin => [origin.host, origin.moved_to ?? null]), [
    ['first-name.trillion.run', null], ['second-name.trillion.run', 'first-name.trillion.run'], ['third-name.trillion.run', 'first-name.trillion.run']]);
  await assert.rejects(nameSite({ installation: OTHER, name: 'second-name' }, { door: files }), /already uses/);
});

test('a domain is attached with the two DNS records naming the account, and an address can be let go', async () => {
  const files = door({ [`/installations/${INSTALL}/index.html`]: 'x' });
  await nameSite({ installation: INSTALL, name: 'field-notes' }, { door: files });
  const attached = await attachDomain({ installation: INSTALL, domain: 'Shop.Example.com', account: ACCOUNT }, { door: files });
  assert.deepEqual(attached.records, [
    { type: 'TXT', name: '_trillion-verify.shop.example.com', value: `trillion-account=${ACCOUNT}` },
    { type: 'CNAME', name: 'shop.example.com', value: 'app.gettrillion.ai' }]);
  await assert.rejects(attachDomain({ installation: INSTALL, domain: 'shop.example.com', account: 'nope' }, { door: files }), /account's address/);
  assert.equal((await siteAddresses({}, { door: files })).origins.length, 2);
  await nameSite({ installation: INSTALL, name: 'new-notes' }, { door: files });
  const gone = await letGo({ host: 'https://new-notes.trillion.run/' }, { door: files });
  assert.deepEqual(gone.origins.map(origin => origin.host), ['shop.example.com'], 'the name moved to it went with it');
  await assert.rejects(letGo({ host: 'nobody.trillion.run' }, { door: files }), /None of your sites/);
  assert.deepEqual(await readOrigins(door()), [], 'no list yet: no addresses');
  assert.equal(await readTold(files), null, 'not handed in yet');
  files.stored.set('/installations/origins-told.json', Buffer.from(JSON.stringify({ state: 'refused', why: 'host_taken', told_at_ms: 1762257600000 })));
  assert.deepEqual((await siteAddresses({}, { door: files })).told, { state: 'refused', told_at: '2025-11-04T12:00:00.000Z',
    why: "Another account's site holds one of these addresses. Choose another name, or let that address go." });
});

test('every row runs the export it names, through the run\'s own door, with the folder it edits only', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:publish_site', 'tool:name_site', 'tool:attach_domain', 'tool:let_go_of_site_address', 'tool:site_addresses']);
  for (const row of rows) {
    assert.equal(row.result_selector, '$.result');
    assert.notEqual(row.invoke.internet, true);
    for (const right of row.invoke.records.rights) {
      if (right.operations.some(operation => operation.startsWith('write_file'))) assert.equal(right.files, '/installations/');
    }
  }
});
