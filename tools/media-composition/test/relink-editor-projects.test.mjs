// Pointing a person's editor projects at clips' new places runs on their own computer
// (do-work/relink-editor-projects.mjs, tool:point-editor-projects-at-new-places). Proven on real
// gzipped Premiere project files in a folder of this test's own, run the way the tool's invoke runs it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import zlib from 'node:zlib';
import { checkedMoves, relinkEditorProjects, relinkPremiereProjects, rewriteProjectXml } from '../do-work/relink-editor-projects.mjs';

const SCRIPT = new URL('../do-work/relink-editor-projects.mjs', import.meta.url).pathname;
const project = (paths) => `<?xml version="1.0"?><PremiereData Version="3"><Media ObjectUID="m1"><FilePath>${paths.absolute}</FilePath><ActualMediaFilePath>${paths.absolute}</ActualMediaFilePath><RelativePath>${paths.relative}</RelativePath><Title>A &amp; B</Title></Media><Media ObjectUID="m2"><FilePath>/work/sample/Other/keep.mp4</FilePath></Media></PremiereData>`;

test('a Premiere project names the clip\'s new place, the original is kept beside it, and other clips stay', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'relink-'));
  const file = join(folder, 'Edit.prproj');
  const before = project({ absolute: '/work/sample/Card/CLIP/A &amp; B.MP4', relative: relative(folder, '/work/sample/Card/CLIP/A &amp; B.MP4') });
  writeFileSync(file, zlib.gzipSync(Buffer.from(before)));
  const out = execFileSync(process.execPath, [SCRIPT, '--moves', JSON.stringify([{ from: '/work/sample/Card/CLIP', to: '/work/sample/Drive/Clips' }]), '--projects', JSON.stringify([file])], { encoding: 'utf8', env: { ...process.env, RESOLVE_SCRIPT_API_MODULES: join(folder, 'no-resolve-here') } });
  const answer = JSON.parse(out);
  assert.equal(answer.projects.length, 1);
  assert.equal(answer.projects[0].state, 'rewritten');
  assert.equal(answer.projects[0].paths_changed, 3);
  assert.match(answer.said, /1 Premiere project now opens/);
  const after = zlib.gunzipSync(readFileSync(file)).toString('utf8');
  assert.match(after, /<FilePath>\/work\/sample\/Drive\/Clips\/A &amp; B\.MP4<\/FilePath>/);
  assert.match(after, /<ActualMediaFilePath>\/work\/sample\/Drive\/Clips\/A &amp; B\.MP4<\/ActualMediaFilePath>/);
  assert.match(after, /<FilePath>\/work\/sample\/Other\/keep\.mp4<\/FilePath>/, 'a clip that did not move is untouched');
  assert.match(after, /<Title>A &amp; B<\/Title>/, 'every other byte is kept');
  assert.equal(after.match(/<RelativePath>([^<]*)<\/RelativePath>/)[1], relative(folder, '/work/sample/Drive/Clips/A &amp; B.MP4'));
  assert.equal(answer.resolve.state, 'not-running');
  const kept = readdirSync(folder).find(name => name.startsWith('.Edit.prproj.before-relink-'));
  assert.ok(kept, 'the original is kept beside the new project');
  assert.equal(zlib.gunzipSync(readFileSync(join(folder, kept))).toString('utf8'), before);
});

test('an open project is left alone and reported as waiting; an unrelated project is not written', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'relink-open-'));
  const open = join(folder, 'Open.prproj'), other = join(folder, 'Other.prproj');
  writeFileSync(open, zlib.gzipSync(Buffer.from(project({ absolute: '/work/sample/Card/a.mp4', relative: 'a.mp4' }))));
  writeFileSync(other, zlib.gzipSync(Buffer.from(project({ absolute: '/work/sample/Else/b.mp4', relative: 'b.mp4' }))));
  const reports = await relinkPremiereProjects({ moves: checkedMoves([{ from: '/work/sample/Card/a.mp4', to: '/work/sample/dav/a.mp4' }]), projects: [open, other], isOpen: async file => file === open });
  assert.deepEqual(reports, [{ file: open, state: 'open', moves_waiting: [{ from: '/work/sample/Card/a.mp4', to: '/work/sample/dav/a.mp4' }] }]);
  assert.equal(readdirSync(folder).length, 2, 'nothing new was written');
});

test('Resolve\'s answer is folded into the summary, and moves must be full paths', async () => {
  const result = await relinkEditorProjects({
    moves: [{ from: 'C:\\Card\\a.mp4', to: 'Z:\\Clips\\a.mp4' }], projects: [],
    resolve: async ({ moves }) => ({ state: 'running', project: 'Edit', relinked: moves.map(move => move.from), failed: [] }),
  });
  assert.equal(result.resolve.project, 'Edit');
  assert.match(result.said, /1 clip in DaVinci Resolve's open project now opens/);
  assert.throws(() => checkedMoves([{ from: 'card/a.mp4', to: '/work/sample/dav/a.mp4' }]), /full location/);
  assert.throws(() => checkedMoves([]), /List the moved clips/);
  const windows = rewriteProjectXml('<PremiereData><FilePath>C:\\Card\\a.mp4</FilePath></PremiereData>', checkedMoves([{ from: 'C:\\Card', to: 'Z:\\Clips' }]), 'D:\\Projects\\Edit.prproj');
  assert.equal(windows.xml, '<PremiereData><FilePath>Z:\\Clips\\a.mp4</FilePath></PremiereData>');
});
