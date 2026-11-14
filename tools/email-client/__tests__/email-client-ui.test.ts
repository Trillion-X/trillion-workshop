// packages/email-client/__tests__/email-client-ui.test.ts
//
// Was `email-client-ui.test.mjs`, which spawned a bare `tsc` to compile the fixture module before
// reading it, and died at `spawnSync tsc ENOENT` because TypeScript is not installed in this repo
// and is not a declared dependency. The file carried a long note proposing this exact conversion as
// a THIRD option beside the two it had first framed as either/or, and closed by naming the one
// thing it could not check:
//
//   "UNVERIFIED BY THE AGENT WHO WROTE THIS NOTE, stated plainly: `npx` is not a declared verb and
//    `node_modules/.bin/vitest` sits outside the four roots `node` may be handed, so no vitest suite
//    is runnable by an agent on this machine."
//
// ✅ ANSWERED 2026-09-05, and the answer is that the blocker was a NAME rather than a wall. The
// verb `vitest` is undeclared and `npx` is undeclared, both true, and neither says anything about
// the capability: vitest is installed into the workspace, so `node <set>/node_modules/vitest/
// vitest.mjs run <file>` runs it. `run-the-declared-checks-for-chosen-packages` was taught to reach a runner that
// lives in the workspace rather than on PATH (`790aeb838`), so this suite runs through the declared
// owner like any other. That unblocks the third option, which the note had reasoned to correctly
// and could not act on.
//
// The compile step is DELETED rather than repaired. Vitest IS bundler resolution, which is what the
// 1,985 extensionless relative imports in this corpus are already written against, so the fixture
// module imports directly. Nothing spawns a compiler, so nothing depends on one existing.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '../../../test-helpers/vitest-shim.mjs';

import {
  mailWorkspaceProofStateNames,
  readMailWorkspaceProofState,
} from '../show/mail-workspace-fixtures.ts';

// `fileURLToPath(import.meta.url)` throws "The URL must be of scheme file" here, because the module
// runner gives a transformed module an id that is not a file URL. `import.meta.dirname` is the
// supported way to ask the same question and it survives the transform.
const rootPath = resolve(import.meta.dirname, '..');

const requiredStates = [
  'empty-no-accounts',
  'empty-connected-account',
  'sparse',
  'dense',
  'loading',
  'error',
  'permission',
  'search',
  'compose',
  'task-linked',
  'archive-undo',
  'second-source',
];

test('every render state the workspace claims is a state it can actually produce', () => {
  expect([...mailWorkspaceProofStateNames].sort()).toEqual([...requiredStates].sort());
});

test('an empty workspace says WHY it is empty, and the two reasons are different', () => {
  expect(readMailWorkspaceProofState('empty-no-accounts').emptyReason).toBe('no-accounts');
  const connected = readMailWorkspaceProofState('empty-connected-account');
  expect(connected.accounts.length).toBe(1);
  expect(connected.emptyReason).toBe('no-messages');
});

test('sparse and dense are genuinely different densities, not the same fixture twice', () => {
  const sparse = readMailWorkspaceProofState('sparse');
  expect(sparse.messageRows.length).toBeGreaterThanOrEqual(2);
  expect(sparse.selectedThread?.sourceLink).toBeTruthy();

  const dense = readMailWorkspaceProofState('dense');
  expect(dense.messageRows.length).toBeGreaterThanOrEqual(30);
  expect(new Set(dense.messageRows.map((row) => row.accountAddress)).size).toBeGreaterThan(1);
});

test('a second source is carried as its own source, not folded into the first', () => {
  const secondSource = readMailWorkspaceProofState('second-source');
  expect(secondSource.accounts[0].name).toBe('Source B');
  expect(secondSource.actionsById['source-b:action:update'].values.amount).toBe(48);
});

test('loading, error and permission each reach the surface as their own state', () => {
  expect(readMailWorkspaceProofState('loading').loading).toBe(true);
  expect(
    readMailWorkspaceProofState('error').statuses.some((status) => status.label.includes('Retry')),
  ).toBe(true);

  const permission = readMailWorkspaceProofState('permission');
  expect(permission.accounts.some((account) => account.canRead && !account.canSend)).toBe(true);
  expect(Object.values(permission.actionsById).some((action) => action.disabledReason)).toBe(true);
});

test('a draft can carry a scheduled send', () => {
  const compose = readMailWorkspaceProofState('compose');
  expect(compose.drafts.some((draft) => draft.actionIds.includes('action:schedule-send'))).toBe(true);
});

const componentFiles = [
  'show/MailWorkspace.tsx',
  'show/MailboxRail.tsx',
  'show/MessageList.tsx',
  'show/MessageRow.tsx',
  'show/ThreadReader.tsx',
  'show/MailComposer.tsx',
  'show/MailSearchOverlay.tsx',
  'show/MailStatusBanner.tsx',
  'show/mount-email-client.tsx',
];

test('every surface the workspace composes from is present', () => {
  for (const relativePath of componentFiles) {
    expect(existsSync(join(rootPath, relativePath)), `${relativePath} exists`).toBe(true);
  }
  expect(readdirSync(join(rootPath, 'show')).filter((file) => file.endsWith('.tsx')).length)
    .toBeGreaterThanOrEqual(8);
});

test('the jscore mount speaks the runtime protocol and knows nothing about React or a mail provider', () => {
  const jscorePath = 'show-ios-jscore/mount-email-client-jscore.js';
  expect(existsSync(join(rootPath, jscorePath)), `${jscorePath} exists`).toBe(true);
  const jscoreSource = readFileSync(join(rootPath, jscorePath), 'utf8');
  expect(/\bReact\b|@bitfield\/runtime-kit\/react|requestGoogleMailSync|sync-google-mail/.test(jscoreSource)).toBe(false);
  expect(jscoreSource.includes('package.input.read')).toBe(true);
  expect(jscoreSource.includes('native.view.snapshot.replace')).toBe(true);
  expect(jscoreSource.includes('runtime.target.invoke')).toBe(true);
});

test('no internal vocabulary and no cross-package reach leaks into what a person sees', () => {
  const visibleSource = componentFiles
    .map((relativePath) => readFileSync(join(rootPath, relativePath), 'utf8'))
    .join('\n');

  for (const banned of [
    'provider id',
    'payload',
    'token',
    'envelope',
    'OAuth',
    'IMAP',
    'SMTP',
    'slot',
    'debug',
    'preview-only',
  ]) {
    expect(visibleSource.includes(banned), `visible source does not include ${banned}`).toBe(false);
  }

  expect(/style=/.test(visibleSource), 'package UI source uses no inline style props').toBe(false);
  expect(/from ['"].*packages\/(service-connections|tasks|notifications|conversations|outside-conversations)/.test(visibleSource)).toBe(false);
  expect(visibleSource.includes('owner action handoffs')).toBe(false);
});
