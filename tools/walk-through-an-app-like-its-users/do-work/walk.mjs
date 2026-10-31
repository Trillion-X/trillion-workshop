// tools/walk-through-an-app-like-its-users/do-work/walk.mjs
//
// Walks an app's journeys in a real browser the way a person would (clicking at a control's centre, typing, pressing
// keys, choosing files), checks what each step expects on what the page then shows, and keeps the evidence: a
// picture after every step with the touched control boxed and numbered, a log of every action, console line and
// failed request, and a video of each journey when ffmpeg is on this computer. Also maps an app's screens and the
// controls on each, for writing journeys.
//
// Invariants:
//   - Every journey runs in a browser context of its own and starts at the app's address.
//   - A step acts only on a control its target names exactly; a step with no action, or whose learned action no
//     longer names one control, stops as needs_decision with the actions the page offers. Adapting the route never
//     changes what the step expects.
//   - A failed or undecided step stops its journey; the steps after it are skipped, never guessed.
//   - Every run walks every step again; nothing passes because it passed before.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { openBrowser } from './browser.mjs';
import { centreOf, controlAt, markBox, prepareFill, readControls, readScreen } from './in-page.mjs';
import {
  compareWith, decisionsFrom, fixesFrom, judgeExpectation, learnedFrom, matchTarget, offeredActions, verdictOf,
} from './judge.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const safeName = text => String(text).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'step';

/** The page's events, kept for one journey: requests in flight, console errors, failed requests, and the log file. */
export function watchPage(page, conventions, logFile, startedAt) {
  const inflight = new Set();
  const consoleErrors = [];
  const failedRequests = [];
  const urls = new Map();
  const noisyUrl = url => conventions.noise.request_url_patterns.some(pattern => new RegExp(pattern).test(url));
  const noisyText = text => conventions.noise.console_text_patterns.some(pattern => new RegExp(pattern).test(text));
  const log = entry => appendFileSync(logFile, `${JSON.stringify({ at_ms: Date.now() - startedAt, ...entry })}\n`);
  let lastActivity = Date.now();
  page.on(({ method, params }) => {
    if (method === 'Network.requestWillBeSent') {
      inflight.add(params.requestId);
      urls.set(params.requestId, { url: params.request.url, method: params.request.method });
      lastActivity = Date.now();
    } else if (method === 'Network.responseReceived') {
      const { status, url } = params.response;
      if (status >= 400 && !noisyUrl(url)) {
        const failed = { url, method: urls.get(params.requestId)?.method ?? 'GET', status };
        failedRequests.push(failed);
        log({ kind: 'request_failed', ...failed });
      }
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      inflight.delete(params.requestId);
      lastActivity = Date.now();
      if (method === 'Network.loadingFailed' && !params.canceled) {
        const request = urls.get(params.requestId) ?? { url: '', method: 'GET' };
        if (!noisyUrl(request.url)) {
          const failed = { ...request, status: null, error: params.errorText };
          failedRequests.push(failed);
          log({ kind: 'request_failed', ...failed });
        }
      }
    } else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      const text = params.args.map(arg => arg.value ?? arg.description ?? '').join(' ');
      if (!noisyText(text)) { consoleErrors.push(text); log({ kind: 'console_error', text }); }
    } else if (method === 'Runtime.exceptionThrown') {
      const text = params.exceptionDetails.exception?.description ?? params.exceptionDetails.text;
      if (!noisyText(text)) { consoleErrors.push(text); log({ kind: 'page_error', text }); }
    } else if (method === 'Log.entryAdded' && params.entry.level === 'error' && params.entry.source !== 'network') {
      if (!noisyText(params.entry.text)) { consoleErrors.push(params.entry.text); log({ kind: 'browser_error', text: params.entry.text }); }
    }
  });
  return {
    log,
    mark: () => ({ console: consoleErrors.length, requests: failedRequests.length }),
    since: mark => ({ console_errors: consoleErrors.slice(mark.console), failed_requests: failedRequests.slice(mark.requests) }),
    quietFor: () => (inflight.size === 0 ? Date.now() - lastActivity : 0),
  };
}

export async function evaluate(page, fn, arg, { byValue = true } = {}) {
  const answer = await page.send('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(arg)})`, returnByValue: byValue, awaitPromise: true });
  if (answer.exceptionDetails) throw new Error(`The page could not run ${fn.name}: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`);
  return byValue ? answer.result.value : answer.result;
}

/** Waits until the document is loaded and no request has been in flight for settle_quiet_ms, at most settle_most_ms. */
export async function settle(page, watch, timing) {
  const until = Date.now() + timing.settle_most_ms;
  while (Date.now() < until) {
    const ready = await page.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }).then(answer => answer.result?.value, () => null);
    if (ready === 'complete' && watch.quietFor() >= timing.settle_quiet_ms) return;
    await sleep(timing.poll_ms);
  }
}

export const controlsOf = (page, conventions) => evaluate(page, readControls, { selector: conventions.controls.selector, implicit_roles: conventions.controls.implicit_roles, most: conventions.controls.most_offered });

async function clickAt(page, point) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function pressKey(page, name, keys) {
  const key = keys[name];
  if (!key) throw new Error(`Unknown key "${name}". Keys: ${Object.keys(keys).join(', ')}.`);
  const base = { key: key.key ?? name, code: key.code, windowsVirtualKeyCode: key.windowsVirtualKeyCode };
  await page.send('Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...base, ...(key.text ? { text: key.text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/**
 * Does one step's action. Answers { box?, problem?, decide? }: `box` is the touched control (for the picture), and a
 * `problem` either fails the step or, with `decide`, asks the caller to choose among the offered actions.
 */
export async function act(page, action, context) {
  const { conventions, appUrl, fixturesFolder, fromLearned } = context;
  if (action.action === 'goto') {
    const url = new URL(action.url ?? '', appUrl).href;
    const answer = await page.send('Page.navigate', { url });
    return answer.errorText ? { problem: `Opening ${url} failed: ${answer.errorText}` } : {};
  }
  if (action.action === 'press') { await pressKey(page, action.key, conventions.keys); return {}; }
  if (action.action === 'wait') { await sleep(Math.min(Number(action.ms) || 0, conventions.most_wait_ms)); return {}; }
  if (!['click', 'fill', 'upload'].includes(action.action)) {
    return { problem: `Unknown action "${action.action}". Actions: goto, click, fill, press, upload, wait.` };
  }
  const controls = await controlsOf(page, conventions);
  const match = matchTarget(controls, action.target);
  if (!match.control) return { problem: match.says, decide: fromLearned || match.problem !== 'missing', controls };
  const point = await evaluate(page, centreOf, { index: match.control.index });
  if (!point) return { problem: 'The control left the page before it could be used.', decide: true, controls };
  if (action.action === 'click') {
    await clickAt(page, point);
    return { box: point.box };
  }
  if (action.action === 'fill') {
    if (action.value === undefined) return { problem: 'A fill needs do.value: the words to type ("" clears the field).', box: point.box };
    const value = String(action.value);
    const prepared = await evaluate(page, prepareFill, { index: match.control.index, value });
    if (prepared === 'no-option') return { problem: `The ${match.control.role} "${match.control.name}" has no option "${value}".`, box: point.box };
    if (prepared === 'focused') {
      if (value === '') await pressKey(page, 'Backspace', conventions.keys);
      else await page.send('Input.insertText', { text: value });
    }
    return { box: point.box };
  }
  const files = (action.files ?? []).map(file => (isAbsolute(file) ? file : resolve(fixturesFolder ?? process.cwd(), file)));
  const missing = files.filter(file => !existsSync(file));
  if (!files.length || missing.length) return { problem: `Upload needs files that exist: ${missing.join(', ') || 'none named'}. Give do.files, relative to fixtures_folder or absolute.`, box: point.box };
  const element = await evaluate(page, controlAt, { index: match.control.index }, { byValue: false });
  await page.send('DOM.setFileInputFiles', { files, objectId: element.objectId });
  return { box: point.box };
}

/** Polls the step's expectations until all hold or expect_most_ms passes; answers each one judged on the last look. */
async function expectations(page, step, watch, mark, conventions) {
  const until = Date.now() + conventions.timing.expect_most_ms;
  for (;;) {
    const screen = await evaluate(page, readScreen, { most_links: conventions.map.most_links_per_screen });
    const controls = await controlsOf(page, conventions);
    const judged = step.expect.map(expect => judgeExpectation(expect, { screen, controls, ...watch.since(mark) }));
    if (judged.every(expect => expect.held) || Date.now() >= until) return { judged, screen, controls };
    await sleep(conventions.timing.poll_ms);
  }
}

export async function picture(page, file, box, label) {
  if (box) await evaluate(page, markBox, { box, label }).catch(() => {});
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
  if (box) await evaluate(page, markBox, { remove: true }).catch(() => {});
  return file;
}

function onPath(program) {
  for (const folder of (process.env.PATH ?? '').split(delimiter)) if (folder && existsSync(join(folder, program))) return join(folder, program);
  return null;
}

/** The journey's screencast frames as one video, when ffmpeg is here; otherwise the frames folder stays the evidence. */
function videoOf(frames, folder) {
  const ffmpeg = onPath('ffmpeg');
  if (!ffmpeg || frames.length < 2) return null;
  const list = frames.map((frame, at) => `file '${frame.file}'\nduration ${Math.max(0.04, ((frames[at + 1]?.at ?? frame.at + 1) - frame.at)).toFixed(3)}`).join('\n');
  const listFile = join(folder, 'frames.txt');
  writeFileSync(listFile, `${list}\nfile '${frames.at(-1).file}'\n`);
  const video = join(folder, 'journey.mp4');
  const made = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p', '-vsync', 'vfr', video], { encoding: 'utf8' });
  return made.status === 0 ? video : null;
}

async function walkJourney(browser, journey, context) {
  const { conventions, evidenceFolder, learned, appUrl } = context;
  const folder = join(evidenceFolder, safeName(journey.id));
  mkdirSync(join(folder, 'frames'), { recursive: true });
  const logFile = join(folder, 'log.jsonl');
  writeFileSync(logFile, '');
  const startedAt = Date.now();
  const page = await browser.newPage();
  const frames = [];
  const steps = [];
  try {
    const watch = watchPage(page, conventions, logFile, startedAt);
    page.on(({ method, params }) => {
      if (method !== 'Page.screencastFrame') return;
      const file = join(folder, 'frames', `${String(frames.length).padStart(5, '0')}.jpg`);
      writeFileSync(file, Buffer.from(params.data, 'base64'));
      frames.push({ file, at: params.metadata.timestamp });
      page.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    });
    for (const domain of ['Page', 'Runtime', 'Network', 'Log', 'DOM']) await page.send(`${domain}.enable`);
    const cast = conventions.evidence.screencast;
    await page.send('Page.startScreencast', { format: cast.format, quality: cast.quality, everyNthFrame: cast.every_nth_frame });
    const opening = await page.send('Page.navigate', { url: appUrl });
    watch.log({ kind: 'open', url: appUrl, ...(opening.errorText ? { error: opening.errorText } : {}) });
    await settle(page, watch, conventions.timing);
    let stopped = opening.errorText ? `The app did not open at ${appUrl}: ${opening.errorText}` : null;
    for (const [at, raw] of journey.steps.entries()) {
      const step = { id: raw.id ?? `step-${at + 1}`, intent: raw.intent ?? '', expect: [...(journey.expect_every_step ?? []), ...(raw.expect ?? [])] };
      if (stopped) { steps.push({ id: step.id, intent: step.intent, status: 'skipped', why: stopped }); continue; }
      const learnedDo = learned.get(`${journey.id}\u0000${step.id}`);
      const action = raw.do ?? learnedDo;
      const source = raw.do ? 'journey' : learnedDo ? 'learned' : null;
      const mark = watch.mark();
      const label = String(at + 1);
      const shot = join(folder, `${String(at + 1).padStart(2, '0')}-${safeName(step.id)}.png`);
      if (!action) {
        const controls = await controlsOf(page, conventions);
        const screen = await evaluate(page, readScreen, { most_links: conventions.map.most_links_per_screen });
        steps.push({
          id: step.id, intent: step.intent, status: 'needs_decision', problem: 'This step says what to do in words only; choose one offered action for it.',
          url: screen.url, offered: offeredActions(controls, conventions.controls.offered_actions_by_role), screenshot: await picture(page, shot), expectations: [], console_errors: [], failed_requests: [],
        });
        watch.log({ kind: 'needs_decision', step: step.id });
        stopped = `Step ${step.id} needs a decision.`;
        continue;
      }
      watch.log({ kind: 'step', step: step.id, intent: step.intent, do: action, source });
      const done = await act(page, action, { conventions, appUrl, fixturesFolder: context.fixturesFolder, fromLearned: source === 'learned' });
      await settle(page, watch, conventions.timing);
      if (done.problem && done.decide) {
        const controls = done.controls ?? await controlsOf(page, conventions);
        steps.push({
          id: step.id, intent: step.intent, do: action, source, status: 'needs_decision', problem: done.problem,
          url: (await evaluate(page, readScreen, { most_links: 0 })).url, offered: offeredActions(controls, conventions.controls.offered_actions_by_role),
          screenshot: await picture(page, shot), expectations: [], ...watch.since(mark),
        });
        watch.log({ kind: 'needs_decision', step: step.id, problem: done.problem });
        stopped = `Step ${step.id} needs a decision.`;
        continue;
      }
      const looked = await expectations(page, step, watch, mark, conventions);
      const status = done.problem || !looked.judged.every(expect => expect.held) ? 'failed' : 'passed';
      const kept = {
        id: step.id, intent: step.intent, do: action, source, status, ...(done.problem ? { problem: done.problem } : {}),
        url: looked.screen.url, expectations: looked.judged, ...watch.since(mark),
        screenshot: await picture(page, shot, done.box, label),
      };
      if (status === 'failed' && done.problem) kept.offered = offeredActions(looked.controls, conventions.controls.offered_actions_by_role);
      steps.push(kept);
      watch.log({ kind: 'step_done', step: step.id, status, url: looked.screen.url });
      if (status === 'failed') stopped = `Step ${step.id} failed.`;
    }
    await page.send('Page.stopScreencast').catch(() => {});
  } finally {
    await page.close();
  }
  const statuses = steps.map(step => step.status);
  return {
    id: journey.id, goal: journey.goal ?? '', verdict: verdictOf(statuses), steps, log: logFile,
    video: videoOf(frames, folder), frames: join(folder, 'frames'), seconds: Math.round((Date.now() - startedAt) / 100) / 10,
  };
}

export function evidenceFolderFor(request, conventions) {
  const folder = request.evidence_folder ?? join(tmpdir(), conventions.evidence.folder_under_tmp, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  mkdirSync(folder, { recursive: true });
  return folder;
}

export function checkedAppUrl(text) {
  let url;
  try { url = new URL(text); } catch { throw new Error('app_url must be a full address, such as http://localhost:3000/ or https://staging.example.org/.'); }
  if (!['http:', 'https:', 'data:', 'file:'].includes(url.protocol)) throw new Error('app_url must be an http, https, file or data address.');
  return url.href;
}

/** Walks every journey and answers the report: verdict, each step, what to fix, what needs a decision, what was learned. */
export async function walkApp(request, conventions) {
  const appUrl = checkedAppUrl(request.app_url);
  if (!Array.isArray(request.journeys) || !request.journeys.length) throw new Error('journeys must be a list of at least one journey: { id, goal, steps: [{ id, intent, do?, expect? }] }.');
  for (const journey of request.journeys) {
    if (!journey?.id || !Array.isArray(journey.steps) || !journey.steps.length) throw new Error('Every journey needs an id and at least one step.');
    if (new Set(journey.steps.map((step, at) => step.id ?? `step-${at + 1}`)).size !== journey.steps.length) throw new Error(`Journey ${journey.id} has two steps with one id; step ids must be unique within a journey.`);
  }
  if (new Set(request.journeys.map(journey => journey.id)).size !== request.journeys.length) throw new Error('Two journeys share an id; journey ids must be unique.');
  const window = { ...conventions.window, ...(request.window ?? {}) };
  const learned = new Map([...(request.previous_report?.learned ?? []), ...(request.learned ?? [])].map(item => [`${item.journey}\u0000${item.step}`, item.do]));
  const evidenceFolder = evidenceFolderFor(request, conventions);
  const started = new Date().toISOString();
  const browser = await openBrowser(conventions.browser, window, request.browser);
  const journeys = [];
  try {
    for (const journey of request.journeys) journeys.push(await walkJourney(browser, journey, { conventions, evidenceFolder, learned, appUrl, fixturesFolder: request.fixtures_folder }));
  } finally {
    browser.close();
  }
  const run = { app_url: appUrl, version: request.version ?? null, started_at: started, finished_at: new Date().toISOString(), browser: browser.name, window, evidence_folder: evidenceFolder };
  const report = {
    kind: 'app-walk-report',
    run,
    verdict: verdictOf(journeys.map(journey => journey.verdict)),
    counts: Object.fromEntries(['passed', 'failed', 'blocked'].map(verdict => [verdict, journeys.filter(journey => journey.verdict === verdict).length])),
    fixes: fixesFrom(journeys, run),
    decisions_needed: decisionsFrom(journeys),
    learned: learnedFrom(journeys),
    compared_with_previous: compareWith(request.previous_report, journeys),
    journeys,
  };
  const reportFile = join(evidenceFolder, 'report.json');
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return { ...report, report_file: reportFile };
}

/** Opens the app and every same-origin screen its links reach (at most most_screens): each screen's title, headings, controls and a picture. */
export async function mapApp(request, conventions) {
  const appUrl = checkedAppUrl(request.app_url);
  const most = Math.min(Number(request.most_screens ?? conventions.map.most_screens), conventions.map.most_screens);
  const window = { ...conventions.window, ...(request.window ?? {}) };
  const evidenceFolder = evidenceFolderFor(request, conventions);
  const logFile = join(evidenceFolder, 'log.jsonl');
  writeFileSync(logFile, '');
  const browser = await openBrowser(conventions.browser, window, request.browser);
  const origin = new URL(appUrl).origin;
  const queue = [appUrl];
  const seen = new Set(queue);
  const screens = [];
  try {
    const page = await browser.newPage();
    const watch = watchPage(page, conventions, logFile, Date.now());
    for (const domain of ['Page', 'Runtime', 'Network', 'Log']) await page.send(`${domain}.enable`);
    while (queue.length && screens.length < most) {
      const url = queue.shift();
      const mark = watch.mark();
      const opened = await page.send('Page.navigate', { url });
      await settle(page, watch, conventions.timing);
      if (opened.errorText) { screens.push({ url, problem: opened.errorText }); continue; }
      const screen = await evaluate(page, readScreen, { most_links: conventions.map.most_links_per_screen });
      const controls = await controlsOf(page, conventions);
      const shot = await picture(page, join(evidenceFolder, `${String(screens.length + 1).padStart(2, '0')}-${safeName(new URL(screen.url).pathname)}.png`));
      const links = screen.links.filter(link => { try { return new URL(link).origin === origin; } catch { return false; } });
      screens.push({
        url: screen.url, title: screen.title, headings: screen.headings, links,
        controls: controls.map(({ role, name, value, disabled }) => ({ role, name, ...(value !== undefined ? { value } : {}), ...(disabled ? { disabled } : {}) })),
        offered: offeredActions(controls, conventions.controls.offered_actions_by_role), screenshot: shot, ...watch.since(mark),
      });
      for (const link of links) if (!seen.has(link)) { seen.add(link); queue.push(link); }
    }
    await page.close();
  } finally {
    browser.close();
  }
  return { kind: 'app-map', app_url: appUrl, browser: browser.name, evidence_folder: evidenceFolder, screens, not_opened: queue };
}
