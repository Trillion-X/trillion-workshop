// Read-only review entry for a working contract, using this package's real validator/repository reader.
// Missing baseline history or missing active targets are reported; no source, history or target is substituted.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gitReaders } from '../do-work/read-from-repositories.mjs';
import { validateReferenceAdaptationContract } from '../do-work/validate-reference-adaptation-contract.mjs';

const root = resolve(process.argv[2] ?? '.');
const contractPath = process.argv[3];
const tree = process.argv[4];
if (!contractPath) throw new Error('give repository root and repository-relative contract path');
const contract = JSON.parse(readFileSync(resolve(root, contractPath), 'utf8'));
const rules = JSON.parse(readFileSync(resolve(root, 'ports/feature-files.json'), 'utf8'));
const readers = gitReaders({ root, tree });
const activeTargetPaths = readers.listPaths({ untracked: !tree }).filter(path => rules.feature_files.some(rule =>
  new RegExp(rule.matches).test(path) && !(rule.ignore && new RegExp(rule.ignore).test(path))));
const checked = validateReferenceAdaptationContract(contract, {
  readers, activeTargetPaths, repository: readers.self, policySince: rules.since,
  stage: 'pre-edit', modes: rules.modes, retentionAtLeast: rules.retention_at_least,
  oldCopyDaysAtMost: rules.old_copy_days_at_most, requireRepositorySources: true,
});
const sources = contract.sources.map(source => {
  const bytes = readers.readSource(source);
  const lines = bytes?.toString('utf8').split('\n');
  return { repository: source.repository, commit: source.commit, path: source.path, lines: source.lines,
    declared_multihash: source.multihash, readable: bytes !== null,
    full_source_line_count: lines ? lines.length - Number(lines.at(-1) === '') : null };
});
readers.assertScope();
console.log(JSON.stringify({ contract: contractPath, contract_origin: 'working file',
  policy_origin: 'working file', target_tree: tree ?? null, sources, ...checked }, null, 2));
process.exitCode = checked.valid ? 0 : 1;
