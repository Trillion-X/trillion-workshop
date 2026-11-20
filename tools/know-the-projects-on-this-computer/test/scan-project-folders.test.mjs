// tools/know-the-projects-on-this-computer/test/scan-project-folders.test.mjs
// The scan port (verify-every-port L14, C1 and C2): markers, roots one level deep, BLAKE3 ids, the preview descriptor,
// and the one-path add check. Every fixture is a mkdtemp folder, removed after the run.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import {
  isProjectDir,
  listCandidateProjects,
  normalizePreviewCommand,
  projectIdFor,
  readScanConfig,
  scanProjects,
  validateOneProjectPath,
} from '../do-work/scan-project-folders.mjs';

function fixture() {
  // realpath: on macOS the temp folder sits behind a symlink, and the scan reports resolved paths.
  const root = fs.realpathSync(tempFolder(path.join(os.tmpdir(), 'known-projects-scan-')));
  const write = (rel, text = '') => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  return { root, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a folder is a project only when it is a directory holding a marker', () => {
  const f = fixture();
  try {
    f.write('node/package.json', '{}');
    f.write('rust/Cargo.toml', '');
    f.write('git/.git/HEAD', 'ref');
    f.write('claude/.claude/x', '');
    f.write('plain/readme.txt', '');
    assert.equal(isProjectDir(path.join(f.root, 'node')), true);
    assert.equal(isProjectDir(path.join(f.root, 'rust')), true);
    assert.equal(isProjectDir(path.join(f.root, 'git')), true);
    assert.equal(isProjectDir(path.join(f.root, 'claude')), true);
    assert.equal(isProjectDir(path.join(f.root, 'plain')), false);
    assert.equal(isProjectDir(path.join(f.root, 'missing')), false);
    assert.equal(isProjectDir(path.join(f.root, 'node', 'package.json')), false);
  } finally {
    f.cleanup();
  }
});

test('a root is scanned one level deep, and a root that is itself a project counts', () => {
  const f = fixture();
  try {
    f.write('root/package.json', '{}');
    f.write('root/child-a/go.mod', '');
    f.write('root/child-b/deep/go.mod', '');
    f.write('root/child-c/readme', '');
    const found = listCandidateProjects({ roots: [path.join(f.root, 'root')] });
    assert.deepEqual(found, [path.join(f.root, 'root'), path.join(f.root, 'root', 'child-a')].sort());
  } finally {
    f.cleanup();
  }
});

test('ids are project:<slug>-<24 hex of BLAKE3 over the resolved path bytes>, never SHA-256', () => {
  const folder = '/work/projects/My Cool App';
  const id = projectIdFor(folder);
  const digest = makeHashCodeHexFromBytes(new TextEncoder().encode(folder)).slice(3, 27);
  assert.equal(id, `project:my-cool-app-${digest}`);
  assert.match(id, /^project:my-cool-app-[0-9a-f]{24}$/);
  assert.equal(projectIdFor(folder), id, 'the same path gives the same id');
  assert.notEqual(projectIdFor('/a/app'), projectIdFor('/b/app'), 'two folders with one name get two ids');
});

test('the record carries the old field set, git and claude flags, and a non-git source', () => {
  const f = fixture();
  try {
    f.write('plain/package.json', '{}');
    f.write('repo/.git/HEAD', 'ref');
    f.write('repo/.claude/settings.json', '{}');
    const records = scanProjects({ paths: [path.join(f.root, 'plain'), path.join(f.root, 'repo')] });
    assert.equal(records.length, 2);
    const plain = records.find((r) => r.name === 'plain');
    const repo = records.find((r) => r.name === 'repo');
    assert.equal(plain.source, 'user_config');
    assert.equal(plain.is_git_repo, false);
    assert.equal(plain.has_claude_dir, false);
    assert.equal(repo.source, 'git_scan');
    assert.equal(repo.is_git_repo, true);
    assert.equal(repo.has_claude_dir, true);
    assert.equal(plain.path, path.join(f.root, 'plain'));
    assert.match(plain.last_activity, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(plain.project_id, /^project:plain-[0-9a-f]{24}$/);
  } finally {
    f.cleanup();
  }
});

test('the preview descriptor gives a resolved url, a command with a relative cwd, and a status probe', () => {
  const f = fixture();
  try {
    f.write('app/package.json', '{}');
    f.write(
      'app/.architect-preview.json',
      JSON.stringify({
        url: '  http://localhost:3000  ',
        command: { argv: ['npm', 'run', 'dev'], cwd: 'web', env: { PORT: '3000' }, timeout_ms: 5000 },
        status_probe: { command: { argv: ['curl', '-s', 'localhost:3000'] } },
      }),
    );
    const [record] = scanProjects({ paths: [path.join(f.root, 'app')] });
    assert.equal(record.resolved_url, 'http://localhost:3000');
    assert.deepEqual(record.preview_command.argv, ['npm', 'run', 'dev']);
    assert.equal(record.preview_command.cwd, path.join(fs.realpathSync(f.root), 'app', 'web'));
    assert.deepEqual(record.preview_command.env, { PORT: '3000' });
    assert.equal(record.preview_command.timeout_ms, 5000);
    assert.equal(record.preview_status_probe.kind, 'command');
    assert.deepEqual(record.preview_status_probe.command.argv, ['curl', '-s', 'localhost:3000']);
  } finally {
    f.cleanup();
  }
});

test('a broken preview descriptor drops only the broken part, and never throws', () => {
  const f = fixture();
  try {
    f.write('bad/package.json', '{}');
    f.write('bad/.architect-preview.json', '{not json');
    const [record] = scanProjects({ paths: [path.join(f.root, 'bad')] });
    assert.equal(record.resolved_url, undefined);
    assert.equal(record.preview_command, undefined);
    assert.equal(record.preview_status_probe, undefined);
    assert.equal(record.name, 'bad');
  } finally {
    f.cleanup();
  }
});

test('a preview command with a non-string argv entry is dropped', () => {
  assert.equal(normalizePreviewCommand({ argv: ['npm', 3] }, '/x'), null);
  assert.equal(normalizePreviewCommand({ argv: 'npm' }, '/x'), null);
  assert.equal(normalizePreviewCommand(null, '/x'), null);
  const command = normalizePreviewCommand({ argv: ['make'], timeout_ms: -4, env: ['no'] }, '/x');
  assert.equal(command.timeout_ms, undefined);
  assert.deepEqual(command.env, {});
});

test('the one-path check returns the record for a project folder and null for anything else', () => {
  const f = fixture();
  try {
    f.write('good/Cargo.toml', '');
    f.write('plain/notes.txt', '');
    const good = validateOneProjectPath(path.join(f.root, 'good'));
    assert.equal(good.name, 'good');
    assert.equal(good.source, 'user_config');
    assert.equal(validateOneProjectPath(path.join(f.root, 'plain')), null);
    assert.equal(validateOneProjectPath(path.join(f.root, 'nowhere')), null);
    assert.equal(validateOneProjectPath('   '), null);
  } finally {
    f.cleanup();
  }
});

test('the config reader takes JSON, reads anything else as one path, and gives nothing for a JSON non-object', () => {
  assert.deepEqual(readScanConfig(undefined), {});
  assert.deepEqual(readScanConfig('{"roots":["~/dev"]}'), { roots: ['~/dev'] });
  assert.deepEqual(readScanConfig('/work/projects/app'), { paths: ['/work/projects/app'] });
  assert.deepEqual(readScanConfig('[1,2]'), {});
});
