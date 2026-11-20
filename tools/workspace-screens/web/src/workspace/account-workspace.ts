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
//   2. The records the arrangement keeps are this page's own (memoryRecordsSource), kept in no server store.
//   3. The first page of the catalogue draws the workspace; the rest are offered as they come (Workspace.reoffer).

import { readJson, setPageDoor } from './api';
import { answerAtTheDoor } from './account-door';
import { pass, takeCallback } from './account-pass';
import { memoryRecordsSource, setWorkspaceRecordsSource } from './records-source';
import { answerTargets } from './targets';
import { installScreenRunner } from './screen-runner';
import { screens } from './screen-mounts';
import { offeredScreens, startScreenRecords, type ScreenRow } from './offered-screens';
import { mountWorkspace, newWorkspaceRoot } from './mount-workspace';
import { showRecords } from './records';
import { keepShowRules } from './show-rules-live';
import surfaces from './screens.mjs';
import { toolSurfaces } from '../work-workshop.mjs';

type Listed = { tools: { id: string; label?: string; job?: string }[]; next?: string | null };
const listed = (after: string | null) =>
  readJson<Listed>(`/work/api/door/tools:list?input=${encodeURIComponent(JSON.stringify(after ? { after } : {}))}`);
const screenRows = (page: Listed) =>
  toolSurfaces(page.tools.map(tool => ({ tool_id: tool.id, label: tool.label, job: tool.job, next_call: true }))) as ScreenRow[];

await takeCallback();
await pass();
setPageDoor(answerAtTheDoor);
setWorkspaceRecordsSource(memoryRecordsSource());
installScreenRunner(screens, surfaces.address_label);
await answerTargets();
const viewer = { access_refs: [] as string[] };
let page = await listed(null);
const tools = screenRows(page);
const offered = offeredScreens(viewer, tools);
await startScreenRecords(offered, {});
// No rules are assigned to this page by an operator: the person's own rules are their records, applied as on every page.
await keepShowRules({ rules: [] });
const root = newWorkspaceRoot();
document.body.prepend(root);
const workspace = mountWorkspace(root, offered, { catalogComplete: !page.next });
while (page.next) {
  page = await listed(page.next);
  tools.push(...screenRows(page));
  // The workspace holds this one list: it is changed in place, as the signed-in page does (main.tsx).
  offered.splice(0, offered.length, ...offeredScreens(viewer, tools));
  showRecords({ [surfaces.address_label]: offered });
  workspace.reoffer(offered, { catalogComplete: !page.next });
}
