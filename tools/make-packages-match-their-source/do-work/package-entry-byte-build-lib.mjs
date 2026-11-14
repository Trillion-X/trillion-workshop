import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { parseAst } from 'rollup/parseAst';
import { makeHashCodeHexFromBytes } from '@bitfield/slot-protocol';
import {
  createNoReplyCallLoweringPlugin,
  createNoReplyCallLoweringState,
  generatedNoReplyWriterPrefix,
  NO_REPLY_RUNTIME_NAMES,
  noReplyRuntimeNamesMissingFrom,
} from './package-entry-no-reply-lowering.mjs';
import { createReachPastTheEnginePlugin, readReachClasses } from './package-entry-reach-past-the-engine.mjs';
import { createPackageEntryAtAliasPlugin } from './package-entry-at-alias.mjs';

const entryScopeBindingsFile = 'entry-scope-bindings.json';
const sourceClosureBasisSchema = 'bitfield.package-entry-source-closure/hash-bound-build-inputs';
const sourceClosureReceiptSchema = 'bitfield.package-entry-source-closure-receipt/hash-bound-build-inputs';
const entryByteBuilderId = 'bitfield.package-entry-byte-builder/declared-source-archive';

/* WHO WROTE THE RECEIPTS ON DISK, as a hash of this builder's own source.
 *
 *  The currency check beside this file answers "did the package's inputs change". It cannot
 *  answer "was this receipt written by the builder that runs today", and those are different
 *  questions with the same consequence. The builder can change what it emits while every input
 *  it reads stays byte-identical, and then every receipt on disk is stale in a way no input hash
 *  can see.
 *
 *  IT ALREADY HAPPENED, TWICE OVER, AND IS WHY THIS EXISTS. Every one of the 322 receipts in the
 *  set carried a `sha256` field beside its `multihash`. The builder stopped emitting that field
 *  and the compiler's reader declares `deny_unknown_fields`, so each of those receipts became
 *  unreadable to the consumer while remaining perfectly current by input hash. A projection ran
 *  for fourteen minutes and stopped at the first one (BRTK2013, package `access-rule`). The
 *  wider case is worse and silent: an edit to a byte-shaping plugin under `scripts/` changes the
 *  artifact this builder produces, and no package input moved, so the skip would ship stale bytes
 *  with nothing reported.
 *
 *  The receipt's `builder` field cannot carry this. It is inside the hashed basis, and the Rust
 *  verifier reconstructs that basis using its OWN copy of the id constant, so a content-derived
 *  id here would need the same hash hand-copied into Rust, which is a snapshot with a hidden
 *  expiry (L216) in the one place a mismatch is silent. So the identity lives BESIDE the tree,
 *  in one stamp file, and never inside the attestation.
 *
 *  EVERY UNCERTAINTY OVER-INVALIDATES. An unreadable module, an unresolvable relative import, or
 *  no stamp at all means "rebuild everything", because a needless rebuild costs seconds and a
 *  wrong skip costs bytes nobody can explain later. */
export async function entryByteBuilderSourceIdentity({ entryFile = fileURLToPath(import.meta.url) } = {}) {
  const seen = new Map();
  const pending = [entryFile];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    let source;
    try {
      source = await readFile(file, 'utf8');
    } catch {
      // Unreadable module: record the failure under its own name so the identity differs from
      // any run that read it, which rebuilds rather than trusting a partial walk.
      seen.set(file, 'unreadable');
      continue;
    }
    seen.set(file, makeHashCodeHexFromBytes(new TextEncoder().encode(source)));
    // Relative specifiers only. A bare specifier is an installed dependency, pinned by the
    // dependency store rather than by this walk.
    for (const match of source.matchAll(/from\s+'(\.[^']*)'|import\s+'(\.[^']*)'/g)) {
      const specifier = match[1] ?? match[2];
      pending.push(path.resolve(path.dirname(file), specifier));
    }
  }
  // Keyed by path relative to the builder's own directory. An absolute path would make the
  // identity differ between two machines holding identical source, and a bare basename would
  // let two same-named modules in different directories collide.
  const builderDir = path.dirname(entryFile);
  const members = [...seen.entries()]
    .map(([file, hash]) => [path.relative(builderDir, file), hash])
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(members)));
}
export async function buildPackageEntryBytes(options) {
  return (await buildPackageEntryArtifact(options)).bytes;
}

export async function buildPackageEntryArtifact({ packageRoot, entryName, storedBytesName = `entry-bytes-${entryName}` }) {
  const packageName = path.basename(packageRoot);
  const builderInputs = await resolvePackageEntryBuilderInputs({ packageRoot });
  const {
    packageSetRoot,
    dependencyRoot,
    runtimeKitRoot,
    runtimeKitPackageJson,
    externalAliases,
  } = builderInputs;
  const packageData = JSON.parse(
    await readFile(path.join(packageRoot, 'things-to-store-and-run.json'), 'utf8'),
  );
  const entryScopeBindings = await readEntryScopeBindings(packageName, packageRoot);
  const entryPayload = findEntryPayload(packageData, entryName);
  const dynamicReadSelectorPolicy = dynamicReadSelectorPolicyForEntry(entryPayload, packageName, entryName);
  const targetEntryNames = packageTargetEntryNames(packageData);
  const targetPayload = findTargetPayload(packageData, entryName);
  if (targetPayload) {
    const targetSourcePath = targetPayload.source_path ?? entryPayload.source_path;
    const targetExportName = targetPayload.export_name ?? entryPayload.export_name;
    if (typeof targetSourcePath !== 'string' || !targetSourcePath) {
      throw new Error(`${packageName}:${entryName} package target source_path is missing`);
    }
    if (typeof targetExportName !== 'string' || !targetExportName) {
      throw new Error(`${packageName}:${entryName} package target export_name is missing`);
    }
    assertPackageTargetSourceUsesRuntimeContextSecond(
      packageName,
      entryName,
      targetExportName,
      await readFile(packageSourceModulePath(packageRoot, targetSourcePath), 'utf8'),
    );
  }
  assertEntrySourceSelfMounts(
    packageName,
    entryName,
    entryPayload.source_path,
    await readFile(packageSourceModulePath(packageRoot, entryPayload.source_path), 'utf8'),
    targetEntryNames.has(entryName),
  );
  const sharedScopeBinding = JSON.parse(
    await readFile(path.join(packageSetRoot, 'package-entry-scope-binding.json'), 'utf8'),
  ).scope_binding;
  const entryScopeRoot = path.join(packageRoot, '.bitfield-entry-scope', entryName);
  const entryFile = path.join(entryScopeRoot, 'entry.ts');
  const runtimeKitFile = path.join(entryScopeRoot, 'runtime-kit.ts');
  const runtimeKitReactFile = path.join(entryScopeRoot, 'runtime-kit-react.ts');
  if (!existsSync(entryFile)) {
    throw new Error(`package entry scope is missing: ${entryFile}`);
  }
  const noReplyScopeBinding = entryScopeBinding(packageName, entryName, {
    sharedScopeBinding,
    packageEntryScopeBinding: entryScopeBindings.get(entryName),
  });
  let noReplyLowering = createNoReplyCallLoweringState(noReplyScopeBinding);

  const reachClasses = await readReachClasses(packageSetRoot);
  const entryFileText = await readFile(entryFile, 'utf8');
  // `keepRuntimeNames` builds the entry through a wrapper that re-exports those
  // runtime functions, so the bundler keeps them for the prepended writers.
  const buildEntry = (loweringState, keepRuntimeNames = []) => esbuild.build({
    ...(keepRuntimeNames.length === 0
      ? { entryPoints: [entryFile] }
      : {
          stdin: {
            // The entry's own text, unchanged, so its exports are exactly what
            // they were. A `export * from './entry'` wrapper was tried first and
            // the bundle came out exporting nothing but the kept names.
            contents: [
              entryFileText,
              `export { ${keepRuntimeNames.map((name, index) => `${name} as bitfieldGeneratedNoReplyKeep${index}`).join(', ')} } from '@bitfield/runtime-kit/internal/owner-surface';`,
            ].join('\n'),
            resolveDir: entryScopeRoot,
            sourcefile: 'entry.ts',
            loader: 'ts',
          },
        }),
    absWorkingDir: packageRoot,
    bundle: true,
    platform: targetEntryNames.has(entryName) ? 'node' : 'browser',
    format: 'esm',
    jsx: 'automatic',
    outfile: path.join(packageRoot, '.bitfield-entry-byte-memory', `${entryPayload.entry_name}.js`),
    write: false,
    nodePaths: [dependencyRoot],
    alias: {
      '@bitfield/runtime-kit/internal/owner-surface': path.join(
        runtimeKitRoot,
        'src',
        'internal',
        'owner-surface.ts',
      ),
      '@bitfield/runtime-kit/protocol': path.join(
        runtimeKitRoot,
        'src',
        'protocol',
        'index.ts',
      ),
      ...externalAliases,
    },
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    loader: {
      '.css': 'text',
      '.js': 'jsx',
      '.jsx': 'jsx',
      '.ts': 'ts',
      '.tsx': 'tsx',
      '.json': 'json',
      '.sh': 'text',
    },
    plugins: [
      createPackageEntryAtAliasPlugin({ packageSetRoot }),
      // THE BORDER, registered before every other load plugin so a refused file never reaches a
      // transform. A package module that reaches past the engine (file, clock, entropy, process,
      // network, environment) without its manifest declaring ownership of that reach is a build
      // failure here, and nothing downstream ever sees the bundle. Classes are DATA at the set
      // root; ownership is a record in the package's own manifest. See
      // `package-entry-reach-past-the-engine.mjs`.
      createReachPastTheEnginePlugin({
        packageSetRoot,
        reachClasses,
        // A target is a derivation: the engine runs it against the log, so what it computes
        // must be reproducible from the log alone. A surface is not; its clock and randomness
        // are inputs the log records. The DATA file says which classes care about the difference.
        isDerivation: targetEntryNames.has(entryName),
      }),
      createExactAliasPlugin({
        '@bitfield/runtime-kit': runtimeKitFile,
      }),
      createPackageReadScopePlugin({ packageSetRoot, packageRoot, runtimeKitReactFile }),
      createNoReplyCallLoweringPlugin({
        root: packageSetRoot,
        state: loweringState,
      }),
    ],
    metafile: true,
  });
  let result = await buildEntry(noReplyLowering);
  const entryBundleFile = (built) => built.outputFiles?.find((file) => file.path.endsWith(`${entryName}.js`))
    ?? built.outputFiles?.[0];
  if (entryBundleFile(result)) {
    const missingRuntime = noReplyRuntimeNamesMissingFrom(
      noReplyLowering.writers,
      new TextDecoder().decode(entryBundleFile(result).contents),
    );
    if (missingRuntime.length > 0) {
      noReplyLowering = createNoReplyCallLoweringState(noReplyScopeBinding);
      result = await buildEntry(noReplyLowering, [...NO_REPLY_RUNTIME_NAMES]);
      const stillMissing = noReplyRuntimeNamesMissingFrom(
        noReplyLowering.writers,
        new TextDecoder().decode(entryBundleFile(result)?.contents ?? new Uint8Array()),
      );
      if (stillMissing.length > 0) {
        throw new Error(
          `${packageName}:${entryName} rewrote its sends into writes that call ${stillMissing.join(', ')}, `
          + 'and the bundle does not define them. Shipped, it would fail the first time it runs.',
        );
      }
    }
  }
  if (process.env.BITFIELD_ENTRY_META_DIR) {
    mkdirSync(process.env.BITFIELD_ENTRY_META_DIR, { recursive: true });
    writeFileSync(
      path.join(process.env.BITFIELD_ENTRY_META_DIR, `${packageName}__${entryName}.json`),
      JSON.stringify(result.metafile, null, 2),
    );
  }

  const bundle = entryBundleFile(result);
  if (!bundle) throw new Error(`${packageName}:${entryName} produced no entry output bytes`);
  // The app calls an entry by its declared export name. A bundle without it
  // builds cleanly and fails only when someone uses it.
  const declaredExport = entryPayload.export_name;
  if (typeof declaredExport === 'string' && declaredExport) {
    const exported = [...new TextDecoder().decode(bundle.contents).matchAll(/export\s*\{([^}]*)\}/g)]
      .flatMap((match) => match[1].split(',').map((item) => item.trim().split(/\s+as\s+/).pop()));
    if (!exported.includes(declaredExport)) {
      throw new Error(`${packageName}:${entryName} bundle does not export ${declaredExport}; it exports ${exported.join(', ') || 'nothing'}.`);
    }
  }
  const source = `${generatedNoReplyWriterPrefix(noReplyLowering.writers)}${new TextDecoder().decode(bundle.contents)}`;
  // The assertions below grep the source for READABLE identifiers
  // (createRoot/hydrateRoot, useBitfieldData('name'), createReadScopeFromPackageData),
  // so they MUST run on the unminified source — minifying first would rename those
  // and either false-throw the self-mount guard or silently defeat the input-scope
  // checks. Validate readable source, THEN minify the validated bytes for delivery.
  await assertFinalEntryReadScopeContract({
    packageName,
    entryName,
    packageSetRoot,
    runtimeKitReactFile,
    bundleSource: source,
    dynamicReadSelectorPolicy,
  });
  assertBundleSourceDoesNotUseBundledPackageDataReadScope(packageName, source);
  assertReactEntryBundleSelfMounts(packageName, entryName, source, targetEntryNames.has(entryName));
  // Ship minified entry-bytes: esbuild built UNMINIFIED, so every package's payload
  // was ~2x its needed size — the dominant surface-open latency cost (payload
  // transfer + base64 + compile). Minifying here (a semantics-preserving transform
  // on the already-validated, already-bundled ESM) roughly halves it for EVERY
  // package/app, structurally — no per-deploy hand-minification.
  // esbuild can retain absolute alias targets (or paths relative to the process
  // cwd) as internal module labels. Those labels are inert, but they leak the
  // build machine into otherwise portable package bytes and make the sealed
  // distribution depend on where it happened to be compiled. Normalize the
  // package-set root before the final semantics-preserving transform.
  const portableSource = normalizeEntryBundleBuildPaths(source, packageSetRoot, process.cwd(), {
    moduleRoot: packageRoot,
    externalRoots: [dependencyRoot, runtimeKitRoot, ...Object.values(externalAliases)],
  });
  const minified = await esbuild.transform(portableSource, { minify: true, loader: 'js', format: 'esm', legalComments: 'none' });
  const bytes = new TextEncoder().encode(escapeRawControlCharacters(minified.code));
  const buildInputs = await packageEntryBuildInputReceipt({
    packageRoot,
    packageSetRoot,
    dependencyRoot,
    runtimeKitRoot,
    externalAliases,
    metafile: result.metafile,
  });
  const packageLocalInputs = buildInputs.filter((input) => input.kind === 'package-source');
  const externalInputClosures = externalBuildInputClosures(
    buildInputs.filter((input) => input.kind !== 'package-source'),
  );
  const closureBasis = {
    schema: sourceClosureBasisSchema,
    package: packageName,
    entry_name: entryName,
    stored_bytes: storedBytesName,
    builder: entryByteBuilderId,
    package_local_inputs: packageLocalInputs,
    external_input_closures: externalInputClosures,
    build_input_count: buildInputs.length,
  };
  const closureBytes = new TextEncoder().encode(JSON.stringify(closureBasis));
  return {
    bytes,
    receipt: {
      ...closureBasis,
      schema: sourceClosureReceiptSchema,
      closure_multihash: makeHashCodeHexFromBytes(closureBytes),
      artifact_multihash: makeHashCodeHexFromBytes(bytes),
      artifact_byte_length: bytes.byteLength,
    },
  };
}

/**
 * Keep generated JavaScript text-safe without changing the value of string and
 * template-literal separators. Esbuild may emit C0 characters literally when a
 * bundled dependency contains values such as `"\u0000"`. Those bytes are valid
 * inside JavaScript strings, but they make the stored source impossible to
 * inspect and transport through text-only authoring and review paths. A Unicode
 * escape evaluates to the same character at runtime and remains ordinary ASCII
 * in the artifact itself.
 */
export function escapeRawControlCharacters(source) {
  return source.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

// A source-closure receipt for a built blob that is NOT a package entry bundle.
//
// The two receipts differ only in what the blob IS. Everything underneath, resolving the
// portable roots, labelling each input, hashing it, and grouping the external half into
// verifiable closures, is the same work and is the same code below. A process script built
// by `build-node-process-bytes.mjs` deserves the same attestation an entry bundle gets, and
// until 2026-09-05 got none, which is why three rows in `hosted-public-app` are served from
// bytes that name nothing that produced them.
//
// It carries no `entry_name`, because it has none. It carries `builder` for the same reason
// the entry receipt does: the reader needs to know which producer's claim this is.
const storedBytesSourceClosureBasisSchema = 'bitfield.stored-bytes-source-closure/hash-bound-build-inputs';
export const storedBytesSourceClosureReceiptSchema = 'bitfield.stored-bytes-source-closure-receipt/hash-bound-build-inputs';

export async function hashBoundBuildInputReceipt({
  packageRoot,
  packageName,
  storedBytesName,
  builder,
  artifactBytes,
  metafile,
}) {
  const resolved = await resolvePackageEntryBuilderInputs({ packageRoot });
  const buildInputs = await packageEntryBuildInputReceipt({
    packageRoot,
    packageSetRoot: resolved.packageSetRoot,
    dependencyRoot: resolved.dependencyRoot,
    runtimeKitRoot: resolved.runtimeKitRoot,
    externalAliases: resolved.externalAliases,
    metafile,
  });
  const basis = {
    schema: storedBytesSourceClosureBasisSchema,
    package: packageName,
    stored_bytes: storedBytesName,
    builder,
    package_local_inputs: buildInputs.filter((input) => input.kind === 'package-source'),
    external_input_closures: externalBuildInputClosures(
      buildInputs.filter((input) => input.kind !== 'package-source'),
    ),
    build_input_count: buildInputs.length,
  };
  const closureBytes = new TextEncoder().encode(JSON.stringify(basis));
  return {
    ...basis,
    schema: storedBytesSourceClosureReceiptSchema,
    closure_multihash: makeHashCodeHexFromBytes(closureBytes),
    artifact_multihash: makeHashCodeHexFromBytes(artifactBytes),
    artifact_byte_length: artifactBytes.byteLength,
  };
}

function externalBuildInputClosures(inputs) {
  const byOwner = new Map();
  for (const input of inputs) {
    const owner = input.path.startsWith('peer/')
      ? input.path.split('/').slice(0, 2).join('/')
      : input.path.split('/')[0];
    const rows = byOwner.get(owner) ?? [];
    rows.push(input);
    byOwner.set(owner, rows);
  }
  return [...byOwner.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([owner, rows]) => {
    const canonical = rows.sort((left, right) => left.path.localeCompare(right.path));
    const bytes = new TextEncoder().encode(JSON.stringify(canonical));
    return {
      owner,
      input_count: canonical.length,
      multihash: makeHashCodeHexFromBytes(bytes),
      // The hashes above are computed from `canonical`, so WITHOUT the members a reader
      // can verify nothing: it cannot recompute the closure without running the build
      // that produced it. The local half of the receipt is enumerated with per-file
      // hashes and is re-derivable; this half was attested and was not, which is the
      // real reason a pre-build currency check could not be made sound. Enumerating the
      // members changes no hash, because both are taken from `canonical` before this
      // object exists. A reader that finds no `inputs` is looking at a receipt written
      // before this field and must rebuild rather than assume.
      inputs: canonical,
    };
  });
}

export async function packageEntryBuildInputReceipt({
  packageRoot,
  packageSetRoot,
  dependencyRoot,
  runtimeKitRoot,
  externalAliases,
  metafile,
}) {
  const roots = [
    { root: packageRoot, label: 'package', kind: 'package-source' },
    { root: runtimeKitRoot, label: 'runtime-kit', kind: 'builder-external' },
    ...Object.entries(externalAliases).map(([name, root]) => ({
      root,
      // Keep the established portable receipt namespace stable. It predates
      // dependency aliasing and is an owner label, not a package-manager claim.
      label: `peer/${name}`,
      kind: 'builder-external',
    })),
    ...(dependencyRoot ? [{
      root: dependencyRoot,
      label: 'external-dependency-store',
      kind: 'builder-external',
    }] : []),
    // Sibling-package source (`packages/ui`, `packages/screen-look`, ...) is a legitimate
    // input since 2026-08-21: shared UI is imported, not copied, and 22,837 receipt rows
    // carry `package-set/packages/...`. The owner is the `packages/` folder, not the whole
    // set root: the widening accepted anything under the set root, which reopened the
    // exact hole the closure tests were written against (a `desktop/` seed, a `process-host/`
    // helper, a symlink out to product source). Every real receipt row sits under
    // `packages/`, so narrowing changes no hash. `label` and `root` are separate on purpose:
    // the label keeps the receipt path `package-set/packages/<pkg>/...` byte-identical.
    ...(packageSetRoot ? [{
      root: path.join(packageSetRoot, 'packages'),
      labelRoot: packageSetRoot,
      label: 'package-set',
      // Semantically this is sibling package source, not builder output. The kind is inside
      // the hashed closure rows, so renaming it rebuilds and republishes every bundle with a
      // shared-UI input; that is a set-wide republish lane, not a one-line edit.
      kind: 'builder-generated',
    }] : []),
  ].map((entry) => ({
    ...entry,
    root: realpathSync(path.resolve(entry.root)),
    labelRoot: realpathSync(path.resolve(entry.labelRoot ?? entry.root)),
  }))
    .sort((left, right) => right.root.length - left.root.length);
  const inputs = [];
  const seen = new Set();
  for (const inputName of Object.keys(metafile?.inputs ?? {}).sort()) {
    const absolute = realpathSync(path.resolve(
      packageRoot,
      inputName.replace(/\?(?:package-read-scope|raw)$/, ''),
    ));
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const matched = roots.find(({ root }) => {
      const relative = path.relative(root, absolute);
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    });
    if (!matched) {
      throw new Error(`package entry build input has no portable owner root: ${inputName}`);
    }
    let kind = matched.kind;
    const relative = path.relative(matched.labelRoot, absolute).split(path.sep).join('/');
    if (kind === 'package-source') {
      if (relative.startsWith('.bitfield-entry-scope/')) {
        kind = 'builder-generated';
      } else if (
        relative.startsWith('.bitfield-entry-byte-memory/')
        || relative.startsWith('built-stored-bytes/')
      ) {
        throw new Error(
          `generated output cannot be a package entry source input: ${inputName}`,
        );
      }
    }
    const bytes = await readFile(absolute);
    inputs.push({
      kind,
      path: `${matched.label}/${relative}`,
      multihash: makeHashCodeHexFromBytes(bytes),
      byte_length: bytes.byteLength,
    });
  }
  return inputs.sort((left, right) => left.path.localeCompare(right.path));
}

export function commonPathAncestor(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const resolved = paths.map((candidate) => path.resolve(candidate));
  let candidate = resolved[0];
  while (!resolved.every((value) => {
    const relative = path.relative(candidate, value);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  })) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  return path.dirname(candidate) === candidate ? null : candidate;
}

export function packageEntryArtifactPublicationDecision({ currentBytes, currentReceipt, nextArtifact }) {
  const nextReceiptText = `${JSON.stringify(nextArtifact.receipt, null, 2)}\n`;
  const sameBytes = currentBytes != null && Buffer.from(currentBytes).equals(Buffer.from(nextArtifact.bytes));
  const sameReceipt = typeof currentReceipt === 'string' && currentReceipt === nextReceiptText;
  return {
    disposition: sameBytes && sameReceipt ? 'reuse' : 'publish',
    receiptText: nextReceiptText,
  };
}

export function normalizeEntryBundleBuildPaths(
  source,
  packageSetRoot,
  processCwd = process.cwd(),
  portability = {},
) {
  if (typeof source !== 'string') throw new Error('entry bundle source must be a string');
  const options = Array.isArray(portability)
    ? { externalRoots: portability }
    : portability;
  const moduleRoot = path.resolve(options.moduleRoot ?? packageSetRoot);
  const rootSpecs = [
    { root: packageSetRoot, label: 'bitfield-package-set' },
    ...(options.externalRoots ?? []).map((root) => ({
      root,
      label: 'bitfield-builder-external',
    })),
  ];
  return rootSpecs.flatMap(({ root, label }) => {
    const absoluteRoot = path.resolve(root).split(path.sep).join('/');
    return [
      { needle: absoluteRoot, label },
      { needle: path.relative(processCwd, absoluteRoot).split(path.sep).join('/'), label },
      { needle: path.relative(moduleRoot, absoluteRoot).split(path.sep).join('/'), label },
    ];
  })
    .filter(({ needle }) => needle && needle !== '.' && needle !== '..')
    .sort((left, right) => right.needle.length - left.needle.length)
    .reduce(
      (portable, { needle, label }) => portable.split(`${needle}/`).join(`${label}/`),
      source,
    );
}

/**
 * One owner describes the installed inputs used by the canonical entry-byte
 * builder. Proof code consumes this resolver instead of approximating
 * esbuild's aliases from a second hard-coded list.
 */
export function packageEntryDependencyRoot({
  packageSetRoot,
  explicitRoot = process.env.BITFIELD_PACKAGE_ENTRY_DEPENDENCY_ROOT,
}) {
  if (explicitRoot !== undefined && !path.isAbsolute(explicitRoot)) {
    throw new Error('BITFIELD_PACKAGE_ENTRY_DEPENDENCY_ROOT must be an absolute path');
  }
  return realpathSync(explicitRoot ?? path.join(packageSetRoot, 'node_modules'));
}

export async function resolvePackageEntryBuilderInputs({ packageRoot }) {
  const packageSetRoot = path.resolve(packageRoot, '../..');
  const dependencyRoot = packageEntryDependencyRoot({ packageSetRoot });
  const runtimeKitRoot = realpathSync(path.join(
    dependencyRoot,
    '@bitfield',
    'runtime-kit',
  ));
  const runtimeKitPackageJsonPath = path.join(runtimeKitRoot, 'package.json');
  const runtimeKitPackageJson = JSON.parse(
    await readFile(runtimeKitPackageJsonPath, 'utf8'),
  );
  const externalDependencyNames = new Set([
    ...Object.keys(runtimeKitPackageJson.dependencies ?? {}),
    ...Object.keys(runtimeKitPackageJson.peerDependencies ?? {}),
  ]);
  const externalAliases = Object.fromEntries(
    [...externalDependencyNames].map((dependencyName) => [
      dependencyName,
      realpathSync(path.join(dependencyRoot, dependencyName)),
    ]),
  );
  return {
    packageSetRoot,
    dependencyRoot,
    runtimeKitRoot,
    runtimeKitPackageJson,
    runtimeKitPackageJsonPath,
    externalAliases,
    closureInputs: [
      {
        kind: 'runtime-kit-manifest',
        path: runtimeKitPackageJsonPath,
        followModules: false,
      },
      {
        kind: 'runtime-kit-owner-surface',
        path: path.join(runtimeKitRoot, 'src', 'internal', 'owner-surface.ts'),
        followModules: true,
      },
      {
        kind: 'runtime-kit-protocol',
        path: path.join(runtimeKitRoot, 'src', 'protocol', 'index.ts'),
        followModules: true,
      },
      ...Object.entries(externalAliases).map(([name, externalRoot]) => ({
        kind: `external:${name}`,
        path: externalRoot,
        followModules: false,
      })),
    ],
  };
}

export function packageSourceModulePath(packageRoot, sourcePath) {
  const requested = path.join(packageRoot, sourcePath);
  if (existsSync(requested)) return requested;
  const withoutExtension = requested.replace(/\.[^./]+$/, '');
  for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.mjs']) {
    const candidate = `${withoutExtension}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`package source module is missing: ${requested}`);
}

function findEntryPayload(packageData, entryName) {
  const entry = (packageData.things ?? [])
    .map((thing) => thing.payload)
    .find((payload) =>
      payload?.kind === 'bitfield-package-entry'
      && payload.entry_name === entryName
    );
  if (!entry) throw new Error(`package entry is missing: ${entryName}`);
  return entry;
}

export const declaredProviderInputMembershipPolicy = 'declared-provider-input-membership';

function dynamicReadSelectorPolicyForEntry(entryPayload, packageName, entryName) {
  const policy = entryPayload?.dynamic_read_selector_policy;
  if (policy === undefined) return null;
  if (policy !== declaredProviderInputMembershipPolicy) {
    throw new Error(
      `${packageName}:${entryName} dynamic_read_selector_policy must be ${declaredProviderInputMembershipPolicy}`,
    );
  }
  return policy;
}

function findTargetPayload(packageData, entryName) {
  return (packageData.things ?? [])
    .map((thing) => thing.payload)
    .find((payload) =>
      payload?.kind === 'package-target-descriptor'
      && payload.entry_name === entryName
    ) ?? null;
}

/**
 * Package targets are invoked by Runtime Kit as `(input, context)`. Dependency
 * injection therefore starts at argument three. A target that places `sender`,
 * `writer`, `io`, or any other dependency in position two receives the runtime
 * context object there and fails only after live invocation.
 *
 * This source gate makes that complete category unshippable: every executable
 * target has zero second argument or names the reserved argument `context`
 * (`_context` when unused). Pure helpers remain free to use any signature; the
 * rule applies only to exports referenced by package-target descriptors.
 */
export function assertPackageTargetSourceUsesRuntimeContextSecond(
  packageName,
  entryName,
  exportName,
  source,
) {
  const parameters = exportedFunctionParameters(source, exportName);
  if (parameters.length < 2) return;
  const secondName = parameterName(parameters[1]);
  if (secondName !== 'context' && secondName !== '_context') {
    throw new Error(
      `${packageName}:${entryName} package target export ${exportName} reserves argument two `
      + `for Runtime Kit context; found ${secondName || parameters[1]}. Move injected `
      + `dependencies to argument three.`,
    );
  }
  // The name check above is the ABI contract, and it is a proxy: a caller-assembled
  // lookup bag NAMED `context` passes it while the runtime hands the function an object
  // with none of those fields. Found twice on 2026-09-05 (suggested-match, then
  // interactive-demo-maker), both latent because nothing dispatched them live yet. So a
  // body that reads any property off argument two that the runner does not send is reading
  // a homonym, and the first live dispatch throws. Judge what the body reads, not what the
  // parameter is called.
  if (secondName === 'context') {
    const foreignRead = foreignContextPropertyRead(source, exportName);
    if (foreignRead) {
      throw new Error(
        `${packageName}:${entryName} package target export ${exportName} names argument two `
        + `context but reads context.${foreignRead}; the runner sends only `
        + `${RUNNER_TARGET_CONTEXT_FIELDS.join(' and ')} on the target context. A caller-assembled `
        + `lookup bag belongs INSIDE argument one (for example under a lookup key), never at `
        + `argument two.`,
      );
    }
  }
}

// The exact top-level fields the runner serializes onto a target's argument two. Producer:
// bitfield-runtime-kit/bitfield-runner/src/package_target_handlers.rs `package_target_context`,
// which builds `{ runtime: { partition_label }, packageData: { package, things } }`. This is a
// protocol shape closed by its single producer, not a catalog packages extend. Note the JS
// `BitfieldRuntimeContext` type in trusted-runtime-partition.ts declares only `runtime`; the
// Rust producer is the truth, and the first version of this check trusted the JS type and
// rejected two correct material-delivery targets that read `context.packageData`.
const RUNNER_TARGET_CONTEXT_FIELDS = Object.freeze(['runtime', 'packageData']);

// First property read off `context` in the export's body that the runner never sends, or null.
// Body extent: from the export's opening brace to its matching close, so a helper that
// legitimately takes a `context` parameter elsewhere in the file is not blamed.
function foreignContextPropertyRead(source, exportName) {
  const body = exportedFunctionBody(source, exportName);
  if (body === null) return null;
  // Three read spellings: `context.x`, `context?.x`, and the bracket forms `context['x']` and
  // `context?.['x']`. The first version missed `?.[`, so an optional bracket read passed.
  const reads = body.matchAll(/\bcontext\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)|\bcontext\s*(?:\?\.)?\s*\[\s*['"]([^'"]+)['"]\s*\]/g);
  for (const match of reads) {
    const property = match[1] ?? match[2];
    if (!RUNNER_TARGET_CONTEXT_FIELDS.includes(property)) return property;
  }
  return null;
}

function exportedFunctionBody(source, exportName) {
  const escapedName = escapeRegExp(exportName);
  const declaration = new RegExp(`\\bfunction\\s+${escapedName}\\s*\\(`).exec(source);
  const assignment = new RegExp(`\\b(?:const|let|var)\\s+${escapedName}\\s*=\\s*`).exec(source);
  const start = declaration?.index ?? assignment?.index;
  if (start === undefined) return null;
  const parameterOpen = source.indexOf('(', start);
  if (parameterOpen === -1) return null;
  const parameterClose = matchingParenthesisEnd(source, parameterOpen);
  const bodyOpen = source.indexOf('{', parameterClose);
  if (bodyOpen === -1) return null;
  let depth = 0;
  for (let index = bodyOpen; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '"' || character === "'" || character === '`') {
      index = quotedEnd(source, index, character);
      continue;
    }
    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2);
      if (end === -1) break;
      index = end;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) break;
      index = end + 1;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return source.slice(bodyOpen, index + 1);
  }
  return null;
}

function exportedFunctionParameters(source, exportName, seen = new Set()) {
  if (seen.has(exportName)) throw new Error(`package target export alias cycle at ${exportName}`);
  seen.add(exportName);
  const escapedName = escapeRegExp(exportName);
  const declaration = new RegExp(`\\bfunction\\s+${escapedName}\\s*\\(`).exec(source);
  if (declaration) {
    const open = source.indexOf('(', declaration.index);
    return splitTopLevelParameters(
      source.slice(open + 1, matchingParenthesisEnd(source, open)),
    );
  }
  const assignment = new RegExp(
    `\\b(?:const|let|var)\\s+${escapedName}\\s*=\\s*`,
  ).exec(source);
  if (assignment) {
    const valueStart = assignment.index + assignment[0].length;
    if (source[valueStart] === '(') {
      return splitTopLevelParameters(
        source.slice(
          valueStart + 1,
          matchingParenthesisEnd(source, valueStart),
        ),
      );
    }
    const alias = /^[A-Za-z_$][\w$]*/.exec(source.slice(valueStart))?.[0];
    if (alias) return exportedFunctionParameters(source, alias, seen);
  }
  throw new Error(`package target export ${exportName} function declaration is not inspectable`);
}

function matchingParenthesisEnd(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '"' || character === "'" || character === '`') {
      index = quotedEnd(source, index, character);
      continue;
    }
    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2);
      if (end === -1) break;
      index = end;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) break;
      index = end + 1;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')' && --depth === 0) return index;
  }
  throw new Error('package target function parameter list is unterminated');
}

function quotedEnd(source, open, quote) {
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
      continue;
    }
    if (source[index] === quote) return index;
  }
  return source.length - 1;
}

function splitTopLevelParameters(source) {
  const parameters = [];
  let start = 0;
  const depths = { '(': 0, '[': 0, '{': 0, '<': 0 };
  const closes = { ')': '(', ']': '[', '}': '{', '>': '<' };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '"' || character === "'" || character === '`') {
      index = quotedEnd(source, index, character);
      continue;
    }
    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2);
      if (end === -1) break;
      index = end;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) break;
      index = end + 1;
      continue;
    }
    if (Object.hasOwn(depths, character)) depths[character] += 1;
    else if (Object.hasOwn(closes, character)) {
      const opener = closes[character];
      depths[opener] = Math.max(0, depths[opener] - 1);
    } else if (
      character === ','
      && Object.values(depths).every((depth) => depth === 0)
    ) {
      parameters.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const finalParameter = source.slice(start).trim();
  if (finalParameter) parameters.push(finalParameter);
  return parameters;
}

function parameterName(parameter) {
  return /^(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(parameter.trim())?.[1] ?? '';
}

/**
 * Final entry-byte admission guard for read scopes. `bundleSource` is esbuild's
 * exact unminified output after tree-shaking and cross-package inlining, while
 * the generated runtime-kit-react wrapper is the exact provider shape the
 * artifact will mount with. Source-package DATA alone is insufficient: it
 * cannot prove the target partition or surviving inlined consumers.
 */
export async function assertFinalEntryReadScopeContract({
  packageName,
  entryName,
  packageSetRoot,
  runtimeKitReactFile,
  bundleSource,
  dynamicReadSelectorPolicy = null,
}) {
  const wrapperSource = await readFile(runtimeKitReactFile, 'utf8');
  const descriptor = parseGeneratedLiveReadScopeDescriptor(wrapperSource, packageName, entryName);
  const readScopeAnalysis = await staticReadScopeAnalysisFromEsbuildClosure({ bundleSource });
  if (descriptor === null) {
    if (
      readScopeAnalysis.consumers.length > 0
      || readScopeAnalysis.unresolved.length > 0
      || readScopeAnalysis.selectorless.length > 0
    ) {
      const selectors = readScopeAnalysis.consumers.map(({ inputName }) => inputName);
      const dynamic = readScopeAnalysis.unresolved.map(({ hookName, argument }) => `${hookName}(${argument || '<missing>'})`);
      const defaults = readScopeAnalysis.selectorless.map(({ hookName }) => `${hookName}()`);
      throw new Error(
        `BPS_ENTRY_READ_0106_SEALED_ENTRY_LIVE_READ: ${packageName}/${entryName} declares live_read_mode none but final entry bytes call useBitfieldData: ${[...selectors, ...dynamic, ...defaults].sort().join(', ')}`,
      );
    }
    return;
  }
  // Reusable package entry bytes may not remember whichever app happened to be
  // selected when they were compiled. Ordinary reads resolve to the engine
  // serving the current connection; deliberate cross-partition owners use the
  // explicit protocol APIs directly rather than generated package metadata.
  if (Object.hasOwn(descriptor, 'partitionLabel')) {
    throw new Error(
      `BPS_ENTRY_READ_0101_WRAPPER_APP_IDENTITY: ${packageName}/${entryName} generated live read scope must not name an app partition`,
    );
  }
  const providerInputs = providerInputNames(descriptor, packageName, entryName);
  // Validate direct entry reads against the exact scope emitted by the generator.
  // Dependency hooks have separate scopes and may legitimately reuse these names.
  const scopeMatch = wrapperSource.match(/const bitfieldPackageReadScope = createReadScopeFromPackageData\((.*)\);/);
  if (scopeMatch) {
    const rootInputs = new Set(JSON.parse(scopeMatch[1]).things.map(row => row.payload.input_name).filter(Boolean));
    const code = stripComments(bundleSource);
    const rootHooks = new Set([...code.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*createUseBitfieldData\s*\(\s*bitfieldPackageReadScope\d*\s*\)/g)].map(match => match[1]));
    const missing = staticReadScopeSelectorAnalysis(code, rootHooks).selectors.filter(name => !rootInputs.has(name));
    if (missing.length) throw new Error(`BPS_ENTRY_READ_0102_CONSUMER_NOT_IN_PROVIDER_SHAPE: ${packageName}/${entryName} direct entry reads request undeclared or ambiguous input(s): ${missing.join(', ')}`);
  }
  if (dynamicReadSelectorPolicy !== null
    && dynamicReadSelectorPolicy !== declaredProviderInputMembershipPolicy) {
    throw new Error(
      `BPS_ENTRY_READ_0107_DYNAMIC_SELECTOR_POLICY_INVALID: ${packageName}/${entryName} declares unsupported dynamic read selector policy ${JSON.stringify(dynamicReadSelectorPolicy)}`,
    );
  }
  if (readScopeAnalysis.unresolved.length > 0
    && dynamicReadSelectorPolicy !== declaredProviderInputMembershipPolicy) {
    const locations = readScopeAnalysis.unresolved
      .map(({ sourcePath, hookName, argument }) => `${sourcePath}:${hookName}(${argument || '<missing>'})`)
      .sort();
    throw new Error(
      `BPS_ENTRY_READ_0105_DYNAMIC_CONSUMER_SELECTOR: ${packageName}/${entryName} final entry closure has a useBitfieldData selector that cannot be resolved statically: ${locations.join(', ')}`,
    );
  }
  const { consumers } = readScopeAnalysis;
  const missing = [...new Set(consumers
    .map((consumer) => consumer.inputName)
    .filter((inputName) => !providerInputs.has(inputName)))].sort();
  if (missing.length > 0) {
    throw new Error(
      `BPS_ENTRY_READ_0102_CONSUMER_NOT_IN_PROVIDER_SHAPE: ${packageName}/${entryName} final entry closure requests undeclared input(s): ${missing.join(', ')}`,
    );
  }
}

function parseGeneratedLiveReadScopeDescriptor(source, packageName, entryName) {
  if (/bitfieldGeneratedLiveReadScopeDescriptor\s*=\s*\{\s*live_read_mode:\s*'none'\s*\}/.test(source)) return null;
  const match = source.match(/bitfieldGeneratedLiveReadScopeDescriptor\s*=\s*(\{[\s\S]*?\})\s+as const;/);
  if (!match) {
    throw new Error(`BPS_ENTRY_READ_0100_WRAPPER_DESCRIPTOR_MISSING: ${packageName}/${entryName} has no generated live read-scope descriptor`);
  }
  let descriptor;
  try { descriptor = JSON.parse(match[1]); }
  catch (error) { throw new Error(`BPS_ENTRY_READ_0100_WRAPPER_DESCRIPTOR_INVALID: ${packageName}/${entryName}: ${error.message}`); }
  if (!descriptor || typeof descriptor !== 'object' || !Array.isArray(descriptor.packages)) {
    throw new Error(`BPS_ENTRY_READ_0100_WRAPPER_DESCRIPTOR_INVALID: ${packageName}/${entryName} descriptor packages must be an array`);
  }
  return descriptor;
}

function providerInputNames(descriptor, packageName, entryName) {
  const inputs = new Map();
  for (const provider of descriptor.packages) {
    if (!provider || !Array.isArray(provider.inputs)) {
      throw new Error(`BPS_ENTRY_READ_0103_PROVIDER_SHAPE_INVALID: ${packageName}/${entryName} has a provider without an inputs array`);
    }
    for (const input of provider.inputs) {
      if (input?.inputName === null && input.payload?.is_default === true) continue;
      if (!input || typeof input.inputName !== 'string' || input.inputName.length === 0 || typeof input.address !== 'string' || input.address.length === 0) {
        throw new Error(`BPS_ENTRY_READ_0103_PROVIDER_SHAPE_INVALID: ${packageName}/${entryName} has an invalid provider input`);
      }
      // Names can repeat across package-local hook scopes. They no longer share
      // one runtime scope; this set checks that the compiled closure declares them.
      inputs.set(input.inputName, input.address);
    }
  }
  return inputs;
}

export const declaredPackageSetPartitionSchema = 'bitfield-package-set-partition/declared-partition';

// Exported for its own test. The partition it returns is the fact every entry
// byte is addressed under, so its resolution rules are worth pinning directly
// rather than only through a full build fixture.
export async function readCanonicalPackageSetPartition(packageSetRoot) {
  const descriptorPath = path.join(packageSetRoot, 'package-set-partition.json');
  try {
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
    if (descriptor?.schema === declaredPackageSetPartitionSchema) {
      return requiredPartition(descriptor.partition, `${descriptorPath} partition`);
    }
    if (descriptor?.schema !== 'bitfield-package-set-partition/v1') throw new Error(`${descriptorPath} schema is invalid`);
    return requiredPartition(descriptor.partition, `${descriptorPath} partition`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  // The legacy file must STATE its partition. It used to fall back to
  // `?? legacy.package_set`, which is the same substitution that caused the
  // 2026-09-03 retraction of 124 live group records: a set name is not a
  // partition label, and addressing the wrong partition reads whichever app owns
  // that name. The two happen to carry the same string for today's
  // single-partition sets, so the substitution is invisible until it is not.
  //
  // Unreachable at the time of removal (every present set has
  // `package-set-partition.json`, and the legacy file states `partition`
  // explicitly), which is exactly why it had to go: dead code holding a live
  // conflation fires for the first set that lacks a descriptor, and does it
  // silently.
  const legacyPath = path.join(packageSetRoot, 'what-packages-were-used-and-why', 'what-packages-were-used-and-why.json');
  const legacy = JSON.parse(await readFile(legacyPath, 'utf8'));
  if (legacy.partition === undefined && legacy.package_set !== undefined) {
    throw new Error(
      `${legacyPath} states package_set but no partition. These are two facts; `
        + 'substituting the set name for the partition addresses whichever app owns '
        + 'that name. State "partition" explicitly, or add package-set-partition.json.',
    );
  }
  return requiredPartition(legacy.partition, `${legacyPath} partition`);
}

function requiredPartition(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new Error(`${label} must be a package-set partition label`);
  return value;
}

async function staticReadScopeAnalysisFromEsbuildClosure({ bundleSource }) {
  // The esbuild output is the exact final source closure. Scanning individual
  // source modules or metafile byte counts is insufficient: a module can
  // contribute only a comment/re-export while its hook invocation is gone.
  // The generated wrapper binds this entry's hook to `createUseBitfieldData`;
  // inspect those final bindings only, after tree-shaking and cross-package
  // inlining have completed.
  const analysis = staticReadScopeSelectorAnalysisFromFinalBundle(bundleSource);
  return {
    consumers: analysis.selectors.map((inputName) => ({ inputName, sourcePath: '<final-entry-bytes>' })),
    unresolved: analysis.unresolved.map((selector) => ({ ...selector, sourcePath: '<final-entry-bytes>' })),
    selectorless: analysis.selectorless.map((selector) => ({ ...selector, sourcePath: '<final-entry-bytes>' })),
  };
}

export function staticReadScopeSelectorsFromSource(source) {
  return staticReadScopeSelectorAnalysisFromSource(source).selectors;
}

export function staticReadScopeSelectorAnalysisFromSource(source) {
  const code = stripComments(source);
  const hookNames = importedUseBitfieldDataNames(code);
  return staticReadScopeSelectorAnalysis(code, hookNames);
}

export function staticReadScopeSelectorAnalysisFromFinalBundle(source) {
  const code = source;
  const hookNames = new Set();
  const calls = [];
  const pending = [parseAst(code)];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === 'ImportDeclaration' && node.source.value === '@bitfield/runtime-kit/react') {
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportSpecifier' && ['useBitfieldData', 'useBitfieldFold'].includes(specifier.imported.name)) hookNames.add(specifier.local.name);
      }
    }
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier'
      && node.init?.type === 'CallExpression' && node.init.callee?.type === 'Identifier'
      && ['createUseBitfieldData', 'createUseBitfieldFold'].includes(node.init.callee.name)) hookNames.add(node.id.name);
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') calls.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') pending.push(child);
      } else if (value && typeof value === 'object' && typeof value.type === 'string') pending.push(value);
    }
  }
  return staticReadScopeSelectorAnalysis(code, hookNames, calls.sort((a, b) => a.start - b.start));
}

function staticReadScopeSelectorAnalysis(code, hookNames, parsedCalls = null) {
  if (hookNames.size === 0) return { selectors: [], unresolved: [], selectorless: [] };
  const bindings = staticSelectorBindings(code);
  const selectors = new Set();
  const unresolved = [];
  const selectorless = [];
  for (const hookName of hookNames) {
    const callPattern = new RegExp(`\\b${escapeRegExp(hookName)}\\s*(?:<[^>\\n]*>)?\\s*\\(`, 'g');
    const matches = parsedCalls === null ? code.matchAll(callPattern) : parsedCalls
      .filter(call => call.callee.name === hookName)
      .map(call => ({ index: call.start, 0: code.slice(call.start, code.indexOf('(', call.callee.end) + 1) }));
    for (const match of matches) {
      // The final bundle can contain a runtime helper declaration with the
      // same lexical name as this entry's generated binding. A declaration is
      // not a consumer invocation and must not become a synthetic missing
      // selector.
      if (/\bfunction\s*$/.test(code.slice(0, match.index).trimEnd())) continue;
      const open = match.index + match[0].lastIndexOf('(');
      const argument = firstCallArgument(code, open);
      if (!argument) {
        selectorless.push({ hookName });
        continue;
      }
      const selector = staticSelectorFromExpression(argument, bindings);
      if (selector !== null) selectors.add(selector);
      else {
        const forwarded = staticSelectorsForwardedThroughLocalFunction(code, match.index, argument, bindings);
        if (forwarded) for (const value of forwarded) selectors.add(value);
        else unresolved.push({ hookName, argument });
      }
    }
  }
  return { selectors: [...selectors].sort(), unresolved, selectorless };
}

// Custom hooks often centralize optional-read error handling by forwarding one
// selector parameter to useBitfieldData. Treat that parameter as static only
// when every call to the local wrapper supplies a statically resolvable value.
// One dynamic or externally ambiguous call keeps the admission failure closed.
function staticSelectorsForwardedThroughLocalFunction(code, hookCallIndex, argument, bindings) {
  const parameter = argument.match(/^\s*([A-Za-z_$][\w$]*)\s*$/)?.[1];
  if (!parameter) return null;
  const declarations = [...code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g)]
    .filter((match) => match.index < hookCallIndex);
  for (let index = declarations.length - 1; index >= 0; index -= 1) {
    const declaration = declarations[index];
    const openBrace = declaration.index + declaration[0].lastIndexOf('{');
    const closeBrace = matchingDelimiterIndex(code, openBrace, '{', '}');
    if (closeBrace < hookCallIndex) continue;
    const parameters = splitTopLevelParameters(declaration[2]).map(parameterName);
    const parameterIndex = parameters.indexOf(parameter);
    if (parameterIndex < 0) continue;
    const values = new Set();
    const calls = new RegExp(`\\b${escapeRegExp(declaration[1])}\\s*\\(`, 'g');
    for (const call of code.matchAll(calls)) {
      if (/\bfunction\s*$/.test(code.slice(0, call.index).trimEnd())) continue;
      const openParenthesis = call.index + call[0].lastIndexOf('(');
      const closeParenthesis = matchingDelimiterIndex(code, openParenthesis, '(', ')');
      if (closeParenthesis < 0) return null;
      const args = splitTopLevelParameters(code.slice(openParenthesis + 1, closeParenthesis));
      const value = staticSelectorFromExpression(args[parameterIndex] ?? '', bindings);
      if (value === null) return null;
      values.add(value);
    }
    return values.size > 0 ? values : null;
  }
  return null;
}

function matchingDelimiterIndex(source, openIndex, openCharacter, closeCharacter) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (!escaped && character === quote) quote = null;
      escaped = !escaped && character === '\\';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === openCharacter) depth += 1;
    if (character === closeCharacter) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function importedUseBitfieldDataNames(code) {
  const names = new Set();
  const imports = /\bimport\s*\{([\s\S]*?)\}\s*from\s*['"]@bitfield\/runtime-kit\/react['"]/g;
  for (const match of code.matchAll(imports)) {
    for (const part of match[1].split(',')) {
      const binding = part.trim().match(/^useBitfieldData(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (binding) names.add(binding[1] ?? 'useBitfieldData');
    }
  }
  return names;
}

function staticSelectorBindings(code) {
  const bindings = new Map();
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"\\\n]*(?:\\.[^'"\\\n]*)*)\2/g)) bindings.set(match[1], match[3]);
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.)?useMemo\s*\(\s*\(\s*\)\s*=>\s*\(\s*(\{[\s\S]*?\})\s*\)/g)) {
    const selector = staticSelectorFromObject(match[2], bindings);
    if (selector !== null) bindings.set(match[1], selector);
  }
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(\{[\s\S]*?\})\s*;/g)) {
    const selector = staticSelectorFromObject(match[2], bindings);
    if (selector !== null) bindings.set(match[1], selector);
  }
  return bindings;
}

function firstCallArgument(code, openParenthesis) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  const start = openParenthesis + 1;
  for (let index = start; index < code.length; index += 1) {
    const character = code[index];
    if (quote) {
      if (!escaped && character === quote) quote = null;
      escaped = !escaped && character === '\\';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '(' || character === '[' || character === '{') depth += 1;
    if (character === ')' || character === ']' || character === '}') {
      if (depth === 0 && character === ')') return code.slice(start, index).trim();
      depth -= 1;
    }
    if (character === ',' && depth === 0) return code.slice(start, index).trim();
  }
  return '';
}

function staticSelectorFromExpression(expression, bindings) {
  const string = expression.match(/^\s*(['"])([^'"\\\n]*(?:\\.[^'"\\\n]*)*)\1\s*$/);
  if (string) return string[2];
  const identifier = expression.match(/^\s*([A-Za-z_$][\w$]*)\s*$/);
  if (identifier) return bindings.get(identifier[1]) ?? null;
  if (expression.trim().startsWith('{')) return staticSelectorFromObject(expression, bindings);
  return null;
}

function staticSelectorFromObject(object, bindings = new Map()) {
  const literal = object.match(/(?:^|[,\s{])input\s*:\s*(['"])([^'"\\\n]*(?:\\.[^'"\\\n]*)*)\1/);
  if (literal) return literal[2];
  const identifier = object.match(/(?:^|[,\s{])input\s*:\s*([A-Za-z_$][\w$]*)/);
  return identifier ? bindings.get(identifier[1]) ?? null : null;
}

function stripComments(source) {
  let output = '';
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      output += character;
      if (character === '\\') { output += next ?? ''; index += 1; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; output += character; continue; }
    if (character === '/' && next === '/') { while (index < source.length && source[index] !== '\n') { output += ' '; index += 1; } output += '\n'; continue; }
    if (character === '/' && next === '*') { index += 2; while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) { output += source[index] === '\n' ? '\n' : ' '; index += 1; } index += 1; continue; }
    output += character;
  }
  return output;
}

function assertBundleSourceDoesNotUseBundledPackageDataReadScope(packageName, source) {
  if (/\bcreateReadScopeFromPackageData\(\s*things_to_store_and_run_default\s*\)/.test(source)) {
    throw new Error(
      `${packageName} bundle uses bundled things-to-store-and-run.json as read-scope authority`,
    );
  }
}

// Every browser entry is mounted by the host through the self-mounting contract:
// `mount({ el })` must render itself into `el` (its own ReactDOM root) and return
// a cleanup function. The host calls the exported `mount` directly — it never
// renders it as a React element. So an entry whose `mount` is a bare React
// component (no ReactDOM root bundled) is invoked as a plain function: its hooks
// fire with no active render, React's dispatcher (ReactSharedInternals.H) is
// null, and the first hook (e.g. useRef) throws — a black screen at live-mount.
//
// This is Physics, not convention: a bundle that renders React UI (JSX runtime
// present) MUST also bundle a ReactDOM root (createRoot / hydrateRoot) to be
// mountable at all. The fix for any flagged package is a show/mount-<name>.tsx
// wrapper that self-mounts via mountReactSurface (see any existing package).
// Catching it here makes the entire category of useRef-null live-mount crashes
// impossible to ship instead of discoverable only at runtime in production.
//
// Two checks, because the bundle check alone was found unsound on 2026-09-05:
// fourteen bare-component entries PASSED it by importing the `ui` barrel, which
// drags `mountReactSurface` (and so `createRoot`) into the bundle unused. The
// bundle text says whether a root mount is PRESENT, not whether the entry's own
// `mount` export CALLS it. That property lives in the declared source file, so
// `assertEntrySourceSelfMounts` reads that file and requires it to name a root
// mount itself. The bundle check stays as the second layer: a source that names
// the mount but whose import was tree-shaken away still fails there.
const ROOT_MOUNT_NAMES = /\b(mountReactSurface|mountReactMaterial|createRoot|hydrateRoot)\b/;
const REACT_IMPORT = /from\s+['"]react(\/jsx-runtime)?['"]/;

// A source is a React UI surface when its file is JSX-bearing (.tsx/.jsx, where the
// automatic runtime needs no `react` import) or when it imports `react` itself. Angle
// brackets are deliberately NOT a marker: `.ts` generics look identical to JSX.
export function assertEntrySourceSelfMounts(packageName, entryName, sourcePath, entrySource, isTargetEntry) {
  if (isTargetEntry) return; // node-platform scope-binding senders never render UI
  const rendersReactUi = /\.(tsx|jsx)$/.test(sourcePath) || REACT_IMPORT.test(entrySource);
  if (!rendersReactUi) return;
  if (ROOT_MOUNT_NAMES.test(entrySource)) return;
  throw new Error(
    `${packageName}:${entryName} entry source renders React UI but never names a root mount `
    + `(mountReactSurface/mountReactMaterial/createRoot/hydrateRoot), so its mount export is a `
    + `bare component and the host's mount({ el }) call will throw on the first hook. Point the `
    + `entry's source_path at a show/mount-${entryName}.tsx wrapper that self-mounts, or delete `
    + `the entry if nothing binds it.`,
  );
}

export function assertReactEntryBundleSelfMounts(packageName, entryName, source, isTargetEntry) {
  if (isTargetEntry) return; // node-platform scope-binding senders never render UI
  const rendersReactUi = /react\/jsx-runtime/.test(source)
    || /react-jsx-runtime/.test(source)
    || /\bjsxDEV\b/.test(source);
  if (!rendersReactUi) return; // not a React UI surface — nothing to mount
  const hasReactDomRoot = /\bcreateRoot\b/.test(source) || /\bhydrateRoot\b/.test(source);
  if (hasReactDomRoot) return;
  throw new Error(
    `${packageName}:${entryName} entry renders React UI but bundles no ReactDOM root `
    + `(createRoot/hydrateRoot) — its mount export is a bare component and will crash `
    + `with a null hooks dispatcher when the host calls mount({ el }) on the live-mount `
    + `path. Add a show/mount-${entryName}.tsx wrapper that self-mounts via `
    + `mountReactSurface and point the entry's source_path at it.`,
  );
}

function packageInputNames(packageData) {
  const inputs = new Set();
  for (const thing of packageData.things ?? []) {
    const payload = thing.payload;
    if (
      payload?.kind === 'bitfield-input-descriptor'
      && typeof payload.input_name === 'string'
      && payload.input_name.length > 0
    ) {
      inputs.add(payload.input_name);
    }
  }
  return inputs;
}

export function packageTargetEntryNames(packageData) {
  const targetEntryNames = new Set();
  for (const thing of packageData.things ?? []) {
    const payload = thing.payload;
    if (
      payload?.kind === 'package-target-descriptor'
      && typeof payload.entry_name === 'string'
      && payload.entry_name.length > 0
    ) {
      targetEntryNames.add(payload.entry_name);
    }
  }
  return targetEntryNames;
}

function createExactAliasPlugin(aliases) {
  return {
    name: 'exact-alias',
    setup(build) {
      for (const [specifier, replacement] of Object.entries(aliases)) {
        build.onResolve({ filter: new RegExp(`^${escapeRegExp(specifier)}$`) }, () => ({
          path: replacement,
        }));
      }
    },
  };
}

// Imported package code keeps its own input meanings, including its default.
// Only descriptor definitions are compiled; current values are never bundled.
export function createPackageReadScopePlugin({ packageSetRoot, packageRoot, runtimeKitReactFile }) {
  const packagesRoot = realpathSync(path.join(packageSetRoot, 'packages'));
  const entryPackageRoot = realpathSync(packageRoot);
  return {
    name: 'package-read-scope',
    setup(build) {
      build.onResolve({ filter: /^@bitfield\/runtime-kit\/react$/ }, async args => {
        const relative = path.relative(packagesRoot, realpathSync(args.importer));
        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error(`Package data hook has no owning package: ${args.importer}`);
        }
        const ownerRoot = path.join(packagesRoot, relative.split(path.sep)[0]);
        if (ownerRoot === entryPackageRoot) return { path: runtimeKitReactFile };
        const manifestPath = path.join(ownerRoot, 'things-to-store-and-run.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        const inputs = new Set((manifest.things ?? []).filter(row => row.remove !== true && row.payload?.kind === 'bitfield-input-descriptor')
          .map(row => row.payload.input_name).filter(Boolean));
        // Validate the importing package's actual calls against its own definitions.
        // A same-named input in the entry package cannot satisfy this dependency.
        const source = await esbuild.transform(await readFile(args.importer, 'utf8'), {
          loader: /\.[jt]sx$/.test(args.importer) ? 'tsx' : 'ts', jsx: 'automatic',
        });
        const missing = staticReadScopeSelectorAnalysisFromFinalBundle(source.code).selectors.filter(name => !inputs.has(name));
        if (missing.length) throw new Error(`BPS_ENTRY_READ_0102_CONSUMER_NOT_IN_PROVIDER_SHAPE: ${relative} requests input(s) absent from its owning package: ${missing.join(', ')}`);
        return { path: manifestPath, suffix: '?package-read-scope', pluginData: { packageReadScope: true } };
      });
      build.onLoad({ filter: /things-to-store-and-run\.json$/ }, async args => {
        if (!args.pluginData?.packageReadScope) return;
        const data = JSON.parse(await readFile(args.path, 'utf8'));
        const things = (data.things ?? []).filter(thing => thing.remove !== true && thing.payload?.kind === 'bitfield-input-descriptor')
          .map(({ address, payload }) => ({ type: 'record', address, payload }));
        return {
          loader: 'ts', resolveDir: path.dirname(args.path),
          contents: `import { createReadScopeFromPackageData, createUseBitfieldData, createUseBitfieldFold } from '@bitfield/runtime-kit/internal/owner-surface';\nconst scope = createReadScopeFromPackageData(${JSON.stringify({ package: path.basename(path.dirname(args.path)), things })});\nexport const useBitfieldData = createUseBitfieldData(scope);\nexport const useBitfieldFold = createUseBitfieldFold(scope);\n`,
        };
      });
    },
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function entryScopeBinding(packageName, entryName, {
  sharedScopeBinding,
  packageEntryScopeBinding,
}) {
  return {
    entry_name: entryName,
    package: packageName,
    scope_binding: {
      target_path: ['el'],
      ...plainScopeBinding(sharedScopeBinding, 'shared package entry scope binding'),
      ...plainScopeBinding(
        packageEntryScopeBinding,
        `${packageName}/${entryName} package entry scope binding`,
      ),
    },
  };
}

function plainScopeBinding(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  throw new Error(`${label} must be an object`);
}

async function readEntryScopeBindings(packageName, packageRoot) {
  let raw;
  try {
    raw = JSON.parse(await readFile(path.join(packageRoot, entryScopeBindingsFile), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
  if (raw?.kind !== 'bitfield-entry-scope-bindings') {
    throw new Error(`${packageName}/${entryScopeBindingsFile} has unsupported kind`);
  }
  if (!Array.isArray(raw.entries)) {
    throw new Error(`${packageName}/${entryScopeBindingsFile} entries must be an array`);
  }
  const bindings = new Map();
  for (const entry of raw.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${packageName}/${entryScopeBindingsFile} entry must be an object`);
    }
    if (typeof entry.entry_name !== 'string' || entry.entry_name.length === 0) {
      throw new Error(`${packageName}/${entryScopeBindingsFile} entry_name must be non-empty`);
    }
    if (bindings.has(entry.entry_name)) {
      throw new Error(`${packageName}/${entryScopeBindingsFile} duplicates ${entry.entry_name}`);
    }
    bindings.set(
      entry.entry_name,
      plainScopeBinding(
        entry.scope_binding,
        `${packageName}/${entryScopeBindingsFile}/${entry.entry_name} scope_binding`,
      ),
    );
  }
  return bindings;
}
