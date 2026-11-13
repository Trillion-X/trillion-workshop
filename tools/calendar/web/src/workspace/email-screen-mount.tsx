// tools/calendar/web/src/workspace/email-screen-mount.tsx
//
// PURPOSE
//   The Mail screen (tool:screen-mail) as a screen module: the one file the screen's row names (`screen.module.entry`), whose single export,
//   `mount(element, props)`, is the contract of the module kind (web/src/workspace/tool-screen.tsx). The screen itself
//   is ./email-screen.tsx beside this file, moved here byte for byte from the web client
//   (moved-from.json); the client build opens it from this tool folder and shares the web shell's files with the page.
//   The Mail screen lives in this tool because the Calendar's mail pane draws its EmailSurface (email-screen.tsx), so both
//   screens' files import each other as they were written.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export { mountEmailScreen as mount } from './email-screen';
