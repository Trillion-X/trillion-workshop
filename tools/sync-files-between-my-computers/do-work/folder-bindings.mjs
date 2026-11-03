// computer/folder-bindings.mjs
//
// PURPOSE
//   A folder on this computer bound to a folder in the person's Trillion files, kept by the Drive
//   (computer/trillion-drive.mjs): the computer-backup feature. A binding is a small record (id, local folder, Trillion
//   folder). `run` sends every changed file in the local folder up through the Drive's own keepFile, so each file passes the
//   one compare-and-set gate (`expected_identity`) the Namespace owner enforces. Nothing here decides who may write what.
//   `redirect` is the opt-in step that makes the bound folder live in Trillion: after every file is proven stored, the local
//   folder is moved aside whole (never deleted) and a link to its Trillion place is left at the old path; `restore` puts it
//   back.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A binding is refused unless every constraint named in `folder_bindings.constraints` holds (DATA rows; each is a
//      checkable rule: the local path is whole and absolute, readable, outside the Drive's own state, bound once, not
//      nested in another binding, and the Trillion folder is one this Drive may write). `check` re-runs them on a stored
//      binding, so a folder that was renamed or removed afterwards is reported, not silently skipped.
//   2. A run only adds and updates. It never removes a Trillion name, whatever happened locally. Symbolic links and
//      other special files are counted and left alone; empty files are counted (Trillion keeps no empty file).
//   3. A file is read again only when its size or modified time changed since the run that stored it (`seen`, bounded by
//      `most_seen_entries`); a file that fails is put on a throttle list for `throttle_seconds` instead of retried every run.
//   4. `redirect` is off unless `folder_bindings.redirect.enabled`. It moves nothing until a fresh pass proves, for every
//      file the run would send, that its BLAKE3 identity is the one Trillion lists now and that it has not changed since it
//      was stored; any empty file, link, special file, unsent file or mismatch refuses the redirect and changes nothing. The
//      folder is renamed into `redirect.archive_dir` (a rename on one volume; if that is not possible it refuses, it never
//      copies and deletes), then the link is made; if the link cannot be made the folder is renamed back.
//   5. `restore` only undoes our own redirect: the old path must still be exactly the link made, and the archive must
//      still be there.
//   Every size, count, time and rule here is DATA (`folder_bindings` in trillion-drive.json).
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import { blake3 } from '../parts/live-namespace/do-work/blake3.mjs';

const typed = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const contains = (outer, inner) => inner === outer || inner.startsWith(outer.endsWith(path.sep) || outer.endsWith('/') ? outer : `${outer}${outer === '/' ? '' : path.sep}`);
const trimTarget = target => String(target).replace(/\/+$/, '') || '/';

async function identityOfFile(file) {
  const hasher = blake3.create();
  for await (const piece of createReadStream(file)) hasher.update(piece);
  return `1f:${bytesToHex(hasher.digest())}`;
}

/**
 * `ops` is the Drive's own surface: { entryOf, keepFile, writeRefusal }. `config` is the `folder_bindings` DATA block.
 * `file` is where the bindings are kept, `stateDir` the Drive's state folder (never bindable), `home` the person's home
 * folder (the archive is under it).
 */
export function createFolderBindings({ ops, config, file, stateDir, home, ignored = () => false, now = Date.now, newId = randomUUID }) {
  let loaded = null;
  let saving = Promise.resolve();
  const running = new Map(); // binding id -> promise

  async function load() {
    if (loaded) return loaded;
    try { loaded = JSON.parse(await fs.readFile(file, 'utf8')); } catch { loaded = { bindings: {} }; }
    if (!loaded.bindings || typeof loaded.bindings !== 'object') loaded = { bindings: {} };
    return loaded;
  }
  function save() {
    saving = saving.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const part = `${file}.part-${process.pid}`;
      await fs.writeFile(part, JSON.stringify(loaded));
      await fs.rename(part, file);
    });
    return saving;
  }
  const publicView = binding => { const { seen, ...rest } = binding; return { ...rest, seen_entries: Object.keys(seen ?? {}).length }; };
  const find = async id => {
    const state = await load();
    const binding = state.bindings[id];
    if (!binding) throw typed(404, 'no_binding', `No binding is named ${id}.`);
    return binding;
  };

  // ---- the constraints -------------------------------------------------------------------------------------------
  const constraints = {
    local_whole: async ({ local }) => (path.isAbsolute(local) && path.resolve(local) === local && local !== path.parse(local).root ? null : 'The local folder must be a whole absolute path below the top of a disk.'),
    local_readable: async ({ local }) => {
      try { const stat = await fs.stat(local); if (!stat.isDirectory()) return 'The local path is not a folder.'; await fs.access(local, fs.constants.R_OK); return null; }
      catch { return 'The local folder is missing or cannot be read.'; }
    },
    local_outside_state: async ({ local }) => (contains(stateDir, local) || contains(local, stateDir) ? 'The local folder cannot hold or sit inside the Drive\'s own state.' : null),
    unique_local: async ({ local }, others) => (others.some(other => other.local === local) ? 'That local folder is already bound.' : null),
    unique_target: async ({ target }, others) => (others.some(other => other.target === target) ? 'That Trillion folder is already bound.' : null),
    no_nesting: async ({ local, target }, others) => {
      const clash = others.find(other => contains(other.local, local) || contains(local, other.local) || contains(other.target, target) || contains(target, other.target));
      return clash ? `It overlaps the binding of ${clash.local}.` : null;
    },
    target_writable: async ({ target }) => (await ops.writeRefusal(`${target}/x`, null)) ?? (target === '/' ? 'Bind a folder inside the drive, not the top of it.' : null),
  };
  async function checks(binding, others) {
    const rows = [];
    for (const name of config.constraints) {
      const rule = constraints[name];
      if (!rule) throw typed(500, 'unknown_constraint', `folder_bindings.constraints names ${name}, which no rule answers.`);
      const message = await rule(binding, others);
      rows.push({ constraint: name, ok: message === null, ...(message ? { message } : {}) });
    }
    return rows;
  }

  // ---- create / read / edit / delete ------------------------------------------------------------------------------
  async function add({ local, target, enabled = true } = {}) {
    if (typeof local !== 'string' || typeof target !== 'string' || !target.startsWith('/')) throw typed(400, 'bad_binding', 'Give the local folder and the Trillion folder (starting with /).');
    const state = await load();
    const binding = { id: newId(), local, target: trimTarget(target), enabled: enabled !== false, created_at_ms: now(), last_run: null, throttled: {}, seen: {}, redirect: null };
    const failed = (await checks(binding, Object.values(state.bindings))).filter(row => !row.ok);
    if (failed.length) throw typed(409, 'binding_refused', failed.map(row => row.message).join(' '), { checks: failed });
    state.bindings[binding.id] = binding;
    await save();
    return publicView(binding);
  }
  async function list() { return Object.values((await load()).bindings).map(publicView); }
  async function read(id) {
    const binding = await find(id);
    const others = Object.values((await load()).bindings).filter(other => other.id !== id);
    return { ...publicView(binding), checks: await checks(binding, others) };
  }
  async function edit(id, patch = {}) {
    const binding = await find(id);
    if (Object.hasOwn(patch, 'enabled')) binding.enabled = patch.enabled !== false;
    if (patch.clear_throttle === true) binding.throttled = {};
    await save();
    return publicView(binding);
  }
  async function remove(id) {
    const state = await load();
    const binding = await find(id);
    if (binding.redirect) throw typed(409, 'redirected', 'This folder is redirected into Trillion. Restore it before removing the binding.');
    if (running.has(id)) throw typed(409, 'running', 'A run of this binding is in progress.');
    delete state.bindings[id];
    await save();
    return { id, removed: true };
  }

  // ---- walking the local folder -------------------------------------------------------------------------------------
  async function* walk(root, folder = root) {
    for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) yield* walk(root, full);
      else yield { full, relative: path.relative(root, full).split(path.sep).join('/'), entry };
    }
  }
  const targetName = (binding, relative) => `${binding.target === '/' ? '' : binding.target}/${relative}`;

  /** Reads a stored file's identity, using what the last run saw while the size and modified time still hold. */
  async function localIdentity(binding, relative, full, stat) {
    const seen = binding.seen[relative];
    if (seen && seen.size === stat.size && seen.mtime_ms === stat.mtimeMs) return seen.identity;
    return identityOfFile(full);
  }
  function remember(binding, relative, size, mtime_ms, identity) {
    delete binding.seen[relative];
    binding.seen[relative] = { size, mtime_ms, identity };
    const keys = Object.keys(binding.seen);
    for (const old of keys.slice(0, Math.max(0, keys.length - config.most_seen_entries))) delete binding.seen[old];
  }

  // ---- run ---------------------------------------------------------------------------------------------------------
  async function run(id) {
    const binding = await find(id);
    if (!binding.enabled) throw typed(409, 'paused', 'This binding is paused.');
    if (binding.redirect) throw typed(409, 'redirected', 'This folder is redirected into Trillion; there is nothing local to send.');
    if (running.has(id)) return running.get(id);
    const work = (async () => {
      const tally = { uploaded: 0, unchanged: 0, ignored: 0, links_left: 0, empty: 0, throttled: 0, failed: [], conflicts: [], capped: false };
      let seen = 0;
      for await (const { full, relative, entry } of walk(binding.local)) {
        const name = targetName(binding, relative);
        if (ignored(name)) { tally.ignored += 1; continue; }
        if (!entry.isFile()) { tally.links_left += 1; continue; }
        if ((seen += 1) > config.most_files_per_run) { tally.capped = true; break; }
        const hold = binding.throttled[relative];
        if (hold && hold.until_ms > now()) { tally.throttled += 1; continue; }
        try {
          const stat = await fs.stat(full);
          if (stat.size === 0) { tally.empty += 1; continue; }
          const identity = await localIdentity(binding, relative, full, stat);
          const there = await ops.entryOf(name, { fresh: true });
          if (there && !there.folder && there.identity === identity) { remember(binding, relative, stat.size, stat.mtimeMs, identity); delete binding.throttled[relative]; tally.unchanged += 1; continue; }
          if (there?.folder) throw typed(409, 'folder_in_the_way', `${name} is a folder in Trillion.`);
          const sent = await ops.keepFile(name, createReadStream(full), stat.size, null, Math.floor(stat.mtimeMs), there ? there.identity ?? undefined : null);
          remember(binding, relative, stat.size, stat.mtimeMs, sent?.identity ?? identity);
          delete binding.throttled[relative];
          tally.uploaded += 1;
        } catch (error) {
          if (error.status === 409) tally.conflicts.push({ name, code: error.code ?? 'stale_version' });
          else tally.failed.push({ name, error: String(error.message ?? error) });
          binding.throttled[relative] = { until_ms: now() + config.throttle_seconds * 1000, reason: String(error.message ?? error).slice(0, 200) };
        }
      }
      binding.last_run = { at_ms: now(), ...tally };
      await save();
      return binding.last_run;
    })().finally(() => running.delete(id));
    running.set(id, work);
    return work;
  }

  // ---- redirect / restore --------------------------------------------------------------------------------------------
  async function proveStored(binding) {
    const problems = [];
    const note = (name, why) => { if (problems.length < config.redirect.most_listed) problems.push({ name, why }); };
    for await (const { full, relative, entry } of walk(binding.local)) {
      const name = targetName(binding, relative);
      if (ignored(name)) continue;
      if (!entry.isFile()) { note(name, 'a link or special file would not be in Trillion'); continue; }
      const stat = await fs.stat(full);
      if (stat.size === 0) { note(name, 'an empty file would not be in Trillion'); continue; }
      const seen = binding.seen[relative];
      if (!seen || seen.size !== stat.size || seen.mtime_ms !== stat.mtimeMs) { note(name, 'changed or not sent since the last run'); continue; }
      const there = await ops.entryOf(name, { fresh: true });
      if (!there || there.folder || there.identity !== seen.identity) { note(name, 'Trillion does not list these bytes under this name'); continue; }
      if (await identityOfFile(full) !== seen.identity) note(name, 'the bytes on disk are not the bytes that were sent');
    }
    return problems;
  }
  async function redirect(id) {
    if (!config.redirect.enabled) throw typed(403, 'redirect_off', 'Redirecting a folder into Trillion is off. Turn on folder_bindings.redirect.enabled first.');
    if (!config.redirect.link_root) throw typed(409, 'no_link_root', 'Say where Trillion\'s files appear on this computer (folder_bindings.redirect.link_root) first.');
    const binding = await find(id);
    if (binding.redirect) throw typed(409, 'redirected', 'This folder is already redirected.');
    const sent = await run(id);
    if (sent.failed.length || sent.conflicts.length || sent.throttled || sent.capped) throw typed(409, 'not_all_sent', 'Not every file reached Trillion yet. Nothing was moved.', { run: sent });
    const problems = await proveStored(binding);
    if (problems.length) throw typed(409, 'not_proven', 'Not every file is proven to be stored. Nothing was moved.', { problems });
    const archive = path.join(home, config.redirect.archive_dir, binding.id, path.basename(binding.local));
    const link = path.join(config.redirect.link_root, binding.target);
    await fs.mkdir(path.dirname(archive), { recursive: true });
    try { await fs.rename(binding.local, archive); }
    catch (error) { throw typed(409, 'cannot_move_aside', `The folder could not be renamed into ${archive} (${error.code ?? error.message}). Nothing was moved.`); }
    try { await fs.symlink(link, binding.local); }
    catch (error) {
      await fs.rename(archive, binding.local);
      throw typed(409, 'cannot_link', `The link could not be made (${error.code ?? error.message}); the folder was put back.`);
    }
    binding.redirect = { archive, link, at_ms: now() };
    await fs.writeFile(path.join(archive, '.trillion-redirect.json'), JSON.stringify({ id: binding.id, local: binding.local, link, at_ms: binding.redirect.at_ms })).catch(() => {});
    await save();
    return publicView(binding);
  }
  async function restore(id) {
    const binding = await find(id);
    if (!binding.redirect) throw typed(409, 'not_redirected', 'This folder is not redirected.');
    const { archive, link } = binding.redirect;
    let held;
    try { held = await fs.lstat(binding.local); } catch { held = null; }
    if (held && !(held.isSymbolicLink() && await fs.readlink(binding.local) === link)) throw typed(409, 'path_changed', 'Something else is at the old path now. Nothing was changed.');
    try { await fs.access(archive); } catch { throw typed(409, 'archive_missing', 'The kept folder is not where it was left. Nothing was changed.'); }
    if (held) await fs.unlink(binding.local);
    try { await fs.rename(archive, binding.local); }
    catch (error) {
      if (held) await fs.symlink(link, binding.local).catch(() => {});
      throw typed(409, 'cannot_restore', `The folder could not be moved back (${error.code ?? error.message}); the link was kept.`);
    }
    await fs.rm(path.join(binding.local, '.trillion-redirect.json'), { force: true });
    binding.redirect = null;
    binding.seen = {};
    await save();
    return publicView(binding);
  }

  return { add, list, read, edit, remove, run, check: read, redirect, restore, settled: () => saving };
}
