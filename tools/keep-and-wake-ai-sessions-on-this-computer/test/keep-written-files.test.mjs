// harness/keep-written-files.mjs: at each turn end, every file in the person's chosen folders that was written or
// changed since it was last kept goes to Trillion under the folder's destination, with a header naming its source and
// change time and any secret taken out; files left out, too old or already kept are not sent again, and the state
// moves only past files Trillion accepted, so a failed send is retried at the next turn end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dueFiles, keepNew, keptText, settings } from '../harness/keep-written-files.mjs';

function setUp() {
  const dir = mkdtempSync(join(tmpdir(), 'keep-written-files-'));
  const root = join(dir, 'projects');
  const put = (path, text, when) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
    if (when) utimesSync(join(root, path), new Date(when), new Date(when));
  };
  put('alpha/plans/new-plan.md', '# New plan\n', '2026-09-29T10:00:00Z');
  put('alpha/research/finding.md', '# Finding\n', '2026-09-29T11:00:00Z');
  put('alpha/plans/old-plan.md', '# Old\n', '2026-08-01T00:00:00Z');
  put('alpha/plans/left-out.md', '# Left out\n', '2026-09-29T12:00:00Z');
  put('alpha/audits/audit.md', '# Not a plan\n', '2026-09-29T12:00:00Z');
  put('alpha/plans/.git/HEAD.md', 'never walked\n', '2026-09-29T12:00:00Z');
  writeFileSync(join(dir, 'left-out.txt'), 'alpha/plans/left-out.md\n');
  const folders = [{ root, destination: '/knowledge/projects', include: ['^[^/]+/(plans|research)/.*\\.md$'], since: '2026-09-28T00:00:00Z', leave_out_listed_in: join(dir, 'left-out.txt') }];
  writeFileSync(join(dir, 'folders.json'), JSON.stringify(folders));
  const rules = { ...settings, folders_file: join(dir, 'folders.json'), state_file: join(dir, 'state', 'sent.json') };
  return { dir, root, put, folders, rules };
}

test('only included files changed since the cutoff, not left out and not already kept, are due, newest first', () => {
  const { folders, rules } = setUp();
  assert.deepEqual(dueFiles(folders, {}, rules).map(file => file.name), ['/knowledge/projects/alpha/research/finding.md', '/knowledge/projects/alpha/plans/new-plan.md']);
});

test('a kept file carries its source and change time, its exact body, and no secret', () => {
  const secret = ['sk', 'ant', 'a'.repeat(30)].join('-');
  const { text, removed } = keptText('/x/plan.md', `Key ${secret} here.\nAsk-the-owner stays.\n`, '2026-09-29T10:00:00.000Z');
  assert.match(text, /^---\nsource_path: "\/x\/plan\.md"\nlast_changed: "2026-09-29T10:00:00\.000Z"\nremoved_secrets: "api key"\n/);
  assert.ok(text.endsWith('---\nKey [removed api key] here.\nAsk-the-owner stays.\n'));
  assert.deepEqual(removed, ['api key']);
  assert.ok(!keptText('/x/a.md', 'plain\n', 't').text.includes('removed_secrets'));
});

test('sends each due file once, and again only after it changes', async () => {
  const { rules, put } = setUp();
  const sent = [];
  const send = async file => { sent.push(file); return true; };
  const first = await keepNew({ rules, send, key: () => 'k' });
  assert.equal(first.sent, 2);
  assert.equal(sent[1].media_type, 'text/markdown');
  assert.ok(sent[1].text.endsWith('---\n# New plan\n'));
  assert.equal((await keepNew({ rules, send, key: () => 'k' })).sent, 0);
  put('alpha/plans/new-plan.md', '# New plan, changed\n', '2026-09-30T10:00:00Z');
  const third = await keepNew({ rules, send, key: () => 'k' });
  assert.deepEqual(third.names, ['/knowledge/projects/alpha/plans/new-plan.md']);
});

test('a refused send keeps the file due, and nothing is read from the Keychain when nothing is due', async () => {
  const { rules } = setUp();
  const refused = await keepNew({ rules, send: async () => false, key: () => 'k' });
  assert.deepEqual([refused.sent, refused.pending], [0, 2]);
  assert.equal(await keepNew({ rules, send: async () => true, key: () => 'k' }).then(result => result.sent), 2);
  let asked = false;
  await keepNew({ rules, send: async () => true, key: () => { asked = true; return 'k'; } });
  assert.equal(asked, false);
  assert.equal(Object.keys(JSON.parse(readFileSync(rules.state_file, 'utf8'))).length, 2);
});

test('a refused file does not hold up later files', async () => {
  const { rules } = setUp();
  const result = await keepNew({
    rules,
    send: async file => !file.name.endsWith('/research/finding.md'),
    key: () => 'k',
  });
  assert.equal(result.sent, 1);
  assert.deepEqual(result.failed, ['/knowledge/projects/alpha/research/finding.md']);
  assert.deepEqual(dueFiles(JSON.parse(readFileSync(rules.folders_file, 'utf8')), JSON.parse(readFileSync(rules.state_file, 'utf8')), rules).map(file => file.name), result.failed);
});
