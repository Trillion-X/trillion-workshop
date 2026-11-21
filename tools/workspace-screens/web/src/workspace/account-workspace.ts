// src/workspace/account-workspace.ts
//
// PURPOSE
//   The signed-in workspace as files any computer serves (/workspace, scripts/build-workspace.mjs writes its page): it
//   signs in with the account's sign-in tool (account-pass.ts), answers every read at the account's one door
//   (account-door.ts), offers one screen per tool of the account's own catalogue (tools:list, through toolSurfaces), and
//   draws the one composition every whole workspace draws (mount-workspace.ts).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a tool: the sidebar is the catalogue's answer, page by page; a tool added to it is a screen
//      the next time the page reads it.
//   2. The records the arrangement keeps (its layouts, sidebar, looks, the person's own show rules) are rows of one table
//      in the person's own database (sql-records.ts, account-records.json), read and written through the SQL tool with
//      the person's own rights; the saved ones are read once the pass is held, and they fill in place.
//   3. The screens tools offer in their part.json `offers` (Find anything, the message box, Look, ...) are read when the
//      page is built (`offered-screen-rows`, scripts/build-workspace.mjs) and offered before the catalogue's, as the
//      signed-in page's screens answer offered them.
//   4. The workspace draws at once from what the build knows; the pass, the saved records and the catalogue fill in as
//      they arrive (Workspace.reoffer). No door call is sent before the pass is held: the door waits for it.
//   5. A catalogue row's screen is what its tool declares: the list answer's own, else the one this computer kept from
//      the tool's last description (tool-catalogue-rows.mjs).

import { keptAnswerOf, readJson, setPageDoor } from './api';
import { answerAtTheDoor } from './account-door';
import { answerHere } from './account-own-answers';
import { notificationsAnswers } from './account-notifications';
import { keepPersonNotifications } from './person-notifications';
import { pass, takeCallback } from './account-pass';
import { remoteRecordsSource, setWorkspaceRecordsSource } from './records-source';
import { sqlRecordsTransport } from './sql-records';
import { runWorkshopTool } from './workshop-tool-api';
import kept from './account-records.json' with { type: 'json' };
import { answerTargets } from './targets';
import { installScreenRunner } from './screen-runner';
import { screens } from './screen-mounts';
import { offeredScreens, startScreenRecords, type ScreenRow } from './offered-screens';
import { mountWorkspace, newWorkspaceRoot, openSurface } from './mount-workspace';
import { openRouted, routedRequests } from './routed-open.mjs';
import { readStartupRecords, showRecords } from './records';
import { keepShowRules } from './show-rules-live';
import surfaces from './screens.mjs';
import { catalogueRows } from './tool-catalogue-rows.mjs';
import { toolScreenRequest } from './tool-screen-requests.mjs';
import { onKeptAnswerReplaced, readWithKeptAnswers } from '../../../../ui/show/request/kept-answers.ts';
import { liftOpeningCover } from '../../../../ui/show/thread-cover/thread-cover.mjs';
// The screens every tool offers, read when the page was built (scripts/build-workspace.mjs).
import screensToolsOffer, { rows as rowsToolsOffer } from 'offered-screen-rows';
import { setOfferedRows } from './offered-rows';

type Listed = { tools: { id: string; label?: string; job?: string; screen?: Record<string, unknown> }[]; next?: string | null };
const listPath = (after: string | null) => `/work/api/door/tools:list?input=${encodeURIComponent(JSON.stringify(after ? { after } : {}))}`;
const listed = (after: string | null) => readJson<Listed>(listPath(after));
const warnRead = (what: string) => (error: unknown): Listed => { console.warn(`${what} failed; drawing the screens the build knows`, error); return { tools: [], next: null }; };

// The pass is held before the page's first door call. A call made before it is held waits for it here, so no two calls
// renew or sign in at once (a sign-in code is used once). The page draws meanwhile.
const signedIn = takeCallback().then(() => pass());
signedIn.catch(() => {});

const statement = (sql: string, params: unknown[]) =>
  runWorkshopTool<{ rows: Record<string, unknown>[] }>(kept.tool, { credential_name: kept.credential_name, sql, params }).then(ran => ran.result?.rows ?? []);
const notifications = notificationsAnswers(statement);
setPageDoor(async (path, init) => {
  await signedIn;
  return answerHere(path, init) ?? await notifications(path, init) ?? answerAtTheDoor(path, init);
});
setWorkspaceRecordsSource(remoteRecordsSource(sqlRecordsTransport(statement, kept.table, kept.retry)));
setOfferedRows(rowsToolsOffer);
installScreenRunner(screens, surfaces.address_label);
// Registers every page target at once (targets.ts); the arrangement's own math loads when it is first asked.
void answerTargets().catch(error => console.warn('page targets failed to register', error));

const viewer = { access_refs: [] as string[] };
const tools: ScreenRow[] = [...(screensToolsOffer as ScreenRow[])];
const offered = offeredScreens(viewer, tools);
// The seed the screens read from the first draw (looks, the offered rows); the person's saved values fill in below.
await startScreenRecords(offered, {});
// No rules are assigned to this page by an operator: the person's own rules are their records, applied as on every page.
void keepShowRules({ rules: [] }).catch(error => console.warn('show rules failed to start', error));
const root = newWorkspaceRoot();
document.body.prepend(root);
const workspace = mountWorkspace(root, offered, { catalogComplete: false });
keepPersonNotifications();
void signedIn.then(() => readStartupRecords()).catch(error => console.warn('first records read failed; drawing without them', error));

// The catalogue: its pages as they arrive, each row given the screen its tool declares. The first page may be drawn from
// what this computer kept, and the page reads it again when the network's answer differs (onKeptAnswerReplaced).
const catalogue: Listed['tools'] = [];
let catalogueRun = 0;
let catalogueComplete = false;
const keptScreens = new Map<string, Record<string, unknown>>();
const reofferCatalogue = () => {
  const rows = catalogueRows(catalogue, keptScreens) as ScreenRow[];
  offered.splice(0, offered.length, ...offeredScreens(viewer, [...(screensToolsOffer as ScreenRow[]), ...rows]));
  showRecords({ [surfaces.address_label]: offered });
  workspace.reoffer(offered, { catalogComplete: catalogueComplete });
};
/** The screen each listed tool declared in the copy this computer kept of its description (none is asked for). */
async function keepScreensOf(page: Listed['tools']): Promise<void> {
  await Promise.all(page.filter(tool => !tool.screen).map(async tool => {
    const answer = await keptAnswerOf(toolScreenRequest(tool.id, {}, 'describe').path).catch(() => null);
    const screen = (answer?.body as { screen?: Record<string, unknown> } | null | undefined)?.screen;
    if (screen && typeof screen === 'object') keptScreens.set(tool.id, screen);
  }));
}
async function readCatalogue(): Promise<void> {
  const run = ++catalogueRun;
  const current = () => run === catalogueRun;
  let page = await readWithKeptAnswers(() => listed(null)).catch(warnRead('first tool list'));
  catalogue.length = 0;
  while (current()) {
    catalogue.push(...page.tools);
    await keepScreensOf(page.tools);
    catalogueComplete = !page.next;
    reofferCatalogue();
    liftCover();
    if (!page.next) break;
    page = await listed(page.next).catch((): Listed => ({ tools: [], next: null }));
  }
}
const firstPath = listPath(null);
onKeptAnswerReplaced(path => { if (path === firstPath) void readCatalogue(); });
// The screens this page's address names open once the arrangement takes them: a screen the catalogue offers later still
// opens at its address (routed-open.mjs).
openRouted(() => routedRequests(offered, location.pathname, location.search), openSurface, () => catalogueComplete);

// The opening cover (thread-cover.mjs, drawn by the page's first bytes) lifts once the first catalogue page is drawn, or
// at the latest COVER_MOST_MS after the page started, whatever the reads are doing.
const COVER_MOST_MS = 8000;
let lifted = false;
const liftCover = () => { if (!lifted) { lifted = true; void liftOpeningCover(); } };
setTimeout(liftCover, COVER_MOST_MS);

void readCatalogue();
