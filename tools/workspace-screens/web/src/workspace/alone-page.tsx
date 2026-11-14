// src/workspace/alone-page.tsx
//
// PORTED FROM: src/workspace/screen-view.tsx (its one-screen host: mount from screen-mounts.ts, open another screen in
// place on the placeable-surface event and on a link to a Trillion address, tell the host the height). What changes
// here: the page is signed in, so reads and the live channel are the page's own, and a screen opened from the first one
// sits over it with Back instead of replacing it.
//
// PURPOSE
//   The signed-in page when its address names a screen whose row says `shown_alone` (records/workshop-screen-tool-
//   records.json): that one screen fills the page, with no sidebar and no arrangement, so a small window a host app keeps
//   (the Mac app's menu bar panel, any native popover or widget that shows a web page) is a Trillion screen in the
//   person's own look, drawn by the same screen code as everywhere else. Whatever the screen opens (a notice's
//   recording, the message box, a decision) opens in place over it, one step deeper, with Back to return: the person
//   does the job inside the small window instead of being sent somewhere else.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One screen implementation: every screen is mounted from screen-mounts.ts, the list the workspace and the AI-app
//      screen view mount from, through the same screen runner (screen-runner.ts), so a screen made of screens draws its
//      pieces here as it does on the full page; nothing here draws a screen of its own.
//   2. Every word is DATA (src/alone-page.json); the bar is shared parts (Button, NamedIcon, Text).
//   3. A host is told through one message channel, `window.webkit.messageHandlers[alone-page.json host_channel]`, with
//      { kind: 'size', height } when the page's height changes, { kind: 'glance', count, working, running, now, list }
//      when what the bell shows changes, and { kind: 'outside', url } for a link that is not a Trillion screen. A page
//      with no host opens such a link in a new tab and tells nobody its size. The glance is read from the one
//      notification center, whatever kind each thing is: `count` unread, `working` whether anything runs, `running`
//      how many, `now` the thing most recently moving ({ title, kind, fraction } with fraction 0..1 or null when its
//      amount is not known; with nothing running, the Calendar item now or next as kind 'next' with its countdown in the title) and `list` the titles of everything running, newest first, so a host's mark says what is
//      happening and how far, never only that something is.
//   4. A host reaches the page through `window.trillionAlone`: back() (closes what is open over the screen, as Escape
//      in the page would, else steps back out of a screen opened in place; answers whether there was anything to do), open(address), and tell(lines): what only the host can see (a drive the Mac is still copying), each line
//      { id, title, kind, running, percent? }, shown as the page's own notifications (kept, quiet, never a card that
//      pops up), with its percent as the notification's progress; a line the host stops telling is taken away.
//   5. The live channel is kept exactly as on the full page, so a glance is never staler than the workspace. Like the
//      full page, it asks neither /work/api/notifications nor /work/api/tell/notices at its start: the engine has no
//      owner for either (macos/release.json route_owner_gate.retired).
//   6. The host's own controls never share the window with the screen, which keeps all of it: they are the Settings Menu
//      bar page (settings-pages.tsx), which the host opens in place over the screen by its address (the Mac item's menu),
//      drawn only when a host answers them (host-channel.ts). The shortcut row (panel-shortcut.tsx): { kind: 'shortcut' } asks, { kind: 'shortcut', id } picks (null is Off), and the host
//      answers through window.trillionAlone.shortcut({ pick, choices }); the Mac app only registers the key.
//   7. The "Set up this Mac" section (panel-setup.tsx) follows the same rule: { kind: 'placement' } and { kind: 'permissions' } ask, with
//      id (and action apply or undo) they change one step or open one guide, and the host answers through
//      window.trillionAlone.placement / permissions (panel-setup.mjs).
//   8. The menu bar item's own settings (panel-settings.tsx) follow the same rule: { kind: 'panel_settings' } asks, with
//      id and value it sets one row, and the host answers through window.trillionAlone.panelSettings({ rows })
//      (panel-settings.mjs). The row "Show meetings starting within" decides how far ahead the glance counts down to a
//      Calendar item (tool:name-my-next-commitment); the host applies the rest.

import React from 'react';
import { createRoot } from 'react-dom/client';
import mountScreenLook from '../../parts/screen-look/show/mount-screen-look-surface';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import { mountScreenState, releaseScreenState } from '../../parts/ui/show/screen-state';
import { installTitleTooltips } from '../../parts/ui/show/tooltip/title-tooltips';
import { notificationCenter } from '../../parts/ui/show/coss/notifications';
import { keepCatchUp } from 'trillion-workshop/tools/keep-copies-in-step/web/src/workspace/catch-up.tsx';
import { Button, Container, NamedIcon, Text } from '../../parts/ui';
import { screenOfAddress } from './addresses.mjs';
import type { ScreenRow } from './offered-screens';
import { screens } from './screen-mounts';
import { installScreenRunner, mountScreen } from './screen-runner';
import surfaces from './surfaces.json';
import { keepNextCommitment, type CommitmentReach } from './keep-next-commitment';
import { newRunKey, runWorkshopTool } from './workshop-tool-api';
import settings from '../alone-page.json';
import { PANEL_SHORTCUT_EVENT } from './panel-shortcut';
import { PANEL_SETTINGS_EVENT } from './panel-settings';
import { askPanelSettings, panelSettingValue, panelSettingsState } from './panel-settings.mjs';
import { PANEL_PERMISSIONS_EVENT, PANEL_PLACEMENT_EVENT } from './panel-setup';
import { hostChannel, tellHost } from './host-channel';

type Asked = { id: string; input?: Record<string, unknown> };
type Routed = { row: ScreenRow; input: Record<string, string> | null };
type GlanceNow = { title: string; kind: string; fraction: number | null };
type Glance = { kind: 'glance'; count: number; working: boolean; running: number; now: GlanceNow | null; list: string[] };
type HostLine = { id: string; title: string; kind: string; running: boolean; percent?: number };

/** The screen the page's own address names, when its row asks to be shown alone. */
export function aloneRow(offered: ScreenRow[], pathname: string, search = ''): Routed | null {
  const routed = screenOfAddress(offered, pathname, search) as Routed | null;
  return routed && routed.row.shown_alone === true ? routed : null;
}

/** The bar over a screen opened from the first one: Back at the leading edge, the opened screen's name centred, on one
 *  line (a window's title bar). Container defaults to a column, so the row is asked for here, not only in CSS. */
function Bar({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <Container className="trillion-alone-bar" layout="horizontal" alignItems="center">
      <Button variant="ghost" size="sm" onClick={onBack} aria-label={settings.words.back}>
        <NamedIcon name="ChevronLeft" aria-hidden="true" />{settings.words.back}
      </Button>
      <Text className="trillion-alone-title">{label}</Text>
    </Container>
  );
}

/** Shows the screen `first` names alone in the page, keeps every screen it opens in place over it, and keeps the host
 *  told. `offered` are the screens this person is offered. */
export async function startAlone(first: Routed, offered: ScreenRow[], mountPersonalHold?: (beneath: HTMLElement) => (() => void) & { ready: Promise<void> }): Promise<void> {
  document.body.classList.add('screen-look-page', 'trillion-alone-page');
  // Changes going up and devices catching up are a running line in the bell, so the host's own mark (the Mac menu bar
  // item's ring) shows them from this page too (catch-up.tsx).
  keepCatchUp();
  const page = document.createElement('div');
  page.className = 'trillion-alone';
  page.hidden = Boolean(mountPersonalHold);
  const look = document.createElement('div');
  look.hidden = true;
  const bar = document.createElement('div');
  bar.className = 'trillion-alone-bar-host';
  bar.hidden = true;
  const host = document.createElement('div');
  host.className = 'trillion-alone-screen';
  page.append(look, bar, host);
  document.body.prepend(page);
  mountScreenLook({ el: look, props: {} });
  installTitleTooltips();
  // A screen made of screens (Home, the menu bar panel) draws its pieces through the same runner as the full page.
  installScreenRunner(screens, surfaces.address_label);
  // The message box's entry point (window.trillionComposer.open), so a host can hand it a screenshot or a file; the box
  // itself opens in place like any other screen.
  void import('./global-composer').then(module => module.publishMessageBox());
  // The hold (needs-you-hold.tsx) covers a screen shown alone too (the Mac menu bar panel), so no window of Trillion
  // is a way around the one thing that needs the person.
  const personalHold = mountPersonalHold?.(page);
  await personalHold?.ready;
  page.hidden = false;

  const barRoot = createRoot(bar);
  const opened: Asked[] = [];
  let unmount: (() => void) | null = null;

  function draw() {
    const top = opened.at(-1);
    const deeper = top && opened.length > 1 ? offered.find(item => item.id === top.id) : undefined;
    bar.hidden = !deeper;
    barRoot.render(deeper ? <Bar label={String(deeper.label ?? '')} onBack={stepOut} /> : null);
    unmount?.();
    unmount = null;
    releaseScreenState(host);
    host.replaceChildren();
    if (!top) return;
    const row = offered.find(item => item.id === top.id);
    const entry = (row?.package_entry as { entry_name?: string } | undefined)?.entry_name;
    const mount = entry ? screens[entry] : undefined;
    if (!row || !mount) { mountScreenState(host, { status: 'empty', icon: 'LayoutPanelLeft', title: settings.words.missing }); return; }
    const surfaceInput = { ...(row.surface_input as Record<string, unknown> | undefined), ...(top.input ?? {}) };
    host.dataset.trillionScreen = typeof surfaceInput.screen === 'string' ? surfaceInput.screen : entry;
    unmount = mountScreen(host, entry!, surfaceInput, element => mount(element, { surfaceInput }));
  }
  function open(asked: Asked) {
    const top = opened.at(-1);
    if (top && top.id === asked.id && JSON.stringify(top.input ?? {}) === JSON.stringify(asked.input ?? {})) return;
    opened.push(asked);
    draw();
  }
  function stepOut(): boolean {
    if (opened.length < 2) return false;
    opened.pop();
    draw();
    return true;
  }
  // A host's Escape (the Mac panel keeps the key to itself) first closes whatever the screen has open over it (a menu, a
  // pane map, a dialog), exactly as Escape pressed in the page would, then steps back out of a screen opened in place.
  let asking: KeyboardEvent | null = null;
  function back(): boolean {
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    asking = escape;
    (document.activeElement ?? document.body).dispatchEvent(escape);
    asking = null;
    return escape.defaultPrevented || stepOut();
  }
  function openHere(address: string): boolean {
    const url = new URL(address, location.origin);
    const routed = url.origin === location.origin ? screenOfAddress(offered, url.pathname, url.search) as Routed | null : null;
    if (routed) { open({ id: routed.row.id, input: routed.input ?? {} }); return true; }
    if (hostChannel()) tellHost({ kind: 'outside', url: url.href });
    else window.open(url.href, '_blank', 'noopener');
    return false;
  }

  // A screen asks for another the way it asks the page's arrangement (open-screen.ts): here it opens in place.
  window.addEventListener(PLACEABLE_SURFACE_MIME, event => {
    const detail = (event as CustomEvent).detail as { id?: string; surfaceInput?: Record<string, unknown> } | null;
    if (!detail?.id) return;
    event.preventDefault();
    open({ id: detail.id, input: detail.surfaceInput ?? {} });
  });
  // A link to one of Trillion's screens opens it in place; any other link opens outside.
  document.addEventListener('click', event => {
    const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!link || event.defaultPrevented) return;
    event.preventDefault();
    openHere(link.getAttribute('href') ?? '');
  });
  // Esc steps back out of a screen opened in place; at the first screen the host decides what Esc does. The Escape
  // back() sends only asks what is open, so it never steps back here.
  document.addEventListener('keydown', event => {
    if (event === asking || event.key !== 'Escape' || event.defaultPrevented) return;
    if (stepOut()) event.preventDefault();
  });
  // What only the host sees, as notifications kept until the host stops telling them (invariant 4).
  const center = notificationCenter();
  let told = new Set<string>();
  function tell(lines: HostLine[]) {
    const now = new Set<string>();
    for (const line of lines) {
      const id = `host:${line.id}`;
      now.add(id);
      const progress = line.running && typeof line.percent === 'number' ? { value: line.percent / 100 } : undefined;
      center.emit(line.title, { id, kind: line.kind, running: line.running, ...(progress ? { progress } : {}), quiet: true, toast: false, kept: true });
    }
    for (const id of told) if (!now.has(id)) center.forget(id);
    told = now;
  }
  // The host answers the shortcut setting here (panel-shortcut.mjs): the row reads it from this event.
  const shortcut = (answer: unknown) => window.dispatchEvent(new CustomEvent(PANEL_SHORTCUT_EVENT, { detail: answer }));
  // And the Set up this Mac section (panel-setup.mjs): the host answers the placement steps and the permission switches here.
  const placement = (answer: unknown) => window.dispatchEvent(new CustomEvent(PANEL_PLACEMENT_EVENT, { detail: answer }));
  const permissions = (answer: unknown) => window.dispatchEvent(new CustomEvent(PANEL_PERMISSIONS_EVENT, { detail: answer }));
  // The host answers the menu bar item's settings here (panel-settings.mjs): the rows read it from this event, and the
  // glance counts down only to a Calendar item inside the reach the person chose.
  // null until the person chooses: the Workshop countdown tool then uses its own default reach.
  let reachHours: number | null = null;
  const reachListeners = new Set<() => void>();
  const reach: CommitmentReach = { hours: () => reachHours, subscribe: listener => { reachListeners.add(listener); return () => { reachListeners.delete(listener); }; } };
  const panelSettings = (answer: unknown) => {
    window.dispatchEvent(new CustomEvent(PANEL_SETTINGS_EVENT, { detail: answer }));
    const hours = Number(panelSettingValue(panelSettingsState(answer), 'meetings_within', reachHours ?? NaN));
    if (Number.isFinite(hours) && hours !== reachHours) { reachHours = hours; reachListeners.forEach(listener => listener()); }
  };
  (window as unknown as { trillionAlone: unknown }).trillionAlone = { back, open: openHere, tell, shortcut, placement, permissions, panelSettings };

  // The host's window is as tall as the page (up to what the host allows), told whenever that changes.
  new ResizeObserver(() => tellHost({ kind: 'size', height: Math.ceil(page.scrollHeight) })).observe(page);
  // What the bell shows, for the host's own mark (the Mac menu bar item), told on change (invariant 3).
  let said = '';
  let next: string | null = null;
  // The mark's message is the Workshop tool's answer (tool:say-what-the-menu-bar-mark-shows); a later ask replaces an earlier one still running.
  let asked = 0;
  const glance = () => {
    const turn = ++asked;
    const records = center.history().map(record => ({ title: record.title, kind: record.kind, running: record.running, updatedAt: record.updatedAt, ...(record.progress ? { progress: record.progress } : {}) }));
    void runWorkshopTool<Glance>('tool:say-what-the-menu-bar-mark-shows', { records, unread_count: center.unreadCount(), ...(next ? { next } : {}) }, newRunKey('glance'))
      .then(ran => {
        if (turn !== asked) return;
        const key = JSON.stringify(ran.result);
        if (key !== said) { said = key; tellHost(ran.result as Glance); }
      })
      .catch(() => { /* a failed run keeps what the host was last told */ });
  };
  center.subscribe(glance);
  keepNextCommitment(line => { next = line; glance(); }, reach);
  tellHost(askPanelSettings());
  glance();

  open({ id: first.row.id, input: first.input ?? {} });
}
