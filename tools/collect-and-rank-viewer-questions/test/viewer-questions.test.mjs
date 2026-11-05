// Runs every script of do-work/ for real on made-up posts, comments, buckets, picks, transcripts and a research package,
// with stand-ins for sentence-transformers and torch (test/stand-in) so no model files are needed, the person's settings
// given as a list:settings row read through tools/settings, and tool:check-copy run for real on made-up rules. Needs
// python3; the model steps also need numpy, and skip, saying why, without it. Every name and word here is made up.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
const standIn = join(folder, 'test', 'stand-in');
let root, log;
const run = (script, ...argv) => spawnSync('python3', [join(folder, 'do-work', script), ...argv], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONPATH: standIn, STAND_IN_LOG: log },
});
const lastLine = out => JSON.parse(out.stdout.trim().split('\n').pop());
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const tsv = path => readFileSync(path, 'utf8').trim().split('\n').map(line => line.split('\t'));
const put = (name, value) => { const path = join(root, name); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); return path; };
const putLines = (name, rows) => put(name, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const numpy = spawnSync('python3', ['-c', 'import numpy'], { encoding: 'utf8' });
const modelSkip = numpy.status === 0 ? false : 'needs python3 with numpy';
const FOLDER = 'collect-and-rank-viewer-questions';
// The person's settings as their list:settings row, the way the door's records:read answers it.
const settingRow = (settings, folder = FOLDER) => ({
  id: `record:setting:${folder}~person~sample-baker`, type: 'record:setting',
  value: { name: 'Sample baker viewer questions', tool: `tool:${folder}`, scope_kind: 'person', scope_id: 'sample-baker', settings: JSON.stringify(settings), from: 'made-up@0', status: 'active' },
});
const SETTINGS = {
  buckets: { 'starter-care': ['starter', 'feed'], shaping: ['crumb', 'stretch', 'tear'] },
  bucket_codes: { SC: 'starter-care', SH: 'shaping' },
  asker_overrides: { 1: 'Why does my dough tear?' },
  inferred: [[3, 'SH', 'q', 'What if my oven runs cold?']],
  inferred_file: 'notes.md', inferred_segment: 'my-audience', comment_segment: 'viewer ({})', basis: 'a made-up sample',
  moment_buckets: { starter: { description: 'feeding a sourdough starter' }, crumb: { description: 'crumb and proofing' } },
  reach_rules: [{ when: { source: 'kept', timing: 'word' }, reach: 'word-timed' }, { when: { source: 'kept' }, reach: 'needs-timing' }],
  recordings_reach: { word: 'cuttable-now', other: 'elsewhere' }, recordings_origin: 'recordings', archive_origin: 'archive-',
  packages: { pack: { rows_at: 'rows', id: 'qid', question: 'q', file_label: 'pack.json', observed: null,
    bucket_codes: { field: 'codes', sep: null }, bucket_map: { SC: 'starter-care' }, proposed_buckets: {}, icp_segment: { prefix: 'pack:', field: 'who' }, carry: {} } },
};
let settings;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'viewer-questions-'));
  log = join(root, 'models.log');
  mkdirSync(join(root, 'raw', 'moments'), { recursive: true });
  mkdirSync(join(root, 'youtube-comments'));
  putLines('forum-posts.jsonl', [
    { forum: 'baking', group: 'home-bakers', id: 'p1', permalink: '/r/baking/comments/p1/', title: 'How do I keep my starter alive on holiday?', selftext: 'Also why does my dough tear when I stretch it?', score: 12, num_comments: 4 },
    { forum: 'baking', group: 'home-bakers', id: 'p2', permalink: '/r/baking/comments/p2/', title: 'Crumb shot', selftext: 'How can I get a more open crumb in my loaf?', score: 3, num_comments: 1 },
  ]);
  put('youtube-comments/vid0000001.info.json', { id: 'vid0000001', webpage_url: 'https://www.youtube.com/watch?v=vid0000001', title: 'Made-up video', view_count: 10,
    comments: [{ id: 'c1', text: 'What should I feed my starter every single day?', like_count: 120 }, { id: 'c2', text: 'Nice video', like_count: 2 }] });
  putLines('comments.jsonl', [{ video_id: 'vid0000002', comments: [{ id: 'c9', text: 'Why does my bread go flat in the oven every time?', like_count: 1 }] }]);
  settings = put('setting.json', settingRow(SETTINGS));
});

test('the row runs on the person\'s computer, names scripts that exist and packs the settings reader', () => {
  assert.equal(row.id, 'tool:collect-and-rank-viewer-questions');
  assert.equal(row.invoke.kind, 'on-your-computer');
  for (const name of row.input_schema.properties.command.enum) assert.ok(existsSync(join(folder, 'do-work', `${name}.py`)), name);
  assert.ok(existsSync(join(folder, '..', 'settings', 'read-data', 'settings.py')));
  assert.deepEqual(row.placements, ['placement:your-computer']);
});

test('candidates reads forum posts and video comments, each sentence once, each with its own link', () => {
  const out = run('candidates.py', root, join(root, 'raw', 'candidates.tsv'));
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(lastLine(out).result, { candidates: 5, posts: 2, videos: 2, out: join(root, 'raw', 'candidates.tsv') });
  const rows = tsv(join(root, 'raw', 'candidates.tsv'));
  assert.deepEqual(rows.map(r => [r[0], r[1], r[3], r[5]]), [
    ['0', 'reddit-title', 'home-bakers', 'How do I keep my starter alive on holiday?'],
    ['1', 'reddit-body', 'home-bakers', 'Also why does my dough tear when I stretch it?'],
    ['2', 'reddit-body', 'home-bakers', 'How can I get a more open crumb in my loaf?'],
    ['3', 'youtube-comment', 'from-video:vid0000001', 'What should I feed my starter every single day?'],
    ['4', 'youtube-comment', 'from-video:vid0000002', 'Why does my bread go flat in the oven every time?'],
  ]);
  assert.equal(rows[3][2], 'https://www.youtube.com/watch?v=vid0000001&lc=c1');
});

test('rank puts each candidate in the bucket of the person\'s settings its patterns hit most', () => {
  const out = run('rank.py', settings, join(root, 'raw', 'candidates.tsv'), '5', join(root, 'raw', 'ranked.tsv'));
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(tsv(join(root, 'raw', 'ranked.tsv')).map(r => [r[0], r[1]]), [['3', 'starter-care'], ['0', 'starter-care'], ['1', 'shaping'], ['2', 'shaping']]);
  assert.deepEqual(lastLine(out).result, { ranked: 4, per_bucket: { 'starter-care': 2, shaping: 2 } });
});

test('a settings row of another tool, or a retired one, is refused saying what to give', () => {
  const other = run('rank.py', put('other.json', settingRow(SETTINGS, 'some-other-tool')), join(root, 'raw', 'candidates.tsv'), '5');
  assert.equal(other.status, 2);
  assert.match(lastLine(other).error, /holds the settings of another tool/);
  const retired = settingRow(SETTINGS); retired.value.status = 'retired';
  const old = run('rank.py', put('retired.json', retired), join(root, 'raw', 'candidates.tsv'), '5');
  assert.match(lastLine(old).error, /retired/);
  const none = run('rank.py', put('empty.json', {}), join(root, 'raw', 'candidates.tsv'), '5');
  assert.match(lastLine(none).error, /no buckets/);
});

test('embed_moments cuts word-timed transcripts at sentence ends, drops Whisper loops and adds a moments table', { skip: modelSkip }, () => {
  const transcripts = join(root, 'transcripts');
  mkdirSync(transcripts);
  const said = 'feed your starter every single day with flour and water. a little bit of a little bit of a little bit of a little bit. the oven was hot so the bread rose fast today.';
  writeFileSync(join(transcripts, 'take1.words.json'), JSON.stringify({ root: '/recordings', words: said.split(' ').map((text, i) => ({ text, start: i, end: i + 0.5 })) }));
  const table = put('table.tsv', 'clip\tstart_s\tend_s\ttext\ttranscript_source\tmedia_location\ntake2\t0\t5\tan open crumb comes from a wet dough and a long proof\test-from-duration\t/old\ntake3\t\t\tno times here at all for this row ok\tmanual\t/old\n');
  const out = run('embed_moments.py', transcripts, table, join(root, 'raw', 'moments'));
  assert.equal(out.status, 0, out.stderr);
  const made = readFileSync(join(root, 'raw', 'moments', 'moments.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(made.map(m => [m.clip, m.from, m.time_basis]), [['take1', 0, 'word'], ['take1', 25, 'word'], ['take2', 0, 'estimated']]);
  assert.equal(made[0].media_location, '/recordings');
  assert.ok(existsSync(join(root, 'raw', 'moments', 'moments.npy')));
  assert.equal(lastLine(out).result.moments, 3);
});

test('build_library measures how often each picked question recurs and matches the moments that answer it', { skip: modelSkip }, () => {
  const picks = put('picks.txt', '# made-up picks\n3 SC q\n1 SH p\n');
  const out = run('build_library.py', root, picks, settings);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(lastLine(out).result, { questions: 3, with_answers: lastLine(out).result.with_answers, out: join(root, 'questions.json') });
  const entries = json(join(root, 'questions.json')).questions;
  assert.deepEqual(entries.map(e => [e.id, e.bucket, e.kind, e.evidence]), [['vq-001', 'starter-care', 'question', 'observed'], ['vq-002', 'shaping', 'problem', 'observed'], ['vq-003', 'shaping', 'question', 'inferred']]);
  assert.equal(entries[0].icp_segment, 'viewer (from-video:vid0000001)');
  assert.deepEqual(entries[0].frequency_estimate.engagement, { comment_likes: 120 });
  assert.equal(entries[0].frequency_estimate.basis, 'a made-up sample');
  assert.equal(entries[0].frequency_estimate.sample_size, 5);
  assert.deepEqual(entries[1].frequency_estimate.engagement, { post_score: 12, post_comments: 4 });
  assert.equal(entries[1].asker_line, 'Why does my dough tear?', 'the person\'s asker line wins');
  assert.equal(entries[2].source_url_or_file, 'notes.md:3');
  assert.equal(entries[2].icp_segment, 'my-audience');
  assert.equal(entries[2].frequency_estimate, null);
  const answer = entries[0].answer_moments[0];
  assert.equal(answer.clip, 'take1');
  assert.equal(answer.moment_bucket, 'starter');
  assert.ok(entries.every(e => e.asker_line_gate === null));
  const asked = readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(asked.includes('BAAI/bge-small-en-v1.5') && asked.includes('BAAI/bge-reranker-v2-m3'));
});

test('build_library refuses picks whose bucket codes the settings do not name', { skip: modelSkip }, () => {
  const out = run('build_library.py', root, put('bad-picks.txt', '3 ZZ q\n'), settings);
  assert.equal(out.status, 2);
  assert.match(lastLine(out).error, /bucket codes the settings do not name \(ZZ\)/);
});

test('rematch matches again against the own moments and an archive\'s tagged moments, each with the reach the settings give', { skip: modelSkip }, () => {
  const tagged = putLines('tagged.jsonl', [
    { text: 'feed the starter flour and water every single day', est_start: 3, est_end: 9, timing: 'segment', source: 'kept', source_file: 'archive/day1/take9.txt', identity: '12:aa' },
    { text: 'too short', timing: 'word', source: 'kept', source_file: 'archive/x.txt' },
  ]);
  const out = run('rematch.py', root, tagged, settings);
  assert.equal(out.status, 0, out.stderr);
  const { result } = lastLine(out);
  assert.equal(result.pool, 4);
  const answers = json(join(root, 'questions.json')).questions[0].answer_moments;
  assert.ok(answers.every(m => m.match >= 0.5 && m.match_quality === 'strong'));
  assert.deepEqual(new Set(answers.map(m => m.origin)), new Set(['recordings', 'archive-kept']));
  const archived = answers.find(m => m.origin === 'archive-kept');
  assert.equal(archived.reach, 'needs-timing');
  assert.equal(archived.identity, '12:aa');
  assert.equal(answers.find(m => m.origin === 'recordings').reach, 'cuttable-now');
  assert.equal(result.answers_by_reach['cuttable-now'], 1);
});

test('add_package_questions adds a research package\'s new questions, read the way the settings say', () => {
  const library = put('library.json', { questions: [{ id: 'vq-001', question: 'What should I feed my starter every single day?', source_url_or_file: 'u1' }] });
  const pack = put('pack.json', { rows: [{ qid: 'a', q: 'What if my starter smells odd?', codes: 'SC', who: 'new-bakers' }, { qid: 'b', q: 'what should i feed my starter every single day?', codes: 'SC', who: 'x' }] });
  const out = run('add_package_questions.py', library, pack, 'pack', settings);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(lastLine(out).result, { added: { observed: 0, hypothesis: 1 }, skipped: ['b'], total: 2 });
  assert.deepEqual(json(library).questions[1], { question: 'What if my starter smells odd?', source_url_or_file: 'pack:pack.json#a', source_kind: 'package-hypothesis',
    evidence: 'hypothesis', bucket: 'starter-care', kind: 'question', icp_segment: 'pack:new-bakers', asker_line: 'What if my starter smells odd?',
    frequency_estimate: null, answer_moments: [], id: 'vq-002', asker_line_gate: null, package_id: 'a', package_aa_buckets: ['SC'] });
  const again = run('add_package_questions.py', library, pack, 'pack', settings);
  assert.deepEqual(lastLine(again).result.added, { observed: 0, hypothesis: 0 }, 'a second run adds nothing');
  const unknown = run('add_package_questions.py', library, pack, 'other', settings);
  assert.equal(unknown.status, 2);
  assert.match(lastLine(unknown).error, /no package named 'other'/);
});

const gateLibrary = () => put('gate-library.json', { questions: [
  { id: 'vq-001', asker_line: 'Is this the most amazing loaf ever?' }, { id: 'vq-002', asker_line: 'How do I shape a loaf?' }, { id: 'vq-003', asker_line: 'Is this the most amazing loaf ever?' }] });

test('apply_gate runs every asker line through tool:check-copy with the person\'s rules and writes each verdict back', () => {
  const library = gateLibrary();
  const check = put('check.json', { rules: [{ id: 'no-amazing', words: ['amazing'], says: 'Say what it does, not that it is amazing.' }] });
  const out = run('apply_gate.py', library, check);
  assert.equal(out.status, 1, 'a failing line makes the run fail');
  assert.deepEqual(lastLine(out).result.verdicts, { fail: 2, pass: 1 });
  assert.deepEqual(json(library).questions.map(q => q.asker_line_gate), [
    { verdict: 'fail', rules: ['no-amazing'] }, { verdict: 'pass', rules: [] }, { verdict: 'fail', rules: ['no-amazing'] }]);
});

test('apply_gate also runs a gate program of the older command line, reading its file:LINE blocks', () => {
  const library = gateLibrary();
  const out = run('apply_gate.py', library, join(root, 'lines.txt'), join(standIn, 'older-gate.mjs'));
  assert.equal(out.status, 1);
  assert.equal(readFileSync(join(root, 'lines.txt'), 'utf8').split('\n')[1], 'How do I shape a loaf?');
  assert.deepEqual(json(library).questions.map(q => q.asker_line_gate.verdict), ['fail', 'pass', 'fail']);
});

test('remap_picks keeps each pick and override on its question after the candidates are found again', () => {
  const old = put('old.tsv', '0\treddit-title\tu0\tg\t1\tFirst made-up question here ok?\n1\treddit-body\tu1\tg\t1\tSecond made-up question here ok?\n');
  const fresh = put('new.tsv', '0\treddit-title\tuX\tg\t1\tAn added question came first ok?\n1\treddit-title\tu0\tg\t1\tFirst made-up question here ok?\n2\treddit-body\tu1\tg\t1\tSecond made-up question here ok?\n');
  const picks = put('remap-picks.txt', '# note\n1 SH p\n0 SC q\n');
  const overrides = put('remap-settings.json', { asker_overrides: { 1: 'Second?' }, basis: 'kept' });
  const out = run('remap_picks.py', old, fresh, picks, overrides);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(readFileSync(picks, 'utf8'), '# note\n2 SH p\n1 SC q\n');
  assert.deepEqual(json(overrides), { asker_overrides: { 2: 'Second?' }, basis: 'kept' });
  assert.deepEqual(lastLine(out).result, { remapped: 2 });
  const gone = run('remap_picks.py', fresh, old, put('gone.txt', '0 SC q\n'));
  assert.equal(gone.status, 2);
  assert.match(lastLine(gone).error, /Pick 0 names a question no longer among the new candidates/);
});

test('reports gives the shortlist, answers, review, top30 and its brief, comment counts and vector check', { skip: modelSkip }, () => {
  const questions = join(root, 'questions.json');
  assert.ok(Array.isArray(lastLine(run('reports.py', 'shortlist', questions)).result.shortlist));
  assert.ok('answers_by_reach' in lastLine(run('reports.py', 'answers', questions)).result);
  assert.deepEqual(lastLine(run('reports.py', 'review', questions, '2', '2')).result.questions.map(q => q.id), ['vq-002']);
  const top = join(root, 'top30.json');
  const chosen = run('reports.py', 'top30', questions, top, 'vq-002', 'vq-001');
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.deepEqual(json(top).map(c => c.id), ['vq-002', 'vq-001']);
  assert.equal(run('reports.py', 'top30', questions, top, 'vq-404').status, 2);
  assert.equal(lastLine(run('reports.py', 'brief', top)).result.brief.length, 2);
  assert.deepEqual(lastLine(run('reports.py', 'comments', join(root, 'youtube-comments'))).result.videos.map(v => [v.comments, v.questions]), [[2, 1]]);
  assert.deepEqual(lastLine(run('reports.py', 'vectors', root)).result.not_finite, 0);
  assert.equal(run('reports.py', 'nothing', questions).status, 2);
});
