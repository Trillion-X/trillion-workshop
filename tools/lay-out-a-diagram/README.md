# tools/lay-out-a-diagram/

Lays out a diagram of boxes and arrows in layers so few arrows cross, and tells what changed between two versions of a diagram. Send the boxes (an id, and if wanted a label, a size, a lane and a style) and the arrows between them; the answer gives every box's position and size, every arrow's route as a list of points, how many arrows cross before and after the boxes were put in order, the arrows that had to be reversed to break a cycle, and a standalone SVG of it whose colours come from page variables. The same request always gives the same answer. The tool names no box, lane, word or colour of its own: the diagram, the lanes, the spacing, the label measuring, the limits and the colour fallbacks are all data.

How it works, in order: each box is measured from its label with a per-character width table (no browser) unless a size is given; cycles are broken by a depth-first walk in declaration order, and the arrow that points back into a box still being walked is reversed for the layout, reported, and drawn in its real direction; a self-loop stays out of the layering and is drawn as a small loop; each box gets a layer by its longest path from the sources, then a box with room to spare moves down next to its nearest successor; an arrow that crosses layers gets a virtual point on each layer between, so every piece joins two neighbouring layers; inside each layer the boxes start in declaration order and are reordered by the configured number of sweeps (mean position of the neighbours downward, then upward, then swapping neighbours), keeping a new order only when the exact crossing count does not rise, the count being a Fenwick-tree count over the segments between two layers; across a layer the boxes are placed without overlap and pulled toward the median of their neighbours; the arrows that meet one side of a box spread along it at the port pitch, centred; every arrow becomes a polyline from its source port through its virtual points to its target port. With `lanes`, every box stays in its lane's band and the layers line up across lanes. With `direction: "right"` the layers run left to right.

Not carried: a parser for diagram text (Mermaid, DOT and the like) since the tool takes boxes and arrows as data; arrow labels take no room in the layout (they are drawn at the middle of the route and can overlap a neighbour); sub-groups nested inside boxes; arrows that bend around boxes with curves (routes are straight pieces between ports and layer points); and any interactive editing. A box whose busiest side holds many arrows is made wider than asked so the arrows keep the minimum gap.

## Files

| File | Purpose |
|------|---------|
| `read-data/layout-settings.json` | Every number and word as data: spacing, port pitch and minimum gap, node padding and minimum size, sweep and pass counts, the label width table, the limits, the theme variables with their fallbacks, the style allowlist and refused value pattern |
| `do-work/layout.mjs` | The layered layout: cycles, layers, virtual points, crossing reduction, placement, ports, routes |
| `do-work/draw-svg.mjs` | The SVG writer: one standalone drawing, themed by `--diagram-*` page variables, every value escaped |
| `do-work/compare-diagrams.mjs` | The structural diff of two diagrams |
| `do-work/requests.mjs` | One function per row: checks the request, refuses with a sentence, calls the above |
| `do-work/run-request.mjs` | `node do-work/run-request.mjs <function>`: the request on standard input, `{ result }` or `{ error }` out |
| `part.json` | The one public module |
| `tool-rows.json` | The two Workshop rows |
| `test/*.test.mjs` | Layout (cycles, layers, exact crossing counts against a count over every pair, lanes, ports, direction, determinism), the SVG (no script, escaping, variables, ids, style allowlist), the diff, and each row's sample run in the container with its refusals |

## The rows

| Row | Does |
|-----|------|
| `tool:lay-out-a-diagram` | Boxes and arrows (and optional lanes and direction) in; positions, arrow routes, quality numbers and an SVG out |
| `tool:compare-two-diagrams` | A before and an after in; boxes and arrows added, removed or changed, with what changed on each, out |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| request | `{ nodes: [{ id, label?, width?, height?, lane?, style? }], edges: [{ id?, from, to, label? }], direction?: "down" \| "right", lanes?: [lane ids], draw?: boolean }` | The diagram; an edge id defaults to `e<index>`; a label defaults to the box id |
| `layOut(input, settings)` | `-> { width, height, nodes: [{ id, x, y, width, height, rank, order, lane }], edges: [{ id, from, to, points, reversed, label }], quality: { crossings_before, crossings_after, reversed_edges, ranks, virtual_points } }` | The layout; coordinates start at 0,0 and are rounded to two places |
| `countCrossings(pairs, lowerSize)` | `[[upper position, lower position]] -> integer` | Exact crossings between two neighbouring layers in O(E log V) |
| `drawSvg(layout, nodes, settings)` | `-> string` | The standalone SVG; a node group carries `data-node-id`, an arrow `data-edge-id` |
| `compareDiagrams(before, after)` | `-> { nodes: { added, removed, changed }, edges: { added, removed, changed } }` | Boxes match by id; arrows by id, else by from, to and label; all ordered by id |

The SVG's page variables are `--diagram-background`, `--diagram-ink`, `--diagram-node-fill`, `--diagram-node-stroke` and `--diagram-edge`; each has a fallback colour in the settings. A box's `style` may hold only `fill`, `stroke`, `stroke-width`, `stroke-dasharray`, `font-weight`, `font-style` and `opacity`, with plain values (nothing holding `url(`, `expression`, `javascript:`, `<`, `>` or `;`).

## Dependencies

None outside the folder: plain JavaScript run by Node, no packages. The boxes, arrows and settings arrive in the request or the settings file, so the tool holds no records access, no credential and no network (`internet: false` on both rows).
