// One flow for every AI app: shared stages and app-specific fields come from ai-clients.json.
// The short copied prompt asks the current app to use that flow; it never pastes every app's manual into a chat.
import clients from './ai-clients.json' with { type: 'json' };
import setupPrompt from './ai-setup-prompt.json' with { type: 'json' };
import setupPolicy from './setup-policy.json' with { type: 'json' };
import { logoOf } from './site-icon-url.mjs';
import { askChoices, CHOSEN_AI } from './ask-your-ai.mjs';

const STEP_FIELDS = ['title', 'body', 'code', 'link', 'action', 'leave', 'see', 'fix'];
const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (whole, name) => (values[name] ?? whole));

function stageSteps(stage, client) {
  const own = client.stages?.[stage.id];
  if (Array.isArray(own)) return own;
  const part = { app: client.app ?? client.label, ...(own ?? {}) };
  const step = Object.fromEntries(STEP_FIELDS.flatMap(field => {
    const value = own?.[field] ?? stage[field];
    return value === undefined ? [] : [[field, typeof value === 'string' ? fill(value, part) : value]];
  }));
  if (!step.body && !step.code) {
    if (stage.required) throw new Error(`${client.id} gives nothing for the ${stage.id} stage`);
    return [];
  }
  return [step];
}

export const appSteps = client => clients.stages.flatMap(stage => stageSteps(stage, client));

export function aiAppGuides(origin, installs = {}) {
  const mcp = `${origin}/mcp`;
  const values = { mcp, setup_continuation: setupPolicy.words.continuation, cursor_config: encodeURIComponent(btoa(JSON.stringify({ url: mcp }))), ...installs };
  const filled = text => (text === undefined ? undefined : fill(text, values));
  const filledStep = step => Object.fromEntries(Object.entries(step).map(([field, value]) => [field, typeof value === 'string' ? filled(value) : field === 'link' ? { ...value, href: filled(value.href) } : value]));
  const notes = step => clients.step_notes.filter(note => step[note.key]).map(note => ({ label: note.label, text: step[note.key] }));
  const allow = clients.stages.find(stage => stage.id === 'allow');
  const opens = new Map(askChoices(filled(setupPrompt.text), filled).map(choice => [choice.id, choice]));
  return {
    setup_prompt: filled(setupPrompt.text),
    // Picking an app's tab copies the words for that app (the general setup message, or the line a terminal app runs),
    // remembers the app as the person's AI (every Ask your AI button names it) and opens the app holding the words, so
    // all that is left is Send. An app that connects in one press of its own (Add to Cursor) opens that instead. The same
    // press stays above the steps for opening it again.
    tabs: clients.clients.map(client => {
      const choice = opens.get(client.id);
      const connect = client.connect_open ? { href: filled(client.connect_open.href), label: client.connect_open.label } : null;
      const open = connect ? { href: connect.href } : choice ? { href: choice.href, ...(choice.paste ? { paste: true } : {}) } : null;
      const words = choice?.words ?? filled(setupPrompt.text);
      return {
        id: client.id, label: client.label, lead: client.lead,
        copy: { text: words, copied_label: setupPrompt.copied_label },
        remember: CHOSEN_AI,
        ...(open ? { open } : {}),
        ...(open ? { actions: [{ label: connect?.label ?? fill(setupPrompt.open_label, { app: client.label }), href: open.href, tone: 'primary' }] } : {}),
        ...(client.domain ? { picture: logoOf(client.domain) } : {}), ...(client.icon ? { icon: client.icon } : {}),
        steps: appSteps(client).map(filledStep).map(({ leave, see, fix, ...step }) => {
          const said = notes({ leave, see, fix });
          return said.length ? { ...step, notes: said } : step;
        }),
      };
    }),
    run_without_asking: clients.clients.map(client => ({ app: client.label, ...filledStep(stageSteps(allow, client)[0]) })),
  };
}
