// Usage: node prepare-import.mjs <manifest.json> <output.json> [append-request-key]
// Manifest: {run_sets:[{dataset,source_revision,directory}],case_sets:[{source_revision,file,array_key,field_definitions}]}
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareAuditImport } from '../read-data/import-audit.mjs';

const [manifestPath, outputPath, appendRequestKey] = process.argv.slice(2);
if (!manifestPath || !outputPath) throw new Error('manifest and output paths are required');
const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8'));
for (const set of manifest.run_sets ?? []) {
  const names = (await readdir(resolve(set.directory))).filter(n => n.endsWith('.json')).sort();
  set.runs = await Promise.all(names.map(async name => {
    const parsed = JSON.parse(await readFile(resolve(set.directory, name), 'utf8'));
    return { ...parsed, source_id: parsed.source_id ?? parsed.run_id ?? name.slice(0, -5), evidence: resolve(set.directory, name) };
  }));
}
for (const set of manifest.case_sets ?? []) {
  const parsed = JSON.parse(await readFile(resolve(set.file), 'utf8'));
  const key = set.array_key ?? 'cells';
  if (!Array.isArray(parsed[key])) throw new TypeError(`${set.file} has no array at ${key}`);
  set.cases = parsed[key];
  set.evidence = resolve(set.file);
}
for (const set of manifest.usage_sets ?? []) {
  const lines = (await readFile(resolve(set.file), 'utf8')).split(/\r?\n/).filter(Boolean);
  set.events = lines.map(line => JSON.parse(line));
  set.evidence = resolve(set.file);
}
for (const set of manifest.attempt_sets ?? []) {
  const parsed = JSON.parse(await readFile(resolve(set.file), 'utf8'));
  const key = set.array_key ?? 'attempts';
  if (!Array.isArray(parsed[key])) throw new TypeError(`${set.file} has no array at ${key}`);
  set.attempts = parsed[key];
  set.evidence = resolve(set.file);
}
for (const set of manifest.observation_sets ?? []) {
  const parsed = JSON.parse(await readFile(resolve(set.file), 'utf8'));
  const key = set.array_key ?? 'observations';
  const rows = Array.isArray(parsed) ? parsed : parsed[key];
  if (!Array.isArray(rows)) throw new TypeError(`${set.file} has no array at ${key}`);
  const imported = rows.map(row => {
    const observation = row?.value && typeof row.value === 'object' ? row.value : row;
    return observation.evidence || !set.evidence ? observation : { ...observation, evidence: set.evidence };
  });
  manifest.native_observations ??= [];
  manifest.native_observations.push(...imported);
}
const records = prepareAuditImport(manifest);
const output = appendRequestKey
  ? { action: 'append', request_key: appendRequestKey, observations: records.map(record => record.value) }
  : { schema: 1, count: records.length, records };
await writeFile(resolve(outputPath), `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
const by_provider = Object.groupBy(records, record => record.value.provider);
process.stdout.write(JSON.stringify({ count: records.length, by_provider: Object.fromEntries(Object.entries(by_provider).map(([key, values]) => [key, values.length])), output: resolve(outputPath), observation_type: 'record:cost-measurement-observation' }) + '\n');
