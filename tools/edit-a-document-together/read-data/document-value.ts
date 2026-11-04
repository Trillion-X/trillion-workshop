// parts/documents/read-data/document-value.ts
//
// PURPOSE
//   The document the shared editor edits, and every change it makes to one, as pure functions over a list of blocks:
//   typing a shortcut, Enter (split, continue a list, leave a list), Backspace at a block's start (join), deleting a
//   selection, choosing a mention, and reading the document out as markdown, plain words and mentions, or in from
//   markdown through the same rules typing uses. The editor view (show/DocumentEditor.tsx) only reads the DOM and
//   calls these; everything a machine can check lives here.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The rules are DATA (editing-rules.json plus a caller's own rows); nothing here names a prefix, look or kind.
//   2. A document always holds at least one block: emptiness re-seeds from the empty-state row.
//   3. Every function is pure and returns a new value; ids come from the caller's `mint`, so tests are exact.
//   4. Markdown out is how each block's own rule says it writes (`markdown` template over { block: { text, words } });
//      markdown in folds each line through the same rules as typing, so what goes out comes back as the same blocks.

import { resolveBindingTemplate } from '../../ui/show/action-affordance/read-action-affordances.ts';
import editingRules from './editing-rules.json' with { type: 'json' };
import { readCursorCommands, type CursorCommand } from './cursor-commands.ts';
import {
  foldAutoformatToNodes,
  materializeEmptyStateSeed,
  matchAutoformat,
  readEmptyStateSeed,
  readInlineMarks,
  readInputShortcuts,
  readInputShortcutsFull,
  splitMarkdownLines,
  textInputPolicyFor,
  type AutoformatContext,
  type AutoformatMatch,
  type AutoformatRule,
  type SceneNode as DocumentNode,
  type InputShortcut,
  type ScenePatch,
} from './documents.ts';
import { encodeInlineLinkOpen, encodeRefToken, insertRefTokenIntoText, parseEmphasisRuns, safeInlineLinkUrl, type InlineMark, type Ref } from './inline-tokens.ts';
import { normalizeAuthoredDocument } from './normalize-authored-document.ts';
import { markdownCodeFence } from './markdown-code-fence.ts';
import { readSelectionOps, selectionOpPatches, type SelectionOp } from './selection-ops.ts';
import { markerToStartTheNextOneWith, whatEnterDoesInThisBlock, type EnterDecision } from './what-enter-does-in-this-block.ts';

/** What the editor edits: the blocks, top to bottom. */
export type DocumentValue = { blocks: DocumentNode[] };
/** A block: the documents package's scene node (read-data/documents.ts). */
export type { DocumentNode };
/** Where the caret goes after a change: a block and a flat offset in its text ('end' for its end). */
export type Focus = { blockId: string; at: number | 'end'; end?: number };
/** A change and where the caret lands after it. */
export type Edited = { value: DocumentValue; focus: Focus | null };
export type Mint = () => string;

// List nesting is bounded so malformed or adversarial saved depths cannot push
// content off-screen. The shortcut row opts in; the value layer names no list kind.
export const MAX_INDENT_LEVEL = 8;

/** Every registry the editor reads, decoded once. */
export type EditingRules = {
  shortcuts: InputShortcut[];
  autoformat: AutoformatRule[];
  marks: InlineMark[];
  cursorCommands: CursorCommand[];
  selectionOps: SelectionOp[];
  emptyState: Record<string, unknown>[] | null;
};

/** Decode rows into the registries (by kind, later ids winning). */
export function readEditingRules(raw: unknown): EditingRules {
  return {
    shortcuts: readInputShortcutsFull(raw),
    autoformat: readInputShortcuts(raw),
    marks: readInlineMarks(raw),
    cursorCommands: readCursorCommands(raw),
    selectionOps: readSelectionOps(raw),
    emptyState: readEmptyStateSeed(raw),
  };
}

/** The shipped rows (editing-rules.json). */
export const SHIPPED_EDITING_ROWS: readonly unknown[] = editingRules.rows;
/** The shipped registries. */
export const DEFAULT_EDITING_RULES: EditingRules = readEditingRules(SHIPPED_EDITING_ROWS);
/** The shipped rows with a caller's own rows over them (a row with a shipped id replaces it). */
export function editingRulesWith(rows: readonly unknown[]): EditingRules {
  return rows.length ? readEditingRules([...SHIPPED_EDITING_ROWS, ...rows]) : DEFAULT_EDITING_RULES;
}

let minted = 0;
/** Fresh block ids for the editor: unique within this page and never reused. */
export const mintBlockId: Mint = () => `block:${Date.now().toString(36)}:${(minted += 1).toString(36)}`;

const textOf = (node: DocumentNode | undefined): string => (typeof node?.props?.text === 'string' ? node.props.text : '');
const isWords = (node: DocumentNode) => node.kind === 'Text';
const plainBlock = (id: string, text = ''): DocumentNode => ({ id, kind: 'Text', props: { text }, visible: true, children: [] });
const shown = (value: DocumentValue) => value.blocks.filter((node) => node.visible !== false);

/** A document holding what the empty-state row says (one blank block when there is none). */
export function emptyDocument(rules: EditingRules, mint: Mint): DocumentValue {
  const blocks = rules.emptyState ? materializeEmptyStateSeed(rules.emptyState, mint) : [];
  return { blocks: blocks.length ? blocks : [plainBlock(mint())] };
}

/** A caller's value made safe to draw: ids repaired, nulls dropped, and never zero blocks. */
export function normalizeDocument(value: DocumentValue | null | undefined, rules: EditingRules, mint: Mint): DocumentValue {
  const { children, repaired } = normalizeAuthoredDocument(value?.blocks, [], { mint });
  if (!children.length) return emptyDocument(rules, mint);
  return repaired || !value ? { blocks: children } : value;
}

/** Whether nothing has been written (no words, no mention, nothing but blank blocks). */
export function isDocumentEmpty(value: DocumentValue): boolean {
  return shown(value).every((node) => isWords(node) && textOf(node).trim() === '');
}

const replaceBlock = (value: DocumentValue, id: string, nodes: readonly DocumentNode[]): DocumentValue => ({
  blocks: value.blocks.flatMap((node) => (node.id === id ? [...nodes] : [node])),
});
const withProps = (node: DocumentNode, props: Record<string, unknown>): DocumentNode => ({ ...node, props });

/** A block's words changed as typed (nothing else about it changes). */
export function setBlockText(value: DocumentValue, blockId: string, text: string): DocumentValue {
  return { blocks: value.blocks.map((node) => (node.id === blockId ? withProps(node, { ...node.props, text }) : node)) };
}

/** Indent or outdent a DATA-opted-in block while preserving its identity and caret. */
export function changeBlockIndent(value: DocumentValue, blockId: string, delta: -1 | 1, rules: Pick<EditingRules, 'shortcuts'>, at: number | 'end' = 'end'): Edited | null {
  const node = value.blocks.find((one) => one.id === blockId);
  const madeBy = node?.props?.made_by_shortcut;
  if (!node || typeof madeBy !== 'string' || !rules.shortcuts.some((rule) => rule.id === madeBy && rule.indentable === true)) return null;
  const current = Number.isInteger(node.props?.indent_level)
    ? Math.max(0, Math.min(MAX_INDENT_LEVEL, Number(node.props?.indent_level))) : 0;
  const next = Math.max(0, Math.min(MAX_INDENT_LEVEL, current + delta));
  if (next === current) return null;
  const props = { ...node.props };
  if (next === 0) delete props.indent_level;
  else props.indent_level = next;
  return { value: { blocks: value.blocks.map((one) => one.id === blockId ? withProps(one, props) : one) }, focus: { blockId, at } };
}

/** Resolve a matched rule over a fresh plain block holding the words, and fold it into the node(s) it becomes. */
function transform(match: AutoformatMatch, base: DocumentNode, index: number, mint: Mint): DocumentNode[] {
  const context: AutoformatContext = {
    captured: match.captured,
    block: { id: base.id },
    parent: { id: 'document', index, next: index + 1 },
    fresh: { id: mint(), id2: mint() },
  };
  const patches = resolveBindingTemplate(match.rule.effect, context as never) as ScenePatch[];
  return foldAutoformatToNodes(patches, base);
}

/** A rule recognised in a block (`# ` then space, `---` then Enter): the block becomes what the rule makes. The caret
 *  goes to the last block of words the rule left (the block itself, or the blank one after a divider), `wordsAfter`
 *  characters before its end (the words that were after the caret when the rule fired). */
export function applyAutoformat(value: DocumentValue, blockId: string, match: AutoformatMatch, mint: Mint, wordsAfter = 0): Edited {
  const index = value.blocks.findIndex((node) => node.id === blockId);
  if (index < 0) return { value, focus: null };
  const nodes = transform(match, plainBlock(blockId, match.captured.text), index, mint);
  const landing = [...nodes].reverse().find(isWords);
  const at = landing && wordsAfter > 0 ? Math.max(0, textOf(landing).length - wordsAfter) : 'end';
  return { value: replaceBlock(value, blockId, nodes), focus: landing ? { blockId: landing.id, at } : null };
}

/** What Enter does in this block, from the rule that made it (the editor performs the answer). */
export function enterDecision(value: DocumentValue, blockId: string, rules: EditingRules): EnterDecision {
  const node = value.blocks.find((one) => one.id === blockId);
  const madeBy = node?.props?.made_by_shortcut;
  return whatEnterDoesInThisBlock({ madeByShortcut: typeof madeBy === 'string' ? madeBy : null, text: textOf(node), rules: rules.shortcuts });
}

/** Enter at `at` in a block: the words before stay, the words after move to a new plain block below. */
export function splitBlock(value: DocumentValue, blockId: string, at: number, mint: Mint): Edited {
  const node = value.blocks.find((one) => one.id === blockId);
  if (!node) return { value, focus: null };
  const text = textOf(node);
  const cut = Math.max(0, Math.min(at, text.length));
  const next = plainBlock(mint(), text.slice(cut));
  return { value: replaceBlock(value, blockId, [withProps(node, { ...node.props, text: text.slice(0, cut) }), next]), focus: { blockId: next.id, at: 0 } };
}

/** Enter in a block whose rule continues (a list, a quote): a new block of the same kind, starting with the next
 *  marker, carrying the words after the caret. */
export function continueBlock(value: DocumentValue, blockId: string, at: number, decision: Extract<EnterDecision, { does: 'make_another_one_like_this' }>, mint: Mint): Edited {
  const node = value.blocks.find((one) => one.id === blockId);
  if (!node) return { value, focus: null };
  const text = textOf(node);
  const cut = Math.max(0, Math.min(at, text.length));
  const id = mint();
  const authored = text.slice(cut).trimStart();
  const marker = markerToStartTheNextOneWith(text, decision.nextMarker, decision.rule);
  let next: DocumentNode = { id, kind: node.kind, props: { text: `${marker}${authored}`, made_by_shortcut: decision.rule.id, ...(node.props?.indent_level ? { indent_level: node.props.indent_level } : {}) }, visible: true, children: [] };

  // Continuation starts from a fresh block and runs the same DATA effect that made the current
  // block. This preserves rule-owned look/style/material props without copying stale node props.
  if (Array.isArray(decision.rule.effect_template) && decision.rule.effect_template.length) {
    // Template bindings mint a replacement identity only when the effect needs it.
    let replacementId: string | undefined, trailingId: string | undefined;
    const context: AutoformatContext = {
      captured: { text: authored, ...(decision.nextMarker ? { match: decision.nextMarker } : {}) },
      block: { id },
      parent: { id: 'document', index: value.blocks.findIndex((one) => one.id === blockId) + 1, next: value.blocks.findIndex((one) => one.id === blockId) + 2 },
      fresh: { get id() { return replacementId ??= mint(); }, get id2() { return trailingId ??= mint(); } },
    };
    const patches = resolveBindingTemplate(decision.rule.effect_template, context as never) as ScenePatch[];
    const effected = foldAutoformatToNodes(patches, plainBlock(id, authored));
    const effectedBlock = effected.find((candidate) => candidate.id === id);
    if (effectedBlock) next = { ...effectedBlock, id, props: { ...effectedBlock.props, made_by_shortcut: decision.rule.id, ...(node.props?.indent_level ? { indent_level: node.props.indent_level } : {}) } };
  }
  const nextText = textOf(next);
  return { value: replaceBlock(value, blockId, [withProps(node, { ...node.props, text: text.slice(0, cut) }), next]), focus: { blockId: id, at: Math.max(0, nextText.length - authored.length) } };
}

/** Enter in an empty item: it leaves the list and becomes a plain block in place. */
export function leaveBlockKind(value: DocumentValue, blockId: string): Edited {
  // Ending the kind also ends its lineage and rule-owned appearance.
  return { value: { blocks: value.blocks.map((node) => (node.id === blockId ? withProps(node, { text: '', made_by_shortcut: null }) : node)) }, focus: { blockId, at: 0 } };
}

/** Backspace at a block's start. Above it is a block of words: the two join, caret at the seam. Above it is a
 *  drawn block (a divider): that goes. Nothing above and the block was made by a rule: it becomes plain words. */
export function joinWithPrevious(value: DocumentValue, blockId: string): Edited | null {
  const blocks = shown(value);
  const index = blocks.findIndex((node) => node.id === blockId);
  if (index < 0) return null;
  const node = blocks[index];
  const above = blocks[index - 1];
  if (!above) {
    if (Object.keys(node.props ?? {}).every((key) => key === 'text')) return null;
    return { value: { blocks: value.blocks.map((one) => (one.id === blockId ? withProps(one, { text: textOf(one) }) : one)) }, focus: { blockId, at: 0 } };
  }
  if (!isWords(above)) return { value: { blocks: value.blocks.filter((one) => one.id !== above.id) }, focus: { blockId, at: 0 } };
  const seam = textOf(above).length;
  const joined = withProps(above, { ...above.props, text: `${textOf(above)}${textOf(node)}` });
  return { value: { blocks: value.blocks.flatMap((one) => (one.id === above.id ? [joined] : one.id === blockId ? [] : [one])) }, focus: { blockId: above.id, at: seam } };
}

/** A selection op over the selected blocks (Backspace deletes them). A document emptied this way re-seeds. */
export function applySelectionOp(value: DocumentValue, op: SelectionOp, selected: readonly string[], rules: EditingRules, mint: Mint): Edited {
  const ids = value.blocks.filter((node) => selected.includes(node.id)).map((node) => node.id);
  const patches = selectionOpPatches(op, ids, ids);
  let blocks = value.blocks;
  for (const patch of patches) {
    if (patch.type === 'REMOVE_SUBTREE') blocks = blocks.filter((node) => node.id !== patch.node_id);
    else if (patch.type === 'UPDATE_PROPS') blocks = blocks.map((node) => (node.id === patch.node_id ? withProps(node, { ...node.props, ...((patch.props as Record<string, unknown> | undefined) ?? {}) }) : node));
  }
  const next = blocks.length ? { blocks } : emptyDocument(rules, mint);
  const landing = next.blocks.find(isWords);
  return { value: next, focus: landing ? { blockId: landing.id, at: 'end' } : null };
}

/** A mention chosen from the picker replaces the `@query` it opened on. The caret lands after the chip. */
export function insertMention(value: DocumentValue, blockId: string, ref: Ref, range?: { start: number; end: number }): Edited {
  const node = value.blocks.find((one) => one.id === blockId);
  if (!node) return { value, focus: null };
  const token = encodeRefToken(ref);
  const before = textOf(node);
  const text = insertRefTokenIntoText(before, token, range);
  const at = range && range.start >= 0 && range.end <= before.length && range.start <= range.end ? range.start + token.length + 1 : text.length;
  return { value: setBlockText(value, blockId, text), focus: { blockId, at } };
}

/** Pasted or given markdown as blocks: each line folds through the same rules as typing (`# x` is a heading). A line
 *  is one block, so the blank block a rule leaves for the caret to go on typing into (after a divider) is not kept. */
export function blocksFromMarkdown(markdown: string, rules: Pick<EditingRules, 'shortcuts' | 'autoformat'>, mint: Mint): DocumentNode[] {
  const out: DocumentNode[] = [];
  const keepLinks = (node: DocumentNode): DocumentNode => ({
    ...node,
    ...(node.kind === 'Text' && typeof node.props?.text === 'string'
      ? { props: { ...node.props, text: markdownLinksToInlineText(node.props.text) } } : {}),
    ...(node.children ? { children: node.children.map(keepLinks) } : {}),
  });
  for (const line of splitMarkdownLines(markdown)) {
    const leading = /^\s+/.exec(line)?.[0] ?? '';
    const candidate = line.slice(leading.length);
    const found = matchAutoformat(candidate, 'space', rules.autoformat) ?? matchAutoformat(candidate, 'enter', rules.autoformat);
    const id = mint();
    if (!found) { out.push(keepLinks(plainBlock(id, line))); continue; }
    const indentable = rules.shortcuts.some((rule) => rule.id === found.rule.id && rule.indentable === true);
    if (leading && !indentable) { out.push(keepLinks(plainBlock(id, line))); continue; }
    const match = { ...found, captured: { ...found.captured, text: found.captured.text.trimStart() } };
    const nodes = transform(match, plainBlock(id, match.captured.text), out.length, mint);
    const depth = indentable ? Math.min(MAX_INDENT_LEVEL, Math.floor(leading.replace(/\t/g, '  ').length / 2)) : 0;
    for (const node of nodes) if (node.id === id || !isWords(node) || textOf(node) !== '') {
      const indented = depth > 0 && isWords(node) ? withProps(node, { ...node.props, indent_level: depth }) : node;
      out.push(keepLinks(indented));
    }
  }
  return out;
}

function markdownLinksToInlineText(text: string): string {
  return text.replace(/\[((?:\\.|[^\]\\\n])+?)\]\((https?:\/\/[^\s)]+)\)/gi, (whole, encodedLabel: string, rawHref: string) => {
    const href = safeInlineLinkUrl(rawHref);
    const open = href && encodeInlineLinkOpen(href);
    const label = encodedLabel.replace(/\\([\\\[\]])/g, '$1');
    return open ? `${open}${label}⟦/link⟧` : whole;
  });
}

/** A whole document from markdown (an empty one when there are no lines). */
export function documentFromMarkdown(markdown: string, rules: EditingRules, mint: Mint): DocumentValue {
  const blocks = blocksFromMarkdown(markdown, rules, mint);
  return blocks.length ? { blocks } : emptyDocument(rules, mint);
}

/** Pasted lines land at the caret: the first line joins the words before the caret, the last carries the words after. */
export function pasteMarkdown(value: DocumentValue, blockId: string, at: number, markdown: string, rules: EditingRules, mint: Mint): Edited {
  const node = value.blocks.find((one) => one.id === blockId);
  const pasted = blocksFromMarkdown(markdown, rules, mint);
  if (!node || !pasted.length) return { value, focus: null };
  const text = textOf(node);
  const cut = Math.max(0, Math.min(at, text.length));
  const head = text.slice(0, cut);
  const tail = text.slice(cut);
  const first = pasted[0];
  const merged = head && isWords(first) && Object.keys(first.props ?? {}).every((key) => key === 'text')
    ? [withProps(node, { ...node.props, text: `${head}${textOf(first)}` }), ...pasted.slice(1)]
    : [...(head ? [withProps(node, { ...node.props, text: head })] : []), ...pasted];
  const last = merged[merged.length - 1];
  const lastAt = textOf(last).length;
  const closed = isWords(last) ? [...merged.slice(0, -1), withProps(last, { ...last.props, text: `${textOf(last)}${tail}` })] : [...merged, plainBlock(mint(), tail)];
  const landing = closed[closed.length - 1];
  return { value: replaceBlock(value, blockId, closed), focus: { blockId: landing.id, at: isWords(last) ? lastAt : 0 } };
}

// A block's words as a person reads them: marks without their markers, mentions as @name.
function wordsOf(text: string, marks: readonly InlineMark[]): string {
  return parseEmphasisRuns(text, marks).map((run) => (run.type === 'ref' ? `@${run.label}` : run.text)).join('');
}
// A block's text with mentions as @name and marks kept as markdown.
const withMentionsNamed = (text: string) => parseEmphasisRuns(text, []).map((run) => {
  const words = run.type === 'ref' ? `@${run.label}` : run.text;
  const markdownHref = run.link?.replace(/[()]/g, character => character === '(' ? '%28' : '%29');
  return markdownHref ? `[${words.replace(/([\\[\]])/g, '\\$1')}](${markdownHref})` : words;
}).join('');

/** The document as markdown: each block written the way the rule that made it says, one block per line. */
export function documentToMarkdown(value: DocumentValue, rules: EditingRules): string {
  return shown(value).map((node) => {
    const madeBy = node.props?.made_by_shortcut;
    const rule = typeof madeBy === 'string' ? rules.shortcuts.find((row) => row.id === madeBy) : undefined;
    const literal = rule?.text_input?.mode === 'literal';
    const text = literal ? textOf(node) : withMentionsNamed(textOf(node));
    if (rule?.markdown === undefined) return text;
    if (rule.markdown && typeof rule.markdown === 'object' && 'fence' in rule.markdown) {
      const descriptor = rule.markdown as { fence: string; minimum?: number };
      return markdownCodeFence(text, descriptor.fence, descriptor.minimum);
    }
    const words = text.slice(markerToStartTheNextOneWith(text, undefined, rule).length);
    const written = resolveBindingTemplate(rule.markdown, { block: { text, words } } as never);
    const indent = rule.indentable === true && Number.isInteger(node.props?.indent_level)
      ? '  '.repeat(Math.max(0, Math.min(MAX_INDENT_LEVEL, Number(node.props?.indent_level)))) : '';
    return `${indent}${typeof written === 'string' ? written : text}`;
  }).join('\n').replace(/^\n+|\n+$/g, '');
}

/** The document as plain words: markers dropped, mentions as @name, one block per line. */
export function documentToPlainText(value: DocumentValue, rules: EditingRules): string {
  return shown(value).filter(isWords).map((node) => textInputPolicyFor(rules.shortcuts, node.props?.made_by_shortcut)?.mode === 'literal'
    ? textOf(node) : wordsOf(textOf(node), rules.marks)).join('\n').replace(/^\n+|\n+$/g, '');
}

/** Every mention in the document, once each, in the order written, as it travels with a message: { kind, value, label }. */
export function mentionsIn(value: DocumentValue, rules: EditingRules = DEFAULT_EDITING_RULES): Pick<Ref, 'kind' | 'value' | 'label'>[] {
  const seen = new Map<string, Pick<Ref, 'kind' | 'value' | 'label'>>();
  for (const node of shown(value)) for (const run of textInputPolicyFor(rules.shortcuts, node.props?.made_by_shortcut)?.mode === 'literal'
    ? [] : parseEmphasisRuns(textOf(node), [])) {
    if (run.type !== 'ref') continue;
    const key = JSON.stringify([run.kind, run.value]);
    if (!seen.has(key)) seen.set(key, { kind: run.kind, value: run.value, label: run.label });
  }
  return [...seen.values()];
}
