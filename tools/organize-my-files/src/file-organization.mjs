// Organization at the namespace owner. Every completed arrival gets an organization result; only root-level names
// are moved. Later extracted words can improve provisional names. Nothing is inferred from image bytes or a vector.
// The source name, evidence kind and chosen label stay in the result so an AI can inspect or correct the decision.
import settings from './file-organization.json' with { type: 'json' };
import { fileType } from './file-type.mjs';

export const organizationEvidenceKinds = settings.evidence_kinds;

const base = name => name.slice(name.lastIndexOf('/') + 1);
const parent = name => name.replace(/\/[^/]+$/, '') || '/';
const extension = name => /\.[^./]+$/.exec(base(name))?.[0] ?? '';
const clean = (text, stripExtension = false) => (stripExtension ? String(text ?? '').replace(/\.[^./]+$/, '') : String(text ?? ''))
  .replace(/[_]+/g, ' ').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
const titleCase = value => value && value[0].toLocaleUpperCase() + value.slice(1);
const words = text => String(text ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const taken = (namespace, name, identity) => { const entry = namespace.entry(name); return entry && (entry.folder || entry.identity !== identity); };

function typeOf(file, name, config) {
  const type = String(fileType(file.media_type, name) ?? '').split(';')[0].toLowerCase();
  const stem = clean(base(name), true).toLowerCase();
  if (config.screenshot.words.some(word => stem.startsWith(word))) return config.screenshot;
  return config.categories.find(item => type.startsWith(item.type_prefix)) ?? config.fallback;
}

function evidenceOf(results, identity, config) {
  // The owner resolves every identity and returns the newest row of each requested kind in one read. Ask once,
  // then keep the configured priority below; asking once per kind repeats the same alias/result walk.
  const byKind = new Map(results.evidence(identity, config.evidence_kinds).map(row => [row.kind, row]));
  for (const kind of config.evidence_kinds) {
    const row = byKind.get(kind);
    const value = row?.value;
    const from = kind === 'summary' || kind === 'visual-observation' ? value?.title ?? value?.summary
      : kind === 'contents' ? value?.text?.split(/\r?\n/).find(line => clean(line))
      : kind === 'transcript' ? value?.title ?? null
      : value?.title ?? value?.description ?? null;
    if (typeof from === 'string' && clean(from)) return { kind, title: clean(from), value_identity: row.value_identity,
      label_kind: value?.label_kind, category: value?.category, company: value?.company };
  }
  return null;
}

function describe(name, category, evidence, config) {
  const original = clean(base(name), true);
  // A sender's descriptive name is evidence itself. Camera counters and timestamps are only provisional.
  const generic = config.generic_name_words.some(word => original.toLowerCase().startsWith(word)) || /^(?:dsc|img|mov|vid|c\d+)[-_ ]?\d+/i.test(original);
  // Opaque export identifiers and camera counters say nothing about the contents. Keep their source name until
  // a summary, transcript or other evidence can provide a title; a category prefix would only dress up a hash.
  const opaque = /^(?:[a-f\d]{20,}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|\d{8,})(?: copy \d+)?$/i.test(original);
  if (!evidence && (generic || opaque)) return { label: `${category.label} awaiting description`, company: null, status: 'awaiting-evidence', preserveName: true };
  const detail = evidence?.title ?? (original && !generic ? original : original || 'Untitled');
  const parts = /^([^–—-]{2,40})\s+[-–—]\s+(.+)$/.exec(detail);
  const categoryPrefix = evidence?.label_kind === 'category' ? clean(evidence.category ?? parts?.[1]) : null;
  const explicitCompany = evidence?.label_kind === 'company' ? clean(evidence.company ?? parts?.[1]) : null;
  // A descriptive source filename can contain a dash before a date or detail. Only extracted evidence may turn
  // that prefix into a company; a filename by itself cannot establish a brand.
  const company = categoryPrefix ? null : explicitCompany || (evidence && evidence.kind !== 'visual-observation' && parts && !config.generic_name_words.includes(parts[1].toLowerCase()) ? parts[1].trim() : null);
  const label = `${company ?? categoryPrefix ?? category.label} - ${titleCase((company || categoryPrefix) && parts ? parts[2] : detail)}`.slice(0, config.max_label_chars).trim();
  return { label, company, status: evidence ? 'grounded' : 'provisional' };
}

function uniqueName(namespace, folder, label, ext, identity, current) {
  let candidate = `${folder}/${label}${ext}`;
  if (candidate === current || !taken(namespace, candidate, identity)) return candidate;
  for (let copy = 2; copy < 1000; copy += 1) {
    candidate = `${folder}/${label} (${copy})${ext}`;
    if (candidate === current || !taken(namespace, candidate, identity)) return candidate;
  }
  return null;
}

/** Organize one stored file in the same PersonStore transaction that calls it. */
export function organizeFile({ namespace, results, identity, name = null, config = settings }) {
  const file = namespace.locateForArrival ? namespace.locateForArrival(identity) : namespace.locate(identity);
  if (!file || file.growing || !file.names?.length) return { skipped: 'not a completed named file' };
  const existing = results.read(identity, config.result_kind).results[0]?.value;
  const requested = typeof name === 'string' && file.names.includes(name) ? name : null;
  const fromStaging = candidate => parent(candidate) === '/' || config.staging_folders.includes(parent(candidate)) || (config.staging_prefixes ?? []).some(prefix => candidate.startsWith(prefix));
  const newArrival = requested && fromStaging(requested) && requested !== existing?.name;
  const original = newArrival ? requested : existing?.original_name ?? requested ?? file.names[0];
  // A later manual move out of our category folder is a choice; never move it back.
  const managed = existing?.name && file.names.includes(existing.name);
  const current = newArrival ? requested : managed ? existing.name : file.names.includes(original) ? original : file.names[0];
  const explicit = !fromStaging(original);
  if (existing && !managed && !file.names.includes(original) && !newArrival) return { skipped: 'renamed since organization' };
  const category = typeOf(file, original, config);
  const evidence = evidenceOf(results, identity, config);
  const { label, company, status, preserveName } = describe(original, category, evidence, config);
  const folder = explicit ? parent(current) : category.folder;
  const ext = extension(original);
  const target = explicit ? current : uniqueName(namespace, folder, preserveName ? base(original).slice(0, -ext.length || undefined) : label, ext, identity, current);
  if (!target) return { skipped: 'no free name' };
  if (target !== current) {
    const row = namespace.entry(current);
    if (!row || row.identity !== file.identity) return { skipped: 'name changed' };
    namespace.putNames([{ name: target, identity: file.identity, byte_length: row.byte_length, modified_at_ms: row.modified_at_ms }, { name: current, remove: true }]);
  }
  const tags = [...new Set([category.label.toLowerCase(), ...words(evidence?.title ?? clean(base(original), true)).filter(word => word.length > 2 && !/^\d+$/.test(word))])].slice(0, config.max_tags);
  const value = { identity: file.identity, original_name: original, name: target, title: label, folder, category: category.label, company,
    tags, search_text: `${label} ${tags.join(' ')}`, pursuit: existing?.pursuit ?? null,
    ...(existing?.pursuit_decision ? { pursuit_decision: existing.pursuit_decision } : {}),
    status, evidence: evidence ? { kind: evidence.kind, value_identity: evidence.value_identity } : { kind: 'file-name', value: original } };
  const kept = results.put([{ identity: file.identity, kind: config.result_kind, value, produced_by: config.produced_by }]);
  return { name: target, value, changed: target !== current || kept.recorded > 0 };
}
