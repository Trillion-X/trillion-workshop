// Every feature file added since the rules' `since` commit, or grown past their line number, is claimed by a valid port
// contract (ports/feature-files.json; the judge is tools/check-a-port-against-its-source), so any session that runs this
// repository's tests, here or in the cloud, is judged by the same rules as a commit on the Mac. Repositories with no
// checkout beside this one, and the capability search, are re-run by the Mac's commit and push gates; here they are
// printed as deferred.
//
// The judgement needs this checkout's history. A tree materialised without it (a push gate's candidate folder inside
// the git directory) is judged by that push gate itself (push-time-feature-code-has-a-port-contract.py), so here the
// test says so and skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { judgeRepository } from '../tools/check-a-port-against-its-source/do-work/check-a-repository-for-port-contracts.mjs';

const root = realpathSync(resolve(import.meta.dirname, '..'));
const top = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
const ownCheckout = top.status === 0 && realpathSync(top.stdout.trim()) === root;

test('every feature file since the rules began is claimed by a valid port contract', { skip: !ownCheckout && 'no history here: the push gate judges this tree' }, () => {
  const result = judgeRepository({ root, span: { since: true, to: 'HEAD' } });
  for (const one of result.judged.filter((judged) => judged.deferred.length)) console.log(`${one.path} deferred: ${one.deferred.join('; ')}`);
  const refused = [...result.errors, ...result.judged.flatMap((one) => one.errors.map((error) => `${one.path} (${one.change}): ${error}`))];
  assert.deepEqual(refused, [], `\n${refused.join('\n')}\n\nPort the older owner (a SOURCE_FIRST_PORT contract whose first commit is the byte copy), or claim NO_PRIOR_OWNER with the search that found none. See tools/check-a-port-against-its-source/README.md.`);
});
