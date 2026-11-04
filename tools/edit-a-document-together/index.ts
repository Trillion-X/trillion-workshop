// parts/documents/index.ts
//
// The documents part's public face (declared in part.json): the shared block editor, the document it edits and every
// change and reading of one, and the rule and inline-token models under them.

export { DocumentEditor } from './show/DocumentEditor';
export type { DocumentEditorHandle, DocumentEditorProps, MentionPickerRequest } from './show/DocumentEditor';
export {
  DEFAULT_EDITING_RULES,
  SHIPPED_EDITING_ROWS,
  applyAutoformat,
  applySelectionOp,
  blocksFromMarkdown,
  continueBlock,
  documentFromMarkdown,
  documentToMarkdown,
  documentToPlainText,
  editingRulesWith,
  emptyDocument,
  enterDecision,
  insertMention,
  isDocumentEmpty,
  joinWithPrevious,
  leaveBlockKind,
  mentionsIn,
  mintBlockId,
  normalizeDocument,
  pasteMarkdown,
  readEditingRules,
  setBlockText,
  splitBlock,
} from './read-data/document-value.ts';
export type { DocumentNode, DocumentValue, Edited, EditingRules, Focus, Mint } from './read-data/document-value.ts';
export type { InputShortcut, AutoformatRule } from './read-data/documents.ts';
export { encodeInlineLinkOpen, safeInlineLinkUrl, applyInlineLinkToText, selectedInlineLink, encodeRefToken, parseInlineRuns, hasRefToken, runsToText } from './read-data/inline-tokens.ts';
export type { InlineMark, Ref, Run } from './read-data/inline-tokens.ts';
export { pageReferencesToCheck } from './read-data/page-references.ts';
// A document's pages from plain sections of words (each `{ text, heading?, level? }`), the shape Write keeps.
export { sectionsToContent } from './do-work/imported-document.mjs';
export type { PageReference, ReferenceResolution } from './read-data/page-references.ts';
