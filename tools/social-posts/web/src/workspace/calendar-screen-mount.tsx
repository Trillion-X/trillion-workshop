// tools/social-posts/web/src/workspace/calendar-screen-mount.tsx
//
// PURPOSE
//   The posting calendar screen (tool:read-post-calendar) as a screen module: the one file the screen's row names (`screen.module.entry`), whose single export,
//   `mount(element, props)`, is the contract of the module kind (web/src/workspace/tool-screen.tsx). The screen itself
//   is ./calendar-screen.tsx beside this file, moved here byte for byte from the web client
//   (moved-from.json); the client build opens it from this tool folder and shares the web shell's files with the page.
//
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export { mountCalendarScreen as mount } from './calendar-screen';
