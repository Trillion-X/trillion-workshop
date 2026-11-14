// src/workspace/screen-module-address.mjs
//
// Purpose
//   The two names a screen module (a tool's own screen code, scripts/screen-modules.mjs) is reached by, written once
//   for the build that makes the page's import map and for the page that imports the module:
//     screenModuleSpecifier  what the page's import map names a module built with the page: its row's own spec,
//                            `@trillion-screen/<tool folder>/<file>`, so the page opens it without asking which bundle.
//     moduleAddress          where a kept bundle's file is served by identity (src/files-by-identity.mjs).
//
// Non-negotiable invariants
//   1. Blind: names no tool, folder or file; both are made from the row's and the bundle's own values.
//

/** What the page's import map names the screen module a row specifies as { package, entry }. */
export const screenModuleSpecifier = spec => `@trillion-screen/${spec.package}/${spec.entry}`;

/** Where one file of a kept screen bundle is served. */
export const moduleAddress = (bundle, file) => `/workshop/modules/${encodeURIComponent(bundle)}/${file}`;
