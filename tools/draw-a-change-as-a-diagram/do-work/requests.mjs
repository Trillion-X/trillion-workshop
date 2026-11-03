// tools/draw-a-change-as-a-diagram/do-work/requests.mjs
//
// One function per Workshop row, each a thin call into the moved engine: no logic of its own.
//   drawDiagram(request)       -> draw_diagram's run (./diagram-tools.mjs): the brief and outbound list, or the checked
//                                 document drawn as SVG files with its identity and identifiers.
//   patchDiagram({ document, patch })            -> applyGraphPatch (./graph-patch.mjs)
//   correctDiagram({ document, corrections })    -> applyGraphCorrections (./graph-patch.mjs)
//   pictureChangedFiles({ files })               -> changeGraph (./change-graph.mjs) drawn by graphSvgAssets (./graph-svg.mjs)
import { diagramTools } from './diagram-tools.mjs';
import { applyGraphCorrections, applyGraphPatch } from './graph-patch.mjs';
import { changeGraph } from './change-graph.mjs';
import { graphSvgAssets } from './graph-svg.mjs';

const draw = diagramTools().find((tool) => tool.name === 'draw_diagram');

export const drawDiagram = (request) => draw.run(request);
export const patchDiagram = ({ document, patch } = {}) => applyGraphPatch(document, patch);
export const correctDiagram = ({ document, corrections } = {}) => applyGraphCorrections(document, corrections);
export function pictureChangedFiles({ files, orientation } = {}) {
  const document = changeGraph(files);
  const assets = graphSvgAssets(document, orientation ? { orientation } : {});
  return { document, ...assets };
}
