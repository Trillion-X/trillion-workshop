import { pathToFileURL } from 'node:url';
const [modulePath, dataPath, reportPath, dataBlake3, rubricBlake3] = process.argv.slice(1);
const { validateInput, validateReport } = await import(pathToFileURL(modulePath).href);
const input = JSON.parse(await (await import('node:fs/promises')).readFile(dataPath, 'utf8'));
const report = JSON.parse(await (await import('node:fs/promises')).readFile(reportPath, 'utf8'));
validateInput(input);
validateReport(report, { input, model: report.model, endpoint: report.endpoint, dataPath, dataBlake3, rubricBlake3: rubricBlake3 || null, serving: report.serving, requestPolicy: report.request_policy, requestEvidenceVersion: report.request_evidence_version, servingIdentityPolicy: report.serving_identity_policy }, { requireServing: true });
