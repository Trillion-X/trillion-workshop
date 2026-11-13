// tools/keep-goals-and-focus/show/home-card-mount.tsx
//
// PURPOSE
//   One part of Home (its greeting, numbers, needle mover, workstreams, deciding, waiting, recent, messages, pursuits or
//   suggestions: the part's name is the row's `surface_input.card`) as a screen module: the file the rows
//   tool:screen-home-greeting ... tool:screen-home-suggestions name (`screen.module.entry`), whose single export,
//   `mount(element, props)`, is the contract of the module kind (web/src/workspace/tool-screen.tsx). Every part opens
//   from this one file, so every part of Home on the page shares one bundle and the one read of Home's answers that
//   web/src/workspace/home-screen.tsx keeps for them. The screen itself is that file, beside this folder's other files,
//   moved here byte for byte from the web client (moved-from.json).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export { mountHomeCard as mount } from '../web/src/workspace/home-screen';
