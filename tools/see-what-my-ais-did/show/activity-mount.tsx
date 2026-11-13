// tools/see-what-my-ais-did/show/activity-mount.tsx
//
// PURPOSE
//   The AI activity screen (tool:screen-activity and tool:errors (surfaceInput only: failed)) as a screen module: the one file the screen's row names (`screen.module.entry`), whose single
//   export, `mount(element, props)`, is the contract of the module kind (web/src/workspace/tool-screen.tsx). The screen
//   itself is web/src/workspace/activity-screen.tsx beside this folder's other files, moved here byte for byte from the web
//   client (moved-from.json); the client build opens it from this tool folder and shares the web shell's files with the page.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export { mountActivityScreen as mount } from '../web/src/workspace/activity-screen';
