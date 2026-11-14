// packages/ui/show/person-tag/PersonTag.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The assignee/person chip every task-management reference uses (Asana,
// Monday, ClickUp, Motion, Linear): the person's mark with an optional name
// label. ONE primitive — any surface that shows "who" renders this. The mark
// itself is DisplayMark (show/display-mark), the one place a person's
// initials, hue and picture fallback are made, so a person looks the same in
// a chip, a row, a popover and a chat.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic: `name` is an opaque string from data. No product vocabulary,
//    no hardcoded people. The color is a pure hash of the value.
// 2. Tokens: the mark's radius and colours come from the selected look
//    through DisplayMark; nothing here sets a shape or a colour.
// 3. Raw elements are legal ONLY here (ui primitive). Feature code passes
//    name/showName and never touches the markup.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { cn } from '../cn';
import { DisplayMark } from '../display-mark';

export interface PersonTagProps {
  /** The person value from data (name, handle, account ref). */
  name: string;
  /** Render the name text next to the avatar (default: avatar only). */
  showName?: boolean;
  /** xs and sm sit inside a line of text; md fills a lead tile (the face that leads a row). */
  size?: 'xs' | 'sm' | 'md';
  /** The value's own picture (a logo or a photo) drawn in the same tile;
   *  the initials show while it has none or when it does not load. */
  picture?: string | null;
}

export function PersonTag({ name, showName = false, size = 'xs', picture = null }: PersonTagProps) {
  const trimmed = name.trim();
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5')} title={trimmed}>
      <span aria-hidden="true" className="inline-flex">
        <DisplayMark key={picture ?? ''} spec={{ name: trimmed || '?', ...(picture ? { image: picture } : {}) }} size={size} />
      </span>
      {showName ? (
        <span className="text-xs text-[var(--text-secondary)]">{trimmed}</span>
      ) : null}
      <span className="sr-only">{trimmed}</span>
    </span>
  );
}
