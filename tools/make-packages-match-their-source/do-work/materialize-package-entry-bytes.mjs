#!/usr/bin/env node
// Package-owned materialize-package-entry-bytes CLI.
//
// DEEP FIX for the fresh-whole-set-admit chicken-and-egg (L055):
// `admit-package-set-runtime` COMPILES source but CANNOT run esbuild, so it
// consumes package-entry bytes as PRE-BUILT `stored_bytes` inputs and raises
// BRTK3003 when a declared `bitfield-package-entry` names an entry_bytes
// stored_bytes that is not materialized. The existing `build-package-entry-bytes.mjs`
// only materializes via LIVE-WRITE to a running app (`liveWrite` branch); in
// non-live mode it builds and DISCARDS the streams. That live-only path is the
// chicken-and-egg: a FRESH standalone admit has no running app to write to.
//
// This CLI closes the gap at its root by calling `materializePackageEntryBytes`
// (materialize-package-entry-bytes-lib.mjs) over the whole set, or over the
// packages named in BITFIELD_PACKAGE_NAMES. The package-owned front door with the
// same body, taking `--package` flags instead of an env var, is
// `packages/make-packages-match-their-source/do-work/build-entry-bytes-for-chosen-packages.mjs`.
//
// Prereq: entry-scope source must exist first (run `write-package-entry-scopes.mjs`),
// and the set's node_modules must resolve `@bitfield/slot-protocol` +
// `@bitfield/runtime-kit` (esbuild resolution). Usage:
//   node materialize-package-entry-bytes.mjs <package-set-root>

import { materializePackageEntryBytes } from './materialize-package-entry-bytes-lib.mjs';
import { resolve } from 'node:path';

const setRoot = resolve(process.argv[2] ?? process.cwd());
const packageNames = process.env.BITFIELD_PACKAGE_NAMES
  ? process.env.BITFIELD_PACKAGE_NAMES.split(',')
  : null;
const result = await materializePackageEntryBytes({ setRoot, packageNames });
if (result.failed > 0) process.exit(1);
