// src/meaning-spaces.mjs
//
// PURPOSE
//   A meaning space is where one model's vectors live: vectors are compared only inside one space. A Marketplace tool
//   that serves the job `encode` declares its space in its descriptor (`encodes.space`: model, revision, dim, prompts);
//   the space's identity is the BLAKE3 of that declaration's canonical JSON, so two tools declaring the same space share
//   vectors and a new revision is a new space. Search (src/search.mjs) and the passage encoder (src/meaning-sets.mjs)
//   read spaces only through here.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a model, a content kind or a tool: they come from the descriptors handed in.
//   2. An encoder's answer is used only when the model it names is the model its space declares.
//
import { identityOf } from '../../shared-code/src/typed-operation-contract.mjs';

/** The identity of the space an encoder tool's vectors live in. */
export const spaceOf = tool => `1f:${identityOf(tool.encodes.space)}`;

/** The encoder tools among `tools` that accept content of `kind` (a typed question is `text`). */
export const encodersAccepting = (tools, kind) => (Array.isArray(tools) ? tools : []).filter(tool => tool?.encodes?.accepts?.includes(kind));

/** Whether a run's answer came from the model the tool's space declares (its `output.model`). */
export const answeredInSpace = (tool, output) => {
  const named = output?.model ?? {};
  const space = tool.encodes.space;
  return named.name === space.model && (space.revision === undefined || named.revision === space.revision);
};
