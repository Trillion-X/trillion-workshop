// tools/open-the-sharing-sheet-for-a-record-preview-the-copy/show/shared-with-me-mount.tsx
//
// PURPOSE
//   The Shared with me screen (tool:screen-shared-with-me) as a screen module: the one file the screen row names
//   (`screen.module.entry`), whose single export, `mount(element, props)`, is the contract of the module kind
//   (web/src/workspace/tool-screen.tsx). The screen itself is web/src/workspace/shared-with-me-screen.tsx beside this
//   folder's other files, moved here byte for byte from the web client (moved-from.json); the client build opens it
//   from this tool folder and shares the web shell's files with the page.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export { mountSharedWithMeScreen as mount } from '../web/src/workspace/shared-with-me-screen';
