// src/workspace/guide-screens.tsx
// Owned by the account-screens builder (Get started, Use Trillion in your AI, Connections, Account & security,
// Plan, Business). The workspace shell (main.tsx, records.ts) and the Files and Decisions screens belong to
// the workspace builder; this file only adds screens to its `screens` map.
//
// PURPOSE
//   The guide screens in the signed-in workspace. Each one reads its description from the Worker
//   (GET /work/api/screens/<name>, built in src/account-screens.mjs from this person's real facts) and draws it with the
//   shared guide (parts/ui/show/coss/guide.tsx). Pressing an action does what its DATA says: open another screen in
//   the workspace, open a page (copying words is the guide's own copy button), hand a job to the person's own AIs (src/workspace/queue-job.ts), or send a
//   request whose answer says what happened next.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The screens hold no words of their own: every title, step and label is the Worker's description.
//   2. An answer drives what happens next through its own fields (`said`, `reveal`, `redirect`, `ceremony`, `refresh`,
//      `query`: read this screen again with these words as its query, such as a search the person typed), and
//      a description through `announce` (said once per id in this browser);
//      this file never branches on which screen or which action it is.
//   3. A passkey is made only by the browser's own passkey step (the `ceremony` an answer asks for), and the finished
//      step goes straight back to the Worker; nothing about it is kept here. A refusal whose `step_needed` is the
//      passkey confirmation (src/passkey-authority.mjs) is answered by confirming with a passkey and sending the same
//      request once more with that confirmation.
//   5. A step's `place` (an address of this page) is drawn in place under the step by the shared screen-in-place
//      (./screen-in-place.tsx), so a step is done right on the screen that asks for it.
//   4. Every control is the shared guide's, or a shared part the description places by name (LENT_PARTS); this file
//      only hosts them and wires their actions.

import { openSettingsPage } from './settings-page-request';
import { confirmWithPasskey, makePasskey, passkeyStepEnded } from '../passkey-step.mjs';
import passkeyAuthority from '../passkey-authority.json';
import { guideReveals, mountGuide, type GuideAction, type GuideDescription, type GuideOptions, type GuideReveal } from '../../parts/ui/show/coss/guide';
import { recordFilter } from './record-filter';
import {recordConfigurationSource} from './record-configurations';
import { loadScreen } from '../../parts/ui/show/screen-state';
import { notify } from '../../parts/ui/show/coss/notifications';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import surfaces from './screens.mjs';
import { postJson, readJson } from './api';
import { refusal } from './failure';
import { AI_WORK, onStoreChange } from './store-changes';
import { queuedJobDone, sendQueuedJob } from './queue-job';
import { ChooseScreenLook } from '../../parts/screen-look/show/ChooseScreenLook';
import { PaneSizeSettings } from '../../parts/screen-arrangement/show/PaneSizeSettings';
import {CurrentFeelSettings} from './feel-settings';
import { emitWalkthroughEvent } from '../../parts/guided-overlay/show/walkthroughs';
import { surfaceInputWithoutPlacement } from '../../parts/screen-arrangement/show/surface-placement';
import { openAddress } from './open-screen';
import { yourFiles } from './your-files';
import { AddPages } from './add-pages';
import { pushWorkspaceAddress } from './addresses.mjs';
import { ScreenInPlace } from './screen-in-place';
import { guideRefresh } from './guide-refresh.mjs';
import { heldGetStarted } from './get-started-hold.mjs';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
import { runWorkshopTool } from './workshop-tool-api';
// The parts a screen's description may place in a section by name (`part`): each keeps its own state from the person's
// records, so a re-read of the screen leaves it as it is.
const LENT_PARTS = { 'screen-look': ChooseScreenLook, 'pane-sizes': PaneSizeSettings, feel: CurrentFeelSettings, 'add-pages': AddPages };

type Answer = { said?: string; reveal?: GuideReveal; redirect?: string; refresh?: boolean; query?: Record<string, string | null>; ceremony?: { make_passkey: Parameters<typeof makePasskey>[0]; finish: { path: string; body: Record<string, unknown> }; said?: string } };

// Another screen of this workspace, opened the way the sidebar opens it.
function openScreen(id: string) {
  const surface = surfaces.surfaces.find(item => item.id === id);
  if (!surface) { notify('That screen is not available here.', { kind: 'error' }); return; }
  window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { detail: surface, cancelable: true }));
}

// What a screen announces is said once per thing, in this browser: a session just booked is told once, not on every read.
function announce(said: GuideDescription['announce']) {
  if (!said) return;
  const key = `trillion-announced:${said.id}`;
  try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch { /* storage refused: say it anyway */ }
  notify(said.text, { kind: 'done' });
}

/** One guide screen; which one is its surface row's DATA (`surface_input.screen` in src/workspace/surfaces.json), so a
 *  new guide screen is one row there and one description in src/account-screens.mjs. Any other text in the input
 *  (a decision's `id`) is passed to the Worker as the description's query. */
export function mountGuideScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> }): () => void {
  const { screen, ...given } = surfaceInputWithoutPlacement(props.surfaceInput);
  const name = typeof screen === 'string' ? screen : '';
  // The rest of the screen's own input (a decision's id) goes along as the description's query; where the screen is
  // placed does not, and the viewer's time zone goes with every read (./api.ts), so a screen with no input of its own
  // is read at one address wherever it opens, which the page can read ahead and keep (first-answers.json screens).
  const asked = new Map(Object.entries(given).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const configurations = {source: recordConfigurationSource({accessCode: asked.get('access_code')}), initialId: asked.get('configuration'), sharedCode: asked.get('shared_configuration'), sharedOffer: asked.get('shared_offer')};
  const query = () => (asked.size ? `?${new URLSearchParams([...asked])}` : '');
  // A narrowed screen's Show all: the same screen, read again in place without what narrowed it (`show_*`).
  const widen = () => { for (const field of [...asked.keys()]) if (field.startsWith('show_')) asked.delete(field); void loaded.reload(); };
  let guide: ReturnType<typeof mountGuide> | null = null;
  // What a press revealed stays shown when this screen draws its guide anew (a kept copy replaced by the network's).
  const reveals = guideReveals();
  const host = document.createElement('div');
  host.className = 'trillion-guide';
  element.replaceChildren(host);
  // The screen's own name from its row, for what the loading rows and a failure say.
  const label = (surfaces.surfaces as { label: string; surface_input?: { screen?: unknown } }[]).find(row => row.surface_input?.screen === name)?.label;
  const refresh = guideRefresh(() => loaded.reload());

  // Get started keeps its last good description: a failed read, or an answer that holds no real step yet, shows the
  // description already on screen (src/workspace/get-started-hold.mjs). A failure with nothing kept still fails.
  let kept: (GuideDescription & { refresh_at?: number }) | null = null;
  const holdsLastGood = name === 'get-started';
  const readScreen = async (): Promise<GuideDescription & { refresh_at?: number }> => {
    const url = `/work/api/screens/${encodeURIComponent(name)}${query()}`;
    if (!holdsLastGood) return readJson<GuideDescription & { refresh_at?: number }>(url);
    let next: (GuideDescription & { refresh_at?: number }) | null;
    try { next = await readJson<GuideDescription & { refresh_at?: number }>(url); } catch (error) { if (kept) return kept; throw error; }
    const shown = heldGetStarted(kept, next);
    if (!shown) throw new Error('get-started answered nothing');
    kept = shown;
    return shown;
  };

  // A screen this running Trillion has no owner for (404 no-owner, api.ts `absent`) does not appear by a store change:
  // it shows "absent" once with Try again, and is read again only when the person presses it.
  let absent = false;
  const loaded = loadScreen(host, {
    loading: { label: label ? `Loading ${label}` : 'Loading this screen', layout: 'rows' },
    read: () => readScreen().then(
      description => { absent = false; return description; },
      error => { absent = (error as { absent?: unknown } | null)?.absent === true; throw error; }),
    failed: refusal(label ? `${label} could not load` : 'This screen could not load'),
    clear: () => { refresh.clear(); guide?.unmount(); guide = null; },
    update: description => { refresh.readAt(description.refresh_at); announce(description.announce); guide?.update(description); },
    draw: description => {
      refresh.readAt(description.refresh_at);
      announce(description.announce);
      if (guide) { guide.update(description); return; }
      // A share section sends its card through the same request the screen's actions use.
      // A searchable list filters with the formula engine, fetched the first time one of its rules is in force.
      const options: GuideOptions = { post: (path, body) => postJson(path, body), parts: LENT_PARTS, recordFilter, configurations, reveals, files: yourFiles, place: address => <ScreenInPlace className="guide-screen-in-place" address={address} />, widen };
      guide = mountGuide(host, description, act, options);
    },
  });
  const load = () => loaded.reload();

  async function act(action: GuideAction, values: Record<string, string>): Promise<GuideReveal | void> {
    if (action.open) {
      const page = openSettingsPage(action.open);
      if (page !== 'not-a-page') {
        if (page === 'not-open') notify('That page is not open here.', { kind: 'error' });
      } else if (action.open.startsWith('/')) {
        if (openAddress(action.open)) pushWorkspaceAddress({}, action.open);
        else notify('That screen is not available here.', { kind: 'error' });
      } else openScreen(action.open);
      return;
    }
    // The one sharing sheet for a record the screen names (src/workspace/sharing-sheet.tsx).
    if (action.share) { (await import('./sharing-sheet')).openSharing(action.share.record, { title: action.share.title, anchor: document.activeElement }); return; }
    // A tour asked for by name, in place of any tour already running.
    if (action.tour) { emitWalkthroughEvent({ event_kind: 'walkthrough-requested', walkthrough_id: action.tour }); return; }
    if (action.queue) {
      try {
        const sent = await sendQueuedJob({ job_id: action.queue.job, context: action.queue.context, press_key: crypto.randomUUID() });
        notify(sent.said || queuedJobDone, { kind: 'done' });
      } catch (error) { notify(errorWords(error), { kind: 'error' }); }
      return;
    }
    if (action.href) {
      if (/^https?:\/\//.test(action.href)) window.open(action.href, '_blank', 'noopener');
      else location.assign(action.href);
      return;
    }
    if (action.tool) {
      try {
        // Catalogue actions share the real Workshop owner with AI calls. A tool
        // receives only its declared input plus the fields this action requested;
        // neither presentation visibility nor disclosure state enters the input.
        const input = structuredClone(action.tool.input ?? {});
        if (action.tool.with_fields) {
          for (const [name, value] of Object.entries(values)) {
            const path = action.tool.field_paths ? action.tool.field_paths[name] : [name];
            if (!path) continue;
            if (!path.length || path.length > 16 || path.some(key => !key || ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('This action has an invalid input field path.');
            let target = input;
            for (const key of path.slice(0, -1)) {
              if (target[key] == null) target[key] = {};
              if (typeof target[key] !== 'object' || Array.isArray(target[key])) throw new Error('This action field cannot replace a different input value.');
              target = target[key] as Record<string, unknown>;
            }
            target[path.at(-1)!] = value;
          }
        }
        const requestKey = `screen:${crypto.randomUUID()}`;
        if (action.tool.request_key_field) {
          if (['__proto__', 'constructor', 'prototype'].includes(action.tool.request_key_field)) throw new Error('This action has an invalid request key field.');
          input[action.tool.request_key_field] = requestKey;
        }
        const ran = await runWorkshopTool<{ said?: string; error?: string }>(action.tool.id, input, requestKey);
        if (ran.error || ran.state === 'failed' || ran.output?.error) throw new Error(ran.error || ran.output?.error || 'The action failed.');
        if (ran.state === 'working' || ran.state === 'waiting') throw new Error(`The action is still running (${ran.task_id}). Its result is in Runs.`);
        if (ran.output?.said) notify(ran.output.said, { kind: 'done' });
        await load();
        return;
      } catch (error) {
        notify(errorWords(error), { kind: 'error' });
        throw error; // A refused/unknown write retains the row's draft.
      }
    }
    const target = action.send;
    if (!target) return;
    let answer: Answer;
    try {
      const send = (extra: Record<string, unknown> = {}) => postJson<Answer>(target.path, { ...(target.body ?? {}), ...(target.with_fields ? { values } : {}), ...extra });
      answer = await send().catch(async (error: { step_needed?: string; change?: object }) => {
        if (error?.step_needed !== passkeyAuthority.step_needed || !error.change) throw error;
        return send({ confirmation: await confirmWithPasskey(postJson, error.change, { show: words => { notify(words); } }) });
      });
      if (answer.ceremony) {
        await postJson(answer.ceremony.finish.path, { ...answer.ceremony.finish.body, response: await makePasskey(answer.ceremony.make_passkey) });
        answer = { ...answer, said: answer.ceremony.said ?? answer.said, refresh: true };
      }
    } catch (error) {
      // How the passkey step (or the request) ended, in the same words the sign-in pages use (src/passkey-step.json).
      const ended = passkeyStepEnded(error, 'make');
      notify(ended.said, { kind: ended.kind });
      return;
    }
    if (answer.said) notify(answer.said, { kind: 'done' });
    // Leaving for another page (a checkout): the pressed button keeps saying what is happening until the page goes, and
    // coming back to this page from the browser's history reads the screen again.
    if (answer.redirect) { location.assign(answer.redirect); return new Promise<void>(resolve => window.addEventListener('pageshow', () => { void load(); resolve(); }, { once: true })); }
    // A null value takes that word out of the query.
    if (answer.query) for (const [key, value] of Object.entries(answer.query)) { if (typeof value === 'string') asked.set(key, value); else asked.delete(key); }
    if (answer.refresh || answer.query) await load();
    return answer.reveal;
  }

  const stopListening = onStoreChange(() => { if (!absent) void load(); }, AI_WORK);
  return () => { stopListening(); refresh.clear(); loaded.dispose(); element.replaceChildren(); };
}
