// tools/publish-an-engine-release/do-work/wanted-targets.mjs
//
// Which rust targets to build, derived from the person's computers and the engine's own table of targets
// (trillion-rust .cargo/build-targets.json). No file, network or process; no system, architecture or target is named
// here: a computer is `{ os, arch, libc? }` as its row says, and each table row says which computer it is for
// (`computer`) and whether it builds (every `check` row `expect: "builds"`). A computer that matches no building row has
// no build, which is an answer with a plan (`settings.no_build_plan`), not an error.
import { settings } from './release-feed.mjs';

const fits = (computer, row) => Object.entries(row.computer ?? {}).every(([field, value]) => computer[field] === value);
const builds = row => row.check.every(one => one.expect === 'builds');

/** The plan for a computer with no build: each option of settings.no_build_plan this table can honour, with the targets
 *  that make it possible when it names a `needs_host`. */
function planFor(table) {
  return settings.no_build_plan.flatMap(({ option, says, needs_host: host }) => {
    if (host === undefined) return [{ option, says }];
    const targets = table.targets.filter(row => builds(row) && row.capabilities.host === host).map(row => row.target);
    return targets.length ? [{ option, says, targets }] : [];
  });
}

/**
 * `{ targets, answers }`: every target some computer needs (sorted, once each), and for each computer either the targets
 * that build for it or `no_build` with why (`blocked_by`, the rows that match but do not build yet) and the plan.
 */
export function wantedTargets(computers, table) {
  const answers = computers.map((computer, index) => {
    const id = computer.id ?? `computer ${index + 1}`;
    const matching = table.targets.filter(row => fits(computer, row));
    const ready = matching.filter(builds).map(row => row.target);
    if (ready.length) return { computer: id, answer: 'build', targets: ready };
    return { computer: id, answer: 'no_build', blocked_by: matching.map(row => row.target), plan: planFor(table) };
  });
  return { targets: [...new Set(answers.flatMap(one => one.targets ?? []))].sort(), answers };
}
