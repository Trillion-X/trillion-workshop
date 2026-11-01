import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_CONFIG_TYPE = 'measurement_source_config';
export const SOURCE_CONFIG_ID = 'measurement-source-config:default';
const SCHEMA = JSON.parse(await readFile(new URL('./measurement-source-config.json', import.meta.url), 'utf8'));

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a nonempty string.`);
}

export function validateSourceConfig(record) {
  const value = record?.value ?? record;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== SCHEMA.properties.schema.const) {
    throw new TypeError('measurement source config must use schema measurement-source-config/1.');
  }
  const allowed = new Set(Object.keys(SCHEMA.properties));
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`measurement source config has unknown field ${key}.`);
  for (const field of ['source_roots', 'receipt_roots']) {
    if (!Array.isArray(value[field]) || value[field].length === 0 || value[field].length > 32) throw new TypeError(`${field} must contain 1 to 32 configured roots.`);
    const seen = new Set();
    for (const root of value[field]) {
      requireString(root?.id, `${field} root id`);
      requireString(root?.path, `${field} root path`);
      if (seen.has(root.id)) throw new TypeError(`${field} contains duplicate root id ${root.id}.`);
      seen.add(root.id);
      if (field === 'receipt_roots' && root.source_id !== undefined) requireString(root.source_id, `${field} source_id`);
      if (field === 'receipt_roots' && root.source_revision !== undefined) requireString(root.source_revision, `${field} source_revision`);
    }
  }
  requireString(value.meter_book?.path, 'meter_book.path');
  requireString(value.price_book?.source_tool, 'price_book.source_tool');
  if (value.price_book.source_tool !== 'tool:refresh-provider-prices') throw new TypeError('price_book.source_tool must name tool:refresh-provider-prices.');
  return structuredClone(value);
}

export async function readSourceConfig(door, id = SOURCE_CONFIG_ID) {
  requireString(id, 'configuration record id');
  const record = await door.readRecord(SOURCE_CONFIG_TYPE, id);
  if (!record) throw new Error(`measurement source configuration ${id} is missing; configure its account DATA before enabling refresh wakes.`);
  return validateSourceConfig(record);
}

export async function resolveConfiguredInputs(config, { prices, prior, measure_self } = {}) {
  const current = validateSourceConfig(config);
  const meters = JSON.parse(await readFile(fileURLToPath(new URL(current.meter_book.path, import.meta.url)), 'utf8'));
  const priceRows = prices?.prices ?? prices;
  if (!Array.isArray(priceRows)) throw new TypeError('The configured price source must return a prices array.');
  if (prices?.prices && (typeof prices.source_revision !== 'string' || !prices.source_revision || typeof prices.observed_at !== 'string' || !prices.observed_at)) {
    throw new TypeError('The configured price source must retain its book revision and observation date.');
  }
  for (const price of priceRows) {
    if (typeof price.provider !== 'string' || !price.provider || typeof price.meter !== 'string' || !price.meter ||
      typeof price.currency !== 'string' || !price.currency || typeof price.source_revision !== 'string' || !price.source_revision ||
      typeof price.amount !== 'number' || !Number.isFinite(price.amount) || price.amount < 0) {
      throw new TypeError('Each configured price row must retain provider, meter, unit price, currency, and source revision.');
    }
  }
  return {
    source_roots: current.source_roots,
    receipt_roots: current.receipt_roots,
    meters,
    prices: priceRows,
    price_book_revision: prices?.source_revision ?? null,
    prior,
    measure_self,
  };
}

// Computer task grants are engine-supplied; account configuration cannot expand them.
export async function validateGrantedRoots(config, grantedFolder) {
  if (typeof grantedFolder !== 'string' || !path.isAbsolute(grantedFolder)) throw new TypeError('The computer task must supply its granted read folder.');
  const allowed = await realpath(grantedFolder);
  const contains = candidate => candidate === allowed || candidate.startsWith(allowed + path.sep);
  const resolvedOrMissing = async candidate => {
    const parts = [];
    let at = path.resolve(candidate);
    for (;;) {
      try { return path.resolve(await realpath(at), ...parts.reverse()); }
      catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        const parent = path.dirname(at);
        if (parent === at) throw error;
        parts.push(path.basename(at));
        at = parent;
      }
    }
  };
  for (const root of [...config.source_roots, ...config.receipt_roots]) {
    const resolved = await resolvedOrMissing(root.path);
    if (!contains(resolved)) throw new TypeError('A configured measurement root is outside the granted read folder.');
  }
  const meterPath = fileURLToPath(new URL(config.meter_book.path, import.meta.url));
  const realMeter = await realpath(meterPath);
  const packageData = await realpath(fileURLToPath(new URL('.', import.meta.url)));
  if (!contains(realMeter) && !realMeter.startsWith(packageData + path.sep)) throw new TypeError('The meter book must be packaged DATA or inside the granted folder.');
  if (config.price_book.path) {
    const pricePath = await realpath(fileURLToPath(new URL(config.price_book.path, import.meta.url)));
    if (!contains(pricePath) && !pricePath.startsWith(packageData + path.sep)) throw new TypeError('The price book must be packaged DATA or inside the granted folder.');
  }
  return config;
}
