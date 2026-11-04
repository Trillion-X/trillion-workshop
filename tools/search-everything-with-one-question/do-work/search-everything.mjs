// tools/search-everything-with-one-question/do-work/search-everything.mjs
//
// Purpose: the one search over everything the account keeps (old trillion src/file-tools.mjs:125 `search` -> GET
// /namespace/search, src/namespace.mjs:2127, finished by src/search.mjs:1750 `finish`): the records door's answer
// (records:search, every kind) and, when the question names no record type, the account files' file-name answer (the
// files door's `search`) to the same question, merged by their reciprocal-rank scores into one ranked list, each hit
// with its address.
//
// Moved one to one from trillion-rust src/native_boot/mcp_local.rs `search_everything_at` (deleted there in the same
// change): the engine keeps only the two storage reads (records:search at @own-records and the files' name search at
// @namespace); merging them is a feature, so it is this Workshop tool (engine-feature-boundary.json, Avery 2026-10-29).
//
// Invariants, as the engine kept them:
// - The files are asked under the caller's own rights: a caller they refuse (a run granted only records) gets the
//   records' answer with the files named `unavailable` with the refusal's code, never a guess.
// - A refusal of the records' search is the answer's refusal: it is thrown, not hidden.
// - With `type`, only that kind of record is asked, and the files are not.
// - An answer that came as pages of its own bytes is not merged (the door client joins pages before this sees them).
import settings from '../read-data/settings.json' with { type: 'json' };
import { merged } from '../read-data/merged.mjs';

// `{ question, type?, limit? }` in; `{ question, terms, results, unavailable, pending }` out.
export async function searchEverything(input, { door }) {
  const fields = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const answers = [];
  const refused = [];
  if (fields.type === undefined || fields.type === null) {
    const asked = {};
    for (const field of ['question', 'limit']) if (fields[field] !== undefined && fields[field] !== null) asked[field] = fields[field];
    try {
      answers.push(await door.files(settings.files.operation, asked));
    } catch (error) {
      refused.push({ place: settings.files.place, source: settings.files.source, reason: error?.code ?? 'refused' });
    }
  }
  const records = await door.search(fields);
  // An answer too large for one message comes as pages of its own bytes, which are not merged.
  if (records?.byte_page !== undefined || (!answers.length && !refused.length)) return records;
  const limit = Number.isInteger(fields.limit) ? fields.limit : settings.records.limit;
  const question = typeof records?.question === 'string' ? records.question : '';
  const terms = records?.terms ?? null;
  return merged(question, terms, [records, ...answers], refused, limit);
}
