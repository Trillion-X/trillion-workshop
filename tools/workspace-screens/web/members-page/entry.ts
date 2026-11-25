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
import * as pageLists from '../src/workspace/list-records';
import { setListSource } from '../../../keep-lists-of-rows/read-data/list-source';
import { answerTargets } from '../src/workspace/targets';
import { installScreenRunner } from '../src/workspace/screen-runner';
import type { WarmMount } from '../src/workspace/lazy-screen';
import mountSidebar from '../../../sidebar/show/mount-sidebar';
import mountArrangement from '../../../screen-arrangement/show/mount-screen-arrangement';
import { SCREEN_MODULES } from 'members-screen-registry';
import { customPropertiesOf, doorTransport, readHostConfig, recordsTransport, subjectOf } from './host';
import { screenInputOf, tourDefinitionsOf } from './rows.mjs';
import { sidebarCollections, type ScreenRow, type SidebarListsData } from '../src/workspace/sidebar-lists';
import { activeRecordsSource } from '../src/workspace/records-source';
import { setLiveChangesOffered } from '../src/workspace/store-changes';
import { setSavedViewsOffered } from '../src/workspace/record-configurations';
import { keepRecordViewPreferencesOnThisPage } from '../../../ui/show/record-views/record-view-preferences';
import { readSavedLabels } from '../src/workspace/records';
import { keepShowRules } from '../src/workspace/show-rules-live';
import { applyChosenScreenLook } from '../../../screen-look/show/apply-chosen-screen-look';
import { offerScreensFrom } from '../src/workspace/open-screen';
import { useWindowArrangement } from '../src/workspace/screen-own-arrangement';
import { applyScreenLookValues } from '../../../screen-look/show/ApplyCurrentScreenLook';
import looks from '../src/workspace/looks.json';
import mountWalkthroughHost from '../../../guided-overlay/show/mount-walkthrough-host';
import { emitWalkthroughEventWhenHostReady } from '../../../guided-overlay/show/walkthroughs';
// Every list's view switch offers visual-database's views, and the designed views (chat, feed, forum, and the rest), as the
// workspace's own page offers them (src/workspace/main.tsx): a list's views are the same on both pages.
import '../../../keep-lists-of-rows/show/offer-views-to-every-list.tsx';
import '../../../ui/show/record-views/designs/offer-designed-views';

type ScreenModule = { mount: (element: HTMLElement, props: Record<string, unknown>) => ReturnType<WarmMount> };

const host = readHostConfig();
// The page wears a look as the workspace does (src/workspace/main.tsx): its tokens on the root and the bridges on the body, so
// every shared part draws its edges, grounds and muted words in the look's colours instead of the browser's black.
applyChosenScreenLook(looks.themes, looks.themes.some(row => row.payload?.id === host.look) ? host.look! : looks.start_with);
// The site's own look over it, the one its sign-in page wears (host.site_look): the same tokens, set through the same setter, so
// they win over the workspace look above and the shared buttons take the site's colours.
if (host.site_look) applyScreenLookValues(host.site_look.id, customPropertiesOf(host.site_look.css));
// The members page has no Worker: no live channel (/work/live) and no saved configurations (/work/api/configurations), so it asks for
// neither. Its screens keep what they show from the host's answers.
setLiveChangesOffered(false);
setSavedViewsOffered(false);
// The page keeps each list's view choice on the page and the device, with no account store behind it (no save error).
keepRecordViewPreferencesOnThisPage();
const hostValues = await subjectOf(host);
const LIST = `placeable-surface-list::${host.placement}`;

// Each screen module the build carries, under the key its rows name it by.
const screens: Record<string, WarmMount> = Object.fromEntries(
  Object.entries(SCREEN_MODULES as Record<string, ScreenModule>).map(([key, module]) => [key, (element, props) => {
    const input = screenInputOf(props.surfaceInput as Record<string, unknown> | undefined, hostValues);
    // The frame the pane gives its screen (PlaceableSurfaceHost's floating_frame: inline, or fill) passes through: without it a
    // screen drawn in FloatingMaterialFrame takes the fixed, floating frame and shrinks to its content.
    return module.mount(element, { ...input, surfaceInput: input, floating_frame: props.floating_frame });
  }]),
);

setWorkspaceRecordsSource(remoteRecordsSource(recordsTransport(host)));
setRecordsDoor(doorTransport(host));
// The lists the page keeps are the records its door answers (list-records.ts), not the person's own database tables.
setListSource(pageLists);
await answerTargets();
// The person's show rules are the `show-rules` record the host's records source answers for them, read as the workspace reads
// it (src/workspace/main.tsx keepShowRules). They decide every control the sidebar and the arrangement draw (controls.json) and the
// arrangement's limits (its `constraints`). A host that answers no record shows every control, as the workspace does with no rules.
await readSavedLabels(['show-rules']);
await keepShowRules({ rules: [] });

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
// The arrangement's own props, given to every screen's own arrangement too (src/workspace/screen-own-arrangement.ts), so a
// screen made of screens (a home whose row holds `surface_input.arrangement`) opens its pieces from this page's rows and
// each piece can be arranged in turn, kept per person at screen-arrangement-of::<screen>.
const arrangementProps = {
  placeableSurfaceListAddressLabel: LIST,
  surface_collections_scope: host.placement,
  persist_collection_edits: true,
  surface_intent_destination_ref: `destination:${host.placement}`,
  // A screen opened from another screen (a lesson from the course list) is not one of the sidebar's entries: its tab is kept.
  tabsOutsideCatalog: 'keep',
  // What an empty pane opens on: the rows the host names (its home), never a blank panel.
  empty_container_surface_ids: host.start ?? [],
};
offerScreensFrom(LIST);
// A screen's own arrangement opens no home in its empty pieces: the home is the window's start, not every pane's.
useWindowArrangement({ ...arrangementProps, empty_container_surface_ids: [] });
mountArrangement({ el: document.getElementById('arrangement')!, props: arrangementProps });

// The person's own tours: the walkthrough-definition records the host answers under its `tours` label, run over this page by the
// Workshop's tour host (tools/guided-overlay), which draws nothing until one starts. The page says it opened (first-use-ready), so a
// tour whose trigger waits for that starts once, and the person's progress is kept through the host's records like any other record.
// A host that names no label, or answers none, runs no tour.
async function mountOwnTours(label: string): Promise<void> {
  const read = await activeRecordsSource().read([label]);
  const definitions = tourDefinitionsOf(read.records?.[label]);
  if (!definitions.length) return;
  // Whether a tour that starts by itself shows is the person's show rules (keepShowRules above): the host asks them first.
  const el = document.createElement('div');
  el.hidden = true;
  document.body.append(el);
  mountWalkthroughHost({ el, props: { definitions } });
  emitWalkthroughEventWhenHostReady({ event_kind: 'first-use-ready' });
}
if (host.tours) void mountOwnTours(host.tours).catch(error => console.warn('The tours could not be read.', error));
