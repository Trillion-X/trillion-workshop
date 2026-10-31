// tools/poker/do-work/rank-poker-hands.mjs
//
// The command of tool:rank-poker-hands. One JSON request on standard input:
//   { board: ["AS", "7D", ...], hands: [{ id: "a", cards: ["KH", "QC"] }, ...] }
// and { result: { ranking: [{ id, category, bestFive, place }], winners: [ids] } } out. A card is its rank then its suit
// (ranks 2-9 T J Q K A, suits S H D C). Each hand is ranked on its best five of its own cards and the board; a hand that
// ties the one above it shares its place.
import { runAsMain } from '../read-data/run-as-main.mjs';
import { CARDS_ON_THE_BOARD, HOLE_CARDS, parseCard, rankHands } from '../read-data/poker-rules.mjs';

export function rankFromRequest(input) {
  if (!Array.isArray(input?.board)) throw new Error('board must be a list of cards (it may be empty).');
  if (!Array.isArray(input.hands) || input.hands.length === 0) throw new Error('hands must be a list of { id, cards }.');
  if (input.board.length > CARDS_ON_THE_BOARD) throw new Error(`The board holds at most ${CARDS_ON_THE_BOARD} cards.`);
  const seen = new Set();
  const take = code => {
    const card = parseCard(code);
    if (seen.has(card.code)) throw new Error(`${card.code} is given twice: a card is in one place.`);
    seen.add(card.code);
    return card;
  };
  const board = input.board.map(take);
  const ids = new Set();
  const hands = input.hands.map(hand => {
    if (typeof hand?.id !== 'string' || !hand.id || ids.has(hand.id)) throw new Error('every hand needs its own id, as text.');
    ids.add(hand.id);
    if (!Array.isArray(hand.cards) || hand.cards.length > HOLE_CARDS) throw new Error(`Hand ${hand.id}: cards must be a list of at most ${HOLE_CARDS} cards.`);
    return { id: hand.id, cards: hand.cards.map(take) };
  });
  const ranked = rankHands(board, hands);
  return {
    ranking: ranked.ranking.map(({ id, category, bestFive, place }) => ({ id, category, bestFive, place })),
    winners: ranked.winners,
  };
}

await runAsMain(import.meta.url, rankFromRequest);
