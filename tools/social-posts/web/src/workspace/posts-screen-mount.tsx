// tools/social-posts/web/src/workspace/posts-screen-mount.tsx
//
// PURPOSE
//   The Posts screen (tool:check-a-post) as a screen module: the one file the screen's row names (`screen.module.entry`), whose single export,
//   `mount(element, props)`, is the contract of the module kind (web/src/workspace/tool-screen.tsx). The screen is
//   ./pieces-screen.tsx: each pursuit's pieces read from its own database. ./posts-screen.tsx read the retired records
//   door and is kept until this screen is read back live, then removed.
//
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export { mountPiecesScreen as mount } from './pieces-screen';
