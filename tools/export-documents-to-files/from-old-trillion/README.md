# Inspector source baseline

These are unchanged copies of the private PDF inspector and its mapping tests from the Codex hook tree. They are retained under their original paths as a source-first baseline before adapting them into `tools/export-documents-to-files`.

`moved-from.json` records the source commit, paths, and BLAKE3 identities. The inspector's original `export_private_layout_proof` import is part of its source context; this baseline is not wired into the Workshop tool and is not expected to run here. Adaptation must use the current private-layout admission and input snapshot owners.
