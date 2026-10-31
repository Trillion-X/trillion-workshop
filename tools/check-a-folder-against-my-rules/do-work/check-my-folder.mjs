// tools/check-a-folder-against-my-rules/do-work/check-my-folder.mjs
//
// The rules a person wrote, run over the files of one folder they granted. Run by the Workshop tool
// `tool:check-a-folder-against-my-rules` on the person's computer:
//
//   node do-work/check-my-folder.mjs <the granted folder> < <the input as JSON>
//
// The input is { rules, under?, recorded? }: `rules` the source-file-rule rows (the rule is DATA; this file
// knows none), `under` a sub-folder to judge (rules still see every path as the existence corpus), `recorded`
// a baseline `{ known_findings: { <rule id>: [ "<path>" | "<path>:<line>" ] } }`. It prints the answer on its
// last line as { result }, or { error } and a non-zero status when it cannot report honestly (no rule, two rules
// with one id, a folder that is not a folder). A finding fails the run: `passed` is false, the caller decides
// what that means.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { checkRepository, RunRefusal } from './run-check-source-files-against-declared-rules.mjs';

const isFolder = (candidate) => stat(candidate).then((found) => found.isDirectory(), () => false);

const said = ({ violations, files, rules, no_applicable_rule: none, ratchet }) => {
  if (none) return `${rules} rule(s) judged nothing: no file received an applicable rule, so this is not a pass.`;
  const against = ratchet ? ` Against the recorded set: ${ratchet.appeared.length} appeared, ${ratchet.fixed.length} fixed but still recorded.` : '';
  return `${violations.length} finding(s) from ${rules} rule(s) over ${files} file(s).${against}`;
};

try {
  const folder = process.argv[2];
  if (!folder || !path.isAbsolute(folder) || !(await isFolder(folder))) {
    throw new RunRefusal('the granted folder was not given as an absolute path to a folder');
  }
  const input = JSON.parse((await text(process.stdin)) || '{}');
  if (!Array.isArray(input.rules)) throw new RunRefusal('give rules: a list of source-file-rule rows, each { kind: "source-file-rule", id, why, scope?, violation, ... }');
  const rules = input.rules.map((rule) => (rule?.payload ?? rule));
  const { summary, failed } = checkRepository({ repoRoot: folder, rules, under: input.under ?? null, recorded: input.recorded ?? null });
  console.log(JSON.stringify({ result: { passed: !failed, said: said(summary), ...summary } }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = error instanceof RunRefusal ? 2 : 1;
}
