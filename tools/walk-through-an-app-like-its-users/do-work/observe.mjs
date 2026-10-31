// tools/walk-through-an-app-like-its-users/do-work/observe.mjs
//
// Drives a running app through a declared list of steps and reports what it actually rendered after each: which
// controls exist, what a pointer would land on at each one, stacking and cursor, media readiness, page errors and
// timing. It asserts nothing and fails nothing; the question it answers is "what is really on the screen now".
//
// Invariants:
//   - A step that cannot complete is recorded with completed: false and blocked_by, and the run goes on: a run that
//     stops halfway hides the state that explains the failure.
//   - Observations run even when the step before them was blocked; that is usually the only way to see why.
//   - There is no way to intercept, stub or route the page. A check that mocks its own subject observes nothing.
//   - No app, route, selector, label or product name is in this source: all of it is fields of the request.
//   - A step acts only on a control its target names exactly (the same rule as a walk); a target naming none or
//     several is reported as blocked, never guessed.
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { openBrowser } from './browser.mjs';
import { readAttributes, readCount, readElements, readGlobalPath, readMediaReady, readText } from './in-page.mjs';
import { act, checkedAppUrl, evaluate, evidenceFolderFor, picture, settle, watchPage } from './walk.mjs';

/** What a step can read. Each answers plain JSON; a new kind of reading is one more entry here and one more default in the conventions. */
const READERS = {
  elements: readElements,
  count: readCount,
  media_ready: readMediaReady,
  global_path: readGlobalPath,
  attributes: readAttributes,
  text: readText,
};

const firstLine = (text, most) => String(text).split('\n')[0].slice(0, most);

function checkedSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('steps must be a list of at least one step: { id, intent?, do?, observe?: { name: { read, ... } } }.');
  const ids = steps.map((step, at) => step.id ?? `step-${at + 1}`);
  if (new Set(ids).size !== ids.length) throw new Error('Two steps share an id; step ids must be unique.');
  for (const step of steps) {
    for (const [name, spec] of Object.entries(step.observe ?? {})) {
      if (!READERS[spec?.read]) throw new Error(`Step ${step.id ?? '?'}: observation "${name}" reads "${spec?.read}", which is not one of: ${Object.keys(READERS).join(', ')}.`);
      if (spec.read !== 'global_path' && typeof spec.selector !== 'string') throw new Error(`Step ${step.id ?? '?'}: observation "${name}" needs a selector.`);
      if (spec.read === 'global_path' && typeof spec.path !== 'string') throw new Error(`Step ${step.id ?? '?'}: observation "${name}" needs a path.`);
      if (spec.read === 'attributes' && !Array.isArray(spec.names)) throw new Error(`Step ${step.id ?? '?'}: observation "${name}" needs names, the attributes to read.`);
    }
  }
  return ids;
}

/** Runs the steps and answers { kind, run, page_errors, failed_requests, steps }. */
export async function observeApp(request, conventions) {
  const appUrl = checkedAppUrl(request.app_url);
  const ids = checkedSteps(request.steps);
  const limits = conventions.observe;
  const window = { ...conventions.window, ...(request.window ?? {}) };
  const evidenceFolder = evidenceFolderFor(request, conventions);
  const logFile = join(evidenceFolder, 'log.jsonl');
  writeFileSync(logFile, '');
  const started = new Date().toISOString();
  const browser = await openBrowser(conventions.browser, window, request.browser);
  const steps = [];
  let pageErrors = [];
  let failedRequests = [];
  try {
    const page = await browser.newPage();
    const watch = watchPage(page, conventions, logFile, Date.now());
    for (const domain of ['Page', 'Runtime', 'Network', 'Log', 'DOM']) await page.send(`${domain}.enable`);
    const start = watch.mark();
    const opening = await page.send('Page.navigate', { url: appUrl });
    await settle(page, watch, conventions.timing);
    for (const [at, raw] of request.steps.entries()) {
      const began = Date.now();
      const mark = watch.mark();
      const record = { id: ids[at], intent: raw.intent ?? '', ...(raw.do ? { do: raw.do } : {}) };
      if (at === 0 && opening.errorText) record.opened = `The app did not open at ${appUrl}: ${opening.errorText}`;
      if (raw.do) {
        try {
          const done = await act(page, raw.do, { conventions, appUrl, fixturesFolder: request.fixtures_folder, fromLearned: false });
          record.completed = !done.problem;
          if (done.problem) record.blocked_by = firstLine(done.problem, limits.blocked_by_most);
          await settle(page, watch, conventions.timing);
        } catch (error) {
          record.completed = false;
          record.blocked_by = firstLine(error.message ?? error, limits.blocked_by_most);
        }
      } else {
        record.completed = true;
      }
      record.ms = Date.now() - began;
      record.observed = {};
      for (const [name, spec] of Object.entries(raw.observe ?? {})) {
        const arg = { limit: limits.elements_most, names: [], timeout_ms: limits.media_wait_ms, most: limits.text_most, ...spec };
        try { record.observed[name] = await evaluate(page, READERS[spec.read], arg); } catch (error) { record.observed[name] = { error: firstLine(error.message ?? error, limits.blocked_by_most) }; }
      }
      const since = watch.since(mark);
      if (since.console_errors.length) record.console_errors = since.console_errors;
      if (since.failed_requests.length) record.failed_requests = since.failed_requests;
      if (raw.picture) record.screenshot = await picture(page, join(evidenceFolder, `${String(at + 1).padStart(2, '0')}-${ids[at].replace(/[^A-Za-z0-9._-]+/g, '-')}.png`));
      steps.push(record);
    }
    const everything = watch.since(start);
    pageErrors = everything.console_errors;
    failedRequests = everything.failed_requests;
    await page.close();
  } finally {
    browser.close();
  }
  return {
    kind: 'app-observation',
    run: { app_url: appUrl, started_at: started, finished_at: new Date().toISOString(), browser: browser.name, window, evidence_folder: evidenceFolder },
    page_errors: pageErrors,
    failed_requests: failedRequests,
    steps,
  };
}
