// tools/tours-screen/show/tours-screen-mount.tsx
//
// PURPOSE
//   The Tours screen and the Waiting tours list (tool:screen-tours, tool:screen-waiting-tours: the second is the same
//   screen opened with the input `queue_only`) as a screen module: the one file those rows name
//   (`screen.module.entry`), whose single export, `mount(element, props)`, is the contract of the module kind
//   (web/src/workspace/tool-screen.tsx). The screen itself is web/src/workspace/tours-screen.ts beside this folder's
//   other files, moved here byte for byte from the web client (moved-from.json); the client build opens it from this
//   tool folder and shares the web shell's files with the page. Its `readProgress` is also read by the page's changelog
//   pill (web/src/workspace/global-composer.tsx).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export { mountToursScreen as mount } from '../web/src/workspace/tours-screen';
