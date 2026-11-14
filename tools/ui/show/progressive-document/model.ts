/** Content-neutral model for a document that gains detail between stable anchors. */
export type ProgressivePart = { id: string; kind: string; minDepth: number; text: string; term?: string };
export type ProgressiveParagraph = { id: string; parts: ProgressivePart[] };
export type ProgressivePartGroup = { id: string; kind: string; minDepth: number; parts: ProgressivePart[] };
export type ProgressiveDocumentData = {
  title: string;
  hero: { base: string; suffix: string; suffixMinDepth: number; punctuation: string };
  maxDepth: number;
  /** Last main-explanation stage; later detail stays behind local markers. */
  narrativeDepth: number;
  paragraphs: ProgressiveParagraph[];
  words: { readFull: string; expand: string; collapse: string; expandAccessible: string; collapseAccessible: string };
};

/** The first part's depth opens the paragraph's retained skeleton. */
export function paragraphDepth(paragraph: ProgressiveParagraph) {
  return Math.min(...paragraph.parts.map(part => part.minDepth));
}

/** Group adjacent parts that share one insertion hinge; never reorder source text. */
export function partGroups(paragraph: ProgressiveParagraph) {
  const groups: ProgressivePartGroup[] = [];
  for (const part of paragraph.parts) {
    const previous = groups.at(-1);
    if (previous?.kind === part.kind && previous.minDepth === part.minDepth) previous.parts.push(part);
    else groups.push({ id: part.id, kind: part.kind, minDepth: part.minDepth, parts: [part] });
  }
  return groups;
}

