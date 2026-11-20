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
import { setLiveChangesOffered } from '../src/workspace/store-changes';
import { setSavedViewsOffered } from '../src/workspace/record-configurations';

type ScreenModule = { mount: (element: HTMLElement, props: Record<string, unknown>) => ReturnType<WarmMount> };

const host = readHostConfig();
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
installScreenRunner(screens, LIST);

mountSidebar({ el: document.getElementById('sidebar')!, props: { surfaceInput: {
  scope: host.placement,
  persist_collection_edits: true,
  placeable_surface_list_address_label: LIST,
} } });
mountArrangement({ el: document.getElementById('arrangement')!, props: {
  placeableSurfaceListAddressLabel: LIST,
  surface_collections_scope: host.placement,
  persist_collection_edits: true,
  surface_intent_destination_ref: `destination:${host.placement}`,
  // A screen opened from another screen (a lesson from the course list) is not one of the sidebar's entries: its tab is kept.
  tabsOutsideCatalog: 'keep',
} });
