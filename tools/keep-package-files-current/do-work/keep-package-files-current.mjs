// tools/keep-package-files-current/do-work/keep-package-files-current.mjs
//
// Purpose: keeps the Workshop's package-files.json able to start every tool row. One pass regenerates the file from an export of
// origin/main (the generator is test-helpers/write-package-files.mjs), and compares it with origin's current file. The job only
// ever ADDS: a row or an item the generator finds that origin lacks is added to origin's file. An origin item or row the generator
// does not find is never removed or changed (a generator that misses a still-imported package is a generator bug, not a reason to
// drop it); it is returned as a finding. Origin's file is the base, so a hand patch on origin is never undone.
//
//   node --no-warnings do-work/keep-package-files-current.mjs --root <workshop checkout>
//
// Landing: the commit is built on a private index inside the checkout's git folder (origin/main plus the new file only), judged by
// the gates (gate_chain_body.py --judge), and pushed under the landing lease (landing_lease.py) after origin is checked unchanged.
// Every git call goes through the shared git module, in the granted folder only.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, gitPathIn } from '../../keep-the-shared-checkout-current/do-work/git-in-a-declared-folder.mjs';
import { duplicateLayouts } from '../../workflows/do-work/pin-a-commit-by-its-files.mjs';

export const PACKAGE_FILES = 'package-files.json';
const LANE = 'keep-package-files-current';
const MESSAGE = 'package-files.json: entries the generator finds that origin lacks are added (nothing removed or changed)\n';
// The landing owners live in the ai-command-center checkout beside the Workshop on this Mac.
const OWNERS = join(homedir(), 'dev', 'ai-command-center', '.claude', 'hooks');
const JUDGE = join(OWNERS, 'gate_chain_body.py');
const LEASE = join(OWNERS, 'lib', 'landing_lease.py');
const PYTHON = '/usr/bin/python3';
const itemKey = item => JSON.stringify(item);

// Under the lease: origin is checked unchanged, then the commit is pushed with the lease held (the pre-push gates see
// LANDING_LEASE_HELD=1). Prints one verdict line: LANDED, MOVED, REFUSED or PUSHED-NOT-ANCESTOR.
const PUSH_UNDER_LEASE = `
import importlib.util, os, subprocess, sys
repo, commit, tip = sys.argv[1], sys.argv[2], sys.argv[3]
spec = importlib.util.spec_from_file_location("landing_lease", ${JSON.stringify(LEASE)})
lease_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lease_module)
lease = lease_module.acquire(repo, owner_pid=os.getpid(), lane=${JSON.stringify(LANE)}, parent_alive=lambda: True, via=${JSON.stringify(LANE)})
try:
    subprocess.run(["git", "-C", repo, "fetch", "-q", "origin"], check=True)
    now = subprocess.run(["git", "-C", repo, "rev-parse", "origin/main"], capture_output=True, text=True).stdout.strip()
    if now != tip:
        print("MOVED " + now); sys.exit(0)
    env = dict(os.environ, LANDING_LEASE_HELD="1")
    pushed = subprocess.run(["git", "-C", repo, "push", "origin", commit + ":refs/heads/main"], capture_output=True, text=True, env=env)
    if pushed.returncode:
        print("REFUSED " + pushed.stderr.strip()[-400:]); sys.exit(1)
    subprocess.run(["git", "-C", repo, "fetch", "-q", "origin"], check=True)
    landed = subprocess.run(["git", "-C", repo, "merge-base", "--is-ancestor", commit, "origin/main"]).returncode == 0
    print(("LANDED " if landed else "PUSHED-NOT-ANCESTOR ") + commit)
finally:
    lease_module.release(lease)
`;

/** origin's rows with what the generator adds: a new row, or new items appended to a row origin has. Nothing origin has is removed.
 *  An add whose place the row already lays (by an origin item, or by an earlier add) is not an add: the pin tool's own rule
 *  (duplicateLayouts) judges each candidate, so the merged file cannot fail the judge on a duplicate. */
export function classify({ oldRows, newRows }) {
  const merged = {};
  const added = [];
  const skipped = [];
  const findings = [];
  for (const row of Object.keys(oldRows)) merged[row] = [...oldRows[row]];
  const addIfClear = (row, item) => {
    const candidate = [...merged[row], item];
    if (duplicateLayouts({ [row]: candidate }).length) { skipped.push({ row, item, why: 'its place is already laid by this row' }); return false; }
    merged[row] = candidate;
    return true;
  };
  for (const row of Object.keys(newRows)) {
    if (!(row in oldRows)) {
      merged[row] = [];
      for (const item of newRows[row]) if (addIfClear(row, item)) added.push({ row, item, why: 'row added' });
      continue;
    }
    const before = new Set(oldRows[row].map(itemKey));
    const after = new Set(newRows[row].map(itemKey));
    for (const item of newRows[row]) if (!before.has(itemKey(item)) && addIfClear(row, item)) added.push({ row, item, why: 'item added' });
    for (const item of oldRows[row]) if (!after.has(itemKey(item))) findings.push({ row, item, why: 'the generator does not find this item; origin keeps it' });
  }
  for (const row of Object.keys(oldRows)) if (!(row in newRows)) findings.push({ row, why: 'the generator does not find this row; origin keeps it' });
  return { merged, added, skipped, findings, land: added.length > 0 };
}

/** One pass. The seams do the git, generator and landing work; the tests pass fakes and the command line passes the real ones. */
export async function keepPackageFilesCurrent({ root, seams }) {
  const tip = await seams.fetchOriginMain(root);
  const oldRows = JSON.parse(await seams.fileAt(root, tip));
  const newRows = JSON.parse(await seams.generate(root, tip));
  const verdict = classify({ oldRows, newRows });
  const summary = { at: tip, added: verdict.added.length, skipped: verdict.skipped.length, findings: verdict.findings };
  if (!verdict.land) return { outcome: 'nothing-to-do', ...summary };
  // Origin may have moved while the generator ran. The additions were made against origin's file at `tip`, so they are still right
  // on a newer tip only when origin's file is unchanged; then the commit is built on the newer tip. Any other change to the file
  // lands nothing, and the next pass starts again from the new tip.
  let base = tip;
  const moved = await seams.fetchOriginMain(root);
  if (moved !== tip) {
    if (await seams.fileAt(root, moved) !== await seams.fileAt(root, tip)) return { outcome: 'origin-moved', ...summary };
    base = moved;
  }
  const text = JSON.stringify(verdict.merged, null, 1) + '\n';
  const landed = await seams.land(root, { tip: base, text });
  return { outcome: landed.ok ? 'landed' : 'error', ...summary, commit: landed.commit ?? null, why: landed.why ?? null };
}

// The real seams: git through the shared module, the generator run from an export of the tip, and the landing under the lease.
export const realSeams = {
  async fetchOriginMain(root) {
    git(root, ['fetch', '-q', 'origin']);
    return git(root, ['rev-parse', 'origin/main']).trim();
  },
  async fileAt(root, tip) {
    return git(root, ['show', `${tip}:${PACKAGE_FILES}`]);
  },
  async generate(root, tip) {
    const folder = mkdtempSync(join(tmpdir(), 'keep-package-files-'));
    try {
      const archive = spawnSync('git', ['-C', root, 'archive', tip], { maxBuffer: 2 ** 31 });
      if (archive.status !== 0) throw new Error(`git archive ${tip} failed`);
      spawnSync('tar', ['-x', '-C', folder], { input: archive.stdout });
      symlinkSync(join(root, 'node_modules'), join(folder, 'node_modules'));
      const generator = await import(pathToFileURL(join(folder, 'test-helpers', 'write-package-files.mjs')).href);
      return generator.packageFilesText({ repo: root, ref: tip });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
  async land(root, { tip, text }) {
    // The commit is built on a private index in the checkout's git folder: origin/main, then the new file only.
    const index = gitPathIn(root, `${LANE}.index`);
    const scratch = gitPathIn(root, `${LANE}.json`);
    writeFileSync(scratch, text);
    try {
      const env = { GIT_INDEX_FILE: index };
      git(root, ['read-tree', tip], { env });
      const blob = git(root, ['hash-object', '-w', scratch]).trim();
      git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${PACKAGE_FILES}`], { env });
      const tree = git(root, ['write-tree'], { env }).trim();
      const commit = git(root, ['commit-tree', tree, '-p', tip, '-m', MESSAGE]).trim();
      const judged = spawnSync(PYTHON, [JUDGE, '--judge', root, commit], { encoding: 'utf8' });
      if (judged.status !== 0) return { ok: false, why: `the gates did not pass ${commit.slice(0, 10)}: ${(judged.stderr || judged.stdout).trim().slice(-400)}` };
      const pushed = spawnSync(PYTHON, ['-c', PUSH_UNDER_LEASE, root, commit, tip], { encoding: 'utf8' });
      const verdict = (pushed.stdout || '').trim().split('\n').pop() ?? '';
      if (pushed.status !== 0 || !verdict.startsWith('LANDED ')) return { ok: false, why: verdict || (pushed.stderr || '').trim().slice(-400) };
      return { ok: true, commit };
    } finally {
      for (const path of [index, scratch]) { try { unlinkSync(path); } catch { /* already gone */ } }
    }
  },
};

if (import.meta.url === (process.argv[1] ? pathToFileURL(process.argv[1]).href : '')) {
  const root = process.argv[process.argv.indexOf('--root') + 1];
  // A pass that throws reports an error outcome: the next pass starts again from origin/main.
  const result = await keepPackageFilesCurrent({ root, seams: realSeams }).catch(error => ({ outcome: 'error', why: error.message }));
  console.log(JSON.stringify(result));
}
