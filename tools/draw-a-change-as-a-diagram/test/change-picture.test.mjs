// tools/draw-a-change-as-a-diagram/test/change-picture.test.mjs
//
// A change between two points as a picture and one comment of ours (do-work/change-picture.mjs, do-work/change-graph.mjs):
// the document is valid by the graph contract at any size, the host is DATA, nothing is written unless asked, the comment is found by
// marker AND author and never written twice or for a change that moved.
import assert from 'node:assert/strict';
import test from 'node:test';
import { changeGraph } from '../do-work/change-graph.mjs';
import { validateGraphDocument } from '../do-work/graph-contract.mjs';
import { pictureChange } from '../do-work/change-picture.mjs';
import rules from '../read-data/change-picture.json' with { type: 'json' };

const files = [
  { filename: 'src/a.mjs', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-x\n+y' },
  { filename: 'src/old.mjs', status: 'removed', additions: 0, deletions: 9 },
  { filename: 'src/new-name.test.mjs', status: 'renamed', previous_filename: 'src/was.test.mjs', additions: 1, deletions: 1 },
  { filename: 'package-lock.json', status: 'modified', additions: 900, deletions: 800, patch: 'big' },
  { filename: 'README.md', status: 'added', additions: 10, deletions: 0 },
];

function host({ comments = [], head = 'a'.repeat(40), moveAfter = Infinity } = {}) {
  const log = [];
  let compares = 0;
  const run = async (tool, body) => {
    log.push([tool, body]);
    if (tool.endsWith('compare_commits')) { compares += 1; return { files, commits: [{ sha: compares > moveAfter ? 'b'.repeat(40) : head }] }; }
    if (tool.endsWith('find_my_account')) return { login: 'me' };
    if (tool.endsWith('list_issue_comments')) return comments;
    return { id: 99 };
  };
  return { run, log };
}

test('changed files become a valid graph document: lanes by folder, states by status, ids from a hash, never the path', () => {
  const doc = changeGraph(files);
  assert.equal(validateGraphDocument(doc).ok, true);
  const nodes = doc.lanes.flatMap(lane => lane.nodes);
  assert.deepEqual(nodes.map(node => node.delta), ['modified', 'removed', 'modified', 'modified', 'added']);
  assert.ok(nodes.every(node => !node.id.includes('/') && /^f:[0-9a-f]{12}$/u.test(node.id)));
  assert.equal(nodes.find(node => node.label === 'new-name.test.mjs').kind, 'test');
  assert.ok(nodes.find(node => node.label === 'new-name.test.mjs').detail.includes('was was.test.mjs'));
  assert.deepEqual(doc.lanes.map(lane => lane.label), ['src', 'Top level']);
  assert.equal(doc.caption, '914 lines added, 811 removed.');
});

test('a very large change stays inside the contract, with what did not fit gathered into one rest node whose counts add up', () => {
  const many = Array.from({ length: 700 }, (_, index) => ({ filename: `p${index % 40}/q/f${index}.mjs`, status: 'added', additions: 1, deletions: 0 }));
  const doc = changeGraph(many);
  assert.equal(validateGraphDocument(doc).ok, true);
  const nodes = doc.lanes.flatMap(lane => lane.nodes);
  const rest = nodes.find(node => node.id === 'rest-files');
  const drawn = nodes.length - 1;
  assert.equal(Number(/^(\d+) more files/u.exec(rest.label)[1]) + drawn, 700);
});

test('nothing is written unless asked: the picture, the model-input listing and the comment come back, the host saw only reads', async () => {
  const { run, log } = host();
  const out = await pictureChange({ owner: 'o', repo: 'r', base: 'main', head: 'feat', issue_number: 4, image_url: 'https://x.test/c.svg', run });
  assert.equal(out.ok, true);
  assert.equal(out.posted, null);
  assert.ok(log.every(([tool]) => tool.endsWith('compare_commits')));
  assert.ok(out.body.startsWith('[trillion-change-picture:'));
  assert.ok(out.body.includes('![') && out.body.includes('https://x.test/c.svg'));
  assert.ok(out.outbound.some(line => line.includes('package-lock.json: a lock file is churn')), 'a lock file is named as not sent');
  assert.equal(Object.keys(out.svg_files).length, out.picture.assets.length);
  assert.ok(Object.values(out.svg_files).every(svg => svg.startsWith('<svg')));
});

test('posting creates one comment of ours; again it finds it by marker and author and writes nothing if the words are the same', async () => {
  const first = host();
  const made = await pictureChange({ owner: 'o', repo: 'r', base: 'main', head: 'feat', issue_number: 4, post: true, run: first.run });
  assert.equal(made.posted.outcome, 'created');
  const created = first.log.find(([tool]) => tool.endsWith('create_issue_comment'))[1];
  assert.equal(created.issue_number, '4');
  const second = host({ comments: [{ id: 99, user: { login: 'me' }, body: made.body }] });
  const again = await pictureChange({ owner: 'o', repo: 'r', base: 'main', head: 'feat', issue_number: 4, post: true, run: second.run });
  assert.equal(again.posted.outcome, 'unchanged');
  assert.ok(second.log.every(([tool]) => !tool.endsWith('create_issue_comment') && !tool.endsWith('update_issue_comment')));
});

test('someone else copying the marker is not our comment; our own older words are rewritten', async () => {
  const probe = await pictureChange({ owner: 'o', repo: 'r', base: 'main', head: 'feat', issue_number: 4, run: host().run });
  const marker = probe.body.split('\n')[0];
  const copied = host({ comments: [{ id: 5, user: { login: 'someone' }, body: `${marker}\nfake` }] });
  assert.equal((await pictureChange({ owner: 'o', repo: 'r', base: 'main', head: 'feat', issue_number: 4, post: true, run: copied.run })).posted.outcome, 'created');
  const ours = host({ comments: [{ id: 6, user: { login: 'me' }, body: `${marker}\nolder words` }] });
  const updated = await pictureChange({ owner: 'o', repo: 'r', base: 'main', head: 'feat', issue_number: 4, post: true, run: ours.run });
  assert.equal(updated.posted.outcome, 'updated');
  assert.equal(ours.log.find(([tool]) => tool.endsWith('update_issue_comment'))[1].comment_id, '6');
});

test('a change that moved on while the comment was made is not written', async () => {
  const { run, log } = host({ moveAfter: 1 });
  const out = await pictureChange({ owner: 'o', repo: 'r', base: 'main', head: 'feat', issue_number: 4, post: true, run });
  assert.equal(out.posted.outcome, 'overtaken');
  assert.ok(log.every(([tool]) => !tool.endsWith('create_issue_comment')));
});

test('a document an AI wrote replaces the plain one after the contract checks it; a bad one and an unknown host are refused', async () => {
  const document = { schema_version: 1, id: 'mine', label: 'My view', lanes: [{ id: 'l', label: 'Layer', nodes: [{ id: 'n', label: 'Thing', delta: 'added' }] }], edges: [] };
  const good = await pictureChange({ owner: 'o', repo: 'r', base: 'a', head: 'b', document, run: host().run });
  assert.equal(good.ok, true);
  assert.ok(good.body.includes('My view') || good.picture.assets.length > 0);
  const bad = await pictureChange({ owner: 'o', repo: 'r', base: 'a', head: 'b', document: { ...document, lanes: [] }, run: host().run });
  assert.deepEqual([bad.ok, bad.error], [false, 'BAD_DOCUMENT']);
  const unknown = await pictureChange({ forge: '__proto__', owner: 'o', repo: 'r', base: 'a', head: 'b', run: host().run });
  assert.equal(unknown.error, 'UNKNOWN_FORGE');
  assert.equal(Object.keys(rules.forges).includes('github'), true);
});
