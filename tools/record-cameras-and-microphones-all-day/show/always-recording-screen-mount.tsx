// tools/record-cameras-and-microphones-all-day/show/always-recording-screen-mount.tsx
//
// PURPOSE
//   Always recording: every camera and microphone on this device, each switched on to record without end
//   (tool:screen-always-recording) as a screen module: the one file the screen's row names (`screen.module.entry`), whose
//   single export, `mount(element, props)`, is the contract of the module kind (web/src/workspace/tool-screen.tsx). The
//   screen itself is web/src/workspace/always-recording-screen.tsx beside this folder's other files, moved here byte for
//   byte from the web client (moved-from.json); the client build opens it from this tool folder and shares the web
//   shell's files with the page.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export { mountAlwaysRecordingScreen as mount } from '../web/src/workspace/always-recording-screen';
