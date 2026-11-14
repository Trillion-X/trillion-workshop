// src/workspace/main.tsx
//
// PURPOSE
//   The signed-in Trillion workspace: the shared sidebar lists every screen this app offers, the shared screen
//   arrangement holds them in tabs and panes (drag a tab to another pane, split, rearrange), and each screen is one of
//   this app's own (Files and one opened file, Decisions, Workflows and one workflow's graph, Funnels and one funnel, the Workshop and one tool or run, Shared spaces, Community, Progress, the guides). What the app offers is DATA in surfaces.json; what the
//   person arranged is their own saved records, read once before anything mounts (records.ts).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a shared screen's internals: the sidebar and arrangement decide from DATA and records.
//   2. A screen is mounted by its entry name through `screens`; an entry this app does not have says so in words.
//   3. A fresh account (no saved arrangement) opens on Files, the person's main work surface; Get started is the
//      sidebar's first row.
//   4. The page never writes markup: every element is a shared component, or an empty host a shared component fills.
//   5. Tours are DATA (walkthroughs/*.json): the page mounts their host; the person starts a tour from Tours.
//   6. Connecting the person's AI is a step of the welcome tour (walkthroughs/first-run.json), the one place it is done:
//      the tour starts on a new account's first screen, and anything that needs an AI opens that step (ai-connection.ts).
//   7. The first reads are answered from the copies kept on this device when there are any (api.ts, kept-answers.ts),
//      so a returning open draws at once whatever the store's speed; when the store answers one differently it is
//      taken in place (the person's records, the screens offered), never by drawing the page again.
//   8. Until the workspace is drawn, the thread cover the page's first bytes painted (parts/ui/show/thread-cover) stays
//      over the whole window; it lifts once the open screens show their real content (words, none still loading), at
//      most `COVER_MOST_MS` after the workspace started, and lifts to say plainly, with Try again, when the workspace
//      cannot open. What moves behind the whole page shows only once the cover has finished dissolving. Whatever the
//      reads are doing, the cover lifts at the latest `COVER_OVERALL_MS` after the page started (opening-cover.mjs),
//      onto what is drawn: a screen still reading shows its own loading state, and the workspace not drawn yet shows a
//      plain "still opening" note until it is. The cover lifts once, and the page is marked open after that lift.
//   9. No first read can hold the page: every read gives up after api.ts READ_MOST_MS, a read that only adds rows (the
//      pursuits, the tools' screens) opens the page without them, and one the page cannot open without (the person's
//      records, who they are) lifts the cover to say so with Try again.

import { installTitleTooltips } from '../../parts/ui/show/tooltip/title-tooltips';
import { installCopyGuard } from '../../parts/ui/show/clipboard/copy-guard';
import { personalHoldApplies } from 'trillion-workshop/tools/set-up-my-account/read-data/personal-hold.mjs';
import { installMenuRows } from './menu-rows';
import { registerSoundTargets } from '../../parts/ui/show/sound-signal/sound-targets';
import { markPageOpen, whenPageOpen } from '../../parts/ui/show/page-backdrop';
import { followLights } from '../../parts/ambience/show/sound-followers';
import { watchSteps } from '../../parts/ui/show/recent-steps';
import { tellFramingPageReady } from '../../parts/ui/show/live-frame/live-frame-ready.mjs';
// Every list's view switch also offers visual-database's views (timeline, swimlanes, outline, tree, summary).
import '../../parts/keep-lists-of-rows/show/offer-views-to-every-list.tsx';
// The board's Draw design first, so the designed views offer its row (the design must be known when they are).
import './offer-draw-design';
// ...and the designed views (chat, feed, rows, and every layout a person kept for every list).
import '../../parts/ui/show/record-views/designs/offer-designed-views';
// ...and the Chart view, so a saved view drawn as a chart draws the same in the page and in a chat.
import './offer-chart';
import './keep-record-view-preferences';
// ...and the row that opens a screen in the Trillion Mac app when the Mac helper says the app is on this computer.
import { offerOpenInMacApp } from './open-in-mac-app';
import { mountScreenState } from '../../parts/ui/show/screen-state';
import { watchIntent } from '../../parts/ui/show/intent-prefetch';
import { publishUnsavedWork } from './unsaved-work';
import { publishQuitQuestion } from './quit-question';
import { failedState } from './failure';
import { screens } from './screen-mounts';
import { goTo } from './open-screen';
import { mountWorkspace, openScreens, openSurface } from './mount-workspace';
import { installScreenRunner, type Around } from './screen-runner';
import surfaces, { screenOpenedEvent } from './screens.mjs';
import { replaceWorkspaceAddress, screenAt, screensAtAddress } from './addresses.mjs';
import { takeSpaceInviteAfterCheckout } from './pending-space-invite.mjs';
import { offeredScreens, startScreenRecords, type ScreenRow as Row } from './offered-screens';
import { onPartsChange, partsOf } from './pursuit-parts';
import { createScreenCatalog, pursuitRowsOf, SCREEN_CATALOG_CONVERSATIONS_EVERY_MS, screenCatalogWords } from './screen-catalog.mjs';
import { aloneRow, startAlone } from './alone-page';
import { AI_MESSAGES, onStoreChange } from './store-changes';
import { addressLabelForInput, readStartupRecords, showRecords, takeStartupRecords } from './records';
import { startupRecordsPath } from './startup-records.mjs';
import { answerTargets } from './targets';
import { PlanNeeded, readJson, warmReads } from './api';
import { WAIT_MOST_MS, feltFrom, panesShown, screenShown } from './felt-speed';
import { onKeptAnswerReplaced, readWithKeptAnswers } from '../../parts/ui/show/request/kept-answers';
import { coverLifting } from './opening-cover.mjs';
import { showOf } from '../../parts/ui/show/show-rules/show-of';
import firstAnswers from './first-answers.json';
import looks from './looks.json';
import { applyChosenScreenLook } from '../../parts/screen-look/show/apply-chosen-screen-look';
import { readSignedOutScreenLook } from '../../parts/screen-look/read-data/read-current-screen-look';
import inputs from './inputs.json';
import failureWords from './failure-words.json' with { type: 'json' };
import takeMeThere from '../take-me-there.json';
import { keepCatchUp } from 'trillion-workshop/tools/keep-copies-in-step/web/src/workspace/catch-up.tsx';
import { keepMeetingRecordingTriggers } from './meeting-recording-runtime';
import { keepShowRules, type AppliedShowRules } from './show-rules-live';
import { notify } from '../../parts/ui/show/coss/notifications';
import { readOnlyPage } from './quiet-writes';
import { emitWalkthroughEventWhenShown } from '../../parts/guided-overlay/show/walkthrough-events';
import type { HostEvent } from '../../parts/guided-overlay/engine/trigger-intake';
import { chooseStillWorkingWords } from '../../parts/ui/show/still-working/still-working';
import homeWords from '../home-words.json';
import { installLeaveGuard } from './leave-blockers';

// The row on a screen's ⋯ menu that opens it in the Trillion Mac app when one is here (open-in-mac-app.ts).
offerOpenInMacApp();

// The tour host mounts after the page has started (below), so asking it for a tour loads the tours' code then too.
const emitWalkthroughEventWhenHostReady = (detail: HostEvent) => {
  void import('../../parts/guided-overlay/show/walkthroughs').then(tours => tours.emitWalkthroughEventWhenHostReady(detail));
};

// The arrangement asks the page's on-screen runner (screen-runner.ts) to put each screen in a pane; this page times
// each screen and tells its tour when it shows. No examples strip heads a screen: its read (/work/api/examples) has no
// owner in the engine (macos/release.json route_owner_gate.retired).
// Whether the page has shown its first screens (felt-speed.ts `opening`): a screen opened after it is timed on its own.
let opened = false;
const aroundScreen: Around = (element, { entry, input }, mount) => {
  // How long the person waits for a screen they open, from now until it shows its content (felt-speed.ts); the screens
  // the page opens with are timed as the opening itself.
  const startedAt = performance.now();
  let stopFelt = () => {};
  const timed = (host: HTMLElement) => {
    const unmountScreen = mount(host);
    if (opened) stopFelt = feltFrom('screen-open', startedAt, () => screenShown(host), element.dataset.trillionScreen ?? entry);
    return unmountScreen;
  };
  const unmount = timed(element);
  const stopTour = emitWalkthroughEventWhenShown(element, screenOpenedEvent(entry, input));
  return () => { stopFelt(); stopTour(); unmount(); };
};

// The screens this page's address asks for, as open requests, among the screens this person is offered
// (addresses.mjs, the same resolution the Worker answers the address with): an exact `route_paths` match opens the
// screen itself, an address under its `route_prefix` opens it with that rest as its `route_input` (one decision per tab),
// and each query field a screen's `route_query` names selects that screen with its input. A query about the path's
// screen selects that same copy; a meeting link on a list opens Record beside the list. They open after the person's
// saved arrangement, so the address is what shows.
type Asked = { row: Record<string, unknown>; input: Record<string, string> | null };
// One read of the tools' screens: a page of them, and `next` while more of the person's own are left (first-answers.json).
type ToolScreens = { surfaces: Row[]; next?: string | null };
type ToolScreensRead = { value: ToolScreens } | { error: unknown };
type PursuitsRead = { value: Record<string, unknown>[] } | { error: unknown };
const openRequest = ({ row, input }: Asked): Record<string, unknown> =>
  (input ? { id: row.id, surfaceInput: { ...(row.surface_input as Record<string, unknown> | undefined), ...input } } : row);
// When the path opened a screen too, each query's screen opens beside it (on a phone, where panes stack, it opens in
// place and the path's screen stays one tab back).
function routedOpen(offered: Record<string, unknown>[]): Record<string, unknown>[] {
  const routed = screenAt(offered, location.pathname) as Asked | null;
  return (screensAtAddress(offered, location.pathname, location.search) as Asked[])
    .map((asked, index) => {
      const request = openRequest(asked);
      return routed && index > 0 ? { ...request, placement: 'right' } : request;
    });
}

async function start() {
  // Every long wait on this page (a pressed button, a screen loading) says it is still working in these words.
  chooseStillWorkingWords(homeWords.still_working);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/trillion-share-worker.js', { scope: '/' }).catch(() => {});
  installScreenRunner(screens, surfaces.address_label, aroundScreen);
  // Every tool that carries its own screen is a screen here too (src/work-workshop.mjs toolSurfaces); an account whose
  // plan has no Workshop simply has none.
  // These first reads came with the page (first-answers.json), so none of them waits for a request, and each is
  // answered at once from the copy kept on this device when there is one (invariant 7). A copy the store answers
  // differently is heard from now on, even before the page is drawn, and taken once it is (takeReplaced below).
  const firstPaths = firstAnswers.paths;
  const replacedEarly = new Set<string>();
  let takeReplaced = (path: string) => { replacedEarly.add(path); };
  onKeptAnswerReplaced(path => takeReplaced(path));
  // The tools' own screens are offered when they arrive: a plan without the Workshop is refused them, and a refusal is
  // never kept, so waiting on them would hold every open of such an account on the store.
  // Appearance and arrangement must come from the current answer, before cached screen reads are welcome.
  const startup = readStartupRecords();
  const [[saved, firstViewer, pursuitRead, toolRead, showRules]] = await Promise.all([
    readWithKeptAnswers(() => Promise.all([
      startup,
      readJson<{ access_refs: string[]; throwaway?: boolean }>(firstPaths.viewer),
      // Pursuits only add sidebar rows. Start their read with the others, then let the catalog take its answer
      // after the page draws, even when the store has not answered yet.
      { read: readJson<unknown>(firstPaths.pursuits).then((answer): PursuitsRead => ({ value: pursuitRowsOf(answer) }), (error): PursuitsRead => ({ error })) },
      // Keep an unavailable catalog distinct from a successful empty one, without waiting for this read to draw.
      { read: readJson<ToolScreens>(firstPaths.tool_screens).then((value): ToolScreensRead => ({ value }), (error): ToolScreensRead => ({ error })) },
      readJson<AppliedShowRules>(firstPaths.show_rules, { cache: 'no-store' }),
    ])),
    answerTargets(),
  ]);
  let viewer = firstViewer;
  // A kept first answer may predate a newly deployed viewer field. Reconcile again when the server replaces it.
  let reconcilePersonalHold = () => {};
  // Someone looking at this Trillion by its owner's leave (src/view-as.mjs) is told whose it is, that it is read only,
  // and has the way back to their own until they take it.
  const looking = (firstViewer as { looking?: { said: string; stop: string; stop_address: string } }).looking;
  if (looking) readOnlyPage();
  if (looking) notify(looking.said, { kind: 'info', timeout: 0, key: 'looking', actions: [{ id: 'stop-looking', label: looking.stop, onAction: () => location.assign(looking.stop_address) }] });
  // Already answered (from this device or the store) when the rest were: offered now; otherwise offered once it comes.
  const toolNow = await Promise.race([toolRead.read, Promise.resolve(null)]);
  const pursuitNow = await Promise.race([pursuitRead.read, Promise.resolve(null)]);
  const toolScreens = toolNow && 'value' in toolNow ? toolNow.value : { surfaces: [] };
  const firstPursuits = pursuitNow && 'value' in pursuitNow ? pursuitNow.value : [];
  // Which screens this person is offered (offered-screens.ts).
  const offered: Row[] = offeredScreens(viewer, toolScreens.surfaces, firstPursuits, [], partsOf);
  // The tray picks from what the pointer is over and adds its two rows to the right-click menu; its code arrives
  // while the first screens draw, since nothing is picked before then.
  void import('./tray').then(({ startTray }) => startTray(offered));
  // The app's DATA first (its screens, its looks, the look a new account starts with), then the person's own records.
  await startScreenRecords(offered, saved);
  // Assigned profiles are current before the first workspace paint, including a page opened on one screen.
  await keepShowRules(showRules);
  // A screen whose row asks to be shown alone (a host app's small window, such as the Mac menu bar panel) fills the
  // page by itself, with no sidebar or arrangement (alone-page.tsx).
  // A link that names a layout or a tour (?layout=<id>&tour=<id>: a take-me-there notice, a changelog entry's Show me,
  // an email, a docs page; field names in src/take-me-there.json) opens the layout through the same ask an AI's
  // open_layout writes, shown on this page only, and starts the tour once the tours are ready; the address then drops
  // the names, so a reload does not do it again.
  const linked = new URL(location.href);
  const linkedLayout = linked.searchParams.get(takeMeThere.link.layout);
  const linkedTour = linked.searchParams.get(takeMeThere.link.tour);
  if (linkedLayout || linkedTour) {
    linked.searchParams.delete(takeMeThere.link.layout);
    linked.searchParams.delete(takeMeThere.link.tour);
    replaceWorkspaceAddress(history.state, `${linked.pathname}${linked.search}${linked.hash}`);
  }

  // Resolve an existing ordinary hold before the page or its automatic welcome tour paints.
  // Get started keeps its own checked status; independently admitted work does not await it.
  const holdModule = personalHoldApplies(viewer) ? await import('./needs-you-hold') : null;
  const initialHold = await holdModule?.readInitialPersonalHold();
  const mountPersonalHold = holdModule ? (beneath: HTMLElement) => holdModule.mountNeedsYouHold(beneath, initialHold) : undefined;
  const alone = aloneRow(offered, location.pathname, location.search);
  if (alone) { dropOpeningNote(); await startAlone(alone, offered, mountPersonalHold); return; }
  const root = document.createElement('div');
  root.className = 'trillion-workspace';
  root.hidden = Boolean(initialHold);
  dropOpeningNote();
  // The tours (src/workspace/walkthroughs/*.json) run over every screen; their host draws nothing until one starts.
  const tours = document.createElement('div');
  tours.hidden = true;
  root.append(tours);
  document.body.prepend(root);
  // The look, the sidebar with its lists and the arrangement: the one workspace every whole Trillion draws
  // (mount-workspace.ts), the same one an AI app's chat shows when the person asks to see Trillion.
  const workspace = mountWorkspace(root, offered, { catalogComplete: false });
  const initialPersonalHold = mountPersonalHold?.(root);
  await initialPersonalHold?.ready;
  root.hidden = false;
  // How long opening Trillion took for the person, from the page's first request until its screens show (felt-speed.ts).
  // A screen opened after that is timed on its own.
  feltFrom('opening', 0, () => (opened = panesShown()));
  setTimeout(() => { opened = true; }, WAIT_MOST_MS);
  // The bell is not filled from /work/api/notifications or /work/api/tell/notices at the start: the engine has no owner
  // for either (macos/release.json route_owner_gate.retired), so the page asks neither (test/boot-reads-have-owners.test.mjs).
  // Whether every copy is in step (catch-up.tsx): this device's waiting changes and the person's devices, shown on the
  // Your devices row, in every pane's ⋯ menu, as the bell's running line and on any record kept as two versions.
  keepCatchUp();
  // The recorder observes native input transitions through its own live source;
  // account preferences remain in the ordinary saved-record owner.
  keepMeetingRecordingTriggers(() => !(viewer as { looking?: unknown; throwaway?: boolean }).looking
    && !(viewer as { throwaway?: boolean }).throwaway);
  // The person's connected lights can follow anything that moves with sound (a background behind the panes, Ambience).
  registerSoundTargets(followLights);
  // The tour host and the tours are their own files, fetched once the page has started: a tour starts no sooner than
  // its screen has shown and settled (walkthrough-events.ts), so the first screen never waits for them.
  // Every tour gets the app's words (End tour, where tours are kept) and reads the facts a step waits on, such as
  // whether an AI is connected, at the addresses tour-words.json names (ai-connection.ts reads the same row).
  // Whether a tour that starts by itself shows is the person's show rules (show-rules-live.ts): everyone starts with
  // one that holds them on a page opened at an address naming a screen (first-use-tour.mjs, tunable per screen row), so
  // nothing covers what the address opened, and the person or their AI can turn it off or add their own.
  // A tour naming an audience starts only for a viewer holding it, as a screen naming one is offered only to them.
  const forViewer = <T,>(rows: T[]) => rows.filter(row => !(row as { audience?: string }).audience || viewer.access_refs.includes(`audience:${(row as { audience?: string }).audience}`));
  // A tour starts only once the page is open (the opening cover has dissolved), so its dimmed backdrop never shows
  // through the dissolving cover; its files are fetched meanwhile.
  void Promise.all([import('../../parts/guided-overlay/show/mount-walkthrough-host'), import('trillion-walkthroughs'), import('./ai-connection'), whenPageOpen()])
    .then(async ([host, definitions, connection]) => host.default({ el: tours, props: { definitions: forViewer(await definitions.default), presentationSource: connection.currentTourPresentation, subscribe: onStoreChange } }));
  // A small moment when something good happens (a tour finished, work done, a phrase typed): the moments are DATA in
  // records/delight-moments.json, played by parts/delight-moments, fetched once the page has started.
  void Promise.all([import('../../parts/delight-moments/show/mount-delight-moments'), import('./presentation-rows.mjs').then(source=>source.presentationRows('delight'))])
    .then(([player, rows]) => { const moments = document.createElement('div'); root.append(moments); player.default({ el: moments, props: { rows: rows as never, subscribe:onStoreChange, source:()=>import('./presentation-rows.mjs').then(source=>source.presentationRows('delight')) } }); });
  // How each thing that happens feels on this device (touch, sound, motion): rows in records/feel-moments.json, played by
  // parts/feel through the device's own players (the iPhone and Mac apps play touch natively), quieted or changed by
  // the person's show rules (subject feel).
  void Promise.all([import('../../parts/feel/show/mount-feel'), import('./presentation-rows.mjs').then(source=>source.presentationRows('feel'))])
    .then(([feel, rows]) => { feel.default({ props: { rows: rows as never, subscribe:onStoreChange, source:()=>import('./presentation-rows.mjs').then(source=>source.presentationRows('feel')) } }); });
  // The same catalog owner serves the browser and the AI-app view. Available rows stay usable while later tool pages
  // and conversations arrive. Newer answers cancel older traversals, and a failed read keeps its rows with a retry.
  const catalog = createScreenCatalog({
    initial: { viewer, ...(toolNow && 'value' in toolNow ? { tools: toolNow.value } : {}),
      ...(pursuitNow && 'value' in pursuitNow ? { pursuits: pursuitNow.value } : {}) },
    read: readJson,
    unavailable: (error: unknown) => error instanceof PlanNeeded ? error.upgrade_needed : null,
    offer: ({ viewer: who, tools, pursuits, conversations }) => offeredScreens(who, tools, pursuits, conversations, partsOf),
    onChange: (updated, state) => {
      if (JSON.stringify(updated) !== JSON.stringify(offered)) {
        offered.splice(0, offered.length, ...updated);
        showRecords({ [surfaces.address_label]: updated });
      }
      // A final page may confirm completeness without changing a row. The arrangement must hear that transition
      // before it can close a saved tab whose screen is no longer offered.
      workspace.reoffer(updated, { catalogComplete: state.complete });
    },
    onError: (_error, source) => notify(screenCatalogWords.failed.replace('{source}', screenCatalogWords.sources[source]), {
      kind: 'info', key: `catalog-${source}-not-loaded`, actions: [{ id: `retry-catalog-${source}`, label: screenCatalogWords.retry,
        onAction: () => { void ({ viewer: async () => { await catalog.readViewer(); viewer = catalog.viewer; reconcilePersonalHold(); },
          tools: catalog.readTools, pursuits: catalog.readPursuits, conversations: catalog.readConversations })[source]?.(); },
      }],
    }),
  });
  // Fence these already-started first reads before taking newer kept-answer replacements below.
  void catalog.takePursuits(pursuitNow && 'value' in pursuitNow ? pursuitNow.value : pursuitRead.read.then(answer => {
    if ('error' in answer) throw answer.error;
    return answer.value;
  }));
  void catalog.takeTools(toolNow && 'value' in toolNow ? toolNow.value : toolRead.read.then(answer => {
    if ('error' in answer) throw answer.error;
    return answer.value;
  }));
  onStoreChange(async () => { await catalog.readPursuits(); });
  // The pursuit the workspace is about shows its parts under its row; they change with the focus and its room.
  onPartsChange(() => { catalog.offerAgain(); });
  // The conversations follow the store too, at most once per interval in the shared catalog read policy.
  let conversationsReadAt = 0;
  const readConversationRows = async () => {
    conversationsReadAt = Date.now();
    await catalog.readConversations();
  };
  void readConversationRows();
  onStoreChange(() => { if (Date.now() - conversationsReadAt >= SCREEN_CATALOG_CONVERSATIONS_EVERY_MS) void readConversationRows(); }, AI_MESSAGES);
  // A first read the page drew from this device's copy and the store answered differently is taken in place: the
  // person's records as records changed elsewhere (records.ts takeSavedRecords), the rest by offering the screens again.
  // The read here is answered by the store's answer that replaced the copy, so it asks nothing again.
  takeReplaced = path => {
    if (path === startupRecordsPath) { void takeStartupRecords().catch(() => {}); return; }
    if (path === firstPaths.viewer) void catalog.readViewer().then(() => { viewer = catalog.viewer; reconcilePersonalHold(); });
    else if (path === firstPaths.tool_screens) void catalog.readTools();
    else if (path === firstPaths.pursuits) void catalog.readPursuits();
  };
  for (const path of replacedEarly) takeReplaced(path);
  replacedEarly.clear();
  const opening = [
    ...(addressLabelForInput('layout-state') in saved ? [] : surfaces.open_at_start.map(id => offered.find(surface => surface.id === id)).filter(Boolean) as Record<string, unknown>[]),
    ...routedOpen(offered as Record<string, unknown>[]),
  ];
  if (opening.length) openScreens(opening);
  // Heading for a screen in the sidebar (the pointer's path, parts/ui/show/intent-prefetch) or moving focus to it starts
  // its code and the reads it waits on (first-answers.json screens), so the click opens it without waiting for either;
  // each open from the sidebar says how long ahead of it that start was made.
  const readsOf = firstAnswers.screens as Record<string, string[]>;
  const SIDEBAR_ROW = '[data-sidebar-surface-id]';
  const sidebarRowOf = (target: EventTarget | null) => (target as Element | null)?.closest?.(SIDEBAR_ROW)?.getAttribute('data-sidebar-surface-id') ?? null;
  const warmSurface = (id: string) => {
    const row = offered.find(surface => surface.id === id) as (Row & { surface_input?: { screen?: unknown }; package_entry?: { entry_name?: unknown } }) | undefined;
    const entry = row?.package_entry?.entry_name;
    if (typeof entry !== 'string') return;
    screens[entry]?.warm?.();
    warmReads(readsOf[typeof row?.surface_input?.screen === 'string' ? row.surface_input.screen : entry] ?? []);
  };
  const sidebarIntent = watchIntent(workspace.sidebar, { targets: () => workspace.sidebar.querySelectorAll(SIDEBAR_ROW), keyOf: element => element.getAttribute('data-sidebar-surface-id'), start: key => warmSurface(key) });
  workspace.sidebar.addEventListener('focusin', event => { const id = sidebarRowOf(event.target); if (id) warmSurface(id); });
  workspace.sidebar.addEventListener('click', event => { const id = sidebarRowOf(event.target); if (id) sidebarIntent.opened(id); });
  // Once the page is idle, every screen's code is fetched, one screen per idle moment, so opening any screen later
  // (by the sidebar, a link or a shortcut) never waits for its code.
  const idle = (next: () => void) => ('requestIdleCallback' in window ? window.requestIdleCallback(next, { timeout: 2000 }) : setTimeout(next, 200));
  const unwarmed = Object.values(screens).filter(screen => screen.warm);
  const warmNext = () => { unwarmed.shift()?.warm?.(); if (unwarmed.length) idle(warmNext); };
  // It starts once the first screen has shown, so fetching the rest never competes with the screen being opened.
  const shownFirst = panesShown;
  let waited = 0;
  const warmWhenShown = () => { waited += 250; if (shownFirst() || waited >= 5000) idle(warmNext); else setTimeout(warmWhenShown, 250); };
  setTimeout(warmWhenShown, 250);
  installTitleTooltips();
  installCopyGuard();
  // Every file a preview shows carries its card: facts, what this person can do with it, who is in it, what was said
  // (file-card.ts, parts/ui/show/file-card), under each hover preview and beside the file in its own tab. Its code
  // arrives after the page has started; a card already on screen draws once it is installed (provideFileCards).
  void import('./file-card').then(({ installFileCards }) => installFileCards());
  // Every ⋯ menu that says what it is about offers every row the page has for that thing (menu-rows.tsx): the tools and
  // screens that take it, the person's saved actions and a message box to their AI, formats; each row ruled by showOf.
  installMenuRows();
  // Unsaved work any screen has registered (leave-blockers.ts) asks the browser to confirm before the page is left, which covers sign-out and account switch links.
  installLeaveGuard();
  // What the person did just before they ask their AI for something (recent-steps), kept on this device and sent with each press.
  watchSteps();
  // The person's records kept in this browser, settled with their store in one request (device-copy.ts), once idle.
  idle(() => { void import('./device-copy').then(module => module.startDeviceCopy()); });
  // The floating cards and microphone pill of a recording in progress (recording-widgets.ts), for the person's own page only.
  if (!(viewer as { looking?: unknown; throwaway?: boolean }).looking && !(viewer as { throwaway?: boolean }).throwaway) {
    idle(() => { void import('./recording-widgets').then(module => module.keepRecordingWidgets()); });
  }
  // A host app asks every loaded page how much work has not reached the store before it quits (unsaved-work.ts).
  publishUnsavedWork();
  // The question the host puts to the person when it would quit with such work (quit-question.ts), drawn here in the worn look.
  publishQuitQuestion();
  // Whether this tab's build may keep working (client-version.ts) is not asked: /work/api/client-version has no owner in
  // the engine, which carries the page it serves, so a tab and its store move together.
  // Shares this device kept to send again (share-outbox.ts) are sent once idle; the outbox is not part of the first load.
  idle(() => { void import('./share-outbox').then(module => module.keepSendingShares()); });
  // The message box's shortcut and the entry point the iPhone and Mac apps hand a share through
  // (window.trillionComposer.open) are published once the page has started; both open its screen in its layer.
  void import('./global-composer').then(module => module.publishMessageBox());
  // Find anything's key (command-palette.json): opens and closes it from anywhere.
  void import('./command-palette').then(module => module.publishCommandPalette());
  // The one keymap (keymap.json): every chord the verbs above (and the Calendar's) answer, the person's own keys, and the
  // global keys the Mac app registers.
  void import('./keymap-runtime').then(module => module.publishKeymap());
  // Answer any selected words where they are (responses.tsx): a comment or reaction kept with the thing's audience.
  void import('./responses').then(module => module.publishResponses());
  void import('./live-instructions').then(module => module.publishLiveInstructions());
  // Point at anything on the screen to change it (started from any pane's ⋯): the page's one pointing host.
  void import('./point-at-anything').then(module => module.mountPointAtAnything());
  // The hold (needs-you-hold.tsx): while one thing truly needs the person, this page is that thing and nothing under
  // it can be reached; never on a view-as page or a public showcase without the visitor's own AI and devices.
  // The exemption comes from the authenticated viewer, not the URL or saved browser records. The server still
  // enforces every showcase's restricted routes and lifetime (src/showcases.mjs).
  let stopPersonalHold: (() => void) | null = initialPersonalHold ?? null;
  let holdRead = 0;
  reconcilePersonalHold = () => {
    const read = ++holdRead;
    if (!personalHoldApplies(viewer)) { stopPersonalHold?.(); stopPersonalHold = null; return; }
    if (stopPersonalHold) return;
    void import('./needs-you-hold').then(module => {
      if (read !== holdRead || !personalHoldApplies(viewer)) return;
      stopPersonalHold = module.mountNeedsYouHold(root);
    });
  };
  reconcilePersonalHold();
  // A new account's welcome tour, whose first step after the welcome connects the person's AI, starts on any page
  // whose show rules let a tour start by itself (the starting rule holds it over the Share sheet's message box and
  // over an address that named a screen, first-use-tour.mjs).
  // A showcase's throwaway workspace opens on its own guided tour (src/showcases.mjs), so the welcome tour never starts
  // beside it, however the two reach the page.
  void (initialPersonalHold?.ready ?? Promise.resolve()).then(() => {
    if (!(viewer as { throwaway?: boolean }).throwaway && !document.documentElement.hasAttribute('data-arrangement-locked')) {
      emitWalkthroughEventWhenHostReady({ event_kind: 'first-use-ready' });
    }
  });
  if (linkedLayout) showRecords({ [inputs['layout-open-asked'].address]: { layout_id: linkedLayout, asked_at: new Date().toISOString(), by: 'link' } });
  if (linkedTour) emitWalkthroughEventWhenHostReady({ event_kind: 'walkthrough-requested', walkthrough_id: linkedTour });
}

// The thread cover drawn by the page's first bytes, lifted once the open screens have painted (invariant 8).
const cover = (window as Window & { trillionCover?: { lift(): Promise<void> } }).trillionCover;
const liftCover = () => cover?.lift() ?? Promise.resolve();
// The longest the cover waits for the open screens after the workspace started; past it, a screen still reading shows
// its own loading state.
const COVER_MOST_MS = 15_000;
// The longest the cover stays over the page from the page's start, whatever the first reads and the screens are doing
// (a busy store answers one request at a time): then it lifts onto what is drawn (opening-cover.mjs). READ_MOST_MS
// stays the longest any one read waits; this is the bound over all of them together.
const COVER_OVERALL_MS = 8_000;
// Until the workspace is drawn, a page the cover has lifted from says so plainly instead of showing nothing.
let openingNote: HTMLElement | null = null;
const showOpeningNote = () => {
  if (openingNote || document.querySelector('.trillion-workspace, .trillion-workspace-failed')) return;
  openingNote = document.createElement('div');
  openingNote.className = 'trillion-workspace-opening';
  document.body.prepend(openingNote);
  mountScreenState(openingNote, { status: 'loading', label: failureWords.still_opening });
};
function dropOpeningNote() { openingNote?.remove(); openingNote = null; }
// The open screens show their real content: there is one, none is still loading, and they hold words (a card that
// draws only a picture or nothing at all is drawn too, so not every screen needs words of its own).
const screensPainted = () => {
  const panes = [...document.querySelectorAll<HTMLElement>('[data-trillion-screen]')];
  return panes.length > 0 && !panes.some(pane => pane.querySelector('[data-screen-state="loading"]')) && panes.some(pane => (pane.textContent ?? '').trim().length > 0);
};
const whenScreensPainted = () => new Promise<void>(done => {
  if (screensPainted()) { done(); return; }
  const finish = () => { watch.disconnect(); clearTimeout(most); done(); };
  const watch = new MutationObserver(() => { if (screensPainted()) finish(); });
  watch.observe(document.body, { childList: true, subtree: true, characterData: true });
  const most = setTimeout(finish, COVER_MOST_MS);
});
// The page wears its look from the first script, before the workspace reads anything: the look this account (or, signed
// out, this browser) wore last, else the look every page starts with. The opening note and "Your workspace could not
// open" are drawn in it, never in the shared controls' bare palette (2026-10-11: grey buttons on a light page while the
// same person's share page was black). mountWorkspace paints the account's own look over it once read.
const keptLook = readSignedOutScreenLook();
applyChosenScreenLook(looks.themes, looks.themes.some(row => row.payload?.id === keptLook) ? keptLook! : looks.start_with);
const returningToSpace = location.pathname === '/' ? takeSpaceInviteAfterCheckout() : null;
if (returningToSpace) location.replace(returningToSpace);
else {
  // Once the cover has dissolved, what moves behind the whole page may show (parts/ui/show/page-backdrop): the two
  // never change the window at the same moment.
  const opening = coverLifting({ mostMs: COVER_OVERALL_MS, now: () => performance.now(), lift: liftCover, markOpen: markPageOpen, showNote: showOpeningNote, hideNote: dropOpeningNote });
  start().then(
    // A page framing this one (a live showcase on a landing, parts/ui/show/live-frame) swaps its picture for this page
    // only once the screens show real content.
    () => whenScreensPainted().then(() => { if (screensPainted()) tellFramingPageReady(); return opening.opened(); }),
    error => {
      // The API is navigating to sign in with the full return address.
      if (error?.status === 401) return;
      dropOpeningNote();
      const failed = document.createElement('div');
      failed.className = 'trillion-workspace-failed';
      document.body.prepend(failed);
      mountScreenState(failed, failedState(error, () => location.reload(), 'Your workspace could not open'));
      void opening.failed();
    },
  );
}
