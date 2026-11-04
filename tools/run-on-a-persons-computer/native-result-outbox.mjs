// Durable dispatch markers, retained app outputs and completed native answers awaiting account acceptance.
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { makeHashCodeHasher, makeHashCodeHexFromBytes } from '../content-identity/read-data/identity.mjs';
import { bearerControl, namespaceClient } from '../browse-and-upload-my-files/do-work/namespace-client.mjs';
import { loadChunking } from '../browse-and-upload-my-files/do-work/content-chunks.mjs';
import { NamespaceRefused, sendFile } from '../browse-and-upload-my-files/do-work/send-a-file-to-a-namespace.mjs';

const hexOf = text => makeHashCodeHexFromBytes(new TextEncoder().encode(text)).slice(3);

const IDENTITY = /^1f:[a-f0-9]{64}$/;
const KEY = /^[A-Za-z0-9_-]{1,80}$/;
const WORKSPACE = /^attempt-[a-f0-9]{64}-[A-Za-z0-9]+$/;
const refused = () => Object.assign(new Error('Retained app output no longer matches its authenticated private workspace.'), { status: 422, native_output_refusal: true });
const fingerprint = stat => Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])]));
const sameFile = (stat, expected) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
  && (typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid()))
  && expected && Object.keys(expected).length === 5
  && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => typeof expected[key] === 'string' && /^-?[0-9]{1,30}$/.test(expected[key]) && String(stat[key]) === expected[key]);

function saveAtomic(file, rows) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const part = file + '.' + process.pid + '.part';
  const descriptor = openSync(part, 'w', 0o600);
  try { writeFileSync(descriptor, JSON.stringify(rows) + '\n'); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(part, file);
  const directory = openSync(dirname(file), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

// Uses the current Namespace sender; a receipt requires the exact saved name, identity and length read back.
export function nativeOutputUploader({ origin, key, fetchImpl = fetch }) {
  let client, chunking;
  return async ({ source, output }) => {
    client ??= namespaceClient({ origin, fetchImpl, control: bearerControl({ origin, fetchImpl, authorization: async () => 'Bearer ' + key }) });
    try {
      chunking ??= await loadChunking();
      const name = '/Made by tools/An app on your Mac/' + output.name;
      const saved = await sendFile({ client, chunking, source, identity: output.identity, name, mediaType: output.media_type });
      if (saved?.identity !== output.identity) throw refused();
      const current = await client.file(name, { metadataOnly: true });
      if (!current?.stored || current.growing || current.identity !== output.identity || current.byte_length !== output.bytes || !current.names.includes(name)) throw refused();
      return { identity: current.identity, bytes: current.byte_length };
    } catch (error) {
      if (error instanceof NamespaceRefused) throw Object.assign(new Error('Your file store refused the retained app output.'),
        { status: Number.isInteger(error.status) && error.status >= 400 ? error.status : 422, native_output_refusal: true });
      throw error;
    }
  };
}

/** Native attempts and answers retain their original handoff/generation across helper restarts. */
export function nativeResultOutbox({ file, accountId, origin, read = readFileSync, write = saveAtomic }) {
  if (typeof file !== 'string' || !file || typeof accountId !== 'string' || !accountId.trim()
      || accountId.length > 300 || /[\u0000-\u001f\u007f]/.test(accountId))
    throw new Error('Native result outbox needs its DATA file and authenticated account identity.');
  const service = new URL(origin).origin;
  const scope = hexOf(JSON.stringify([service, accountId]));
  const destination = (isAbsolute(file) ? file : join(homedir(), file)) + '.' + scope + '.json';
  const outputsRoot = destination + '.outputs';
  let rows = [];
  try {
    const parsed = JSON.parse(read(destination, 'utf8'));
    if (!Array.isArray(parsed) || parsed.some(row => !row || row.account_id !== accountId || row.origin !== service || typeof row.handoff_id !== 'string'
      || !Number.isSafeInteger(row.generation) || !row.finish || typeof row.finish !== 'object'))
      throw new Error('The native result outbox is malformed.');
    rows = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const persist = next => { write(destination, next); rows = next; };
  const put = row => {
    if (row.account_id !== undefined && row.account_id !== accountId || row.origin !== undefined && row.origin !== service) throw refused();
    const scoped = { ...row, account_id: accountId, origin: service };
    persist([...rows.filter(item => item.handoff_id !== row.handoff_id), scoped]);
    return scoped;
  };
  const get = handoffId => rows.find(row => row.handoff_id === handoffId) ?? null;
  const ownedDirectory = path => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) throw refused();
    return stat;
  };
  let rootIdentity = null;
  const root = create => {
    if (create) mkdirSync(outputsRoot, { recursive: true, mode: 0o700 });
    const stat = ownedDirectory(outputsRoot);
    if ((stat.mode & 0o077n) !== 0n) throw refused();
    const actual = realpathSync(outputsRoot);
    if (rootIdentity && (rootIdentity.path !== actual || rootIdentity.dev !== String(stat.dev) || rootIdentity.ino !== String(stat.ino))) throw refused();
    rootIdentity ??= { path: actual, dev: String(stat.dev), ino: String(stat.ino) };
    return actual;
  };
  const workspaceOf = row => {
    const record = row?.output_workspace;
    if (row?.account_id !== accountId || row.origin !== service || !WORKSPACE.test(record?.name ?? '')) throw refused();
    const expectedPrefix = 'attempt-' + hexOf(JSON.stringify([row.handoff_id, record.generation])) + '-';
    if (!Number.isSafeInteger(record.generation) || !record.name.startsWith(expectedPrefix)) throw refused();
    const path = join(root(false), record.name);
    if (record.root_dev !== rootIdentity.dev || record.root_ino !== rootIdentity.ino) throw refused();
    const stat = ownedDirectory(path);
    if (realpathSync(path) !== path || String(stat.dev) !== record.dev || String(stat.ino) !== record.ino) throw refused();
    return path;
  };
  const outputPath = (row, output) => {
    if (!KEY.test(output?.key ?? '') || typeof output.name !== 'string' || output.name !== basename(output.name)
      || !output.name || output.name.length > 180 || /[\u0000-\u001f\u007f]/.test(output.name)
      || !Number.isSafeInteger(output.bytes) || output.bytes < 0 || output.identity !== undefined && !IDENTITY.test(output.identity)) throw refused();
    const workspace = workspaceOf(row);
    const folder = join(workspace, 'outputs', output.key);
    for (const directory of [join(workspace, 'outputs'), folder]) {
      ownedDirectory(directory);
      if (realpathSync(directory) !== directory) throw refused();
    }
    const path = join(folder, output.name);
    const stat = lstatSync(path, { bigint: true });
    if (!sameFile(stat, output.fingerprint) || Number(stat.size) !== output.bytes) throw refused();
    return path;
  };
  const sourceOf = async (row, output) => {
    const path = outputPath(row, output);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const check = async () => {
      if (!sameFile(await handle.stat({ bigint: true }), output.fingerprint)) throw refused();
      outputPath(row, output);
    };
    try { await check(); } catch (error) { await handle.close(); throw error; }
    return { size: output.bytes, check, close: () => handle.close(), readAt: async (offset, length, into = null) => {
      await check();
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > output.bytes) throw refused();
      const bytes = into ? into.subarray(0, length) : new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(bytes, read, length - read, offset + read);
        if (!bytesRead) throw refused();
        read += bytesRead;
      }
      return bytes;
    } };
  };
  const api = {
    list: () => rows.slice(), get, put,
    createOutputWorkspace(handoffId, generation) {
      const row = get(handoffId);
      if (!row || row.generation !== generation || row.execution?.state !== 'started' || row.output_workspace) throw refused();
      const prefix = hexOf(JSON.stringify([handoffId, generation]));
      const path = mkdtempSync(join(root(true), 'attempt-' + prefix + '-'));
      const stat = ownedDirectory(path);
      put({ ...row, output_workspace: { name: basename(path), generation, dev: String(stat.dev), ino: String(stat.ino), root_dev: rootIdentity.dev, root_ino: rootIdentity.ino } });
      return path;
    },
    stageOutputs(handoffId, generation, { outputs, result }) {
      const row = get(handoffId);
      if (!row || row.generation !== generation || row.execution?.state !== 'started' || row.execution.uncertain
        || row.execution.steps?.some(step => step.stage !== 'app-step-returned' || step.uncertain === true)
        || !Array.isArray(outputs) || outputs.length > 32 || !outputs.length && result?.ok !== false) throw refused();
      const workspace = workspaceOf(row);
      const keys = new Set(), names = new Set();
      const files = outputs.map(output => {
        if (!KEY.test(output.key) || keys.has(output.key) || names.has(output.name) || typeof output.name !== 'string'
          || output.name !== basename(output.name) || !output.name || output.name.length > 180
          || typeof output.media_type !== 'string' || output.media_type.length > 200) throw refused();
        keys.add(output.key); names.add(output.name);
        const path = join(workspace, 'outputs', output.key, output.name);
        if (resolve(output.path) !== path) throw refused();
        const stat = lstatSync(path, { bigint: true });
        const value = { key: output.key, name: output.name, media_type: output.media_type, bytes: Number(stat.size), fingerprint: fingerprint(stat) };
        outputPath(row, value);
        // Flush the completed artifact before durable continuation says it can be sent.
        const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
        for (const directory of [dirname(path), join(workspace, 'outputs'), workspace, root(false)]) {
          const opened = openSync(directory, 'r');
          try { fsyncSync(opened); } finally { closeSync(opened); }
        }
        return value;
      });
      return put({ ...row, execution: { ...row.execution, state: files.length ? 'outputs' : 'returned' }, finish: { ...row.finish, result },
        output_delivery: { state: files.length ? 'pending' : 'saved', files } });
    },
    async deliverOutputs(handoffId, upload) {
      let row = get(handoffId);
      if (!row || row.execution?.state !== 'outputs' || row.output_delivery?.state !== 'pending'
        || !Array.isArray(row.output_delivery.files) || !row.output_delivery.files.length || row.output_delivery.files.length > 32
        || row.execution.uncertain || row.execution.steps?.some(step => step.stage !== 'app-step-returned' || step.uncertain === true)) throw refused();
      for (let index = 0; index < row.output_delivery.files.length; index++) {
        let output = row.output_delivery.files[index];
        if (output.saved) {
          if (!IDENTITY.test(output.identity) || output.saved.identity !== output.identity || output.saved.bytes !== output.bytes) throw refused();
          continue;
        }
        const source = await sourceOf(row, output);
        try {
          if (!output.identity) {
            const hash = makeHashCodeHasher();
            const scratch = new Uint8Array(1024 * 1024);
            for (let offset = 0; offset < source.size; offset += scratch.length) hash.update(await source.readAt(offset, Math.min(scratch.length, source.size - offset), scratch));
            await source.check();
            output = { ...output, identity: hash.identity() };
            const files = row.output_delivery.files.slice(); files[index] = output;
            row = put({ ...row, output_delivery: { ...row.output_delivery, files } });
          }
          const saved = await upload({ source, output });
          await source.check();
          if (saved?.identity !== output.identity || saved.bytes !== output.bytes) throw new Error('Your files did not acknowledge the retained output identity and length.');
          const files = row.output_delivery.files.slice(); files[index] = { ...output, saved: { identity: saved.identity, bytes: saved.bytes } };
          row = put({ ...row, output_delivery: { ...row.output_delivery, files }, execution: { ...row.execution,
            files: files.filter(item => item.saved).map(item => item.saved),
            progress: { stage: 'app-output-saved', saved_outputs: files.filter(item => item.saved).length, file: files[index].saved } } });
        } finally { await source.close(); }
      }
      const files = row.output_delivery.files.map(({ key, identity, name, bytes, media_type }) => ({ key, identity, name, bytes, media_type }));
      return put({ ...row, execution: { ...row.execution, state: 'returned' },
        output_delivery: { ...row.output_delivery, state: 'saved' }, finish: { ...row.finish, result: { ...row.finish.result, files } } });
    },
    delete(handoffId) {
      const row = get(handoffId);
      if (row?.output_delivery && row.output_delivery.state !== 'saved') throw new Error('App outputs remain retained until every file is acknowledged.');
      if (row?.output_workspace && !row.delivery_ack) throw new Error('The private app workspace remains retained until the completed answer is accepted.');
      if (row?.output_workspace) {
        const path = join(root(false), row.output_workspace.name);
        try { workspaceOf(row); rmSync(path, { recursive: true }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      persist(rows.filter(row => row.handoff_id !== handoffId));
    },
  };
  return api;
}
