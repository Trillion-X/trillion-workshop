// tools/add-a-tool-to-a-project/read-data/card.ts
//
// PURPOSE
//   Reads the two folder-level facts the add tool takes from a tool's card: `needs_tools` (the sibling folders the tool needs
//   beside it under trillion/) and `prepare` (the command that makes the folder ready after it is written, run in the folder).
//   Both are DATA the tool's maker writes; the add tool never reads a tool's code to guess either.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The card is `what-this-tool-does-and-how-to-run-it.json`, or the older name `tool-rows.json`; the new name is read first.
//   2. `prepare` is a list of words (a program and its arguments), never a shell line; absent means nothing to run.
//   3. A card that names either fact in a wrong shape is refused (BadCard), never half-read.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { TOOL_NAME } from './registry.ts';

export const CARD_NAMES = ['what-this-tool-does-and-how-to-run-it.json', 'tool-rows.json'];
export type CardFacts = { needs_tools: string[]; prepare: string[] | null };

/** Refused because a card's needs_tools or prepare is not the shape this tool reads. */
export class BadCard extends Error {}

/** The card's facts from the folder's files (path -> bytes); no card gives no needs and nothing to prepare. */
export function cardFacts(files: Map<string, Buffer>): CardFacts {
  const name = CARD_NAMES.find(candidate => files.has(candidate));
  if (!name) return { needs_tools: [], prepare: null };
  let card: Record<string, unknown>;
  try { card = JSON.parse(files.get(name)!.toString('utf8')); } catch { throw new BadCard(`${name} is not JSON.`); }
  const needs = card.needs_tools ?? [];
  if (!Array.isArray(needs) || !needs.every(n => typeof n === 'string' && TOOL_NAME.test(n))) throw new BadCard(`${name}: needs_tools is not a list of tool names.`);
  const prepare = card.prepare ?? null;
  if (prepare !== null && (!Array.isArray(prepare) || prepare.length === 0 || !prepare.every(word => typeof word === 'string' && word.length > 0))) {
    throw new BadCard(`${name}: prepare is not a list of words (a program and its arguments).`);
  }
  return { needs_tools: [...needs] as string[], prepare: prepare as string[] | null };
}
