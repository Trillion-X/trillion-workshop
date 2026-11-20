// src/workspace/host-channel.ts
//
// The message channel a host app listens on (src/alone-page.json `host_channel`, window.webkit.messageHandlers.<name>):
// the Mac app's menu bar panel (macos/App/MenuBarPanel.swift invariant 3). Read here only, by the page shown alone
// (alone-page.tsx) and by the settings page that draws the host's own controls (settings-pages.tsx). A page with no such
// channel tells nobody.
import settings from '../alone-page.json';

type Handlers = Record<string, { postMessage(message: object): void } | undefined>;

export const hostChannel = () => ((window as unknown as { webkit?: { messageHandlers?: Handlers } }).webkit?.messageHandlers ?? {})[settings.host_channel];
export const tellHost = (message: object) => hostChannel()?.postMessage(message);

// The host's way into the page (settings.host_reach on window, alone-page.tsx invariant 4) stands from the page's first line,
// not from when its screen is drawn: the Mac panel takes a page without it after 30 s for one that never started and loads
// it again, and on Nov 20 2026 (11:31-11:38 AM CST) a page whose first reads were slow was reloaded every 35 s, each reload
// ending its reads (499) and starting them over. What the host calls before the page is ready is kept and handed to it in
// order once it is (answerHost); a page that fails to open takes the stand-in away, so the host loads it again as before.
type Reach = Record<string, (...args: unknown[]) => unknown>;
const held = window as unknown as Record<string, Reach | undefined>;
const waiting: Array<[string, unknown[]]> = [];
export function standForHost() {
  if (!hostChannel() || held[settings.host_reach]) return;
  held[settings.host_reach] = new Proxy({}, { get: (_, name) => (typeof name === 'string' ? (...args: unknown[]) => { waiting.push([name, args]); } : undefined) }) as Reach;
}
export function answerHost(reach: Reach) {
  held[settings.host_reach] = reach;
  for (const [name, args] of waiting.splice(0)) reach[name]?.(...args);
}
export function leaveHost() {
  waiting.length = 0;
  delete held[settings.host_reach];
}
