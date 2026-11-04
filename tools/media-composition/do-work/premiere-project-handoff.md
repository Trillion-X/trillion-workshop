# Premiere project handoff

`buildPremiereProjectHandoff({id, xmlPath, outputPath, title, fps, cuts})`
builds an ExtendScript command for the existing installed MCPBridgeCEP bridge.
Each cut is `{source, in, out}` in seconds. The XML must come from the matching
`exportXmeml` sequence. This module performs no filesystem or process effects.

The bridge's existing transport accepts `{id, script}` in a `command-ID.json`
file under its configured directory and returns `response-ID.json`. Callers
must establish that the bridge is responsive before submitting mutations. Never
leave an unconsumed mutation queued for a future launch or blindly retry after
a timeout. Inspect current project state first. The bridge uses CEP
`CSInterface.evalScript`; no new watcher or scripting transport is introduced.

The command refuses an open project (including unsaved projects), existing output,
missing XML and missing source files. It creates a separate project, imports XML,
identifies exactly one named sequence, checks each video clip's real source path,
source range and sequence position against the requested edit, then saves.
It reports source-cut verification before save, not effects equivalence or a
verified reopen. The caller must verify the saved file and reopen/readback to
claim a completed native handoff. Failed imports may leave the new isolated
project on disk; never mislabel that file as complete.

Four synthetic host-contract tests execute the generated script and cover real
command control flow, mismatched cuts, unavailable inputs, existing-project
protection, and escaping. These are not native Premiere tests.

Installed route found on 2026-09-13:
`~/Library/Application Support/Adobe/CEP/extensions/MCPBridgeCEP/bridge-cep.js`.
Premiere 2026 exposes Window → Extensions → MCP Bridge (CEP) after a document
opens. No debug/signature guard changes are required or authorized by this module.
