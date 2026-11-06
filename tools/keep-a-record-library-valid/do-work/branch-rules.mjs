#!/usr/bin/env node
// tools/keep-a-record-library-valid/do-work/branch-rules.mjs
//
// The person's branch of their one Checks list as the copy check reads it, for the delivery gate (read-data/delivery_gate.py):
// rulesOfBranch (tools/check-against-a-persons-rules-and-verdicts do-work/check-a-branch.mjs) through their records door, opened
// the way check-a-films-copy.mjs opens it. Prints one JSON line:
//   { branch, lineage, verdict_ids, copy_blake3, verdict_blake3 }
//   verdict_ids: the ids of the branch's verdict rows plus its judge_settings stance_rule and novel.rule (every rule id a finding of the
//                person's verdict rows can carry); copy_blake3 / verdict_blake3: BLAKE3 of the generic rows / the verdict rule document as read.
// With --rules-out F it also writes the branch's rows as { rows } (the render check's review-pack --rules file).
//
// usage: node branch-rules.mjs --branch B (--door-mcp '<argv JSON>' | --door-records F) [--rules-out F]
// exit 0 read; 2 a usage error or a branch that cannot be read (the reason on standard error).
import { writeFileSync } from 'node:fs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { rulesOfBranch } from '../../check-against-a-persons-rules-and-verdicts/do-work/check-a-branch.mjs';
import { openDoor } from '../../check-against-a-persons-rules-and-verdicts/do-work/check-a-films-copy.mjs';

const b3 = text => makeHashCodeHexFromBytes(Buffer.from(text)).slice(3);

const args = process.argv.slice(2);
const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
if (!value('--branch') || !(value('--door-mcp') || value('--door-records'))) {
  console.error("usage: node branch-rules.mjs --branch B (--door-mcp '<argv JSON>' | --door-records F) [--rules-out F]");
  process.exit(2);
}
try {
  const door = await openDoor({ mcp: value('--door-mcp'), records: value('--door-records') });
  const { rules, verdict_rules: doc, lineage } = await rulesOfBranch(door, value('--branch'));
  const verdictIds = doc ? [...doc.rows.map(row => row.id), doc.stance_rule, doc.novel?.rule].filter(id => typeof id === 'string') : [];
  if (value('--rules-out')) writeFileSync(value('--rules-out'), JSON.stringify({ rows: [...rules, ...(doc?.rows ?? [])] }, null, 1));
  console.log(JSON.stringify({ branch: value('--branch'), lineage, verdict_ids: [...new Set(verdictIds)].sort(),
    copy_blake3: b3(JSON.stringify(rules)), verdict_blake3: b3(JSON.stringify(doc)) }));
  process.exit(0);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
