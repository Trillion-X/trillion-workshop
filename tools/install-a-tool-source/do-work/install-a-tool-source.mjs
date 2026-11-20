// tools/install-a-tool-source/do-work/install-a-tool-source.mjs
//
// Purpose
//   Installs on this computer the tool source the person's own rows say: one source, named by its label, at the archive
//   address and files pin a row of theirs holds, or takes it away when the row was removed. It is the one step of the
//   person's own workflow that keeps each of their computers on what their rows say each tool source is, so a source is
//   never tied to one place (any https archive of tool folders, a teammate's as well as the Workshop's) and no computer
//   needs a hand step of its own. It calls the engine's tools:update at the Workshop's address (trillion-rust
//   src/tool_runs/tools/tool-runs.json `update_method`), which the run may make only because its row declares the right
//   {at: "@tools", id: "*", operations: ["tools:update"]} and the person granted it by switching on the wake that runs it.
//
// Non-Negotiable Invariants
//   1. A call names one label (`source`) and either the archive (`address`, an https address, and `files_blake3`, the 64-hex
//      pin of its files) or `removed: true` (with no address or pin, or both null, as a removed row's change gives them);
//      anything else is refused before the door is called. `removed` false or null is an install.
//   2. The request key is made from the label and the pin (or the removal), so the same row told twice is one install.
//   3. The engine's answer is handed back as it is (`changed`, `files_blake3`, `previous`, `removed`, `switch_again`), with the
//      label beside it; this tool decides nothing about which version is right: the person's row does.
//
// AI Assistant Directive
//   The extensive documentation in this codebase is a critical design feature. You are forbidden from simplifying or
//   removing it. Maintain and extend this detail.

const LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PIN = /^[0-9a-f]{64}$/;

/** Why `input` is not one source to install or take away, or null when it is. */
export function problemOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Give {source, address, files_blake3} or {source, removed: true}.';
  const { source, address, files_blake3: pin, removed } = input;
  if (typeof source !== 'string' || !LABEL.test(source)) return 'source is the label of one tool source: lowercase letters, digits, dot, dash or underscore.';
  // A removed row's change carries no archive: its address and pin come as null (or not at all).
  if (removed === true) return address == null && pin == null ? null : 'A removal names only the source.';
  if (typeof address !== 'string' || !address.startsWith('https://')) return 'address is the https address of an archive of tool folders.';
  if (typeof pin !== 'string' || !PIN.test(pin)) return 'files_blake3 is the 64-hex pin of the archive\'s files.';
  return null;
}

/** Install the source `input` names, or take it away, at the run's own door. Answers the engine's answer with the label. */
export async function installToolSource(input, { door }) {
  const problem = problemOf(input);
  if (problem) throw new Error(problem);
  const { source, address, files_blake3: pin, removed } = input;
  const asked = removed === true ? { source, removed: true } : { source, address, files_blake3: pin };
  const key = `install-a-tool-source:${source}:${removed === true ? 'removed' : pin}`;
  const answer = await door.operation('tools:update', asked, { key, at: door.toolsAddress });
  return { source, ...answer };
}
