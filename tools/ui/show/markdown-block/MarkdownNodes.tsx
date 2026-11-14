// parts/ui/show/markdown-block/MarkdownNodes.tsx
//
// PORTED FROM: bitfield-packages/packages/chat/show/MarkdownContent.tsx (its markdown pipeline: GFM through `marked`,
//   raw HTML in the source shown as its own words, never run) with the HTML string it wrote swapped for React nodes.
//
// PURPOSE
//   Markdown drawn as React elements: headings, paragraphs, bold, italic, strikethrough, inline code and code blocks,
//   lists (with task boxes), quotes, tables, links, pictures, line breaks and rules. The caller lexes the words once
//   (marked's `lexer`) and hands the tokens here; this draws each token's own element, so no HTML string is ever built
//   or assigned. `renderText` lets a caller draw plain words its own way (a chat draws each `@mention` as a live chip).
//
// NON-NEGOTIABLE INVARIANTS
//   1. No HTML string is built or assigned: every token becomes an element here, and raw HTML in the source is shown
//      as the words it is (the package escaped it; here it is plain text, which cannot run).
//   2. A link opens only when its address is http, https or mailto; any other address is drawn as its words.
//   3. A token kind this file does not draw shows its raw words, so nothing written is ever dropped.
//   4. Looks come from parts/screen-look/show/markdown.css (`.markdown-nodes`); the only inline style is a highlighted
//      code token's own colour variables (`--shiki-light` / `--shiki-dark`), which the stylesheet picks between.
//   5. A code block is drawn plain until the caller's `highlight` answers for it, then as its coloured tokens.

import React from 'react';
import type { Token, Tokens } from 'marked';

import { cn } from '../cn';

export interface MarkdownNodesProps {
  /** The tokens of the words (marked's `lexer`). */
  tokens: readonly Token[];
  /** Draws plain words; defaults to the words as they are. */
  renderText?: (text: string, key: string) => React.ReactNode;
  /** A code block's coloured tokens, line by line, once known; null draws it plain. */
  highlight?: (code: string, language: string) => readonly HighlightedLine[] | null;
  className?: string;
}

/** One line of highlighted code: its tokens, each with its colour variables. */
export type HighlightedLine = readonly { content: string; style?: Readonly<Record<string, string>> }[];

type Draw = (text: string, key: string) => React.ReactNode;
type Highlight = NonNullable<MarkdownNodesProps['highlight']>;

const SAFE_LINK = /^(?:https?:|mailto:)/i;

function inline(tokens: readonly Token[] | undefined, draw: Draw, prefix: string): React.ReactNode[] {
  return (tokens ?? []).map((token, index) => inlineToken(token, draw, `${prefix}.${index}`));
}

function inlineToken(token: Token, draw: Draw, key: string): React.ReactNode {
  switch (token.type) {
    case 'text': {
      const text = token as Tokens.Text;
      return text.tokens?.length ? <React.Fragment key={key}>{inline(text.tokens, draw, key)}</React.Fragment> : <React.Fragment key={key}>{draw(text.text, key)}</React.Fragment>;
    }
    case 'escape': return <React.Fragment key={key}>{draw((token as Tokens.Escape).text, key)}</React.Fragment>;
    case 'strong': return <strong key={key}>{inline((token as Tokens.Strong).tokens, draw, key)}</strong>;
    case 'em': return <em key={key}>{inline((token as Tokens.Em).tokens, draw, key)}</em>;
    case 'del': return <del key={key}>{inline((token as Tokens.Del).tokens, draw, key)}</del>;
    case 'codespan': return <code key={key} className="markdown-nodes-code">{(token as Tokens.Codespan).text}</code>;
    case 'br': return <br key={key} />;
    case 'link': {
      const link = token as Tokens.Link;
      const words = inline(link.tokens, draw, key);
      return SAFE_LINK.test(link.href)
        ? <a key={key} href={link.href} title={link.title ?? undefined} target="_blank" rel="noopener noreferrer" className="markdown-nodes-link">{words}</a>
        : <React.Fragment key={key}>{words}</React.Fragment>;
    }
    case 'image': {
      const image = token as Tokens.Image;
      return /^https?:/i.test(image.href)
        ? <img key={key} src={image.href} alt={image.text} title={image.title ?? undefined} loading="lazy" className="markdown-nodes-image" />
        : <React.Fragment key={key}>{image.text}</React.Fragment>;
    }
    default: return <React.Fragment key={key}>{draw(token.raw, key)}</React.Fragment>;
  }
}

function block(token: Token, draw: Draw, key: string, highlight?: Highlight): React.ReactNode {
  switch (token.type) {
    case 'space': return null;
    case 'heading': {
      const heading = token as Tokens.Heading;
      const Tag = `h${Math.min(Math.max(heading.depth, 1), 6)}` as 'h1';
      return <Tag key={key} className="markdown-nodes-heading" data-depth={heading.depth}>{inline(heading.tokens, draw, key)}</Tag>;
    }
    case 'paragraph': return <p key={key}>{inline((token as Tokens.Paragraph).tokens, draw, key)}</p>;
    case 'text': {
      const text = token as Tokens.Text;
      return <p key={key}>{text.tokens?.length ? inline(text.tokens, draw, key) : draw(text.text, key)}</p>;
    }
    case 'code': {
      const code = token as Tokens.Code;
      const lines = highlight?.(code.text, code.lang ?? '') ?? null;
      return (
        <pre key={key} className="markdown-nodes-pre" data-language={code.lang || undefined} data-highlighted={lines ? 'true' : undefined}>
          <code>{lines ? lines.map((line, index) => (
            <span key={index} className="markdown-nodes-line">{line.map((part, at) => <span key={at} style={part.style as React.CSSProperties | undefined}>{part.content}</span>)}{index < lines.length - 1 ? '\n' : null}</span>
          )) : code.text}</code>
        </pre>
      );
    }
    case 'blockquote': return <blockquote key={key}>{blocks((token as Tokens.Blockquote).tokens, draw, key, highlight)}</blockquote>;
    case 'hr': return <hr key={key} />;
    case 'list': {
      const list = token as Tokens.List;
      const items = list.items.map((item, index) => (
        <li key={`${key}.${index}`} data-task={item.task ? (item.checked ? 'done' : 'open') : undefined}>
          {item.task ? <input type="checkbox" checked={Boolean(item.checked)} readOnly disabled aria-label={item.checked ? 'Done' : 'Not done'} /> : null}
          {item.loose ? blocks(item.tokens, draw, `${key}.${index}`, highlight) : item.tokens.map((child, childIndex) => child.type === 'text'
            ? <React.Fragment key={`${key}.${index}.${childIndex}`}>{inline((child as Tokens.Text).tokens ?? [child], draw, `${key}.${index}.${childIndex}`)}</React.Fragment>
            : block(child, draw, `${key}.${index}.${childIndex}`, highlight))}
        </li>
      ));
      return list.ordered
        ? <ol key={key} start={typeof list.start === 'number' && list.start !== 1 ? list.start : undefined}>{items}</ol>
        : <ul key={key}>{items}</ul>;
    }
    case 'table': {
      const table = token as Tokens.Table;
      const align = (cell: Tokens.TableCell) => cell.align ?? undefined;
      return (
        <table key={key} className="markdown-nodes-table">
          <thead><tr>{table.header.map((cell, index) => <th key={index} data-align={align(cell)}>{inline(cell.tokens, draw, `${key}.h${index}`)}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index} data-align={align(cell)}>{inline(cell.tokens, draw, `${key}.${rowIndex}.${index}`)}</td>)}</tr>)}</tbody>
        </table>
      );
    }
    default: return <p key={key}>{inlineToken(token, draw, key)}</p>;
  }
}

function blocks(tokens: readonly Token[], draw: Draw, prefix: string, highlight?: Highlight): React.ReactNode[] {
  return tokens.map((token, index) => block(token, draw, `${prefix}.${index}`, highlight));
}

const plain: Draw = text => text;

/** Markdown tokens drawn as React elements. */
export function MarkdownNodes({ tokens, renderText = plain, highlight, className }: MarkdownNodesProps) {
  return <div className={cn('markdown-nodes', className)}>{blocks(tokens, renderText, 'm', highlight)}</div>;
}
