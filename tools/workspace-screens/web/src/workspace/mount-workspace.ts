// src/workspace/mount-workspace.ts
//
// NO PRIOR: moved out of src/workspace/main.tsx, where the signed-in page composed its workspace inline, so the same
// workspace can be drawn wherever Trillion is shown whole: the signed-in page, and an AI app's chat (screen-view.tsx,
// when the person asks to see Trillion itself).
//
// PURPOSE
//   One Trillion workspace inside `root`: the person's look, the shared sidebar with its lists (and what fills them:
//   the files tree, the send-actions tree, the AI's notes, the person's row colours, the rule-filled lists), the focus
//   switcher at the sidebar's top, and the shared screen arrangement the sidebar opens screens in.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One composition: every place that shows the whole workspace calls this; none composes its own sidebar or
//      arrangement, so a list, a keeper or an arrangement setting added here reaches every one of them.
//   2. Nothing here names a screen, a list or a person: which screens and lists exist is surfaces.json and the
//      person's records, handed in as `offered` and read by the shared parts.
//   3. The workspace draws into `root` only. Where `root` sits and how tall it is belongs to its host (the page fills
//      the window, a chat's view gives it its own box: workspace.css).
//   4. Opening a screen is the shared placeable-surface request the arrangement answers (open-screen.ts); this module
//      hands back `open` for hosts that turn an address into an open.

import mountSidebar from '../../parts/sidebar/show/mount-sidebar';
import mountArrangement from '../../parts/screen-arrangement/show/mount-screen-arrangement';
import mountScreenLook from '../../parts/screen-look/show/mount-screen-look-surface';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import { sidebarCollections } from './sidebar-lists';
import { keepSidebarNotes } from './sidebar-notes';
import { showChanged } from '../../parts/ui/show/show-rules/show-of';
import { keepSidebarLooks, SCREEN_SUBJECT } from './sidebar-looks';
import { keepSidebarRules } from './sidebar-rules-live';
import { keepListRuleRows } from './list-rules';
import { APP_FOCUS_NODE, focusPathFor, loadScopeFocus, scopeFocus } from './scope-focus';
import { setNodeRulePath, setNodeRuleStore } from '../../parts/ui/show/rule-filter/focus-records';
import { useWindowArrangement } from './screen-own-arrangement';
import focusWords from './focus.json';
import starterLayouts from './starter-layouts.json';
import surfaces from './screens.mjs';
import { showRecords } from './records';
import { createScreenCatalogPresence } from './screen-catalog.mjs';

type Row = Record<string, unknown>;

/** The app's own name, from its screens list's address (`placeable-surface-list::<app>`): the sidebar's list scope and
 *  the prefix of its lists' ids, the same name the Worker's sidebar (src/sidebar.mjs) reads them by. */
export const HOST_PACKAGE = String(surfaces.address_label).split('::').at(-1) as string;

/** Asks the arrangement to open `surface` (a screen row, or `{ id, surfaceInput }`); true when it took the request. */
export function openSurface(surface: Row): boolean {
  const request = new CustomEvent(PLACEABLE_SURFACE_MIME, { detail: surface, cancelable: true });
  window.dispatchEvent(request);
  return request.defaultPrevented;
}

/** Opens `wanted` one after another, in order, so each becomes its own tab and the last one asked for is the one
 *  showing. The arrangement starts listening a moment after it mounts, so a request it has not taken yet is asked
 *  again on the next frame (for about five seconds), and the next is asked once the arrangement drew the one before. */
export function openScreens(wanted: Row[]): void {
  const left = [...wanted];
  let tries = 0;
  const ask = () => {
    if (!left.length) return;
    if (openSurface(left[0])) { left.shift(); tries = 0; requestAnimationFrame(() => requestAnimationFrame(ask)); return; }
    if (++tries < 300) requestAnimationFrame(ask);
  };
  ask();
}

export type Workspace = {
  /** The sidebar's host element (the page warms a screen's code when it is pointed at there). */
  sidebar: HTMLElement;
  /** Draws the sidebar's lists again from the screens now offered (a pursuit or a tool's screen came or went). */
  reoffer(offered: Row[], options?: { catalogComplete?: boolean }): void;
};

/** Draws the whole workspace into `root` for the screens `offered` (offered-screens.ts, already started as records). */
export function mountWorkspace(root: HTMLElement, offered: Row[], options: { catalogComplete?: boolean } = {}): Workspace {
  // The catalog arrives in pages. A saved row never offered here is unknown until all sources answer; a row
  // withdrawn from an accepted offer is known unavailable at once. Top-level and nested panes hear the same state.
  const catalogStateAddressLabel = `${surfaces.address_label}::catalog-state`;
  const presence = createScreenCatalogPresence(offered, options.catalogComplete ?? true);
  let shownCatalogState: ReturnType<typeof presence.state> | undefined;
  const showCatalogState = (state = presence.state()) => {
    if (shownCatalogState === state) return;
    shownCatalogState = state;
    showRecords({ [catalogStateAddressLabel]: state });
  };
  showCatalogState();
  setNodeRuleStore(scopeFocus);
  setNodeRulePath((nodes, own) => nodes.length ? [...focusPathFor(nodes[0], own).slice(0, -1), ...nodes.slice(1), own] : [APP_FOCUS_NODE, own]);
  const look = document.createElement('div');
  look.hidden = true;
  const sidebar = document.createElement('div');
  sidebar.className = 'trillion-workspace-sidebar';
  const arrangement = document.createElement('div');
  arrangement.className = 'trillion-workspace-arrangement';
  root.append(look, sidebar, arrangement);
  // The chosen look paints the whole page, and the record views and controls read it too (screen-look look-bridges.css).
  document.body.classList.add('screen-look-page');
  mountScreenLook({ el: look, props: {} });
  // The sidebar lists this workspace fills with its own panel (surfaces.json sidebar_content_host_by_section_id names
  // the list and the host); a host another part fills, like the arrangement's pane map, is not named here. Each filler
  // is its own file, fetched once the workspace has started, so the first screen never waits for a sidebar list.
  const contentFillers: Record<string, (hostId: string) => void> = {
    'files-tree': hostId => { void import('./files-tree').then(module => module.keepFilesTree(hostId)); },
    'send-actions-tree': hostId => { void import('./send-actions-tree').then(module => module.keepActionsTree(hostId)); },
  };
  for (const hostId of Object.values(surfaces.sidebar_content_host_by_section_id as Record<string, string>)) contentFillers[hostId]?.(hostId);
  // The person's lists, one projection both the sidebar and the arrangement read (a pane's chevron shows the sidebar,
  // and an empty pane its Folders, from the same source).
  const lists = sidebarCollections(offered.map(row => showChanged(SCREEN_SUBJECT, row)), surfaces, HOST_PACKAGE);
  mountSidebar({ el: sidebar, props: { surfaceInput: {
    scope: HOST_PACKAGE,
    persist_collection_edits: true,
    content_host_by_section_id: surfaces.sidebar_content_host_by_section_id,
    header_content_host: surfaces.sidebar_header_content_host,
    surface_collections_graph: lists,
    placeable_surface_list_address_label: surfaces.address_label,
  } } });
  // The notes the person's AI leaves on lists and rows (src/sidebar.mjs note_in_sidebar), drawn on them live.
  keepSidebarNotes(offered, row => { openSurface(row); });
  // The colour and place the person (or their AI, change_sidebar style) gave a row, laid over the app's row.
  keepSidebarLooks(offered, surfaces.address_label);
  // The lists a rule fills (what is new, what a rule picks out), decided by the formula engine and kept current.
  const sidebarRules = keepSidebarRules(offered, surfaces, HOST_PACKAGE, lists as object);
  // The rows the person's own lists decide their rules over (list-rules.ts).
  keepListRuleRows(offered);
  // What the whole workspace is about, at the top of the sidebar (surfaces.json sidebar_header_content_host): the
  // person's focus, saved as their scope (scope-focus.ts) and applied to every list read (api.ts). It is read at once so
  // the first lists already narrow; the switcher's code is fetched after the workspace is drawn, so the first open does
  // not carry the rule editor.
  const focusRead = loadScopeFocus();
  void Promise.all([import('../../parts/ui/show/rule-filter/FocusEditor'), import('trillion-workshop/tools/formula-engine/rules/rule-operators.json')]).then(([{ mountFocusEditorInto }, operators]) => {
    const opens = focusWords.opens.map(row => ({ id: row.id, label: row.label, icon: row.icon, open: () => { window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { id: row.screen } })); } }));
    const focus = mountFocusEditorInto(surfaces.sidebar_header_content_host, { nodeId: APP_FOCUS_NODE, operators: operators.default as never, store: scopeFocus, fields: [], words: focusWords.words, opens });
    void focusRead.then(chosen => focus.update(chosen), () => {});
  }, () => {});
  const arrangementProps = {
    placeableSurfaceListAddressLabel: surfaces.address_label,
    surface_collections_scope: HOST_PACKAGE,
    surface_collections_graph: lists,
    persist_collection_edits: true,
    visiblePlaceableSurfaceIds: { default: surfaces.open_at_start },
    surface_intent_destination_ref: `destination:${HOST_PACKAGE}`,
    // Unknown saved tabs wait for complete tool pages and conversations; explicitly withdrawn owners close at once.
    tabsOutsideCatalog: 'close',
    catalogStateAddressLabel,
    starterLayouts,
  };
  // A screen arranged in place is this same arrangement, nested, offered the same screens, lists and layouts.
  useWindowArrangement(arrangementProps);
  mountArrangement({ el: arrangement, props: arrangementProps });
  return {
    sidebar,
    reoffer: (updated, next = {}) => {
      showCatalogState(presence.reoffer(updated, next.catalogComplete));
      sidebarRules.reoffer(updated);
    },
  };
}
