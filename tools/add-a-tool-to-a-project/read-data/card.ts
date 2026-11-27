// tools/add-a-tool-to-a-project/read-data/card.ts
//
// PURPOSE
//   Reads the two folder-level facts the add tool takes from a tool's card, what-this-tool-does-and-how-to-run-it.json:
//   `needs_tools` (the sibling folders the tool needs beside it under trillion/) and `prepare` (the command that makes the
//   folder ready after it is written, run in the folder). Both are DATA the tool's maker writes; the add tool never reads a
//   tool's code to guess either.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The card is what-this-tool-does-and-how-to-run-it.json and nothing else. A folder whose card still has the old name
//      (tool-rows.json) is refused (OldCardName), naming the folder: its card must be renamed before it can be added.
//   2. `prepare` is a list of words (a program and its arguments), never a shell line; absent means nothing to run.
//   3. A card that names either fact in a wrong shape is refused (BadCard), never half-read.
//   4. A folder with no card (a library other tools import) has no needs and nothing to prepare.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { TOOL_NAME } from './registry.ts';

export const CARD_NAME = 'what-this-tool-does-and-how-to-run-it.json';
const OLD_CARD_NAME = 'tool-rows.json';
export type CardFacts = { needs_tools: string[]; prepare: string[] | null };

/** Refused because a card's needs_tools or prepare is not the shape this tool reads. */
export class BadCard extends Error {}

/** Refused because the folder's card still has the old name. */
export class OldCardName extends Error {}

/** The card's facts from the folder's files (path -> bytes); no card gives no needs and nothing to prepare. */
export function cardFacts(folder: string, files: Map<string, Buffer>): CardFacts {
  const text = files.get(CARD_NAME);
  if (text === undefined) {
    if (files.has(OLD_CARD_NAME)) throw new OldCardName(`${folder}: its card has the old name ${OLD_CARD_NAME}; it is read only as ${CARD_NAME}.`);
    return { needs_tools: [], prepare: null };
  }
  let card: Record<string, unknown>;
  try { card = JSON.parse(text.toString('utf8')); } catch { throw new BadCard(`${folder}: ${CARD_NAME} is not JSON.`); }
  const needs = card.needs_tools ?? [];
  if (!Array.isArray(needs) || !needs.every(n => typeof n === 'string' && TOOL_NAME.test(n))) throw new BadCard(`${folder}: needs_tools is not a list of tool names.`);
  const prepare = card.prepare ?? null;
  if (prepare !== null && (!Array.isArray(prepare) || prepare.length === 0 || !prepare.every(word => typeof word === 'string' && word.length > 0))) {
    throw new BadCard(`${folder}: prepare is not a list of words (a program and its arguments).`);
  }
  return { needs_tools: [...needs] as string[], prepare: prepare as string[] | null };
}
