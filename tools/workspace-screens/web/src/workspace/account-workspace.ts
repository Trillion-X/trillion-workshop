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
//      the person's own rights; the saved ones the first draw needs are read in one read beside the catalogue's first page.
//   3. The screens tools offer in their part.json `offers` (Find anything, the message box, Look, ...) are read when the
//      page is built (`offered-screen-rows`, scripts/build-workspace.mjs) and offered before the catalogue's, as the
//      signed-in page's screens answer offered them.
//   4. The first page of the catalogue draws the workspace; the rest are offered as they come (Workspace.reoffer).

import { readJson, setPageDoor } from './api';
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
import { mountWorkspace, newWorkspaceRoot } from './mount-workspace';
import { readStartupRecords, showRecords } from './records';
import { keepShowRules } from './show-rules-live';
import surfaces from './screens.mjs';
import { toolSurfaces } from '../work-workshop.mjs';
// The screens every tool offers, read when the page was built (scripts/build-workspace.mjs).
import screensToolsOffer, { rows as rowsToolsOffer } from 'offered-screen-rows';
import { setOfferedRows } from './offered-rows';

type Listed = { tools: { id: string; label?: string; job?: string }[]; next?: string | null };
const listed = (after: string | null) =>
  readJson<Listed>(`/work/api/door/tools:list?input=${encodeURIComponent(JSON.stringify(after ? { after } : {}))}`);
const screenRows = (page: Listed) =>
  toolSurfaces(page.tools.map(tool => ({ tool_id: tool.id, label: tool.label, job: tool.job, next_call: true }))) as ScreenRow[];

await takeCallback();
await pass();
const statement = (sql: string, params: unknown[]) =>
  runWorkshopTool<{ rows: Record<string, unknown>[] }>(kept.tool, { credential_name: kept.credential_name, sql, params }).then(ran => ran.result?.rows ?? []);
const notifications = notificationsAnswers(statement);
setPageDoor(async (path, init) => answerHere(path, init) ?? await notifications(path, init) ?? answerAtTheDoor(path, init));
setWorkspaceRecordsSource(remoteRecordsSource(sqlRecordsTransport(statement, kept.table, kept.retry)));
setOfferedRows(rowsToolsOffer);
installScreenRunner(screens, surfaces.address_label);
await answerTargets();
const viewer = { access_refs: [] as string[] };
// Neither first read may keep the page from drawing: a records read or a tool list that fails (no computer answered
// within account-door.json most_ms) draws the page with what it has, the screens the build knows and no saved
// records, and each screen then says for itself what it could not read.
const startup = readStartupRecords().catch((error: unknown) => { console.warn('first records read failed; drawing without them', error); return {}; });
let page = await listed(null).catch((error: unknown): Listed => { console.warn('first tool list failed; drawing the screens the build knows', error); return { tools: [], next: null }; });
const tools: ScreenRow[] = [...(screensToolsOffer as ScreenRow[]), ...screenRows(page)];
const offered = offeredScreens(viewer, tools);
await startScreenRecords(offered, await startup);
// No rules are assigned to this page by an operator: the person's own rules are their records, applied as on every page.
await keepShowRules({ rules: [] });
const root = newWorkspaceRoot();
document.body.prepend(root);
const workspace = mountWorkspace(root, offered, { catalogComplete: !page.next });
keepPersonNotifications();
while (page.next) {
  page = await listed(page.next).catch((): Listed => ({ tools: [], next: null }));
  tools.push(...screenRows(page));
  // The workspace holds this one list: it is changed in place, as the signed-in page does (main.tsx).
  offered.splice(0, offered.length, ...offeredScreens(viewer, tools));
  showRecords({ [surfaces.address_label]: offered });
  workspace.reoffer(offered, { catalogComplete: !page.next });
}
