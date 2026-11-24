// tools/start-a-computer/do-work/keep-recent-builds.mjs
//
// A unit built from source (`source`) keeps each commit it was built from in its `builds` folder, and every deploy adds one. The
// computer keeps the builds its units run (every `current` and `current-<slot>` link) and the newest `keep_builds` of each folder
// (the unit's own, else settings.json `builds.keep`); the older ones are a difference the apply removes, with the log files each
// left beside it. Units that share a folder (the slots of one program) are one folder, kept by the most any of them names.
import { readFileSync } from 'node:fs';

const KEEP_RECENT = readFileSync(new URL('./keep-recent-builds.sh', import.meta.url), 'utf8');
const COMMIT = /^[0-9a-f]{40}$/;
const q = text => `'${String(text).replace(/'/g, `'\\''`)}'`;
const refused = message => Object.assign(new Error(message), { exit: 2 });

/** How many builds a unit's folder keeps beyond the ones its links name: its `keep_builds`, else the settings' `builds.keep`. */
export function keepOf(unit, fallback) {
  const keep = unit.keep_builds ?? fallback;
  if (!Number.isInteger(keep) || keep < 1) throw refused(`${unit.unit} keep_builds must be a whole number of at least 1.`);
  return keep;
}

/** For each builds folder of the units built from source, the commits beyond what it keeps: [{ builds, keep, commits }], only the
 * folders that have any. Reads the computer; removes nothing. */
export async function surplusBuilds(machine, units, run, fallback) {
  const keeps = new Map();
  for (const unit of units.filter(row => row.source && row.builds)) keeps.set(unit.builds, Math.max(keeps.get(unit.builds) ?? 0, keepOf(unit, fallback)));
  const found = [];
  for (const [builds, keep] of keeps) {
    const listed = await run(machine, `sh -s -- ${q(builds)} ${keep}`, KEEP_RECENT);
    const commits = listed.split('\n').map(line => line.trim()).filter(Boolean);
    const odd = commits.find(commit => !COMMIT.test(commit));
    if (odd) throw refused(`${builds} listed a build named ${JSON.stringify(odd)}, which is not a commit.`);
    if (commits.length) found.push({ builds, keep, commits });
  }
  return found;
}

/** Remove each surplus commit's folder and the build log and memory-event files beside it. */
export async function dropSurplusBuilds(machine, surplus, run) {
  for (const { builds, commits } of surplus) {
    await run(machine, `cd ${q(builds)} && while IFS= read -r commit; do rm -rf -- "$commit" "build-$commit.log" "build-$commit.memory-events" "source-$commit"; done`, `${commits.join('\n')}\n`);
  }
}

/** The differences a surplus is, in the shape `found` has. */
export const surplusDifferences = surplus => surplus.flatMap(({ builds, keep, commits }) =>
  commits.map(commit => ({ path: `${builds}/${commit}`, reason: `a build beyond the newest ${keep} its unit keeps, and no link runs it` })));
