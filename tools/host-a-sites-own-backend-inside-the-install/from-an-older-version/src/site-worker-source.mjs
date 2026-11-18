import { checkedSourceBuildInputs } from '../../../assemble-and-publish-an-app-project/src/source-build-inputs.mjs';
import { publicAppFilePath, publicAppMediaType, MAX_PUBLIC_APP_FILE_BYTES, MAX_PUBLIC_APP_BYTES, MAX_PUBLIC_APP_FILES } from '../../../shared-code/src/public-app-files.mjs';

export const SITE_WORKER_SOURCE_MANIFEST_PATH = 'trillion-site-worker.json';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const MODULE = /\.(?:m?js)$/i;
const inDeclaredPath = (path, declared) => declared === path || path.startsWith(`${declared}/`);

function checkedSourceFile(value, what, { module = false } = {}) {
  if (!object(value) || Object.keys(value).some(key => !['mount', 'path'].includes(key)) ||
      typeof value.mount !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.mount) ||
      typeof value.path !== 'string' || !PATH.test(value.path) || value.path.split('/').some(part => part === '.' || part === '..') ||
      module && !MODULE.test(value.path)) {
    throw new Error(`The ${what} source path is invalid.`);
  }
  return { mount: value.mount, path: value.path };
}

function checkedPublishedFiles(value, kind, mounts, seen) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PUBLIC_APP_FILES) throw new Error(`The Worker ${kind} list is invalid.`);
  return value.map(row => {
    if (!object(row) || Object.keys(row).some(key => !['mount', 'path', 'as'].includes(key))) {
      throw new Error(`A Worker ${kind} row is invalid.`);
    }
    const source = checkedSourceFile({ mount: row.mount, path: row.path }, `Worker ${kind}`);
    if (!mounts.has(source.mount)) throw new Error(`The Worker ${kind} names an undeclared source mount.`);
    const allowedPaths = mounts.get(source.mount);
    if (allowedPaths && !allowedPaths.some(path => inDeclaredPath(source.path, path))) {
      throw new Error(`The Worker ${kind} is outside its locked source paths.`);
    }
    if (typeof row.as !== 'string' || publicAppFilePath(row.as) !== row.as || row.as === 'site-worker.js' ||
        seen.has(row.as)) throw new Error(`The Worker ${kind} output path is invalid or repeated.`);
    publicAppMediaType(row.as);
    seen.add(row.as);
    return { ...source, as: row.as };
  });
}

/** Validate a product-neutral declaration of one self-contained Worker plus its installation files. */
export function checkedSiteWorkerSourceManifest(value, buildInputs) {
  if (!object(value) || Object.keys(value).some(key => !['schema', 'module', 'assets', 'data',
      'compatibility_date', 'compatibility_flags', 'permissions'].includes(key)) ||
      value.schema !== 'trillion.site-worker-source/v1' ||
      typeof value.compatibility_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.compatibility_date) ||
      !Array.isArray(value.compatibility_flags) || value.compatibility_flags.length > 32 ||
      value.compatibility_flags.some(flag => typeof flag !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(flag))) {
    throw new Error('The pinned Worker source manifest is invalid.');
  }
  const checkedInputs = buildInputs === undefined ? null : checkedSourceBuildInputs(buildInputs);
  const mounts = new Map([['source', null]]);
  for (const input of checkedInputs?.inputs ?? []) mounts.set(input.mount, input.paths);
  const module = checkedSourceFile(value.module, 'Worker module', { module: true });
  if (module.mount !== 'source') throw new Error('The Worker entry module must be in the pinned source repository.');
  const seen = new Set();
  const assets = checkedPublishedFiles(value.assets, 'asset', mounts, seen);
  const data = checkedPublishedFiles(value.data, 'data', mounts, seen);
  if (assets.length + data.length > MAX_PUBLIC_APP_FILES) throw new Error('The Worker source has too many assets and data files.');
  const permissions = value.permissions;
  if (permissions !== undefined && (!object(permissions) || Object.keys(permissions).some(key =>
      !['outbound_hosts', 'ai_models', 'crons', 'email_senders', 'receive_email'].includes(key)) ||
      (permissions.outbound_hosts !== undefined && (!Array.isArray(permissions.outbound_hosts) || permissions.outbound_hosts.length > 100 ||
        permissions.outbound_hosts.some(host => typeof host !== 'string'))) ||
      (permissions.ai_models !== undefined && (!Array.isArray(permissions.ai_models) || permissions.ai_models.length > 100 ||
        permissions.ai_models.some(model => typeof model !== 'string'))) ||
      (permissions.crons !== undefined && (!Array.isArray(permissions.crons) || permissions.crons.length > 20 ||
        permissions.crons.some(cron => typeof cron !== 'string'))) ||
      (permissions.email_senders !== undefined && (!Array.isArray(permissions.email_senders) || permissions.email_senders.length > 10 ||
        permissions.email_senders.some(sender => !object(sender) || Object.keys(sender).some(key => !['email', 'name'].includes(key)) || typeof sender.email !== 'string' || typeof sender.name !== 'string'))) ||
      (permissions.receive_email !== undefined && typeof permissions.receive_email !== 'boolean'))) {
    throw new Error('The pinned Worker permissions are invalid.');
  }
  return { schema: value.schema, module, assets, data, compatibility_date: value.compatibility_date,
    compatibility_flags: [...new Set(value.compatibility_flags)], ...(permissions === undefined ? {} : { permissions }) };
}

/** Apply only source-declared permissions; a changed grant leaves the Worker offline. */
export function pinnedWorkerPermissions(existing, declared = {}) {
  const fields = ['outbound_hosts', 'ai_models', 'crons', 'email_senders', 'receive_email'];
  const defaults = { outbound_hosts: [], ai_models: [], crons: [], email_senders: [], receive_email: false };
  const permissionSet = (key, values) => [...new Set(values.map(value =>
    key === 'email_senders' ? `${value.email}\0${value.name}` : value))].sort();
  const changed = Object.entries(declared).some(([key, value]) => key === 'receive_email'
    ? value !== (existing?.[key] ?? defaults[key])
    : JSON.stringify(permissionSet(key, value)) !==
      JSON.stringify(permissionSet(key, existing?.[key] ?? defaults[key])));
  return {
    ...Object.fromEntries(fields.map(key => [key, declared[key] ?? existing?.[key] ?? defaults[key]])),
    enabled: changed ? false : existing?.enabled ?? false,
  };
}

export function checkedSelfContainedWorkerModule(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('The pinned Worker module is empty.');
  if (/\bimport\s*(?:\(|(?:['"`]|[*{A-Za-z_$][\s\S]*?\bfrom\s*['"`]))/m.test(value)) {
    throw new Error('The pinned Worker module imports unbundled code.');
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_PUBLIC_APP_FILE_BYTES) throw new Error('The pinned Worker module is too large.');
  return value;
}

export function pinnedWorkerAssets(manifest, readFile) {
  const files = {};
  let total = 0;
  for (const row of [...manifest.assets, ...manifest.data]) {
    const bytes = readFile(row.mount, row.path);
    if (!(bytes instanceof Uint8Array)) throw new Error(`The ${row.path} bytes are unavailable.`);
    if (bytes.byteLength > MAX_PUBLIC_APP_FILE_BYTES) throw new Error(`The ${row.path} file is too large.`);
    total += bytes.byteLength;
    if (total > MAX_PUBLIC_APP_BYTES) throw new Error('The pinned Worker files exceed the Sites file limit.');
    const media = publicAppMediaType(row.as);
    const extension = row.as.split('.').at(-1)?.toLowerCase();
    if (['html', 'css', 'js', 'mjs', 'json', 'webmanifest', 'svg', 'txt'].includes(extension)) {
      try { files[row.as] = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error(`The ${row.path} text is not valid UTF-8.`); }
    } else {
      let binary = '';
      for (let at = 0; at < bytes.length; at += 32_768) binary += String.fromCharCode(...bytes.subarray(at, at + 32_768));
      files[row.as] = `data:${media};base64,${btoa(binary)}`;
    }
  }
  return files;
}
