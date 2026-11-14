// parts/ui/show/markdown-block/MarkdownWords.tsx
//
// PURPOSE
//   Words a person reads, drawn as a readable passage: paragraphs, line breaks, headings, lists, quotes, code, links,
//   and each #tag, @handle and bare address as its mark (document-page word-marks.json). The one reading surface for
//   words wherever they show: a file's text, an email's body, an opened record, a post.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The one markdown renderer (document-page markdownHtml) reads the words; raw HTML in them shows as text and only
//      http(s) or same-page addresses become links. Nothing here builds markup.
//   2. Marks are always on: a tag, a handle or an address reads the same on every surface.
//   3. `breaks` keeps each line break the writer made (a post, a message); without it a paragraph's lines join, as
//      wrapped prose in a document should.
//   4. The look is screen-look file-preview.css (`.file-preview-markdown` and its `.doc-mark` marks); a caller with its
//      own look names it with `className`.

import React from 'react';
import { MarkdownBlock } from './MarkdownBlock';
import { markdownHtml } from '../document-page/document-page-html.mjs';

export interface MarkdownWordsProps {
  /** The words, in markdown or plain text. */
  words: string;
  /** Keep each line break the writer made. */
  breaks?: boolean;
  /** Links drawn as their words, for a passage inside something that opens as a whole (a tile). */
  links?: boolean;
  className?: string;
}

/** Words drawn as a readable passage with their marks. */
export function MarkdownWords({ words, breaks = false, links = true, className = 'file-preview-markdown' }: MarkdownWordsProps) {
  return <MarkdownBlock className={className} html={markdownHtml(words, { linkClass: 'file-preview-link', newTab: true, links, breaks, marks: true })} />;
}
