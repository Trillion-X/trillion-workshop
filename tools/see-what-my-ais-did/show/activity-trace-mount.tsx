// tools/see-what-my-ais-did/show/activity-trace-mount.tsx
//
// PURPOSE
//   The screen that traces how one thing happened (tool:screen-activity-trace) as a screen module: the one file the screen's row names (`screen.module.entry`), whose single
//   export, `mount(element, props)`, is the contract of the module kind (web/src/workspace/tool-screen.tsx). The screen
//   itself is web/src/workspace/activity-trace-screen.tsx beside this folder's other files, moved here byte for byte from the web
//   client (moved-from.json); the client build opens it from this tool folder and shares the web shell's files with the page.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export { mountActivityTraceScreen as mount } from '../web/src/workspace/activity-trace-screen';
