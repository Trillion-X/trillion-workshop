// src/screen-host.mjs
//
// PURPOSE
//   The generic screen host, answered by the account's own records resource (src/native-owner-routes.json `screen-host`,
//   bound in src/standalone-resource-behavior.mjs). GET /screens is the screen catalogue (the screens of the tools this
//   account has, the service's own first, then its own, a page at a time with `next`). GET /screens/<id> is one screen
//   of the catalogue, read by its own id (a tool id such as tool:drives, or a catalogue screen's name, which is its
//   tool id without "tool:"):
//     - a screen whose kind is "reads" ({ kind, reads: [{ id, tool, input }], shown_when, layout },
//       records/marketplace-screens.json, published by the Marketplace publisher) answers its description: each read is
//       its tool run for this account, its input drawn from the address's query and the asking browser, and the layout
//       (src/screen-layout.mjs) is drawn from what they answered, narrowed to what the address asks for (src/narrowed-screen.mjs) and
//       marked with the automations that back its rows (src/backing-automations.mjs);
//     - any other screen answers its catalogue row ({ surface }).
//   A screen is a definition in the catalogue, published through the Marketplace; nothing here names a screen.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One catalogue: the rows are the Workshop's (src/workshop.mjs screens, list), projected by toolSurfaces
//      (src/work-workshop.mjs), the same rows the workspace's sidebar and arrangement offer.
//   2. Every read is bounded: a catalogue page holds at most firstAnswers.tool_screens_per_read rows, one screen is read
//      by its id alone, and a reads screen runs only the reads its definition names, each once, kept nowhere.
//   3. A screen that is not in this account's catalogue is answered 404, never an empty row; so is a reads screen whose
//      shown_when (a binding over what its reads answered) is not true for this account.
//   4. A read's input comes only from the address's query and the asking browser's own facts; the account a read
//      answers for is the one it runs in.
import firstAnswers from './workspace/first-answers.json' with { type: 'json' };
import { toolSurfaces } from './work-workshop.mjs';
import { drawLayout } from './screen-layout.mjs';
import { narrowedTo } from './narrowed-screen.mjs';
import { withBackingAutomations } from './backing-automations.mjs';
import { passing } from './cut-off.mjs';

const json = (value, status = 200) => Response.json(value, { status });
const NOT_FOUND = () => json({ error: 'Not found' }, 404);
const toolIdOf = id => (id.startsWith('tool:') ? id : `tool:${id}`);

/** GET /screens?after= and GET /screens/<id> over `catalogue`: { page({ after, limit }) → { tools, next },
 *  one(id) → { tools }, read(tool_id, input) → what the tool answered, backing() → the automations that back rows,
 *  evaluate(binding, input) → the compiled formula evaluator's value (src/formula-evaluate.mjs) }.
 *  `browser` holds the asking browser's own facts ({ user_agent, origin, visitor }). */
export async function handleScreenHost(catalogue, request, { browser = {} } = {}) {
  const url = new URL(request.url);
  if (request.method !== 'GET') return NOT_FOUND();
  if (url.pathname === '/screens') {
    const { tools, next } = await catalogue.page({ after: url.searchParams.get('after') ?? '', limit: firstAnswers.tool_screens_per_read });
    return json({ surfaces: toolSurfaces(tools), next });
  }
  if (!url.pathname.startsWith('/screens/')) return NOT_FOUND();
  const id = decodeURIComponent(url.pathname.slice('/screens/'.length));
  if (!id || id.includes('/')) return NOT_FOUND();
  const toolId = toolIdOf(id);
  const cards = (await catalogue.one(toolId)).tools.filter(card => card.tool_id === toolId);
  const screen = cards[0]?.screen;
  if (screen?.kind === 'reads') return describe(catalogue, screen, id, url, browser);
  const [row] = toolSurfaces(cards);
  return row ? json({ surface: row }) : NOT_FOUND();
}

// A reads screen's description: its reads run for this account, its layout drawn from their answers. A read or layout
// that fails answers 502 with its words, as a guide screen always has; a cut-off or busy owner passes to the shared
// failure owner, which asks again.
async function describe(catalogue, screen, id, url, browser) {
  try {
    const context = { query: Object.fromEntries(url.searchParams), browser };
    const answered = await Promise.all(screen.reads.map(async read => [read.id, await catalogue.read(read.tool, drawLayout(read.input ?? {}, context, catalogue.evaluate))]));
    const drawnFrom = { ...context, reads: Object.fromEntries(answered) };
    if (screen.shown_when !== undefined && drawLayout(screen.shown_when, drawnFrom, catalogue.evaluate) !== true) return NOT_FOUND();
    const [description, backing] = await Promise.all([drawLayout(screen.layout, drawnFrom, catalogue.evaluate), catalogue.backing().catch(() => [])]);
    return json(narrowedTo(withBackingAutomations(id, description, backing), url.searchParams));
  } catch (error) {
    if (passing(error)) throw error;
    console.error(JSON.stringify({ event: 'catalogue_screen_failed', screen: id, reason: String(error?.stack ?? error).slice(0, 1000) }));
    return json({ error: String(error?.message ?? error) }, 502);
  }
}
