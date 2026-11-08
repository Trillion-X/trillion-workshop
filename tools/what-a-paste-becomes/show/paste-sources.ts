// Public compatibility entry: use the existing converter with this tool's editable source rules.
import { pasteSourceOf as canonicalSourceOf, pastedMarkdown as canonicalMarkdown, tableRows as canonicalTableRows, type PastedMarkdown } from '../../edit-a-document-together/read-data/paste-sources.ts';
import configuration from './paste-sources.json' with { type: 'json' };

export type { PastedMarkdown };
export const pasteSourceOf = (html: string): string | null => canonicalSourceOf(html, configuration);
export const pastedMarkdown = (html: string, parse?: (html: string) => Document): PastedMarkdown | null => canonicalMarkdown(html, parse, configuration);
export const tableRows = (html: string, parse?: (html: string) => Document): string[][] | null => canonicalTableRows(html, parse, configuration);
