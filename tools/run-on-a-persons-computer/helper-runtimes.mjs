// computer/helper-runtimes.mjs
//
// PURPOSE
//   Keeps the app small by fetching a native helper (a model runner, an encoder, a tool server) the first time it is
//   needed, from a manifest that pins what the bytes must be. Other modules in computer/ ask for a helper by id and get the
//   path of a copy that was checked against its pinned hash just now.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: this file names no helper, host or program. Every helper is a row in computer/helper-runtimes.json.
//   2. Pinned: bytes are installed only when their length is within the row's `size` and their BLAKE3 equals the row's
//      `blake3`; the fetch host is never trusted. A row without both is refused.
//   3. Checked on every use: the installed copy is hashed again before its path is handed out. A copy that no longer matches
//      is removed and fetched again, so a changed file is never run.
//   4. Single flight and atomic: concurrent asks for one helper share one fetch; the bytes are written beside the final path
//      and renamed into place, so a reader never sees half a file. Staging left by a process that is gone is reaped.
//   5. Blocked content is switched off, not forgotten: `recheck` turns off every installed helper whose BLAKE3 is in `blocked`
//      (with the reason) and, when the block is lifted, restores exactly the state it had before (a helper the person
//      had turned off stays off). Each install keeps a receipt (content hash, size, source, signer, time) beside it.
//   5b. A row may be `unpinned` (no blake3: a vendor whose releases cannot be pinned, such as a model server). It is
//      fetched over https within the row's `size` (or `unpinned_max_bytes`) and its receipt says `pinned: false` with the hash
//      that was seen, so nobody reads it as checked. A row may list `adopt` paths: a copy the person installed themselves is
//      used as it is, never replaced, and its receipt says `adopted: true`. An `archive` row is a zip unpacked beside its
//      receipt; its `entry` is what is handed out.
//   5c. `manifest` (url, signature_url, channel) names a list somebody publishes. `refresh` fetches it, accepts it only when a
//      trusted key verifies its detached signature (computer/signed-manifest.mjs), and adds or advances a helper row only to a
//      strictly newer version, never back; the accepted rows are kept in the state folder and used beside the shipped ones.
//      The shipped rows are never rewritten, and an unsigned or unverifiable list changes nothing.
//   5d. A row may carry `verify`: argument arrays (never a shell string) run with {app} filled in as the unpacked entry, before
//      anything is moved into place; one that exits non-zero refuses the install and leaves the install folder as it was (the
//      model server's `codesign --verify` is such a row). It runs on the unpacked bundle even when the row has no pin.
//   6. A withdrawn row is refused the next time it is asked for, with no app release; its installed copy is deleted.
//
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { makeHashCodeHexFromBytes } from '../content-identity/read-data/identity.mjs';
import { openDocument } from '../run-on-a-persons-computer/versioned-document.mjs';
import { chooseUpdate, compareVersions, manifestSettings, verifyManifest } from './signed-manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const helperSettings = () => JSON.parse(readFileSync(join(HERE, 'helper-runtimes.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const refusal = (message, status, retry) => Object.assign(new Error(message), { status, retry });
export const hashOf = bytes => makeHashCodeHexFromBytes(bytes).slice(3);

const execFileAsync = promisify(execFile);
const unzip = (zip, into) => execFileAsync('ditto', ['-x', '-k', zip, into]);
async function fetchBody(url) {
  const answer = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!answer.ok) throw new Error(`answered ${answer.status}`);
  return answer.text();
}

const STATE_VERSION = 1;
const STATE_MIGRATIONS = {};

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };

async function fetchPinned(url, size) {
  const answer = await fetch(url, { redirect: 'follow' });
  if (!answer.ok) throw new Error(`answered ${answer.status}`);
  const declared = Number(answer.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > size) return { tooBig: true };
  const bytes = new Uint8Array(await answer.arrayBuffer());
  return bytes.length > size ? { tooBig: true } : { bytes };
}

/** The helper manager, over the Mac's files and network so tests hold pretend ones. `fetchBytes(url, size)` → { bytes } | { tooBig }. */
export function makeHelperRuntimes({ settings = helperSettings(), home = homedir(), now = () => Date.now(), arch = process.arch, pid = process.pid, fetchBytes = fetchPinned, unpack = unzip, run = (program, args) => execFileAsync(program, args), fetchText = fetchBody, manifestRules = manifestSettings() } = {}) {
  const root = join(home, settings.install_dir);
  const flights = new Map();
  const signedFile = join(root, 'signed-helpers.json');
  const readSigned = () => { try { return JSON.parse(readFileSync(signedFile, 'utf8')).rows ?? []; } catch { return []; } };
  /** The shipped rows with the verified signed ones laid over them. */
  const helpersNow = () => {
    const rows = new Map(settings.helpers.map(item => [item.id, item]));
    for (const item of readSigned()) rows.set(item.id, { ...rows.get(item.id), ...item });
    return [...rows.values()];
  };
  const row = id => {
    const found = helpersNow().find(item => item.id === id);
    if (!found) throw refusal(fill(settings.words.unknown, { id }), 404, false);
    return found;
  };
  const pinned = helper => /^[0-9a-f]{64}$/.test(helper.blake3 ?? '');
  const slot = helper => join(root, helper.id, pinned(helper) ? helper.blake3 : 'unpinned');
  const pathOf = helper => join(slot(helper), helper.entry ?? helper.file);
  const expand = path => (path.startsWith('~/') ? join(home, path.slice(2)) : path);
  const adopted = helper => (helper.adopt ?? []).map(expand).find(path => existsSync(path));
  const sizeCap = helper => helper.size ?? settings.unpinned_max_bytes;
  const withdrawnAt = helper => (helper.withdrawn_at && Date.parse(helper.withdrawn_at) <= now() ? helper.withdrawn_at : null);

  const stateFile = join(root, settings.state_file);
  // The person's and the blocklist's switches are one versioned document (computer/versioned-document.mjs): every entry says what
  // produced it, and a change of layout is migrated after a backup is made.
  const document = () => { mkdirSync(root, { recursive: true, mode: 0o700 }); return openDocument({ file: stateFile, version: STATE_VERSION, migrations: STATE_MIGRATIONS, now }); };
  const readState = () => { try { return Object.fromEntries(Object.entries(document().read().entries).map(([id, entry]) => [id, entry.value])); } catch (error) { if (error.status === 409) throw error; return {}; } };
  const writeState = state => {
    const doc = document();
    for (const id of Object.keys(doc.read().entries)) if (!(id in state)) doc.remove(id);
    for (const [id, value] of Object.entries(state)) {
      const have = doc.get(id);
      if (!have || JSON.stringify(have.value) !== JSON.stringify(value)) doc.set(id, value, value.by === 'block' ? `block: ${value.reason}` : 'the person turned it off');
    }
  };
  const blockOf = helper => settings.blocked.find(item => item.blake3 === helper.blake3);

  function judge(helper) {
    const state = readState()[helper.id];
    if (state && state.enabled === false) throw refusal(fill(state.by === 'block' ? settings.words.blocked : settings.words.disabled_by_person, { id: helper.id, reason: state.reason ?? '' }), 403, false);
    if (blockOf(helper)) throw refusal(fill(settings.words.blocked, { id: helper.id, reason: blockOf(helper).reason }), 403, false);
    if (withdrawnAt(helper)) {
      rmSync(join(root, helper.id), { recursive: true, force: true });
      throw refusal(fill(settings.words.withdrawn, { id: helper.id, at: helper.withdrawn_at }), 403, false);
    }
    if (adopted(helper)) return;
    if (helper.unpinned === true ? !(sizeCap(helper) > 0) : (!pinned(helper) || !(helper.size > 0))) throw refusal(fill(settings.words.unpinned, { id: helper.id }), 403, false);
    if (helper.arch && helper.arch !== arch) throw refusal(fill(settings.words.wrong_machine, { id: helper.id, arch: helper.arch, here: arch }), 409, false);
    if (!String(helper.url ?? '').startsWith('https://')) throw refusal(fill(settings.words.insecure, { id: helper.id }), 403, false);
  }

  /** Staging of processes that are gone: a crash between the write and the rename leaves a file nobody will finish. */
  function reap() {
    if (!existsSync(root)) return;
    for (const folder of readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      for (const name of readdirSync(join(root, folder.name))) {
        const owner = /^\.staging-(\d+)-/.exec(name);
        if (owner && Number(owner[1]) !== pid && !alive(Number(owner[1]))) rmSync(join(root, folder.name, name), { recursive: true, force: true });
      }
    }
  }

  function verified(helper) {
    const file = pathOf(helper);
    if (!existsSync(file)) return false;
    if (!pinned(helper) || helper.archive) return true;
    if (hashOf(readFileSync(file)) === helper.blake3) return true;
    rmSync(dirname(file), { recursive: true, force: true });
    return false;
  }

  async function install(helper) {
    let got;
    try { got = await fetchBytes(helper.url, sizeCap(helper)); }
    catch (error) { throw refusal(fill(settings.words.fetch_failed, { id: helper.id, error: String(error?.message ?? error).slice(0, 200) }), 502, true); }
    if (got.tooBig) throw refusal(fill(settings.words.too_big, { id: helper.id, size: sizeCap(helper) }), 403, false);
    const seen = hashOf(got.bytes);
    if (pinned(helper) && seen !== helper.blake3) throw refusal(fill(settings.words.wrong_bytes, { id: helper.id }), 403, false);
    const folder = slot(helper);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const staging = join(root, helper.id, `.staging-${pid}-${seen.slice(0, 12)}`);
    writeFileSync(staging, got.bytes, { mode: 0o600 });
    if (helper.archive) {
      // Unpacked beside the final place, checked, and only then moved in: a bundle that fails its check is never put where a reader looks.
      const unpacked = join(root, helper.id, `.staging-${pid}-${seen.slice(0, 12)}-unpacked`);
      try {
        mkdirSync(unpacked, { recursive: true, mode: 0o700 });
        await unpack(staging, unpacked);
        const candidate = join(unpacked, helper.entry);
        if (!existsSync(candidate)) throw refusal(fill(settings.words.fetch_failed, { id: helper.id, error: `the archive has no ${helper.entry}` }), 502, true);
        for (const [program, ...args] of helper.verify ?? []) {
          try { await run(program, args.map(word => word.replaceAll('{app}', candidate))); }
          catch { throw refusal(fill(settings.words.not_verified, { id: helper.id }), 403, false); }
        }
        for (const name of readdirSync(unpacked)) { rmSync(join(folder, name), { recursive: true, force: true }); renameSync(join(unpacked, name), join(folder, name)); }
      } finally { rmSync(staging, { force: true }); rmSync(unpacked, { recursive: true, force: true }); }
    } else {
      if (helper.executable) chmodSync(staging, 0o755);
      renameSync(staging, pathOf(helper));
    }
    writeReceipt(helper, { size: got.bytes.length, seen });
    return pathOf(helper);
  }

  function writeReceipt(helper, { size = null, seen = null, adoptedFrom = null } = {}) {
    const folder = adoptedFrom ? join(root, helper.id) : slot(helper);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, 'receipt.json'), JSON.stringify({ id: helper.id, version: helper.version ?? null, pinned: pinned(helper), blake3: seen ?? helper.blake3 ?? null, size,
      source: adoptedFrom ?? helper.url, adopted: Boolean(adoptedFrom), signer: helper.signer ?? null, installed_at: new Date(now()).toISOString() }, null, 2) + '\n', { mode: 0o600 });
  }

  return {
    /** The path of the helper, fetched if missing, hashed again if present. */
    async ensure({ id } = {}) {
      const helper = row(id);
      judge(helper);
      reap();
      const own = adopted(helper);
      if (own) { writeReceipt(helper, { adoptedFrom: own }); return { id, path: own, fetched: false, adopted: true, pinned: false, said: fill(settings.words.adopted, { id, path: own }) }; }
      if (verified(helper)) return { id, path: pathOf(helper), fetched: false, pinned: pinned(helper), said: fill(pinned(helper) ? settings.words.installed : settings.words.installed_unpinned, { id }) };
      if (!flights.has(id)) flights.set(id, install(helper).finally(() => flights.delete(id)));
      const path = await flights.get(id);
      return { id, path, fetched: true, pinned: pinned(helper), said: fill(pinned(helper) ? settings.words.installed : settings.words.installed_unpinned, { id }) };
    },
    /** What this Mac keeps and what is on it, each installed copy checked now. */
    list() {
      return { helpers: helpersNow().map(helper => ({ id: helper.id, what: helper.what, version: helper.version, withdrawn: Boolean(withdrawnAt(helper)), enabled: readState()[helper.id]?.enabled !== false && !blockOf(helper),
        installed: !withdrawnAt(helper) && (pinned(helper) || helper.unpinned === true) && Boolean(adopted(helper) || verified(helper)), pinned: pinned(helper) })) };
    },
    /** Turns every helper whose installed bytes are blocked off with the reason, and restores one whose block was lifted to what it was. */
    recheck() {
      const state = readState();
      let off = 0, restored = 0;
      for (const helper of helpersNow()) {
        const block = blockOf(helper), now_ = state[helper.id];
        if (block && now_?.by !== 'block') { state[helper.id] = { enabled: false, by: 'block', reason: block.reason, restore_to: now_ ? now_.enabled !== false : true }; off += 1; }
        else if (!block && now_?.by === 'block') {
          if (now_.restore_to === false) state[helper.id] = { enabled: false, by: 'person', reason: '' }; else delete state[helper.id];
          restored += 1;
        }
      }
      writeState(state);
      return { turned_off: off, restored, said: fill(settings.words.blocked_now, { count: off, restored }) };
    },
    /** The person turns a helper off or on; a block is not undone by turning it on while its content is still blocked. */
    setEnabled({ id, enabled } = {}) {
      const helper = row(id);
      const state = readState();
      if (enabled === false) state[id] = { enabled: false, by: 'person', reason: '' };
      else {
        if (blockOf(helper)) throw refusal(fill(settings.words.blocked, { id, reason: blockOf(helper).reason }), 403, false);
        delete state[id];
      }
      writeState(state);
      return { id, enabled: enabled !== false, said: fill(enabled === false ? settings.words.disabled_by_person : settings.words.enabled, { id }) };
    },
    /** Fetches the published list, and keeps the rows its signature and versions allow: { applied: [ids], said }. */
    async refresh() {
      const rule = settings.manifest;
      if (!rule?.url) return { applied: [], said: settings.words.no_manifest };
      let text, signature;
      try { [text, signature] = await Promise.all([fetchText(rule.url), fetchText(rule.signature_url)]); }
      catch (error) { throw refusal(fill(settings.words.fetch_failed, { id: 'the helper list', error: String(error?.message ?? error).slice(0, 200) }), 502, true); }
      const manifest = verifyManifest({ text, signature: signature.trim(), settings: manifestRules, now });
      const kept = new Map(readSigned().map(item => [item.id, item]));
      const applied = [];
      for (const id of new Set((manifest.entries ?? []).map(entry => entry.id).filter(Boolean))) {
        const current = helpersNow().find(item => item.id === id)?.version ?? '0';
        const { entry } = chooseUpdate({ entries: manifest.entries.filter(item => item.id === id) }, { current, channel: rule.channel, settings: manifestRules });
        if (entry && compareVersions(entry.version, current) > 0) { kept.set(id, entry); applied.push(id); }
      }
      mkdirSync(root, { recursive: true, mode: 0o700 });
      writeFileSync(`${signedFile}.${pid}.part`, JSON.stringify({ at: new Date(now()).toISOString(), rows: [...kept.values()] }, null, 2) + '\n', { mode: 0o600 });
      renameSync(`${signedFile}.${pid}.part`, signedFile);
      return { applied, said: fill(settings.words.refreshed, { count: applied.length }) };
    },
    /** Deletes the installed copy; the row stays, so the next ensure fetches it again. */
    remove({ id } = {}) {
      row(id);
      rmSync(join(root, id), { recursive: true, force: true });
      return { id, said: fill(settings.words.removed, { id }) };
    },
  };
}
