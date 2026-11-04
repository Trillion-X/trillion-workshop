// packages/group/show/item-board-link.ts
//
// The board's board-link leaf — pure, zero I/O. Sibling of item-link.ts: where `href`
// points at an external URL, `boardLink` points at ANOTHER board (a boardId of the board
// index). Read boundary only — the panel resolves the id against the live boards list
// and navigates via switchBoard, so a dangling id self-heals to no chip (never a fake).
// Adding "board link" is one DATA prop on `extra` — no item-kind branch, no engine change.

interface ItemLike {
  extra?: Record<string, unknown> | undefined;
}

// The item's linked boardId (a non-empty string), or undefined. Presence + type guard.
export function itemBoardLink(item: ItemLike | undefined): string | undefined {
  const b = item?.extra?.boardLink;
  return typeof b === 'string' && b.trim() !== '' ? b : undefined;
}

// A short, bounded label for the board-link chip (#221) — the sibling of item-link's
// `linkHost`. A long board title would make the corner chip arbitrarily wide (L114/L118);
// this caps the VISIBLE label (the full name stays in the chip's `title`/`aria-label`
// tooltip). Short titles pass through unchanged; longer ones are trimmed + ellipsized.
export function boardLinkLabel(title: string, max = 22): string {
  const v = (title ?? '').trim();
  if (v.length <= max) return v;
  return `${v.slice(0, max - 1).trimEnd()}…`;
}
