// tools/draw-a-change-as-a-diagram/do-work/author-input.mjs
//
// WHAT LEAVES THE MACHINE WHEN A MODEL IS ASKED FOR A GRAPH: CHOSEN BY PRIORITY, FILTERED BEFORE ANYTHING IS SENT, LISTED EXACTLY.
//
// Purpose: a graph document is often written from a large input (the files of a change). Cutting that input at its first N
// bytes lets lock-file churn push real work out and lets a secret-bearing file go out as written. This chooses what is sent by
// rank, never sends what DATA says must not leave, cuts at most the one file that straddles the budget, and returns the
// exact list of what leaves and what stays, so the same list can be shown to the person first (a dry run) and checked.
//
// Non-negotiable invariants:
//   1. Excluded paths are removed before ranking and never reach the budget; each carries the reason it is told in.
//   2. Lower ranks are sent before higher ones, in the input's own order within a rank; a file is sent whole, or cut only when
//      it is the one that straddles the budget and at least `min_cut_bytes` of it fits.
//   3. Sizes are bytes of UTF-8; the total sent never exceeds `budget_bytes`.
//   4. Every exclusion, class, limit and word is DATA (./author-input.json). Pure: the same input and rules, the same list.
//
// Key concepts: `boundAuthorInput(files, rules?)` -> { sent, left_out, bytes }; `outboundList(bounded, rules?)` -> lines.
import authorInput from '../read-data/author-input.json' with { type: 'json' };
import { selectorTest } from './select-glob.mjs';

const encoder = new TextEncoder();
const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (whole, name) => (name in values ? String(values[name]) : whole));

function cutToBytes(text, bytes) {
  let end = Math.min(text.length, bytes);
  while (end > 0 && encoder.encode(text.slice(0, end)).length > bytes) end -= 1;
  return text.slice(0, end);
}

/**
 * `files`: [{ path, text }] in the order given. -> { sent: [{ path, text, bytes, cut, class }], left_out: [{ path, reason, why }], bytes }
 * `reason` is the rule's id (or 'budget'); `why` is its words.
 */
export function boundAuthorInput(files, rules = authorInput) {
  const excludes = rules.exclude.map((row) => ({ row, tests: row.match.map((glob) => selectorTest(glob, rules.wildcard)) }));
  const classes = rules.classes.map((row) => ({ row, tests: row.match.map((glob) => selectorTest(glob, rules.wildcard)) }));
  const leftOut = [];
  const candidates = [];
  files.forEach((file, order) => {
    const excluded = excludes.find(({ tests }) => tests.some((test) => test(file.path)));
    if (excluded) { leftOut.push({ path: file.path, reason: excluded.row.id, why: excluded.row.reason }); return; }
    const found = classes.find(({ tests }) => tests.some((test) => test(file.path)));
    candidates.push({ file, order, rank: found ? found.row.rank : rules.default_rank, class: found ? found.row.id : null, size: encoder.encode(file.text).length });
  });
  candidates.sort((a, b) => a.rank - b.rank || a.order - b.order);
  const sent = [];
  let used = 0;
  for (const item of candidates) {
    const room = rules.budget_bytes - used;
    if (item.size <= room) { sent.push({ path: item.file.path, text: item.file.text, bytes: item.size, cut: false, class: item.class }); used += item.size; continue; }
    if (room >= rules.min_cut_bytes) {
      const text = cutToBytes(item.file.text, room);
      const bytes = encoder.encode(text).length;
      sent.push({ path: item.file.path, text, bytes, cut: true, class: item.class });
      used += bytes;
    } else leftOut.push({ path: item.file.path, reason: 'budget', why: rules.words.budget });
  }
  return { sent, left_out: leftOut, bytes: used };
}

/** The exact list of what leaves and what stays, one line each, for showing before anything is sent. */
export function outboundList(bounded, rules = authorInput) {
  const words = rules.words;
  return [
    fill(words.intro, { sent_count: bounded.sent.length, sent_bytes: bounded.bytes, budget_bytes: rules.budget_bytes }),
    ...bounded.sent.map((file) => fill(words.sent, { path: file.path, bytes: file.bytes, cut: file.cut ? words.cut : '' })),
    ...(bounded.left_out.length ? [fill(words.left_out_intro, { left_out_count: bounded.left_out.length }),
      ...bounded.left_out.map((file) => fill(words.left_out, { path: file.path, reason: file.why }))] : []),
  ];
}
