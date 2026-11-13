// tools/messages-screen/web/src/workspace/messages-screen-mount.tsx
//
// PURPOSE
//   The Messages screen (tool:screen-messages) as a screen module: the one file the screen's row names (`screen.module.entry`), whose single export,
//   `mount(element, props)`, is the contract of the module kind (web/src/workspace/tool-screen.tsx). The screen itself
//   is ./messages-screen.tsx beside this file, moved here byte for byte from the web client
//   (moved-from.json); the client build opens it from this tool folder and shares the web shell's files with the page.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export { mountMessagesScreen as mount } from './messages-screen';
