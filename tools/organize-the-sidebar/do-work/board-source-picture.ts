// parts/group/do-work/board-source-picture.ts
//
// PURPOSE
//   A source's records (board-source.ts) as a still picture of the board they would be drawn on: planned onto an empty
//   board with the board's own source layout and drawn through the board's own picture export (board-svg.ts), so a
//   small picture of a source (a hover card) and the source on a live board never disagree.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Places nothing anywhere: the board it plans onto is empty and thrown away.
//   2. Blind: names no kind of record.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { emptyGraph } from '../../ui/show/group/group-graph';
import { boardRootRef, placeItems, readItems } from '../read-data/group-board-model.ts';
import { planBoardSource, type BoardSource } from './board-source.ts';
import { boardToSvg, exportFillOf } from './board-svg.ts';
import boardSettings from '../show/board-screen.json';

/** The picture (an SVG document) of `source` laid out as the board lays it out. */
export function boardSourcePicture(source: BoardSource, padding = 16): string {
  const root = boardRootRef('picture');
  const plan = planBoardSource([], source, 'picture', boardSettings.source_layout);
  return boardToSvg(readItems(placeItems(emptyGraph(), root, plan.place), root), { fillOf: exportFillOf, padding });
}
