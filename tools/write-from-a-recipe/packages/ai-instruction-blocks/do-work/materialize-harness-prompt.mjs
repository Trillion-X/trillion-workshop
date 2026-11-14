// packages/ai-instruction-blocks/do-work/materialize-harness-prompt.mjs
//
// =============================================================================
// PURPOSE: assemble the harness system prompt from the `group` organization
// graph plus this package's `ai-instruction-block` bodies, WRITE the assembled
// bytes to CAS via engine.operation.write-batch (as raw `payload_text`), read
// back the record `content_hash` (the BLAKE3 CAS hash), and return that small
// hash + address. A `blob_ref` mount of that hash hands the raw prompt markdown
// to the launched session, so the large text never crosses a leaf stdout.
//
// WHY THIS OWNS THE ASSEMBLY (NO-GOD-PACKAGE): materializing instruction blocks
// from a group graph is `ai-instruction-blocks`'s job, NOT the launch adapter's.
// The traversal moved here from ai-cli-launch-adapters/assemble-harness-prompt.mjs
// (that leaf + mount-harness-system-prompt.mjs are retired AFTER this path is
// live and the dispatch def is rewired, L030/L101 materialize-before-retire).
//
// WHY IN-ENGINE, NOT A SANDBOXED compute.process LEAF: the assembled prompt is
// large (the full always-loaded harness). A sandboxed leaf's captured stdout is
// truncated at a hardcoded 64KB engine tail (OUTPUT_TAIL_MAX_BYTES,
// architect/crates/process-engine/src/session_handler.rs:43), so the assembled
// text can never cross the leaf->workflow boundary. This op runs in-engine (like
// request-instruction-update.ts, via sendRequestToBitfieldTarget), so the large
// text stays in-process and only a small address/hash flows onward. The one byte
// path (CAS) carries 1 byte or 1000TB identically; there is no size-selected lane.
// =============================================================================
// INVARIANTS
//   - PURE core: `traverseBlockRefs` + `assembleHarnessPrompt` + the write-request
//     builder are pure (graph/blocks/text in, structures out; no I/O). Only
//     `materializeHarnessPrompt` touches the engine, through an injected sender.
//   - BLIND to depth: traversal recurses through ANY nested group with zero
//     change (the group core is blind), so is this.
//   - Deterministic: order is memberOrder; missing block bodies are reported,
//     never silently dropped or fabricated.
//   - Content-addressed: the written record payload lands in CAS at its BLAKE3
//     hash; the workflow reads `content_hash` and mounts it by blob_ref.
// =============================================================================

// NOTE: no top-level `@bitfield/runtime-kit` import. The entry-scope handler
// provides the real sender (runtime-kit sendRequestToBitfieldTarget) and injects
// it as `send`. Keeping the module import-free of runtime-kit lets the pure core
// + the op be unit-tested with `node --test` (no TS type-stripping in node_modules).

const BLOCK_FAMILY = 'ai-instruction-block';
const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed';
const ENGINE_WRITE_BATCH_OPERATION = 'engine.operation.write-batch';
const GROUP_LOAD_GRAPH_TARGET = 'group.load-graph';
const FIND_CURRENT_ITEMS_TARGET = 'slot::find-current-items';
const EMPTY_PROMPT_SENTINEL = '<!-- no profile instructions -->\n';
const DEFAULT_PROMPT_PATH = ['current-item', 'published-record'];
const PROMPT_ADDRESS_PREFIX = 'package::ai-instruction-blocks::harness-prompt::';

/** The map key for a group address; mirrors group-graph.ts serializeNodeRef. */
export function groupKey(ref) {
  const parts = ref?.parts ?? {};
  const sorted = {};
  for (const k of Object.keys(parts).sort()) sorted[k] = parts[k];
  return JSON.stringify({ family: ref?.family, parts: sorted });
}

/**
 * Depth-first ordered list of leaf block ids under `rootRef`, recursing through
 * any nested group. Returns [{ id, path }] where path is the group-family trail.
 * PREFER-SECTIONS-ELSE-BLOCK: if a group has ANY subgroup member, descend ONLY
 * those subgroups in order and SKIP the co-located whole-content leaf; a group
 * with NO subgroups emits its `block` leaf. Depth-blind, cycle-guarded, generic.
 */
export function traverseBlockRefs(graph, rootRef) {
  const groups = graph?.groups ?? {};
  const out = [];
  const seen = new Set();
  function descend(ref, trail) {
    const key = groupKey(ref);
    if (seen.has(key)) return; // cycle guard
    const group = groups[key];
    if (!group) {
      if (ref?.family === BLOCK_FAMILY && ref?.parts?.id) out.push({ id: ref.parts.id, path: trail });
      return;
    }
    seen.add(key);
    const label = `${ref.family}:${Object.values(ref.parts).join('/')}`;
    const subgroups = [];
    const leaves = [];
    for (const mid of group.memberOrder) {
      const m = group.members[mid];
      if (!m?.nodeRef) continue;
      (groups[groupKey(m.nodeRef)] ? subgroups : leaves).push(m);
    }
    const toVisit = subgroups.length > 0 ? subgroups : leaves;
    for (const m of toVisit) descend(m.nodeRef, [...trail, label]);
    seen.delete(key);
  }
  descend(rootRef, []);
  return out;
}

/**
 * Assemble the ordered prompt text. `blocksById` maps block id to { body, label }.
 * A FILE-level header (the direct child of the set, `path[1]`) precedes each
 * file's content; section bodies carry their own markdown headings. An optional
 * `objective` string is appended last under its own header, so the launched
 * session sees the always-loaded harness first, then its specific objective.
 */
export function assembleHarnessPrompt(graph, rootRef, blocksById, options = {}) {
  const withHeaders = options.headers !== false;
  const refs = traverseBlockRefs(graph, rootRef);
  const chunks = [];
  const missing = [];
  let lastHeader = null;
  for (const { id, path } of refs) {
    const block = blocksById[id];
    if (!block || typeof block.body !== 'string') { missing.push(id); continue; }
    if (withHeaders) {
      const header = path[1] || path[path.length - 1] || id;
      if (header !== lastHeader) { chunks.push(`\n===== ${header} =====\n`); lastHeader = header; }
    }
    chunks.push(block.body);
  }
  const objective = typeof options.objective === 'string' ? options.objective.trim() : '';
  if (objective) {
    if (withHeaders) chunks.push('\n===== objective =====\n');
    chunks.push(objective);
  }
  const text = chunks.join('\n').replace(/^\n+/, '');
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    blockCount: refs.length - missing.length,
    missing,
    order: refs.map((r) => r.id),
  };
}

/** Deterministic stored-bytes address for a session's materialized prompt. */
export function harnessPromptAddress(sessionRef) {
  if (typeof sessionRef !== 'string' || !sessionRef.trim()) throw new Error('sessionRef is required');
  return `${PROMPT_ADDRESS_PREFIX}${sessionRef}`;
}

/**
 * PURE builder for the write-batch request that stores the assembled prompt.
 *
 * The payload is stored via `payload_text` (NOT a structured `payload` object),
 * so the engine writes the assembled markdown to CAS VERBATIM (bytes ==
 * `text.as_bytes()`, engine-operation-target/src/lib.rs:1034-1035). That makes
 * the record's `content_hash` the BLAKE3 of the RAW prompt, so a `blob_ref`
 * mount of that hash hands the launched session the raw system-prompt markdown
 * file, NOT a JSON-wrapped `{kind,body,...}` record (a structured `payload`
 * would store JSON, which would then reach `--system-prompt` as JSON bytes).
 * Observability (block_count/missing) rides the op RETURN value plus the launch
 * provenance, never the mounted prompt bytes.
 */
export function buildMaterializeWriteRequest({ sessionRef, partitionLabel, text }) {
  if (typeof text !== 'string') throw new Error('text must be a string');
  if (typeof partitionLabel !== 'string' || !partitionLabel.trim()) throw new Error('partitionLabel is required');
  const address = harnessPromptAddress(sessionRef);
  return {
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: {
      operation_label: ENGINE_WRITE_BATCH_OPERATION,
      partition_label: partitionLabel,
      writes: [
        {
          address_label: address,
          // Match the workflow `read` primitive: it resolves a canonical label
          // through the engine's ordinary label-hash address owner.
          address_mode: 'label_hash',
          path: DEFAULT_PROMPT_PATH,
          // Raw verbatim bytes, so content_hash == BLAKE3(prompt markdown).
          payload_text: text,
        },
      ],
    },
  };
}

/**
 * PURE builder for the read-current request that fetches the just-written
 * prompt record `content_hash` (the BLAKE3 CAS hash of the raw markdown).
 * read-current responses append a `content_hash` frame in `code:hex` form,
 * directly usable as `/cas/<content_hash>` and as a `blob_ref` mount hash
 * (engine-operation-target/src/lib.rs:887-945). The op reads back the exact
 * literal address it just wrote (no binding needed), so it is the sole
 * authority on both the prompt bytes AND their hash.
 */
export function buildReadPromptHashRequest({ sessionRef, partitionLabel }) {
  if (typeof partitionLabel !== 'string' || !partitionLabel.trim()) throw new Error('partitionLabel is required');
  return {
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: {
      operation_label: 'engine.operation.read-current',
      partition_label: partitionLabel,
      address_label: harnessPromptAddress(sessionRef),
      address_mode: 'label_hash',
    },
  };
}

/**
 * Read the op input. Callers (the workflow ask-step) bind:
 *   graph        - group.load-graph output for the harness-set root
 *   blocks       - the ai-instruction-block feed rows [{ id, body, label }]
 *   root_ref     - the harness-set root node ref (family/parts)
 *   objective    - the session objective text (optional, appended last)
 *   session_ref  - the session id (address suffix)
 *   partition_label - the app partition (e.g. 'trillion')
 */
function normalizeRootRef(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const match = value.match(/^harness-set:(.+)$/);
    if (match) return { family: 'harness-set', parts: { name: match[1] } };
  }
  return null;
}

/**
 * Bind the package target to the partition that actually serves this invocation.
 * Runtime context is trusted over caller DATA so stale or foreign partition keys
 * cannot escape into current-owner reads.
 */
export function bindServingPartition(input, context) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const runtimePartitionLabel = nonEmptyString(context?.runtime?.partition_label);
  const callerPartitionLabel = nonEmptyString(input.partition_label) ?? nonEmptyString(input.partitionLabel);
  const partitionLabel = runtimePartitionLabel ?? callerPartitionLabel;
  return partitionLabel ? { ...input, partition_label: partitionLabel } : input;
}

function readInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('materialize input must be an object');
  const graph = value.graph ?? {};
  const emptyWhenRootMissing = value.empty_when_root_missing === true || value.emptyWhenRootMissing === true;
  const rawRootRef = value.root_ref ?? value.rootRef;
  const rootRef = normalizeRootRef(rawRootRef);
  if (rawRootRef != null && !rootRef) throw new Error('root_ref must be a harness-set ref');
  if (!rootRef && !emptyWhenRootMissing) throw new Error('root_ref is required');
  const partitionLabel = value.partition_label ?? value.partitionLabel;
  if (typeof partitionLabel !== 'string' || !partitionLabel.trim()) throw new Error('partitionLabel is required');
  const sessionRef = value.session_ref ?? value.sessionRef;
  if (typeof sessionRef !== 'string' || !sessionRef.trim()) throw new Error('sessionRef is required');
  const objective = value.objective;
  const maxTotalBytes = value.max_total_bytes ?? value.maxTotalBytes ?? null;
  const loadFromLive = value.load_from_live === true || value.loadFromLive === true;
  const rawDirectInstructionRefs = value.direct_instruction_refs ?? value.directInstructionRefs ?? [];
  if (!Array.isArray(rawDirectInstructionRefs)) throw new Error('direct_instruction_refs must be an array');
  if (rawDirectInstructionRefs.length > 64) throw new Error('direct_instruction_refs exceeds hard limit');
  const directInstructionRefs = rawDirectInstructionRefs.map((ref) => {
    if (typeof ref !== 'string' || !ref.trim()) throw new Error('direct_instruction_refs must contain non-empty strings');
    return ref.trim();
  });
  const rawBuilderValues = value.builder_values ?? value.builderValues;
  const rawBuilderStrings = value.builder_strings ?? value.builderStrings ?? {};
  if (rawBuilderValues != null && Object.keys(rawBuilderStrings).length > 0) {
    throw new Error('builder_values and builder_strings are mutually exclusive');
  }
  const builderSource = rawBuilderValues ?? rawBuilderStrings;
  if (!builderSource || typeof builderSource !== 'object' || Array.isArray(builderSource)) {
    throw new Error('builder_values must be an object');
  }
  const builderEntries = Object.entries(builderSource);
  if (builderEntries.length > 32) throw new Error('builder values exceed hard limit');
  let builderStringBytes = 0;
  const builderStrings = {};
  for (const [key, rawValue] of builderEntries) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`builder value key is invalid: ${key}`);
    const stringValue = rawBuilderValues == null ? rawValue : JSON.stringify(rawValue);
    if (typeof stringValue !== 'string') throw new Error(`builder value ${key} cannot be stringified`);
    builderStringBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(stringValue, 'utf8');
    builderStrings[key] = stringValue;
  }
  if (builderStringBytes > 4 * 1024 * 1024) throw new Error('builder values exceed 4 MiB hard limit');
  const blocksById = {};
  const rows = Array.isArray(value.blocks) ? value.blocks : Array.isArray(value.blocksById) ? value.blocksById : [];
  for (const row of rows) {
    if (row && typeof row === 'object' && typeof row.id === 'string') {
      blocksById[row.id] = { body: row.body, label: row.label };
    }
  }
  // Also accept a pre-mapped blocksById object.
  if (value.blocksById && !Array.isArray(value.blocksById) && typeof value.blocksById === 'object') {
    Object.assign(blocksById, value.blocksById);
  }
  return { graph, rootRef, blocksById, objective, sessionRef, partitionLabel, maxTotalBytes, loadFromLive, emptyWhenRootMissing, directInstructionRefs, builderStrings };
}

export function buildLoadHarnessGraphRequest({ rootRef, partitionLabel }) {
  return {
    target: GROUP_LOAD_GRAPH_TARGET,
    payload: {
      partition_label: partitionLabel,
      roots: [rootRef],
    },
  };
}

export function buildFindHarnessBlocksRequest(blockId) {
  if (typeof blockId !== 'string' || !blockId.trim()) throw new Error('blockId is required');
  return {
    target: FIND_CURRENT_ITEMS_TARGET,
    payload: {
      operation: 'find-current-items',
      in: 'published-record',
      where: { all: [
        { field: 'kind', eq: 'ai-instruction-block' },
        { field: 'id', eq: blockId.trim() },
      ] },
      select: ['kind', 'id', 'body', 'label', 'status'],
    },
  };
}

async function loadExactBlockRows(blockIds, send) {
  const uniqueIds = [...new Set(blockIds)];
  if (uniqueIds.length > 512) throw new Error('instruction block selection exceeds hard limit');
  const rows = [];
  for (const blockId of uniqueIds) {
    const reply = await send(buildFindHarnessBlocksRequest(blockId));
    const exact = (Array.isArray(reply?.items) ? reply.items : []).filter((row) => row?.id === blockId);
    if (exact.length > 1) throw new Error(`instruction block is ambiguous: ${blockId}`);
    if (exact.length === 1) rows.push(exact[0]);
  }
  return rows;
}

function blocksByIdFromRows(rows) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && typeof row === 'object' && typeof row.id === 'string') {
      out[row.id] = { body: row.body, label: row.label };
    }
  }
  return out;
}

/**
 * IN-ENGINE op: assemble the harness prompt and write it to CAS. For a direct
 * profile, it also returns only the explicitly requested current instruction
 * rows. Builder inputs that were stringified before materialization are passed
 * through unchanged, so no transform clones the large post-materialization
 * workflow state. The workflow mounts the returned `content_hash` by blob_ref.
 * `send` is injected for tests.
 */
export async function materializeHarnessPromptWithSender(input, send) {
  if (typeof send !== 'function') throw new Error('materializeHarnessPromptWithSender requires an injected `send` (the thin .ts entry passes runtime-kit sendRequestToBitfieldTarget)');
  let { graph, rootRef, blocksById, sessionRef, partitionLabel, maxTotalBytes, loadFromLive, emptyWhenRootMissing, directInstructionRefs, builderStrings } = readInput(input);
  let liveBlockRows = [];
  if (loadFromLive) {
    if (rootRef) {
      const graphReply = await send(buildLoadHarnessGraphRequest({ rootRef, partitionLabel }));
      graph = graphReply?.graph ?? {};
    }
    // A direct CLI identity with no authored instruction refs needs no corpus
    // read. Skipping it avoids both unnecessary work and exposure to unrelated
    // malformed rows in the generic current-items owner.
    if (rootRef || directInstructionRefs.length > 0) {
      const requestedIds = rootRef
        ? traverseBlockRefs(graph, rootRef).map((entry) => entry.id)
        : directInstructionRefs;
      liveBlockRows = await loadExactBlockRows(requestedIds, send);
      blocksById = blocksByIdFromRows(liveBlockRows);
    }
  }
  // The system-prompt-file is the harness ONLY (headers, ordered block bodies).
  // The session objective is NOT baked in here: it stays the separate prompt arg
  // (resolveChatLaunch), matching the working mount-harness-system-prompt.mjs
  // behavior. Baking the objective into the system prompt would diverge (L156).
  let asm = rootRef
    ? assembleHarnessPrompt(graph, rootRef, blocksById, { headers: true })
    : { text: EMPTY_PROMPT_SENTINEL, bytes: Buffer.byteLength(EMPTY_PROMPT_SENTINEL, 'utf8'), blockCount: 0, missing: [], order: [] };
  // Guards moved from ai-cli-launch-adapters/mount-harness-system-prompt.mjs so the
  // refactor does not silently drop them. Fail BEFORE the write (never persist a
  // partial/empty/over-cap prompt, never fabricate a missing block).
  if (asm.missing.length > 0) throw new Error(`mount_harness_incomplete missing=${asm.missing.length} first=${asm.missing[0]}`);
  if (asm.blockCount === 0 && !emptyWhenRootMissing) throw new Error('mount_harness_empty');
  if (asm.blockCount === 0 && emptyWhenRootMissing) {
    asm = { ...asm, text: EMPTY_PROMPT_SENTINEL, bytes: Buffer.byteLength(EMPTY_PROMPT_SENTINEL, 'utf8') };
  }
  if (maxTotalBytes != null && asm.bytes > maxTotalBytes) throw new Error(`mount_harness_over_cap bytes=${asm.bytes} cap=${maxTotalBytes}`);
  const request = buildMaterializeWriteRequest({ sessionRef, partitionLabel, text: asm.text });
  await send(request);
  // Read back the just-written address to get the CAS content_hash (BLAKE3 of the
  // raw markdown). run_leaf binds this as `--prompt-content-hash` and mounts it by
  // blob_ref, so the assembled prompt reaches the launched session by HASH (tiny),
  // never inline in the leaf plan JSON (which the 64KB compute-capture tail would
  // truncate). The op is the sole authority on both the bytes and their hash.
  const readBack = await send(buildReadPromptHashRequest({ sessionRef, partitionLabel }));
  // The entry's injected `send` decodes read-current replies via
  // decodeEngineReadCurrentReply, which surfaces the CAS hash as `contentHash`
  // (camelCase). Accept the snake variants too so a test sender can inject either.
  const contentHash = nonEmptyString(readBack?.contentHash)
    ?? nonEmptyString(readBack?.content_hash)
    ?? nonEmptyString(readBack?.payload?.contentHash)
    ?? nonEmptyString(readBack?.payload?.content_hash)
    ?? null;
  const directInstructionRows = rootRef
    ? []
    : directInstructionRefs.flatMap((instructionRef) => liveBlockRows.filter((row) => row?.id === instructionRef));
  return {
    address: harnessPromptAddress(sessionRef),
    content_hash: contentHash,
    content_bytes: asm.bytes,
    block_count: asm.blockCount,
    missing: asm.missing,
    delivery_mode: rootRef ? 'cas-system-prompt' : 'direct-profile',
    instruction_rows_json: JSON.stringify(directInstructionRows),
    materialization_content_bytes_json: JSON.stringify(asm.bytes),
    materialization_block_count_json: JSON.stringify(asm.blockCount),
    materialization_missing_json: JSON.stringify(asm.missing),
    builder_strings: builderStrings,
  };
}

/** Trim-and-nonempty guard for a possibly-absent string field. */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}
