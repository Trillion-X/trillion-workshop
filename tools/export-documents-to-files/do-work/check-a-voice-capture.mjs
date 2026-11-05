// tools/export-documents-to-files/do-work/check-a-voice-capture.mjs
//
// The writing gate's check of one captured book-voice run (DATA and report): the classifier's own validateInput and
// validateReport, imported from the module path given (the Workshop's tools/train-and-evaluate-a-writing-voice-classifier,
// or a stand-in in tests). Exit 0 when both accept, nonzero with the reason on standard error otherwise.
//   node check-a-voice-capture.mjs <classifier module> <data> <report> <data blake3> [<rubric blake3>]
// Moved from the inline `node -e` script of source-repo-a tools/private-book-reader/writing_gate.py:255-261.
import { pathToFileURL } from 'node:url';
const [modulePath, dataPath, reportPath, dataBlake3, rubricBlake3] = process.argv.slice(2);
const { validateInput, validateReport } = await import(pathToFileURL(modulePath).href);
const input = JSON.parse(await (await import('node:fs/promises')).readFile(dataPath, 'utf8'));
const report = JSON.parse(await (await import('node:fs/promises')).readFile(reportPath, 'utf8'));
validateInput(input);
validateReport(report, { input, model: report.model, endpoint: report.endpoint, dataPath, dataBlake3, rubricBlake3: rubricBlake3 || null, serving: report.serving, requestPolicy: report.request_policy, requestEvidenceVersion: report.request_evidence_version, servingIdentityPolicy: report.serving_identity_policy }, { requireServing: true });
