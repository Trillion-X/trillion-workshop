// src/content-tags.mjs
//
// PURPOSE
//   Automatic content tags for a person's files, kept beside the file as one namespace result of kind `tags`
//   (src/namespace-results.mjs): { vocabulary, grounded_on, tagged_at, tags: [{ tag, source, score }] }. Each tag says
//   where it came from (`auto`, or `person` for one the person set) and how strongly. Auto tags are scored from what is
//   already kept about the file (its transcript, summary, facts, title) against a vocabulary that is DATA
//   (content-tags.json, or the vocabulary a caller passes: editable without recompiling).
//
// NON-NEGOTIABLE INVARIANTS
//   1. One owner: tags are a result of the existing store, not a second table; read_file_results kind `tags` reads them.
//   2. Versioned: `vocabulary` is the BLAKE3 fingerprint of the vocabulary entries, the scorer id and the thresholds.
//      `grounded_on` is the fingerprint of the value identities of the evidence results. A sweep re-tags only the files
//      whose kept fingerprints differ, so a vocabulary edit or new evidence touches only the rows it affects.
//   3. Bounded: one sweep step reads at most `page_size` files and resumes from the `next_after` it answers.
//   4. A person's own tags (source `person`) are never removed or rescored by a re-tag.
//   5. The scorer is injected: lexicalScorer here, embeddingScorer for a model. Nothing here names a model or a tag.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import settings from './content-tags.json' with { type: 'json' };

const fingerprintOf = value => '1f:' + bytesToHex(blake3(utf8ToBytes(JSON.stringify(value))));
const wordsOf = text => String(text ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const textsIn = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => textsIn(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => textsIn(item, out));
  return out;
};
const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** The words of the vocabulary entries a text mentions, as a fraction of each entry's words (0 to 1). */
export function lexicalScorer(config = settings) {
  const stem = word => word.slice(0, config.stem_length);
  const counted = word => word.length >= config.min_word_length && !/^\d+$/.test(word);
  return {
    id: `lexical:${config.stem_length}:${config.min_word_length}`,
    async score(text, vocabulary) {
      const seen = new Set(wordsOf(text).filter(counted).map(stem));
      return vocabulary.map(({ tag, words }) => {
        const wanted = [...new Set(words.filter(counted).map(stem))];
        return { tag, score: wanted.length ? wanted.filter(word => seen.has(word)).length / wanted.length : 0 };
      });
    },
  };
}

/** Cosine of the text's meaning against each entry's words; `embed(texts)` answers one vector per text. Entry vectors
 *  are made once per (model, entry) and kept for this scorer's life. */
export function embeddingScorer({ embed, model }) {
  const kept = new Map();
  return {
    id: `embedding:${model}`,
    async score(text, vocabulary) {
      const key = entry => fingerprintOf([model, entry.tag, entry.words]);
      const missing = vocabulary.filter(entry => !kept.has(key(entry)));
      if (missing.length) (await embed(missing.map(entry => entry.words.join(' ')))).forEach((vector, index) => kept.set(key(missing[index]), vector));
      const [asked] = await embed([text]);
      return vocabulary.map(entry => ({ tag: entry.tag, score: Math.max(0, cosine(asked, kept.get(key(entry)))) }));
    },
  };
}

/**
 * @param sql      the person's store (namespace_results lives in it)
 * @param results  resultsStore(sql, ...): put and read
 * @param options  { scorer = lexicalScorer(), vocabulary = settings.vocabulary, config = settings }
 */
export function contentTags(sql, results, { scorer = lexicalScorer(), vocabulary = settings.vocabulary, config = settings } = {}) {
  // reads-ok: every caller is a keyed point read or a page bounded by page_size (find and sweep cap their limit at page_size).
  const all = (query, ...values) => sql.exec(query, ...values).toArray();
  const version = fingerprintOf([vocabulary, scorer.id, config.min_score, config.max_tags, config.evidence_kinds]);
  const evidenceOf = identity => results.read(identity).results.filter(row => config.evidence_kinds.includes(row.kind));
  const groundedOn = rows => fingerprintOf(rows.map(row => [row.kind, row.recorded_at, JSON.stringify(row.value).length]).sort());
  const heldOf = identity => results.read(identity, config.result_kind).results[0]?.value ?? null;
  const write = (identity, held, tags, grounded, producedBy) => results.put([{ identity, kind: config.result_kind, produced_by: producedBy, value: { vocabulary: held, grounded_on: grounded, tagged_at: new Date().toISOString(), tags } }]);

  /** Scores one file's evidence and keeps the tags; answers the tags the file now has. */
  async function tagFile(identity, producedBy = 'trillion content tags') {
    const rows = evidenceOf(identity);
    const text = rows.flatMap(row => textsIn(row.value)).join('\n').slice(0, config.max_text_characters);
    const own = (heldOf(identity)?.tags ?? []).filter(tag => tag.source !== config.auto_source);
    const owned = new Set(own.map(tag => tag.tag));
    const scored = text ? await scorer.score(text, vocabulary) : [];
    const auto = scored.filter(item => item.score >= config.min_score && !owned.has(item.tag))
      .sort((a, b) => b.score - a.score || (a.tag < b.tag ? -1 : 1)).slice(0, config.max_tags)
      .map(item => ({ tag: item.tag, source: config.auto_source, score: Math.round(item.score * 1000) / 1000 }));
    const tags = [...own, ...auto];
    write(identity, version, tags, groundedOn(rows), producedBy);
    return tags;
  }

  return {
    version,
    scorer: scorer.id,
    tagFile,
    /** One bounded step over the files that have evidence: re-tags only those whose kept vocabulary or evidence differs. */
    async sweep({ after = '', limit = config.page_size } = {}) {
      const kinds = JSON.stringify(config.evidence_kinds);
      const page = all('SELECT DISTINCT identity FROM namespace_results WHERE kind IN (SELECT value FROM json_each(?)) AND identity > ? ORDER BY identity LIMIT ?', kinds, after, Math.max(1, Math.min(limit, config.page_size)) + 1);
      const step = page.slice(0, Math.max(1, Math.min(limit, config.page_size)));
      let tagged = 0, skipped = 0, failed = 0;
      for (const { identity } of step) {
        const held = heldOf(identity);
        if (held?.vocabulary === version && held.grounded_on === groundedOn(evidenceOf(identity))) { skipped += 1; continue; }
        try { await tagFile(identity); tagged += 1; } catch { failed += 1; }
      }
      return { tagged, skipped, failed, next_after: page.length > step.length ? step.at(-1).identity : null };
    },
    /** The tags of one file, each with its source and score. */
    tagsOf: identity => heldOf(identity)?.tags ?? [],
    /** Every file carrying a tag, a page at a time in identity order. */
    find: (tag, { after = '', limit = config.page_size } = {}) => all(`SELECT identity FROM namespace_results, json_each(json_extract(namespace_results.value, '$.tags')) AS item WHERE kind = ? AND identity > ? AND json_extract(item.value, '$.tag') = ? GROUP BY identity ORDER BY identity LIMIT ?`, config.result_kind, after, tag, Math.max(1, Math.min(limit, config.page_size))).map(row => row.identity),
    /** A tag the person sets (source `person`, score 1), or takes away with on = false. */
    setTag(identity, tag, on = true) {
      const held = heldOf(identity);
      const rest = (held?.tags ?? []).filter(item => item.tag !== tag);
      const tags = on ? [...rest, { tag, source: config.person_source, score: 1 }] : rest;
      write(identity, held?.vocabulary ?? null, tags, held?.grounded_on ?? null, 'person');
      return tags;
    },
  };
}

const json = (value, status = 200) => Response.json(value, { status });
const fail = (status, error) => json({ error }, status);

/**
 * The person's tags: contentTags over their store, addressed by a file's path name or content identity.
 * @param resolve  ref => content identity, or null when no such file (a name starts with /)
 */
export function contentTagsStore(sql, results, { resolve, ...options }) {
  const tags = contentTags(sql, results, options);
  const config = options.config ?? settings;
  const identityOf = ref => {
    const identity = typeof ref === 'string' && ref ? resolve(ref) : null;
    if (!identity) throw new Error('That file is not in your Files.');
    return identity;
  };
  const tagName = tag => {
    const name = typeof tag === 'string' ? tag.trim().toLocaleLowerCase() : '';
    if (!name || name.length > config.max_tag_length) throw new Error(`Name a tag of 1 to ${config.max_tag_length} characters.`);
    return name;
  };
  const page = ({ after, limit } = {}) => ({ after: typeof after === 'string' ? after : '', limit: Number.isInteger(limit) && limit > 0 ? limit : config.page_size });
  return {
    tags,
    version: () => ({ vocabulary: tags.version, scorer: tags.scorer, result_kind: config.result_kind }),
    sweep: query => tags.sweep(page(query)),
    async tag(file) { const identity = identityOf(file); return { identity, tags: await tags.tagFile(identity) }; },
    read(file) { const identity = identityOf(file); return { identity, tags: tags.tagsOf(identity) }; },
    set(file, tag, on = true) { const identity = identityOf(file); return { identity, tags: tags.setTag(identity, tagName(tag), on !== false) }; },
    find(tag, query) {
      const name = tagName(tag), { after, limit } = page(query), size = Math.min(limit, config.page_size);
      const files = tags.find(name, { after, limit: size });
      return { tag: name, files, next_after: files.length === size ? files.at(-1) : null };
    },
  };
}

export const isTagsPath = path => path === '/namespace/tags' || path.startsWith('/namespace/tags/');

// Routes (under /mcp/api and /work/api). A file travels in a POST body as `file` (a path name starting with /, or a
// content identity), never in the URL:
//   GET  /namespace/tags/version                    the vocabulary version and scorer the tags are made with
//   POST /namespace/tags/sweep   { after?, limit? } one bounded step; answers tagged, skipped, failed, next_after
//   POST /namespace/tags/tag     { file }           tags that one file now
//   POST /namespace/tags/read    { file }           the tags of that file, each with source and score
//   POST /namespace/tags/set     { file, tag, on? } the person sets a tag (on false takes it away); a re-tag keeps it
//   GET  /namespace/tags/find?tag=&after=&limit=    the files carrying a tag, a page at a time
// `person` answers namespaceTags(verb, ...args) from its contentTagsStore.
export async function handleTagsApi(request, person, path, url) {
  if (request.method === 'GET' && path === '/namespace/tags/version') return json(await person.namespaceTags('version'));
  if (request.method === 'GET' && path === '/namespace/tags/find') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || settings.page_size, settings.page_size);
    return answered(() => person.namespaceTags('find', url.searchParams.get('tag'), { after: url.searchParams.get('after') || undefined, limit }));
  }
  if (request.method !== 'POST') return fail(405, 'Use GET for version and find, POST for the rest.');
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return fail(400, 'Send a JSON body.');
  if (path === '/namespace/tags/sweep') return answered(() => person.namespaceTags('sweep', { after: body.after, limit: body.limit }));
  if (path === '/namespace/tags/tag') return answered(() => person.namespaceTags('tag', body.file));
  if (path === '/namespace/tags/read') return answered(() => person.namespaceTags('read', body.file));
  if (path === '/namespace/tags/set') return answered(() => person.namespaceTags('set', body.file, body.tag, body.on));
  return fail(404, 'Not found');
}
async function answered(run) {
  try { return json(await run()); } catch (error) { return fail(error?.message === 'That file is not in your Files.' ? 404 : 400, error?.message ?? 'That did not work.'); }
}

/** Every verb of the person's tags as an account action: sweep, tag one file now, read a file's tags, set or take away a person tag, the version, find by tag. `run(verb, ...args)` calls the store. */
export const contentTagActions = run => ({
  'sweep-content-tags': async ({ after, limit } = {}) => run('sweep', { after, limit }),
  'tag-file-now': async ({ file } = {}) => run('tag', file),
  'read-file-tags': async ({ file } = {}) => run('read', file),
  'set-file-tag': async ({ file, tag, on } = {}) => run('set', file, tag, on),
  'content-tags-version': async () => run('version'),
  'find-files-by-tag': async ({ tag, after, limit } = {}) => run('find', tag, { after, limit }),
});
