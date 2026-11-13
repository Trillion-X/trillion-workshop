// tools/keep-goals-and-focus/show/home-mount.tsx
//
// PURPOSE
//   Home itself drawn bare (tool:screen-home, tool:screen-menu-bar) as a screen module: the file those rows name
//   (`screen.module.entry`), whose single export, `mount(element, props)`, is the contract of the module kind
//   (web/src/workspace/tool-screen.tsx). Home is made of its parts (the row's `surface_input.arrangement`, drawn by the
//   page's screen arrangement, each part opening from show/home-card-mount.tsx); only an arrangement holding Home inside
//   itself reaches this file, and it shows Home's greeting. The screen itself is web/src/workspace/home-screen.tsx beside
//   this folder's other files, moved here byte for byte from the web client (moved-from.json).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export { mountHomeScreen as mount } from '../web/src/workspace/home-screen';
