// packages/documents/do-work/project-scene-to-file-request.ts
//
// In-package text helpers over this package's OWN node vocabulary (the same
// props its editor writes). Used for selection context and the read-only note
// display. File projection does NOT live here — files are produced by the
// file-output owner's action, whose projection rules are DATA records.

import { isRecord, type SceneNode } from '../read-data/documents';

export type SceneTextSection = {
  heading?: string;
  lines?: string[];
  rows?: string[][];
};

function nodeText(node: SceneNode): string | null {
  const props = node.props;
  if (!isRecord(props)) return null;
  for (const key of ['text', 'title', 'label']) {
    const value = props[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function children(node: SceneNode): SceneNode[] {
  return Array.isArray(node.children) ? node.children : [];
}

function isVisible(node: SceneNode): boolean {
  return node.visible !== false;
}

function rowCells(node: SceneNode): string[] | null {
  const kids = children(node).filter(isVisible);
  if (kids.length < 2) return null;
  const cells: string[] = [];
  for (const kid of kids) {
    const text = nodeText(kid);
    if (text === null || children(kid).length > 0) return null;
    cells.push(text);
  }
  return cells;
}

function tableRows(node: SceneNode): string[][] | null {
  const kids = children(node).filter(isVisible);
  if (kids.length < 2) return null;
  const rows: string[][] = [];
  for (const kid of kids) {
    const cells = rowCells(kid);
    if (!cells) return null;
    rows.push(cells);
  }
  return rows;
}

export function visibleTextLines(node: SceneNode): string[] {
  const lines: string[] = [];
  const walk = (current: SceneNode) => {
    if (!isVisible(current)) return;
    const text = nodeText(current);
    if (text !== null) lines.push(text);
    for (const child of children(current)) walk(child);
  };
  walk(node);
  return lines;
}

function pushSection(sections: SceneTextSection[], section: SceneTextSection): void {
  if ((section.lines?.length ?? 0) > 0 || (section.rows?.length ?? 0) > 0 || section.heading) {
    sections.push(section);
  }
}

// Display sections for the in-package note view (own vocabulary, own screen).
export function projectSceneSubtreeToSections(subtree: SceneNode): SceneTextSection[] {
  const sections: SceneTextSection[] = [];
  let current: SceneTextSection = { lines: [] };

  const flush = () => {
    pushSection(sections, current);
    current = { lines: [] };
  };

  const visit = (node: SceneNode, depth: number) => {
    if (!isVisible(node)) return;

    const rows = tableRows(node);
    if (rows) {
      current.rows = [...(current.rows ?? []), ...rows];
      return;
    }

    const kids = children(node).filter(isVisible);
    const ownText = nodeText(node);

    if (depth > 0 && ownText !== null && kids.length > 0) {
      flush();
      current.heading = ownText;
      for (const kid of kids) visit(kid, depth + 1);
      flush();
      return;
    }

    if (ownText !== null) {
      current.lines = [...(current.lines ?? []), ownText];
    }
    for (const kid of kids) visit(kid, depth + 1);
  };

  visit(subtree, 0);
  flush();
  return sections;
}
