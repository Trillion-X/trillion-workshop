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
