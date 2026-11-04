// tools/move-code-between-trees/read-data/check-move.mjs
//
// Prove a move from its receipts (moved-from.json) on a clean checkout of the destination:
// - same bytes: each file's identity is the receipt's, and its bytes equal the source commit's bytes once the receipt's
//   calls are swapped and every import path is set aside; every import still reaches the same file, at its new place;
// - one copy: the source no longer holds the file;
// - it loads: every moved module is imported in a fresh Node process (a .tsx or .jsx file is compiled, when a compiler is
//   installed in either tree, since Node cannot import it);
// - its own tests pass.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { aliasesOf, isCode, isRelative, requestsIn, resolveRequest, targetOf } from './imports.mjs';
import { swapCalls } from './swap-calls.mjs';

const TEST_FILE = /\.test\.(?:mjs|cjs|js|ts|tsx|mts)$/;
const identity = bytes => makeHashCodeHexFromBytes(new Uint8Array(bytes));
// A run started from inside another test run must report as its own run, not to the outer one.
const ownEnv = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return env; };

/** Every receipt in the destination, or in the named folders only. */
export function receiptsIn(destinationFolder, folders) {
  const found = [];
  // A moved-from.json some other mover wrote (its files not a list of this tool's file rows) is not one of these receipts.
  const look = folder => { const path = join(destinationFolder, folder, 'moved-from.json'); if (!existsSync(path)) return; const receipt = JSON.parse(readFileSync(path, 'utf8')); if (Array.isArray(receipt?.files)) found.push({ folder, receipt }); };
  if (folders?.length) folders.forEach(look);
  else if (existsSync(join(destinationFolder, 'tools'))) for (const name of readdirSync(join(destinationFolder, 'tools'))) {
    if (statSync(join(destinationFolder, 'tools', name)).isDirectory()) look(`tools/${name}`);
  }
  return found;
}

/** Every receipt anywhere under tools/, nested folders included. */
export function receiptsUnder(destinationFolder) {
  const folders = [];
  const walk = folder => {
    for (const name of readdirSync(join(destinationFolder, folder))) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = `${folder}/${name}`;
      if (statSync(join(destinationFolder, path)).isDirectory()) walk(path);
      else if (name === 'moved-from.json') folders.push(folder);
    }
  };
  if (existsSync(join(destinationFolder, 'tools'))) walk('tools');
  return receiptsIn(destinationFolder, folders);
}

// The text with every module request's specifier set aside, so two texts that differ only there compare equal.
const withoutRequests = text => {
  let out = '';
  let at = 0;
  for (const item of requestsIn(text)) { out += text.slice(at, item.start) + '\u0000'; at = item.end; }
  return out + text.slice(at);
};

export function checkMove({ sources, destinationFolder, sourceAfterFolder, folders, run = true, timeoutMs = 600000 }) {
  const receipts = receiptsIn(destinationFolder, folders);
  // A tree that keeps its moved files outside tools/ (an app's web/) has its receipts only in the folders named.
  // Where each file landed is read from every receipt in the tree, nested ones too (a group that landed in a folder
  // inside a tool keeps its receipt there), so an import reaching a file an earlier lane carried is found wherever it went.
  const allReceipts = [...receipts, ...receiptsUnder(destinationFolder).filter(item => !receipts.some(own => own.folder === item.folder))];
  // A source file an earlier lane moved and a later one found home already (or two lanes each carried) has every place a
  // receipt names: an import reaching any of them reaches that file.
  const landing = new Map();
  for (const { receipt } of allReceipts) for (const file of receipt.files) landing.set(`${file.commit}:${file.from}`, [...(landing.get(`${file.commit}:${file.from}`) ?? []), file.to]);
  const destinationExists = path => existsSync(join(destinationFolder, path)) && statSync(join(destinationFolder, path)).isFile();

  const results = receipts.map(({ folder, receipt }) => {
    const problems = [];
    for (const file of receipt.files) {
      const tree = sources(file.commit);
      const there = join(destinationFolder, file.to);
      if (!existsSync(there)) { problems.push(`${file.to} is missing`); continue; }
      const now = readFileSync(there);
      if (identity(now) !== file.identity) problems.push(`${file.to} is not the bytes its receipt names`);
      const before = tree.read(file.from);
      if (identity(before) !== file.source_identity) problems.push(`${file.from} at ${file.commit.slice(0, 10)} is not the bytes the receipt names`);
      if (file.reused) { if (isCode(file.from) ? withoutRequests(now.toString('utf8')) !== withoutRequests(before.toString('utf8')) : !now.equals(before)) problems.push(`${file.to} was reused but differs from ${file.from}${isCode(file.from) ? ' beyond its import paths' : ''}`); }
      else if (isCode(file.from)) {
        const used = new Set(file.calls ?? []);
        const swapped = swapCalls(before.toString('utf8'), (receipt.calls ?? []).filter(row => used.has(row.id))).text;
        if (withoutRequests(swapped) !== withoutRequests(now.toString('utf8'))) problems.push(`${file.to} differs from ${file.from} beyond its import paths and swapped calls`);
        const was = requestsIn(swapped);
        const is = requestsIn(now.toString('utf8'));
        if (was.length !== is.length) problems.push(`${file.to} has ${is.length} imports where ${file.from} had ${was.length}`);
        else for (let at = 0; at < was.length; at += 1) {
          const alias = aliasesOf(tree.exists('package.json') ? JSON.parse(tree.read('package.json').toString('utf8')) : {});
          const own = receipt.package && was[at].specifier.startsWith(`${receipt.package}/`) ? was[at].specifier.slice(receipt.package.length + 1) : null;
          if (own && isRelative(is[at].specifier)) {
            const reached = resolveRequest(file.to, is[at].specifier, destinationExists);
            if (reached !== own) problems.push(`${file.to}: ${is[at].specifier} reaches ${reached ?? 'nothing'}, where ${file.from} imported ${own} from the package`);
            continue;
          }
          if (!isRelative(was[at].specifier) && !alias(was[at].specifier)) { if (was[at].specifier !== is[at].specifier) problems.push(`${file.to} imports ${is[at].specifier} where ${file.from} imported ${was[at].specifier}`); continue; }
          const target = targetOf(file.from, was[at].specifier, tree.exists, alias);
          const expected = target && (landing.get(`${file.commit}:${target}`) ?? null);
          const reached = resolveRequest(file.to, is[at].specifier, destinationExists);
          if (target && (expected ? !expected.includes(reached) : reached !== null)) problems.push(`${file.to}: ${is[at].specifier} reaches ${reached ?? 'nothing'}, where ${file.from} reached ${target} (now ${expected?.join(' or ') ?? 'not moved'})`);
        }
      } else if (!now.equals(before)) problems.push(`${file.to} differs from ${file.from}`);
      if (sourceAfterFolder && existsSync(join(sourceAfterFolder, file.from))) problems.push(`${file.from} is still in the source: two copies`);
    }
    const result = { folder, files: receipt.files.length, same_bytes: problems.length === 0, problems };
    if (run) {
      result.loads = loadAll(destinationFolder, receipt.files.map(file => file.to).filter(path => isCode(path) && !TEST_FILE.test(path)), timeoutMs, sources);
      result.tests = runTests(destinationFolder, receipt.files.map(file => file.to).filter(path => TEST_FILE.test(path)), timeoutMs);
    }
    result.ok = result.same_bytes && (!run || (result.loads.failed.length === 0 && result.tests.fail === 0));
    return result;
  });
  return { ok: results.every(item => item.ok), folders: results };
}

// Import each module in one fresh process from the destination's own folder; compile .tsx/.jsx when a compiler is here.
function loadAll(folder, paths, timeoutMs) {
  const runnable = paths.filter(path => !/\.(?:tsx|jsx)$/.test(path));
  const compiled = paths.filter(path => /\.(?:tsx|jsx)$/.test(path));
  const failed = [];
  if (runnable.length) {
    const script = `const failed = [];\nfor (const url of ${JSON.stringify(runnable.map(path => pathToFileURL(join(folder, path)).href))}) {\n  try { await import(url); } catch (error) { failed.push({ url, error: String(error?.message ?? error).split('\\n')[0].slice(0, 300) }); }\n}\nprocess.stdout.write('\\n' + JSON.stringify(failed) + '\\n');\nprocess.exit(0);\n`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: folder, env: ownEnv(), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 28 });
    const last = (child.stdout ?? '').trim().split('\n').pop();
    let answer;
    try { answer = JSON.parse(last); } catch { answer = [{ url: 'all', error: `the load did not finish: ${(child.stderr || child.error?.message || '').slice(0, 300)}` }]; }
    for (const item of answer) failed.push({ path: item.url === 'all' ? 'all' : relative(folder, new URL(item.url).pathname), error: item.error });
  }
  let compiler = null;
  for (const base of [folder]) { try { compiler = createRequire(join(base, 'package.json'))('esbuild'); break; } catch { /* no compiler here */ } }
  const notCompiled = [];
  for (const path of compiled) {
    if (!compiler) { notCompiled.push(path); continue; }
    try { compiler.transformSync(readFileSync(join(folder, path), 'utf8'), { loader: path.endsWith('x') ? posix.extname(path).slice(1) : 'ts', jsx: 'automatic' }); }
    catch (error) { failed.push({ path, error: String(error.message).split('\n')[0] }); }
  }
  return { imported: runnable.length, compiled: compiled.length - notCompiled.length, not_compiled: notCompiled, failed };
}

function runTests(folder, paths, timeoutMs) {
  if (!paths.length) return { files: 0, pass: 0, fail: 0 };
  const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...paths], { cwd: folder, env: ownEnv(), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 28 });
  const count = name => Number((child.stdout ?? '').match(new RegExp(`^# ${name} (\\d+)`, 'm'))?.[1] ?? 0);
  const failedNames = [...(child.stdout ?? '').matchAll(/^not ok \d+ - (.*)$/gm)].map(match => match[1]).slice(0, 20);
  const fail = count('fail') + count('cancelled') + (child.status !== 0 && count('fail') === 0 ? 1 : 0);
  return { files: paths.length, pass: count('pass'), fail, ...(failedNames.length ? { failed: failedNames } : {}) };
}
