// src/inspiration.mjs
//
// Purpose
//   Inspiration: everything worth making from, as named rows of cards (the next pick, recordings no edit has used,
//   files used lately, formats, saved examples, prepared posts, finished videos, fresh recordings), ported from
//   Trillion Media's Inspiration screen. Which rows exist, where each reads its cards, how a card reads and the
//   sentence that sums it up are DATA (src/inspiration.json); the shared card-sections reader (src/card-sections.mjs)
//   reads each named source once, keeps the items a row's tests pass, and turns them into cards. tool:inspiration
//   answers it, and the Inspiration screen (src/workspace/inspiration-screen.tsx) draws it with the shared card layouts.
//
// Non-negotiable invariants
//   1. Real records only: every card is an item a source answered. A row with no cards is still listed, empty, so
//      the screen can leave it out; a source that failed marks only its own rows failed.
//   2. Each source is read once however many rows read it.
//   3. Nothing here names a source, a row or a field: they are keys and paths in the DATA.
//

import settings from './inspiration.json' with { type: 'json' };
import { readCardSections } from './card-sections.mjs';

/**
 * read: { <source name>: async () => answer } for each source the DATA names. Answers { layouts, default_layout,
 * view_all_layout, sections: [{ id, title, subtitle, cards, failed? }], card_actions, pick_actions, aspects, empty,
 * said }.
 */
export const inspiration = (read, config = settings) => readCardSections(read, config);
