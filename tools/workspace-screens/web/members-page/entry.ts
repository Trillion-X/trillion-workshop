// tools/workspace-screens/web/members-page/entry.ts
//
// PURPOSE
//   The generic members page for any site: the Workshop's own workspace (the sidebar from tools/sidebar, the screen arrangement
//   from tools/screen-arrangement) for the person the host says is signed in. The sidebar's entries are the placeable-surface rows
//   the host's records source holds for this page's placement; each entry opens the screen module its row names, mounted with
//   the row's own input and the host values that row names. Nothing here names a screen, a site or a word.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Who is signed in comes from the host before anything is read or drawn; a person who is not signed in goes to the sign-in.
//   2. The screens are the screen modules the build carries (members-screen-registry, built from the rows' packages), keyed
//      as the rows name them. No screen is written here.
//   3. A screen gets only its row's input and the host values that row names (rows.mjs screenInputOf).

import './members-page.css';
import '../src/workspace/workspace.css';
import { remoteRecordsSource, setWorkspaceRecordsSource } from '../src/workspace/records-source';
import { setRecordsDoor } from '../src/workspace/records-door';
import { answerTargets } from '../src/workspace/targets';
import { installScreenRunner } from '../src/workspace/screen-runner';
import type { WarmMount } from '../src/workspace/lazy-screen';
import mountSidebar from '../../../sidebar/show/mount-sidebar';
import mountArrangement from '../../../screen-arrangement/show/mount-screen-arrangement';
import { SCREEN_MODULES } from 'members-screen-registry';
import { doorTransport, readHostConfig, recordsTransport, subjectOf } from './host';
import { screenInputOf } from './rows.mjs';
import { sidebarCollections, type ScreenRow, type SidebarListsData } from '../src/workspace/sidebar-lists';
import { activeRecordsSource } from '../src/workspace/records-source';
import { setLiveChangesOffered } from '../src/workspace/store-changes';
import { setSavedViewsOffered } from '../src/workspace/record-configurations';
import { applyChosenScreenLook } from '../../../screen-look/show/apply-chosen-screen-look';
import looks from '../src/workspace/looks.json';

type ScreenModule = { mount: (element: HTMLElement, props: Record<string, unknown>) => ReturnType<WarmMount> };

const host = readHostConfig();
// The page wears a look as the workspace does (src/workspace/main.tsx): its tokens on the root and the bridges on the body, so
// every shared part draws its edges, grounds and muted words in the look's colours instead of the browser's black.
applyChosenScreenLook(looks.themes, looks.themes.some(row => row.payload?.id === host.look) ? host.look! : looks.start_with);
// The members page has no Worker: no live channel (/work/live) and no saved configurations (/work/api/configurations), so it asks for
// neither. Its screens keep what they show from the host's answers.
setLiveChangesOffered(false);
setSavedViewsOffered(false);
const hostValues = await subjectOf(host);
const LIST = `placeable-surface-list::${host.placement}`;

// Each screen module the build carries, under the key its rows name it by.
const screens: Record<string, WarmMount> = Object.fromEntries(
  Object.entries(SCREEN_MODULES as Record<string, ScreenModule>).map(([key, module]) => [key, (element, props) => {
    const input = screenInputOf(props.surfaceInput as Record<string, unknown> | undefined, hostValues);
    return module.mount(element, { ...input, surfaceInput: input });
  }]),
);

setWorkspaceRecordsSource(remoteRecordsSource(recordsTransport(host)));
setRecordsDoor(doorTransport(host));
await answerTargets();

// The list definitions and the rows that name them, read from the host's records under the labels the host block gives.
async function membersLists(): Promise<unknown> {
  const read = await activeRecordsSource().read([host.lists, LIST]);
  const surfaces = (read.records?.[host.lists] ?? {}) as SidebarListsData;
  // The catalog rows arrive as { record, payload }; the builder reads each screen row as its payload (id, label, sidebar_collection).
  const rows = ((read.records?.[LIST] ?? []) as { payload: ScreenRow }[]).map(entry => entry.payload);
  // The graph is keyed under this page's sidebar scope, the one the sidebar below reads (scope: host.placement).
  return sidebarCollections(rows, surfaces, host.placement, undefined, host.placement);
}
installScreenRunner(screens, LIST);

// The sidebar's lists come from the host's rows: the list definitions (the host's `lists` label) and each row's `sidebar_collection`
// name them, built by the owner of that rule (sidebar-lists.ts sidebarCollections), as the Workshop's own page builds its lists. The
// members page keeps no list and no word of its own.
const lists = await membersLists();
mountSidebar({ el: document.getElementById('sidebar')!, props: { surfaceInput: {
  scope: host.placement,
  // A member cannot make a list here: the 'Add a list' control is not drawn (the sidebar's own switch).
  hide_collection_manager: true,
  placeable_surface_list_address_label: LIST,
  surface_collections_graph: lists,
} } });
mountArrangement({ el: document.getElementById('arrangement')!, props: {
  placeableSurfaceListAddressLabel: LIST,
  surface_collections_scope: host.placement,
  persist_collection_edits: true,
  surface_intent_destination_ref: `destination:${host.placement}`,
  // A screen opened from another screen (a lesson from the course list) is not one of the sidebar's entries: its tab is kept.
  tabsOutsideCatalog: 'keep',
} });
