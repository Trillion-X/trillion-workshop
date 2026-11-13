// tools/build-and-send-a-sales-contract/web/src/workspace/sales-contract-builder-mount.tsx
//
// PURPOSE
//   The Sales contracts screen (tool:manage-sales-contracts) as a screen module: the one file the screen's row names (`screen.module.entry`), whose single export,
//   `mount(element, props)`, is the contract of the module kind (web/src/workspace/tool-screen.tsx). The screen itself
//   is ./sales-contract-builder-screen.tsx beside this file, moved here byte for byte from the web client
//   (moved-from.json); the client build opens it from this tool folder and shares the web shell's files with the page.
//
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export { mountSalesContractBuilderScreen as mount } from './sales-contract-builder-screen';
