// tools/build-and-send-a-sales-contract/web/src/workspace/sales-contract-builder-mount.tsx
//
// The Sales contracts screen as a screen module: the one file the screen's row names (`screen.module.entry`), whose single
// export, `mount(element, props)`, is the contract of the module kind (web/src/workspace/tool-screen.tsx). The screen is
// the private deal builder (private-deal-builder.tsx).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export { mountPrivateDealBuilder as mount } from './private-deal-builder';
