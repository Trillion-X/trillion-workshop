// tools/check-a-project-for-drift-and-broken-promises/do-work/check-my-documents.mjs
//
// Several documents each claim to reflect one source: which have fallen behind it. Run by the Workshop tool
// `tool:check-documents-agree-with-their-source` on the person's computer:
//
//   node do-work/check-my-documents.mjs <the granted folder> < { "sets": [ <mirror set>, ... ] }
//
// A mirror set is DATA: { set_id, source, unit_pattern, required_markers?, mirrors: [{ document, required_markers? }] },
// every document a path inside the granted folder. The engine (check-documents-agree-with-their-source.mjs) names no
// document, pattern or marker. This is the disk half, and holds nothing else: a document that does not exist reads
// as empty, which is right for a mirror (a missing mirror HAS fallen behind) and wrong for a source, so a missing
// document is reported as its own fact. Prints { result: { agrees, reports } } on its last line, or { error } and a
// non-zero status when it cannot report honestly (no set, a set with no mirror, a path that leaves the folder).
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { agreementReport } from './check-documents-agree-with-their-source.mjs';

const folder = process.argv[2];
try {
  if (!folder || !path.isAbsolute(folder) || !statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('the granted folder was not given as an absolute path to a folder');
  }
  const input = JSON.parse((await text(process.stdin)) || '{}');
  const sets = (Array.isArray(input.sets) ? input.sets : []).map((set) => set?.payload ?? set);
  // A run over no sets reports clean and proves nothing, which is the failure this check exists to end.
  if (sets.length === 0) throw new Error('give sets: a list of mirror sets, each { set_id, source, unit_pattern, mirrors: [{ document }] }; a run over no set would report clean over nothing');
  const inside = (document) => {
    const resolved = path.resolve(folder, String(document));
    if (path.isAbsolute(String(document)) || (resolved !== folder && !resolved.startsWith(folder + path.sep))) {
      throw new Error(`the document ${JSON.stringify(document)} is not a path inside the granted folder`);
    }
    return resolved;
  };
  const reports = sets.map((set) => {
    const missingDocuments = [];
    const textOf = (document) => {
      const absolute = inside(document);
      if (!existsSync(absolute)) {
        missingDocuments.push(document);
        return '';
      }
      return readFileSync(absolute, 'utf8');
    };
    const report = agreementReport(set, textOf);
    // The engine reads a document once for the units and again for the markers, so one absent document is named once.
    return { ...report, set_id: set.set_id ?? null, missing_documents: [...new Set(missingDocuments)] };
  });
  const agrees = reports.every((report) => report.agrees && report.missing_documents.length === 0);
  console.log(JSON.stringify({ result: { schema: 'document-mirror-agreement', agrees, reports } }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 2;
}
