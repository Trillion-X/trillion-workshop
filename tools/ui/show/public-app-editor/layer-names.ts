// parts/ui/show/public-app-editor/layer-names.ts
//
// NO PRIOR: searched ~/dev/bitfield-packages/packages/*/show for "layer name", "element name" and "describeLayer"
// (only caller-supplied labels in ui/show/node-editors/LayerStackPanel, nothing that names page elements), and the
// 21st.dev MCP for a layers tree (no naming of page elements in any result).
//
// What the page editor's layers call each element and which mark it gets, read from layer-kinds.json: "Small-batch
// Fresh bread, out of the oven" with a heading mark rather than "Text", "Order now" with a link mark rather than
// "Link", "Hero copy" for a group whose class is hero-copy rather than "Box". The kinds are DATA; this file only reads
// them, so a new kind of element is a row there.

import KINDS from './layer-kinds.json';

type Kind = { tags?: string[]; label: string; icon: string; named_by: string | string[]; text_inside?: boolean };

/** What an element offers to be named by, all as plain words. */
export type LayerFacts = {
  tag: string;
  /** A name given to it in the editor, or its id or aria-label. */
  given?: string;
  text?: string;
  alt?: string;
  placeholder?: string;
  title?: string;
  className?: string;
  /** The words of the first heading inside it. */
  heading?: string;
};

const byTag = new Map<string, Kind>();
for (const kind of KINDS.kinds as Kind[]) for (const tag of kind.tags ?? []) byTag.set(tag, kind);
const otherwise = KINDS.otherwise as Kind;

const words = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
const short = (value: string) => value.length > KINDS.longest_name ? `${value.slice(0, KINDS.longest_name - 1).trimEnd()}…` : value;
/** "hero-copy card" -> "Hero copy": the first class, its separators turned into spaces. */
const fromClass = (value: string | undefined) => {
  const first = words(value).split(' ').find(name => /[a-z]/i.test(name) && !/^(gjs|trillion)-/.test(name)) ?? '';
  const spaced = first.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : '';
};

export function layerKind(tag: string): Kind {
  return byTag.get(tag.toLowerCase()) ?? otherwise;
}

/** The element is edited as one piece of words: its layer lists nothing inside it. */
export function layerHoldsOnlyWords(tag: string): boolean {
  return layerKind(tag).text_inside === true;
}

export function layerLabel(facts: LayerFacts): { name: string; icon: string } {
  const kind = layerKind(facts.tag);
  const given = words(facts.given);
  if (given) return { name: short(given), icon: kind.icon };
  const offered: Record<string, string> = {
    text: words(facts.text), alt: words(facts.alt), placeholder: words(facts.placeholder), title: words(facts.title),
    heading: words(facts.heading), class: fromClass(facts.className),
  };
  const order = [kind.named_by].flat();
  const name = order.map(by => offered[by]).find(Boolean) || offered.class || kind.label;
  return { name: short(name), icon: kind.icon };
}
