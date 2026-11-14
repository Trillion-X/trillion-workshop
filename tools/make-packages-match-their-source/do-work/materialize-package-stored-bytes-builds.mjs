#!/usr/bin/env node

// Package-owned materialization of install-facing stored_bytes build profiles before a fresh
// package-set compile. This is intentionally narrower than a process engine:
// it accepts one-step, publication-free Node build profiles only, writes the
// declared bytes inside their package, and records `source_path` BESIDE the `build`
// that produced it. Runtime behavior remains DATA-owned by Runtime Kit.
//
// The two fields answer different questions and neither replaces the other:
// `source_path` says where the bytes are, `build` says what makes them. Writing the
// first is not a reason to delete the second, and doing so is what stranded three
// process scripts in hosted-public-app.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILT_STORED_BYTES_DIR = 'built-stored-bytes';
const INHERITED_ENVIRONMENT = ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'NO_COLOR', 'NODE_OPTIONS'];

function fail(message) {
  throw new Error(`materialize-package-stored-bytes-builds: ${message}`);
}

function safeSegment(value, label) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    fail(`${label} must be one safe path segment`);
  }
  return value;
}

function inside(root, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath) fail(`${label} is required`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relation = path.relative(resolvedRoot, resolved);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    fail(`${label} resolves outside its package`);
  }
  return resolved;
}

function declaredNodeStep(build, packageName, storedBytesName) {
  const steps = build?.sequence?.steps;
  if (!Array.isArray(steps) || steps.length !== 1) {
    fail(`${packageName}/${storedBytesName} must declare exactly one build step`);
  }
  const step = steps[0];
  const argv = step?.process?.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv[0] !== 'node') {
    fail(`${packageName}/${storedBytesName} is not a supported Node build profile`);
  }
  const publications = step?.process?.containment?.publications;
  if (Array.isArray(publications) && publications.length > 0) {
    fail(`${packageName}/${storedBytesName} declares publications and cannot be materialized offline`);
  }
  if ((step?.predecessor_outputs?.length ?? 0) !== 0) {
    fail(`${packageName}/${storedBytesName} has predecessor outputs and requires the full process engine`);
  }
  const output = build?.output;
  if (!output || output.step !== step.name || typeof output.mount_path !== 'string' || !output.mount_path) {
    fail(`${packageName}/${storedBytesName} has an incoherent build output`);
  }
  return step;
}

function buildEnvironment(declared = {}) {
  const inherited = Object.fromEntries(
    INHERITED_ENVIRONMENT
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  return { ...inherited, ...declared };
}

function resolveWorkspaceArgumentBindings(argv, bindings, workspaceRoot, label) {
  const resolved = [...argv];
  const claimed = new Set();
  for (const binding of bindings?.arguments ?? []) {
    const index = binding?.index;
    if (!Number.isInteger(index) || index <= 0 || index >= resolved.length || claimed.has(index)) {
      fail(`${label} workspace argument binding index is invalid or duplicated`);
    }
    claimed.add(index);
    if (!Array.isArray(binding.parts) || binding.parts.length === 0) {
      fail(`${label} workspace argument binding parts are required`);
    }
    resolved[index] = binding.parts.map((part) => {
      if (part?.kind === 'literal' && typeof part.value === 'string' && !part.value.includes('\0')) {
        return part.value;
      }
      if (part?.kind === 'workspace_root') return path.resolve(workspaceRoot);
      if (part?.kind === 'workspace_path' && Array.isArray(part.segments)) {
        const relative = part.segments.map((segment) => safeSegment(segment, `${label} workspace path segment`)).join('/');
        return inside(workspaceRoot, relative, `${label} workspace path`);
      }
      fail(`${label} workspace argument binding part is unsupported`);
    }).join('');
  }
  return resolved.map((argument, index) => {
    if (typeof argument !== 'string' || !argument.startsWith('__PACKAGE_SET_ROOT__/')) return argument;
    if (claimed.has(index)) fail(`${label} binds argument ${index} twice`);
    const relative = argument.slice('__PACKAGE_SET_ROOT__/'.length);
    return inside(workspaceRoot, relative, `${label} package-set-root argument`);
  });
}

/** Write `bytes` to `destination` only if what is there differs, and report whether it wrote.
 *
 *  A build that produces identical output should leave the tree alone. Rewriting the same bytes
 *  moves an mtime, and an mtime is what several tools in this repo read to decide whether
 *  something is stale, so an unconditional write manufactures staleness out of a no-op. The
 *  manifest write at the bottom of this file already reasoned this way about itself.
 *
 *  `mode` null means the destination's mode is not this caller's business (a receipt). When a mode
 *  IS given it is applied even on a byte match, because a correct file with the wrong mode bits is
 *  a real failure this file has already been bitten by, and a byte comparison cannot see it. */
async function writeFileWhenDifferent(destination, bytes, mode) {
  if (existsSync(destination)) {
    const current = await readFile(destination);
    if (current.equals(bytes)) {
      if (mode !== null && mode !== undefined) {
        const { mode: currentMode } = await stat(destination);
        if ((currentMode & 0o777) !== mode) await chmod(destination, mode);
      }
      return false;
    }
  }
  await writeFile(destination, bytes, mode === null || mode === undefined ? undefined : { mode });
  return true;
}

async function materializeThing({ packageSetRoot, packageRoot, packageName, thing, options }) {
  const storedBytesName = safeSegment(thing.name, `${packageName} stored_bytes.name`);
  const step = declaredNodeStep(thing.build, packageName, storedBytesName);
  const argv = resolveWorkspaceArgumentBindings(
    step.process.argv,
    step.workspace_bindings,
    packageSetRoot,
    `${packageName}/${storedBytesName}`,
  );
  const workspaceOwner = path.join(
    homedir(), '.bitfield', 'runtime-kit', 'build-workspaces', 'make-packages-match-their-source',
  );
  await mkdir(workspaceOwner, { recursive: true, mode: 0o700 });
  const runRoot = await mkdtemp(path.join(workspaceOwner, 'stored-bytes-build.'));
  try {
    const requestPath = path.join(runRoot, 'request.json');
    const outputPath = path.join(runRoot, 'output.bytes');
    // Somewhere for the producer to report what it consumed. Offering the path costs
    // nothing and commits no producer: one that writes nothing here is materialized exactly
    // as before. One that does gets its blob attested, which is the difference between a
    // checked-in binary a reader can verify and one trusted on faith.
    const receiptPath = path.join(runRoot, 'source-closure.json');
    const request = {
      ...(thing.build.request ?? {}),
      package: packageName,
      stored_bytes: storedBytesName,
      output_file: thing.build.output.mount_path,
    };
    await writeFile(requestPath, `${JSON.stringify(request)}\n`);
    const cwd = inside(packageRoot, step.process.cwd ?? '.', `${packageName}/${storedBytesName} cwd`);
    const timeout = Number.isFinite(step.process.timeout_ms) ? step.process.timeout_ms : 120000;
    // A declared `node` argv is owned by the runtime already executing this
    // materializer. Resolving it here keeps stored-byte builds reproducible from
    // harness shells whose PATH does not expose Node.
    const executable = argv[0] === 'node' ? process.execPath : argv[0];
    const result = spawnSync(executable, argv.slice(1), {
      cwd,
      env: {
        ...buildEnvironment(step.process.env ?? {}),
        BITFIELD_PACKAGE_BUILD_OUTPUT: outputPath,
        BITFIELD_PACKAGE_BUILD_REQUEST: requestPath,
        BITFIELD_PACKAGE_BUILD_RECEIPT: receiptPath,
      },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout,
    });
    if (result.error) fail(`${packageName}/${storedBytesName} failed to start: ${result.error.message}`);
    const expectedCode = step.process.expected_termination?.code ?? 0;
    if (result.signal || result.status !== expectedCode) {
      const diagnostic = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().slice(-4000);
      fail(`${packageName}/${storedBytesName} exited ${result.status ?? result.signal}: ${diagnostic}`);
    }
    if (!existsSync(outputPath)) fail(`${packageName}/${storedBytesName} produced no output bytes`);
    const bytes = await readFile(outputPath);
    const relativeOutput = `${BUILT_STORED_BYTES_DIR}/${storedBytesName}`;
    const finalOutput = inside(packageRoot, relativeOutput, `${packageName}/${storedBytesName} output`);
    await mkdir(path.dirname(finalOutput), { recursive: true });
    // Carry the build output's mode. package-compiler derives each selected row's
    // `executable` from the source file's mode bits, and the app-open bundle records
    // and restores that mode on the customer machine. A byte copy that dropped the
    // mode shipped the launcher's freshly compiled executable as 0644, and the
    // authority refused it: "does not point to an executable file" (2026-09-05).
    const { mode } = await stat(outputPath);
    // Write ONLY when the bytes differ, which is the rule the manifest write at the bottom of
    // this file already follows and states. Applying it to one of three writes made the other two
    // churn: a re-run rewrote byte-identical output and its receipt every time, moving mtimes
    // across every package carrying a build block, and 36 manifests carry one. On a branch several
    // sessions share, that is a diff nobody made. The mode is still corrected on a match, because
    // an identical file with the wrong mode bits is the exact failure recorded above.
    const wroteBytes = await writeFileWhenDifferent(finalOutput, bytes, mode & 0o777);
    if (existsSync(receiptPath)) {
      const relativeReceipt = `${relativeOutput}.source-closure.json`;
      await writeFileWhenDifferent(
        inside(packageRoot, relativeReceipt, `${packageName}/${storedBytesName} receipt`),
        await readFile(receiptPath),
        null,
      );
      thing.source_closure_receipt_path = relativeReceipt;
    }
    thing.source_path = relativeOutput;
    if (options?.consumeMaterializedBuild) delete thing.build;
    // In the SOURCE corpus the `build` block stays: deleting it there made "already
    // materialized" and "never had instructions" the same state and stranded rebuilds.
    // A PROJECTION may explicitly consume the block after materialization so the
    // package-set compiler admits the produced bytes instead of rebuilding them inside
    // Darwin process containment.
    return { byteLength: bytes.length, wroteBytes };
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}

export async function materializePackageStoredBytesBuilds(setRoot, options = {}) {
  const packageSetRoot = path.resolve(setRoot);
  const packagesRoot = path.join(packageSetRoot, 'packages');
  if (!existsSync(packagesRoot)) fail(`no packages/ under ${packageSetRoot}`);
  const selected = options.packageNames ? new Set(options.packageNames) : null;
  const selectedBytes = options.storedBytesNames ? new Set(options.storedBytesNames) : null;
  const packageNames = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && (!selected || selected.has(entry.name)))
    .map((entry) => entry.name)
    .sort();
  if (selected && packageNames.length !== selected.size) {
    fail(`unknown packages: ${[...selected].filter((name) => !packageNames.includes(name)).join(', ')}`);
  }

  const results = [];
  for (const packageName of packageNames) {
    const packageRoot = path.join(packagesRoot, packageName);
    const dataPath = path.join(packageRoot, 'things-to-store-and-run.json');
    if (!existsSync(dataPath)) continue;
    const originalText = await readFile(dataPath, 'utf8');
    const data = JSON.parse(originalText);
    for (const thing of data.things ?? []) {
      if (thing?.type !== 'stored_bytes' || !thing.build || (selectedBytes && !selectedBytes.has(thing.name))) continue;
      const { byteLength, wroteBytes } = await materializeThing({
        packageSetRoot, packageRoot, packageName, thing,
        options,
      });
      results.push({
        package: packageName,
        stored_bytes: thing.name,
        byte_length: byteLength,
        wrote_bytes: wroteBytes,
      });
    }
    // Write the manifest back ONLY when its meaning changed. It used to write whenever a
    // build ran, and a re-serialization is not a no-op: it reflows every array the author
    // kept on one line. The manifest is itself a build INPUT of any package entry that
    // imports it (`import contract from '../things-to-store-and-run.json'`), and that
    // entry's source-closure receipt holds the manifest's exact multihash. So a run that
    // materialized the same blob into the same declared path still rewrote the bytes under
    // a valid receipt, and the compiler refused the set: BRTK2013 on
    // hosted-public-app/package-store-metadata, first ship after the checks row landed
    // (2026-09-05). Same meaning, same bytes; a different meaning is the only reason to touch
    // a file that other receipts attest.
    const originalMeaning = JSON.stringify(JSON.parse(originalText));
    if (JSON.stringify(data) !== originalMeaning) {
      await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`);
    }
  }
  return results;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  const setRoot = process.argv[2] ?? process.cwd();
  const packageNames = process.argv
    .flatMap((value, index) => value === '--package' ? [process.argv[index + 1]] : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  const results = await materializePackageStoredBytesBuilds(setRoot, {
    packageNames: packageNames.length > 0 ? packageNames : null,
    consumeMaterializedBuild: process.argv.includes('--consume-materialized-build'),
  });
  process.stdout.write(`${JSON.stringify({ materialized: results.length, results })}\n`);
}
