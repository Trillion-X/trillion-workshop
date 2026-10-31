// tools/walk-through-an-app-like-its-users/do-work/judge.mjs
//
// The pure half of a walk: which control a step names, whether an expectation holds on what the page showed, which
// actions a page offers, and the report a coding agent fixes from. No browser and no file system here, so every rule
// is tested on plain values.
//
// Invariants:
//   - A target names a control the way a person sees it (role, accessible name), never by a CSS selector; a target
//     that matches no control or more than one is refused, never guessed.
//   - An expectation answers whether it held and what was observed, so a failure carries its own evidence.
//   - A past pass is never a current pass: a report is made only from the steps this run walked.

const folded = text => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The one control `target` ({ role?, name?, name_contains?, nth? }) names in `controls`, or why there is none. */
export function matchTarget(controls, target) {
  if (!target || (target.role === undefined && target.name === undefined && target.name_contains === undefined)) {
    return { problem: 'no-target', says: 'The step names no control: give target.role and target.name (or target.name_contains).' };
  }
  const fits = controls.filter(control => (target.role === undefined || control.role === target.role)
    && (target.name === undefined || folded(control.name) === folded(target.name))
    && (target.name_contains === undefined || folded(control.name).includes(folded(target.name_contains))));
  if (target.nth !== undefined) {
    const chosen = fits[target.nth];
    return chosen ? { control: chosen } : { problem: 'missing', says: `There are ${fits.length} controls like ${describe(target)}, so there is no number ${target.nth}.`, candidates: fits };
  }
  if (fits.length === 1) return { control: fits[0] };
  if (fits.length === 0) return { problem: 'missing', says: `No visible control is ${describe(target)}.`, candidates: [] };
  return { problem: 'ambiguous', says: `${fits.length} visible controls are ${describe(target)}; add target.nth (0 is the first) or a fuller name.`, candidates: fits };
}

export function describe(target) {
  const role = target.role ?? 'control';
  if (target.name !== undefined) return `the ${role} named "${target.name}"`;
  if (target.name_contains !== undefined) return `a ${role} whose name contains "${target.name_contains}"`;
  return `a ${role}`;
}

const contains = (haystack, needle) => folded(haystack).includes(folded(needle));

/**
 * What each expectation kind reads from `facts` ({ screen: { url, title, text }, controls, console_errors,
 * failed_requests }): an answer { held, observed }. Adding a kind is one entry here.
 */
const EXPECTATIONS = {
  text_visible: (expect, facts) => ({ held: contains(facts.screen.text, expect.text), observed: excerpt(facts.screen.text, expect.text) }),
  text_absent: (expect, facts) => ({ held: !contains(facts.screen.text, expect.text), observed: excerpt(facts.screen.text, expect.text) }),
  url_contains: (expect, facts) => ({ held: facts.screen.url.includes(expect.text), observed: facts.screen.url }),
  title_contains: (expect, facts) => ({ held: contains(facts.screen.title, expect.text), observed: facts.screen.title }),
  control_present: (expect, facts) => {
    const match = matchTarget(facts.controls, expect.target);
    return { held: Boolean(match.control), observed: match.control ? summarise(match.control) : match.says };
  },
  control_absent: (expect, facts) => {
    const match = matchTarget(facts.controls, expect.target);
    return { held: match.problem === 'missing', observed: match.control ? summarise(match.control) : match.says };
  },
  field_value: (expect, facts) => {
    const match = matchTarget(facts.controls, expect.target);
    if (!match.control) return { held: false, observed: match.says };
    return { held: String(match.control.value ?? '') === String(expect.equals), observed: match.control.value ?? null };
  },
  checked: (expect, facts) => {
    const match = matchTarget(facts.controls, expect.target);
    if (!match.control) return { held: false, observed: match.says };
    return { held: match.control.checked === (expect.equals ?? true), observed: match.control.checked ?? null };
  },
  no_console_errors: (_expect, facts) => ({ held: facts.console_errors.length === 0, observed: facts.console_errors }),
  no_failed_requests: (_expect, facts) => ({ held: facts.failed_requests.length === 0, observed: facts.failed_requests }),
};

export const expectationKinds = Object.keys(EXPECTATIONS);

/** Whether one expectation holds on `facts`; an unknown kind is refused with the kinds there are. */
export function judgeExpectation(expect, facts) {
  const judge = EXPECTATIONS[expect?.kind];
  if (!judge) return { ...expect, held: false, observed: `Unknown expectation kind "${expect?.kind}". Kinds: ${expectationKinds.join(', ')}.` };
  return { ...expect, ...judge(expect, facts) };
}

function excerpt(text, needle) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const at = folded(flat).indexOf(folded(needle));
  if (at < 0) return flat.slice(0, 300);
  return flat.slice(Math.max(0, at - 80), at + String(needle).length + 80);
}

/** The fields an offered action still needs from the caller before it can run. */
export const FIELDS_NEEDED = { fill: ['value'], upload: ['files'] };

const summarise = control => ({ role: control.role, name: control.name, ...(control.value !== undefined ? { value: control.value } : {}), ...(control.disabled ? { disabled: true } : {}) });

/**
 * The actions a page offers a person, as `do` objects a caller copies into its journey: one per action a control's
 * role allows (conventions.offered_actions_by_role), with a target that names exactly that control. An action that
 * takes the caller's own input lists the fields it still needs in `needs` (`value` for fill, `files` for upload); the
 * caller adds them, and a fill or upload without them is refused when it runs.
 */
export function offeredActions(controls, actionsByRole) {
  return controls.filter(control => !control.disabled && control.name).flatMap(control => {
    const same = controls.filter(other => other.role === control.role && folded(other.name) === folded(control.name));
    const target = { role: control.role, name: control.name, ...(same.length > 1 ? { nth: same.indexOf(control) } : {}) };
    return (actionsByRole[control.role] ?? []).map(action => ({ action, target, ...(FIELDS_NEEDED[action] ? { needs: FIELDS_NEEDED[action] } : {}) }));
  });
}

/** One run's verdict from its journeys: failed beats blocked beats passed. */
export function verdictOf(statuses) {
  if (statuses.includes('failed')) return 'failed';
  if (statuses.some(status => status === 'blocked' || status === 'needs_decision')) return 'blocked';
  return 'passed';
}

/** The steps a run may reuse next time: every step that passed, with the action it took. */
export function learnedFrom(journeys) {
  return journeys.flatMap(journey => journey.steps.filter(step => step.status === 'passed' && step.do).map(step => ({ journey: journey.id, step: step.id, do: step.do })));
}

/** For each failed step, everything a coding agent needs to reproduce and fix it, and nothing it must look up. */
export function fixesFrom(journeys, run) {
  return journeys.flatMap(journey => journey.steps.flatMap((step, at) => {
    if (step.status !== 'failed') return [];
    const unmet = step.expectations.filter(expect => !expect.held);
    return [{
      journey: journey.id,
      goal: journey.goal,
      step: step.id,
      intent: step.intent,
      what_failed: step.problem ?? unmet.map(expect => `${expect.kind}${expect.text !== undefined ? ` "${expect.text}"` : ''}${expect.target ? ` ${describe(expect.target)}` : ''} did not hold`).join('; '),
      expected: unmet.map(({ held: _held, observed: _observed, ...expect }) => expect),
      observed: unmet.map(expect => ({ kind: expect.kind, observed: expect.observed })),
      url: step.url,
      app_url: run.app_url,
      version: run.version ?? null,
      reproduce: journey.steps.slice(0, at + 1).filter(earlier => earlier.do).map(earlier => ({ step: earlier.id, intent: earlier.intent, do: earlier.do })),
      console_errors: step.console_errors,
      failed_requests: step.failed_requests,
      evidence: { screenshot: step.screenshot, log: journey.log, video: journey.video ?? null },
      recheck: 'Run this tool again with the same journeys and previous_report set to this report; this step must come back as fixed.',
    }];
  }));
}

/** Steps that need a decision: what the step wants and the actions the page offered, for the caller to choose one. */
export function decisionsFrom(journeys) {
  return journeys.flatMap(journey => journey.steps.filter(step => step.status === 'needs_decision').map(step => ({
    journey: journey.id, step: step.id, intent: step.intent, why: step.problem, url: step.url, screenshot: step.screenshot, offered: step.offered,
    answer: 'Copy the chosen offered `do` into this step of the journey, or into learned, adding each field its `needs` names, and run again.',
  })));
}

/**
 * How each step stands against the previous report: fixed (failed, now passes), still_failing, newly_failing (now
 * fails, did not fail before), still_passing, now_passing (skipped or undecided before, passes now), not_walked
 * (skipped or undecided now) or new (not in the previous report).
 */
export function compareWith(previous, journeys) {
  if (!previous?.journeys) return null;
  const before = new Map(previous.journeys.flatMap(journey => journey.steps.map(step => [`${journey.id}\u0000${step.id}`, step.status])));
  return journeys.flatMap(journey => journey.steps.map(step => {
    const was = before.get(`${journey.id}\u0000${step.id}`) ?? null;
    const now = step.status;
    const state = was === null ? 'new'
      : was === 'failed' && now === 'passed' ? 'fixed'
        : was === 'failed' && now === 'failed' ? 'still_failing'
          : was === 'passed' && now === 'failed' ? 'newly_failing'
            : was === 'passed' && now === 'passed' ? 'still_passing'
              : now === 'passed' ? 'now_passing'
                : now === 'failed' ? 'newly_failing'
                  : 'not_walked';
    return { journey: journey.id, step: step.id, before: was, now, state };
  }));
}
