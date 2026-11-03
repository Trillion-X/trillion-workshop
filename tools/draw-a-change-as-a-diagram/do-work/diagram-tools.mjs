// src/diagram-tools.mjs
//
// WORDS OR A DIFF BECOME A DIAGRAM THE DOCUMENT PAGE SHOWS AND THE PERSON CAN EXPORT AS SVG, WITH THEIR OWN AI AS THE AUTHOR.
//
// Purpose: the person's AI is the model. draw_diagram first gives it the writing brief for a graph document (schema and message
// from the graph contract) and the exact list of what of a large input (the files of a change) would be shown to a model, so it
// can write the document from the words or the diff. Given that document it is checked, its text contained, its host fields
// stamped (parts/ui/show/layer-diagram/graph-authoring.mjs), drawn as standalone SVG files named by their own BLAKE3 identity
// (graph-svg.mjs), and a live command (answer, show, sketch) is checked against the document's own ids (graph-live.mjs).
//
// Non-negotiable invariants:
//   1. Nothing here calls a model: the document comes from the caller; a refused one comes back with the validator's own words.
//   2. The page block returned is the document itself, which the document page already draws; the SVG files are exports of it.
//   3. Read-only: nothing is stored or posted (picture_a_change posts).
import { authorGraphDocument, graphAuthoringBrief, graphIdentifiers } from '../parts/ui/show/layer-diagram/graph-authoring.mjs';
import { graphIdentity } from '../parts/ui/show/layer-diagram/graph-contract.mjs';
import { graphSvgAssets } from '../parts/ui/show/layer-diagram/graph-svg.mjs';
import { resolveLiveCommand } from '../parts/ui/show/layer-diagram/graph-live.mjs';

export const diagramTools = () => [
  { name: 'draw_diagram', description: 'Turns words or a code change into a diagram of lanes, nodes and edges, each marked added, changed, removed or unchanged. Call it first with request (and files: [{ path, text }] for a large input) and no document: it answers brief (the schema and message to write a graph document by) and outbound, the exact list of which files a model would be shown and which would not leave (secrets, lock files, binaries). Write the document, then call it again with document: it is checked (a refusal lists each problem with its path), its text is contained, and it answers page_block (put it in a document page, which draws it), svg_files (one standalone image per palette, named by the identity of its bytes), identity, identifiers (the ids to copy exactly), and, if command is given ({ kind: answer | show | sketch, ... }), that command checked against the document\'s ids with where the named parts are drawn and, for a sketch, the changed copy. It stores and posts nothing.', inputSchema: { type: 'object', properties: {
    request: { type: 'string', description: 'What the diagram should show, in words' },
    files: { type: 'array', items: { type: 'object', required: ['path', 'text'], properties: { path: { type: 'string' }, text: { type: 'string' } } }, description: 'The large input, for example the files of a change' },
    document: { type: 'object', description: 'The graph document you wrote by the brief' },
    host: { type: 'object', description: 'Fields the host already knows (id, label, caption)' },
    command: { type: 'object', description: 'A live command to check against the document' },
    orientation: { type: 'string', description: 'across (default) or down' },
  } }, run: async ({ request = '', files = [], document, host = {}, command, orientation = 'across' } = {}) => {
    if (document === undefined) {
      const dry = await authorGraphDocument({ request, host, files, dryRun: true });
      return { ok: true, document: null, brief: graphAuthoringBrief(), outbound: dry.outbound };
    }
    const authored = await authorGraphDocument({ ask: async () => document, request, host, files });
    if (!authored.ok) return { ok: false, errors: authored.errors, outbound: authored.outbound };
    const assets = graphSvgAssets(authored.document, { orientation });
    if (!assets.ok) return { ok: false, errors: assets.errors };
    return {
      ok: true, identity: graphIdentity(authored.document), warnings: authored.warnings, page_block: { graph: authored.document },
      identifiers: graphIdentifiers(authored.document), svg_files: assets.files, manifest: assets.manifest,
      ...(command ? { live: resolveLiveCommand(authored.document, command) } : {}),
    };
  } },
];

export const diagramAnnotations = {
  draw_diagram: { title: 'Draw a diagram', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
