// tools/set-up-my-account/read-data/get-started-screen.mjs
//
// Moved from trillion src/account-screens.mjs (setupAccessSteps and getStartedFacts), unchanged but for these imports.
import { aiAppGuides } from './ai-app-guides.mjs';
import setupSettings from './setup-steps.json' with { type: 'json' };
import setupAccess from './setup-access.json' with { type: 'json' };
import { askChoices, CHOSEN_AI } from './ask-your-ai.mjs';

/**
 * What only the person can do about app access, as steps: confirming their own email, and agreeing to the emailed
 * invitation. Everything else about access (what the provider recorded, who at Trillion configures it) is Trillion's
 * and the person's AI's work, so it is never drawn. The words are DATA (src/setup-steps.json, src/setup-access.json).
 */
function setupAccessSteps(facts) {
  const words = setupSettings.words;
  const send = (operation, access) => ({ label: setupAccess.words.request, tone: 'primary', send: { path: '/work/api/setup-access',
    body: { source_id: access.source_id, request_id: access.request_id, operation, consent: true } } });
  return (facts.setup_access ?? []).flatMap(access => {
    if (access.blocker === 'verified-email-missing') return [{ title: words.email_title, body: words.email_body, action: { label: setupAccess.words.confirm_email, href: '/sign-in/add-email', tone: 'primary' } }];
    if (access.blocker === 'mandate-missing') return [{ title: words.invite_title, body: words.invite_body, action: send('prepare', access) }];
    if (access.state === 'canceled') return [{ title: words.invite_title, body: words.invite_body, action: send('retry', access) }];
    return [];
  });
}

/**
 * Get started: the required setup steps composed from their owners by src/setup-steps.mjs. A null done state is a
 * failed/unknown read, never completion. facts: { complete, workspace_ready, workspace_mode, person_actions,
 * steps, words, can_dispatch, workflow, origin,
 * access?, plan_sections?, plan_lead?, free_decisions? }. A plan refusal keeps its original status and payload;
 * its checkout and free-decision choices are inside the hold, where an ordinary Plan link cannot be reached.
 */
export function getStartedFacts(facts) {
  const steps = Array.isArray(facts.steps) ? facts.steps : [];
  // The count is the person's required steps (audience person_only). Optional steps ("If you want it") and the AI's own
  // steps are never counted. The total does not change while a read is pending, because unknown steps stay in it.
  const personFacing = steps.filter(step => step.audience === 'person_only' && step.required === true);
  const done = personFacing.filter(step => step.done === true).length;
  const requirements = Array.isArray(facts.requirements) ? facts.requirements : steps;
  const required = requirements.filter(step => step.required === true);
  const hasPolicy = facts.policy != null;
  const requirementsKnown = hasPolicy ? facts.policy.requirements_resolved === true && facts.policy.required_count === required.length
    : steps.length > 0;
  const complete = facts.complete === true && requirementsKnown && (hasPolicy ? required.every(step => step.done === true) : done === personFacing.length);
  const now = Date.now();
  // One count for every view: it is the steps' own, and shown only when every step could be read, so a failed read never
  // makes it say one number now and another a moment later. An unknown step is read again soon, never drawn as an error.
  const known = steps.length > 0 && steps.every(step => typeof step.done === 'boolean');
  const unreadable = facts.access?.status >= 400 && facts.access?.status !== 402;
  const checking = !known || unreadable;
  const changes = [facts.policy?.next_change_at, ...(facts.setup_access ?? []).map(access => Date.parse(access.retry_at ?? '')),
    ...(checking ? [now + setupSettings.gate.read_every_seconds * 1000] : [])]
    .filter(at => typeof at === 'number' && Number.isFinite(at) && at > now);
  // The account may be ready for its existing free decisions without having bought or verified ongoing setup.
  // This is the shared composer's explicit activation result, never inferred from prices or remaining use. A finished
  // step reads finished from its real records (src/setup-policy.json checks), so a set-up account passes on its own.
  const ready = requirementsKnown && !facts.policy?.problems?.some(problem => problem.blocking)
    && (typeof facts.workspace_ready === 'boolean' ? facts.workspace_ready : complete);
  const freeReady = ready && !complete && facts.workspace_mode === 'free';
  const guides = aiAppGuides(facts.origin ?? 'https://app.gettrillion.ai', facts.installs);
  const said = setupSettings.words;
  const connectedAis = Array.isArray(facts.ai_apps) ? facts.ai_apps : [];
  const aiSignedIn = connectedAis.length > 0 || facts.ai_signed_in === true;
  const planNeeded = facts.access?.status === 402 && facts.access?.upgrade_needed === true;
  const stopped = facts.workflow?.withdrawn === true;
  const canContinue = !complete && !planNeeded && !stopped;
  const retry = label => ({ label, tone: 'quiet', send: { path: '/work/api/setup/retry' } });
  // This uses the same AI-opening owner as every Ask your AI button. It sends a decision request, not the full
  // setup prompt: an allowance does not buy durable setup, and opening an AI does not purchase anything.
  const freePrompt = `Connect Trillion at ${facts.origin ?? 'https://app.gettrillion.ai'}/mcp to this AI if needed, then check my account's free decision allowance. Use an available free decision for what I am already working on, asking only for essential information you cannot recover. Keep the result in this chat: the free plan does not keep decisions or include full ongoing setup. If my allowance is used up or unavailable, explain the actual limit and next available option. Do not start paid setup, upgrade, subscribe, or buy anything from this request.`;
  const freeTabs = () => askChoices(freePrompt).map(choice => ({
    id: choice.id, label: choice.label, ...(choice.picture ? { picture: choice.picture } : {}),
    remember: CHOSEN_AI, copy: { text: choice.words, copied_label: 'Decision request copied' },
    open: { href: choice.href, ...(choice.paste ? { paste: true } : {}) },
    lead: 'Send the prepared request in your AI. It checks your allowance before starting a decision.',
    actions: [{ label: `Open ${choice.label}`, href: choice.href, tone: 'primary' }], steps: [],
  }));
  // Every required step is listed, done or not, with who does it next. Connected things are items (logo chips) with
  // their add action, partial progress is the step's own count, and a step keeps its real control (its fields, its
  // action) while it is done too, so nothing on the screen is only text.
  // A value shown in an editable field is not repeated beside it as a row.
  const formLabels = step => new Set(step.complete_here && !planNeeded ? step.complete_here.fields.map(field => field.label) : []);
  const notesOf = step => (step.notes ?? []).filter(note => !formLabels(step).has(note.label));
  const stepOf = step => ({ id: step.id, title: step.title, done: step.done, ...(step.body ? { body: step.body } : {}),
    ...(notesOf(step).length ? { notes: notesOf(step) } : {}), ...(step.items?.length ? { items: step.items } : {}),
    ...(step.add ? { add: step.add } : {}), ...(step.progress ? { progress: step.progress } : {}),
    ...(step.action ? { action: step.action } : {}),
    ...(step.actions ? { actions: step.actions } : {}), ...(step.place ? { place: step.place } : {}), // A plan that does not keep what a form saves (free access) gets no form it would refuse; its plan choice is above.
    ...(step.complete_here && !planNeeded ? { complete_here: step.complete_here } : {}) });
  // The owner of a step is the person when its audience is person_only, and their AI otherwise.
  // Only a step the person can act on names its owner ("You"); their AI's own work carries no label. A step whose parts are
  // running, and an AI step not finished yet, are shown as being worked on (the checking mark), never as not set up.
  const shownDone = step => step.done === true ? true : step.running === true ? null : step.audience === 'person_only' ? step.done : step.done === false ? null : step.done;
  const withOwner = step => ({ ...stepOf(step), done: shownDone(step),
    ...(step.audience === 'person_only' && shownDone(step) !== true ? { owner: 'you' } : {}) });
  // One list of every required step in requirement order. The person's access steps (confirm email, accept the invitation)
  // come first, because the rest waits on them; they are never done while shown. The progress count is taken over this
  // whole list, never over a subset of it.
  // Before any AI is connected the connect choices above are the only ask, so only what already works is drawn under them.
  const shown = row => aiSignedIn || row.done === true;
  const requiredRows = requirements.filter(step => step.required === true).map(withOwner).filter(shown);
  const accessRows = setupAccessSteps(facts).map(row => ({ ...row, done: false, owner: 'you' }));
  const setupRows = [...accessRows, ...requiredRows];
  // Optional steps ("If you want it") include the person's optional actions, such as a computer permission, so they stay visible.
  // Optional steps show only while there is something to do in them; a done optional step is not drawn as a heading over a tick.
  const optionalRows = requirements.filter(step => step.required !== true && (step.audience === 'optional' || step.audience === 'person_only'))
    .map(withOwner).filter(shown).filter(row => row.done !== true);
  return {
    title: freeReady ? 'Ready for free decisions' : complete && ready ? facts.words.complete_title : !aiSignedIn && facts.words.title_first ? facts.words.title_first : facts.words.title,
    lead: complete && ready ? facts.words.complete_lead : freeReady ? 'Your AI is connected and your free workspace is ready. Full ongoing setup is not included; the checks below remain unfinished.'
      : planNeeded
      ? 'Choose a plan for full ongoing setup, or use an available free decision in your AI.'
      : stopped ? 'Setup is stopped. You can restart it here when you want to continue.' : facts.words.lead,
    ready, workspace_ready: ready, setup_complete: complete, requirements,
    ...(facts.policy ? { policy: facts.policy } : {}),
    ...(changes.length ? { refresh_at: Math.min(...changes) } : {}),
    workspace_mode: facts.workspace_mode ?? (complete ? 'full' : 'setup'),
    ...(facts.access ? { access: facts.access } : {}),
    ...(facts.workflow ? { workflow: facts.workflow } : {}),
    sections: [
      ...(planNeeded ? [
        { id: 'setup-access', heading: 'Choose how to use Trillion',
          body: 'Full ongoing setup is not included in your current access. You can use an available free decision in your AI, or choose a plan below to continue the full setup.',
          ...(facts.access.feature?.label ? { note: `The current plan does not include: ${facts.access.feature.label}.` } : {}),
          actions: [retry('Check access again')],
        },
        { id: 'setup-free-decisions', heading: facts.free_decisions?.included ? 'Use your free decisions in your AI' : 'Check free decisions in your AI',
          body: [facts.free_decisions?.left_words ?? 'Your AI will check whether a free decision is available before starting.',
            'The free plan does not keep decisions or complete the ongoing setup shown below. Choosing an AI here does not change your plan.'].join(' '),
          // An AI that already connected is not asked to pick one again; only the request to send it stays.
          ...(aiSignedIn ? {} : { tabs: freeTabs() }), actions: [{ label: 'Copy free decision request', tone: aiSignedIn ? 'primary' : 'quiet', copy: freePrompt }],
        },
        ...(Array.isArray(facts.plan_sections) && facts.plan_sections.length
          ? [{ id: 'setup-plan-heading', heading: 'Continue with full setup', body: facts.plan_lead },
            ...facts.plan_sections.map((section, index) => ({ ...section, id: `setup-plan-${index}` }))]
          : [{ id: 'setup-plan-unavailable', heading: 'Plans could not be read',
            body: 'Your plan has not changed. Try again to see the current offers and their checkout buttons.', actions: [retry('Try reading plans again')] }]),
      ] : []),
      ...(facts.notice ? [{ id: 'setup-status', ...(facts.notice.id ? { notice: facts.notice.id } : {}), heading: facts.notice.title, body: facts.notice.body,
        actions: [{ label: facts.notice.action, tone: 'quiet', href: facts.notice.href }] }] : []),
      ...(canContinue && !aiSignedIn ? [{
        id: 'setup-with-ai', heading: said.connect_heading, body: said.connect_body,
        tabs_require_choice: setupSettings.connect_requires_choice === true,
        tabs: guides.tabs.map(tab => ({ ...tab, lead: said.connect_lead, steps: [] })),
      }] : []),
      ...(stopped ? [{ id: 'setup-run', heading: said.stopped_heading, body: said.stopped_body,
        actions: [{ label: said.restart, tone: 'primary', send: { path: '/work/api/setup/restart' } }] }] : []),
      ...(setupRows.length ? [{ id: 'setup-steps', heading: said.steps_heading, steps: setupRows }] : []),
      ...(optionalRows.length ? [{ id: 'setup-optional', heading: said.optional_heading, steps: optionalRows }] : []),
    ],
  };
}
