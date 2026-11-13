// tools/calendar/web/src/workspace/shared-calendar-screen-mount.tsx
//
// PURPOSE
//   The one Calendar screen (tool:screen-calendar, and the grid, settings and tasks rows that share it) as a screen module: the one file the screen's row names (`screen.module.entry`), whose single export,
//   `mount(element, props)`, is the contract of the module kind (web/src/workspace/tool-screen.tsx). The screen itself
//   is ./shared-calendar-screen.tsx beside this file, moved here byte for byte from the web client
//   (moved-from.json); the client build opens it from this tool folder and shares the web shell's files with the page.
//
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export { mountSharedCalendarScreen as mount } from './shared-calendar-screen';
