#!/usr/bin/env node
/** Build frozen, label-free prose subsets for a selected maintained v3 criterion.
 * Moved from trillion-launch-video tools/copy-gate/build-book-voice-unlabeled-diagnostic.mjs: the blocks are
 * tools/pin-files-by-content's writingBlocks and BLAKE3 is tools/content-identity, each read from its one home. */
import {readFileSync, writeFileSync} from 'node:fs';
import {basename, resolve} from 'node:path';
import {classifyWritingBlock} from '../read-data/evaluation-integrity.mjs';
import {writingBlocks} from '../../pin-files-by-content/do-work/verify-writing-profile.mjs';
import {makeHashCodeHexFromBytes} from '../../content-identity/read-data/identity.mjs';

const args = process.argv.slice(2);
const arg = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const freezePath = resolve(arg('--freeze') ?? '');
const criteriaPath = resolve(arg('--criteria') ?? '');
const criterionId = arg('--criterion-id');
const outDir = resolve(arg('--out-dir') ?? '');
if (!arg('--freeze') || !arg('--criteria') || !arg('--out-dir')) {
  console.error('usage: build-book-voice-unlabeled-diagnostic.mjs --freeze <SOURCE-FREEZE.json> --criteria <v3-DATA.json|provenance.json> [--criterion-id <id>] --out-dir <private-dir>');
  process.exit(2);
}

const digest = bytes => makeHashCodeHexFromBytes(bytes).replace(/^1f:/, '');
const freezeBytes = readFileSync(freezePath);
const freeze = JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(freezeBytes));
if (freeze.schema !== 'private-book-source-freeze-v1' || !Array.isArray(freeze.sources) || !freeze.sources.length) {
  throw new Error('Expected a private-book-source-freeze-v1 manifest with sources');
}
const sourceNames = new Set();
for (const source of freeze.sources) {
  if (!source || typeof source.name !== 'string' || !source.name.trim() || sourceNames.has(source.name)
      || typeof source.source !== 'string' || typeof source.source_blake3 !== 'string'
      || typeof source.adoption !== 'string' || typeof source.adoption_blake3 !== 'string') {
    throw new Error('Every frozen source needs a unique name and source/adoption paths with BLAKE3 identities');
  }
  sourceNames.add(source.name);
}

const criteriaBytes = readFileSync(criteriaPath);
const criteriaSource = JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(criteriaBytes));
let candidateCriteria;
if (criteriaSource.schema === 'book-voice-decider-challenge-v3' && Array.isArray(criteriaSource.criteria)) {
  candidateCriteria = criteriaSource.criteria;
} else if (criteriaSource.criteria_frozen && typeof criteriaSource.criteria_frozen === 'object') {
  candidateCriteria = [criteriaSource.criteria_frozen];
} else {
  throw new Error('Criteria source must be maintained v3 DATA or legacy criteria_frozen provenance');
}
if (!criterionId && candidateCriteria.length !== 1) {
  throw new Error('Criteria source has multiple criteria; pass --criterion-id to select one');
}
const selectedId = criterionId ?? candidateCriteria[0]?.id;
const matching = candidateCriteria.filter(criterion => criterion?.id === selectedId);
if (matching.length !== 1) throw new Error('Selected criterion id must resolve exactly once in the criteria source');
const criterion = matching[0];
if (typeof criterion.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/iu.test(criterion.id)
    || criterion.primitive !== 'one-of' || !Array.isArray(criterion.applies_to) || !criterion.applies_to.length
    || typeof criterion.reference_context !== 'string' || !criterion.reference_context.trim()) {
  throw new Error('Selected criterion must be a typed v3 one-of with applicability and pinned reference context');
}
const excludedKinds = ['paragraph', 'heading', 'table', 'list', 'quote', 'mixed']
  .filter(kind => !criterion.applies_to.includes(kind));
const criterionBlake3 = digest(criteriaBytes);
const freezeBlake3 = digest(freezeBytes);
const outputs = [];

for (const frozen of freeze.sources) {
  const sourcePath = resolve(frozen.source);
  const sourceBytes = readFileSync(sourcePath);
  const sourceHash = digest(sourceBytes);
  if (sourceHash !== frozen.source_blake3) {
    throw new Error(`${frozen.name} source differs from ${basename(freezePath)}; refusing to build diagnostic DATA`);
  }
  const adoptionBytes = readFileSync(resolve(frozen.adoption));
  if (digest(adoptionBytes) !== frozen.adoption_blake3) {
    throw new Error(`${frozen.name} adoption manifest differs from ${basename(freezePath)}; refusing to build diagnostic DATA`);
  }
  const sourceText = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(sourceBytes);
  const blocks = writingBlocks(sourceText);
  const counts = {};
  const unassessed = {};
  const items = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const blockKind = classifyWritingBlock(block.text);
    counts[blockKind] = (counts[blockKind] ?? 0) + 1;
    if (!criterion.applies_to.includes(blockKind)) {
      (unassessed[blockKind] ??= []).push(index);
      continue;
    }
    const previous = blocks.slice(Math.max(0, index - 2), index);
    const readerContext = previous.map(({text}) => text).join('\n\n');
    const byteStart = block.byte_start;
    const byteEndExclusive = byteStart + Buffer.byteLength(block.text);
    if (sourceBytes.subarray(byteStart, byteEndExclusive).toString('utf8') !== block.text) {
      throw new Error(`${frozen.name} block ${index} text does not match its source byte span`);
    }
    items.push({
      id: `${frozen.name.toLowerCase()}-block-${index}`,
      family: `${frozen.name.toLowerCase()}-frozen-manuscript`,
      split: 'unlabeled',
      text: block.text,
      block_kind: blockKind,
      reader_context: readerContext,
      role: 'authored',
      source_kind: 'manuscript',
      origin: {kind: 'frozen-manuscript-candidate', source: sourcePath, source_blake3: sourceHash},
      block_index: index,
      byte_start: byteStart,
      byte_end_exclusive: byteEndExclusive,
      preceding_block_indices: previous.map((_, offset) => index - previous.length + offset),
    });
  }
  if (!items.length) throw new Error(`${frozen.name} contains no blocks applicable to ${criterion.id}`);
  const unassessedCounts = Object.fromEntries(Object.entries(unassessed).map(([kind, indices]) => [kind, indices.length]));
  const data = {
    schema: 'book-voice-decider-challenge-v3',
    dataset_role: 'unlabeled_manuscript_diagnostic_not_gate_evidence',
    source_identity: {
      name: frozen.name,
      source: sourcePath,
      source_blake3: sourceHash,
      source_freeze: freezePath,
      source_freeze_blake3: freezeBlake3,
      adoption: resolve(frozen.adoption),
      adoption_blake3: frozen.adoption_blake3,
      criteria_source: criteriaPath,
      criteria_source_blake3: criterionBlake3,
    },
    criteria: [criterion],
    items,
    limits: {
      purpose: 'unlabeled diagnostic over criterion-applicable prose, quote, list, and mixed blocks only',
      criterion_id: criterion.id,
      total_source_blocks: blocks.length,
      selected_model_rows: items.length,
      all_block_counts: counts,
      unassessed_block_counts: unassessedCounts,
      unassessed_block_indices: unassessed,
      excluded_block_kinds: excludedKinds,
      gold_labels_present: false,
      reader_context: 'the literal text of the preceding two writingBlocks, preserving original block indices',
      source_freeze_status: freeze.status,
    },
  };
  const outPath = resolve(outDir, `unlabeled-${frozen.name.toLowerCase()}-${criterion.id}-v1.json`);
  writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  outputs.push({name: frozen.name, path: outPath, source_blake3: sourceHash, total_blocks: blocks.length,
    selected_rows: items.length, block_counts: counts, unassessed_counts: unassessedCounts,
    excluded_block_kinds: excludedKinds});
}
console.log(JSON.stringify({schema: 'unlabeled-manuscript-diagnostic-build-v1', criterion_id: criterion.id,
  criterion_source: criteriaPath, criterion_source_blake3: criterionBlake3, outputs}, null, 2));
