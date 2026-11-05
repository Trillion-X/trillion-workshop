import { brokenReferences, cardTitle } from '../read-data/card-references.ts';
import type { ShareCapsule } from '../read-data/share-capsule.ts';

/** Report only the exact shared snapshot. Never read excluded cards or add them
 * to resolve a link: a reference does not expand the person's chosen scope. */
export function shareReferenceWarnings(capsule: ShareCapsule): string[] {
  return capsule.boards.flatMap((board) => {
    const names = new Map(board.items.map((item) => [item.memberId, cardTitle(item)]));
    return brokenReferences(board.items).map((ref) =>
      `${board.title} / ${names.get(ref.from) || 'Untitled card'} → [[${ref.title}]]`,
    );
  });
}
