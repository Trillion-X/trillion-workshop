# Test fixtures

Synthetic data the tests read. Nothing here is a person's account.

Each folder and file is named for the test owner that reads it (`credential-verification`, `credentials-vault`,
`execution-types`, `mcp-app-resource*`, `record-sealed-original-vectors.json`, `retired-snapshot`, `screen-view.json`,
`workshop-looks.json`, `workspace-*`, `own-resource-command-quota.json`).

- `mac-app/`: the engine's synthetic installed-app selection inputs. `device-notices.json` is an object with no
  `origin`, the only property of that resource the selection regression needs. `computer-reader.json` describes the
  layout the engine consumes. The historical app layout is recorded at Trillion-X/trillion-apps c43efbb6
  (`macos/computer-reader.json`, `macos/App/device-notices.json`); these files are not a copy of that product.

- `screen-view.json`: the MCP Apps adapter's URI, read policy and six synthetic messages. It has no product tool
  catalogue, placements, renderer settings or app prose.
- `workshop-looks.json`: the screen projector's icon and mount template only; no Workshop labels, tools or features.
- `starting-set/tools/starting-set/shipped-defaults.json`: one synthetic show-rules type, its merge rules and in-use
  switch. The overlay tests need its identity and label, not the publisher's product rules.
  `starting-set/overlay-read-schema.json` supplies the generic reader's required record label and empty subject map; the
  defaults tests do not read a Workshop checkout or carry its show-rules schema.
- `screen-host/decision-descriptions.json`: seven synthetic decision cases and their complete expected descriptions.
  All found/removed, chosen/revised, stance, result, action, evidence and question branches stay covered.
- `retired-snapshot/frontend-contract/src/workspace/inputs.json`: only the nine address mappings the startup
  contract reads. Other files in that folder remain historical captures as described in its provenance.
