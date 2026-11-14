// parts/ui/show/layer-diagram/LayerDiagram.tsx
//
// Purpose: the React drawing of a layer diagram (people, their AIs, the spaces those AIs may enter, or
// any other layers the caller names). It draws from the same `layerDiagramLayout` numbers and wears the
// same LAYER_DIAGRAM_CSS as `layerDiagramHtml`, so the page a browser draws and the readable copy a
// server sends show one picture.
//
// Invariants:
// 1. Knows no product: every word, mark and tone is a prop (DATA).
// 2. Colours come from theme roles only, each surface with its own paired words (see LAYER_DIAGRAM_CSS).
// 3. Both orientations are drawn; the stylesheet shows `across` on a wide screen and `down` on a phone.

import { HEAD_BOX, layerDiagramClass, layerDiagramLayout, layerDiagramNodeParts, layerDiagramSpotBox, LAYER_DIAGRAM_CSS, NODE_TEXT, type LayerDiagramLayout as Layout, type LayerDiagramSpot } from './layer-diagram.mjs';

export type LayerDiagramMark = { image?: string; letters?: string };
export type LayerDiagramNode = { id: string; label: string; detail?: string; mark?: LayerDiagramMark; tone?: string; delta?: string };
export type LayerDiagramLayer = { id: string; label?: string; nodes: LayerDiagramNode[] };
export type LayerDiagramEdge = { from: string; to: string; tone?: string; label?: string; delta?: string };
export type LayerDiagramData = { id: string; label: string; caption?: string; layers: LayerDiagramLayer[]; edges: LayerDiagramEdge[] };

const round = (value: number) => Math.round(value * 10) / 10;

function Words({ spot, className, size, width }: { spot: LayerDiagramSpot; className: string; size: number; width: number }) {
  const box = layerDiagramSpotBox(spot, size, width);
  return (
    <span className={className} style={{ left: box.left, top: box.top, width: box.width, lineHeight: `${box.line_height}px`, textAlign: box.align as 'left' | 'center' }}>
      {spot.lines.map((line, index) => <span key={index} className="layer-diagram__line">{line}</span>)}
    </span>
  );
}

// Surfaces are HTML boxes inside foreignObject (see layerDiagramHtml): only the connectors are SVG drawing.
function Drawing({ layout }: { layout: Layout }) {
  const way = layout.orientation;
  return (
    <svg
      className={`layer-diagram__svg layer-diagram__svg--${way}`}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
      height={layout.height}
      aria-hidden="true"
      focusable="false"
    >
      {layout.edges.map((edge) => (
        <path key={`${edge.from}-${edge.to}`} className={layerDiagramClass('layer-diagram__edge', edge.tone)} data-delta={edge.delta ?? undefined} d={edge.d} />
      ))}
      {layout.heads.map((head) => (
        <foreignObject key={head.id} x={round(head.x - head.w / 2)} y={round(head.y - HEAD_BOX.above)} width={round(head.w)} height={HEAD_BOX.height}>
          <h3 className="layer-diagram__head">{head.label}</h3>
        </foreignObject>
      ))}
      {layout.nodes.map((node) => {
        const at = layerDiagramNodeParts(node, way);
        const place = at.mark ? { left: round(at.mark.x), top: round(at.mark.y), width: at.mark.size, height: at.mark.size } : undefined;
        return (
          <foreignObject key={node.id} x={round(node.x)} y={round(node.y)} width={round(node.w)} height={round(node.h)}>
            <div className={layerDiagramClass('layer-diagram__node', node.tone)} data-delta={node.delta ?? undefined}>
              {at.mark && node.mark?.image ? <span className="layer-diagram__mark layer-diagram__mark--image" style={place}><img src={node.mark.image} alt="" /></span> : null}
              {at.mark && !node.mark?.image ? <span className="layer-diagram__mark layer-diagram__mark--letters" style={place}>{node.mark?.letters}</span> : null}
              <Words spot={at.label} className="layer-diagram__label" size={NODE_TEXT[way].label} width={node.w} />
              {at.detail ? <Words spot={at.detail} className="layer-diagram__detail" size={NODE_TEXT[way].detail} width={node.w} /> : null}
            </div>
          </foreignObject>
        );
      })}
      {layout.edges.filter((edge) => edge.label).map((edge) => (
        <foreignObject key={`${edge.from}-${edge.to}-label`} x={round(edge.label_x - edge.label_w / 2)} y={round(edge.label_y - 10)} width={edge.label_w} height={20}>
          <span className={layerDiagramClass('layer-diagram__edge-label', edge.tone)}>{edge.label}</span>
        </foreignObject>
      ))}
    </svg>
  );
}

export function LayerDiagram({ diagram }: { diagram: LayerDiagramData }) {
  const across = layerDiagramLayout(diagram, 'across');
  if (!across.nodes.length) return null;
  const down = layerDiagramLayout(diagram, 'down');
  return (
    <figure className="layer-diagram" role="img" aria-label={across.label}>
      <style>{LAYER_DIAGRAM_CSS}</style>
      <Drawing layout={across} />
      <Drawing layout={down} />
      {across.caption ? <figcaption className="layer-diagram__caption">{across.caption}</figcaption> : null}
    </figure>
  );
}
