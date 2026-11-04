// The board's ordered presentation frames are the source for every output.
// This adapter names their rendered images for the workspace media publisher.
import type { BoardDeck } from './board-deck';

export interface BoardFrameMedia {
  readonly frameId: string;
  readonly order: number;
  readonly label: string;
  readonly fileName: string;
  readonly mediaType: 'image/svg+xml';
  readonly content: string;
}

export function boardFrameMedia(deck: BoardDeck): BoardFrameMedia[] {
  const seen = new Set<string>();
  const orders = new Set<number>();
  return deck.slides.map(slide => {
    if (!slide.frameId || seen.has(slide.frameId)) throw new Error('The board has repeated frame identities.');
    if (!Number.isSafeInteger(slide.order) || slide.order < 1 || orders.has(slide.order)) throw new Error('The board has repeated or invalid frame order.');
    seen.add(slide.frameId);
    orders.add(slide.order);
    const name = slide.label.normalize('NFKC').replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 80).trim() || 'Frame';
    return {
      frameId: slide.frameId,
      order: slide.order,
      label: slide.label,
      fileName: `${slide.order.toString().padStart(3, '0')}-${name}.svg`,
      mediaType: 'image/svg+xml',
      content: slide.svg,
    };
  });
}
