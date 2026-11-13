// tools/keep-copies-in-step/show/catch-up-mount.tsx
//
// PURPOSE
//   Your devices (tool:screen-catch-up) and its preview (tool:screen-catch-up-preview) as a screen module: the one file the screen's row names (`screen.module.entry`), whose single export,
//   `mount(element, props)`, is the contract of the module kind (web/src/workspace/tool-screen.tsx). Both rows name this file: the preview is the same picture. The screen
//   itself is web/src/workspace/catch-up.tsx beside this folder's other files, moved here byte for byte from the web
//   client (moved-from.json); the client build opens it from this tool folder and shares the web shell's files with
//   the page.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export { mountCatchUpScreen as mount } from '../web/src/workspace/catch-up';
