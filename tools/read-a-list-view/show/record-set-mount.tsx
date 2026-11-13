// tools/read-a-list-view/show/record-set-mount.tsx
//
// PURPOSE
//   The Sent, Spend, Visitors and Price tests (each row's `input` names what it reads) screen (tool:screen-sent, tool:screen-spend, tool:screen-visitors and tool:screen-price-tests) as a screen module: the one file the screen's row names (`screen.module.entry`), whose
//   single export, `mount(element, props)`, is the contract of the module kind (web/src/workspace/tool-screen.tsx).
//   The screen itself is web/src/workspace/record-set-screen.tsx beside this folder's other files, moved here byte for byte from
//   the web client (moved-from.json); the client build opens it from this tool folder and shares the web shell's
//   files with the page.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export { mountRecordSetScreen as mount } from '../web/src/workspace/record-set-screen';
