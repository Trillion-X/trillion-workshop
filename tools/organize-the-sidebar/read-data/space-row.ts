// parts/sidebar/read-data/space-row.ts
//
// PURPOSE
// The empty space row: a row of a list that holds nothing. On a thin bar it takes no icon's place and only pushes the
// rows apart, so where spaces stand decides where the icons sit (left, right, centred, a little to one side), and spaces
// side by side add up. In a list with names it shows as a quiet gap the person can move or take out like any row.
// It belongs to every list as the sidebar's own row, so it needs no screen behind it and may be added any number of
// times: each one is its own row (its own member id), never folded into one by "each screen shows once".
//
// NON-NEGOTIABLE INVARIANTS
// 1. A space is recognised by its surface id only (SPACE_ROW_ID); nothing else about it is read.
// 2. Every space added is a new member (spaceMemberId), so two spaces never collapse into one.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

/** The id every space row goes by in a list. */
export const SPACE_ROW_ID = 'sidebar.space';

/** How a space row is drawn (a NavItemData `look`). */
export const SPACE_ROW_LOOK = 'space';

/** Its name and icon where a person picks rows to add. */
export const SPACE_ROW_WORDS = { label: 'Empty space', icon: 'Space' } as const;

/** Whether a member or row is a space. */
export function isSpaceRow(surfaceId: string | undefined): boolean {
  return surfaceId === SPACE_ROW_ID;
}

/** A new member id for one more space in a list (invariant 2). */
export function spaceMemberId(now: number = Date.now(), salt: number = Math.random()): string {
  return `surface:${SPACE_ROW_ID}:${now.toString(36)}${Math.floor(salt * 1296).toString(36)}`;
}
