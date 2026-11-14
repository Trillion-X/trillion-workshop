# context-feed

`context-feed` is the package-owned source workshop for a generic record
projection lens. It evaluates data-described source sets, field readers, labels,
groups, and owner-action handoff descriptors into one JSON-compatible projection
feed.

Live package truth is the selected Bitfield root log fold. Files in this folder
are package implementation proposal material until the package implementation
import/live writer records them into the selected log and current reads verify
the records.

## Boundary

- Owns: generic projection lens source, lens records, projection feed contract,
  and tests proving cross-runtime feed compatibility.
- Reuses: EEAF facts, generic records, workflow owner-action contracts,
  process-session records, `record_from_matching_records`, and selected payload
  records as inputs.
- Does not own: workflow execution, process spawning, provider transport,
  relationship mutation, credentials, mail, calendar, CRM, device-specific
  backends, or live app data writes.

## Proof

Run from `/workspace/the-owner/dev/bitfield-packages`:

```bash
node -e "JSON.parse(require('node:fs').readFileSync('/workspace/the-owner/dev/bitfield-packages/packages/context-feed/things-to-store-and-run.json','utf8')); console.log('ok')"
node --test /workspace/the-owner/dev/bitfield-packages/packages/context-feed/tests/*.test.mjs
rg -n "context-feed-(mobile|ios|desktop|worker|watch|kiosk)|context-dashboard|context-sync|context-http|context-workflow|context-feed\\.query|context-feed-subscription|context-backend|context-db" /workspace/the-owner/dev/bitfield-packages/packages/context-feed
rg -n "fetch\\(|WebSocket|compute\\.process|start.*session|workflow|http-client|calendar|email|crm|provider" /workspace/the-owner/dev/bitfield-packages/packages/context-feed/read-data
```

The `rg` commands are expected to return no matches.

## 2026-06-22 backend implementation proof

- JSON parse: `ok`.
- Focused tests: `node --test packages/context-feed/tests/*.test.mjs`
  passed `7` tests.
- Static boundary scans passed with no matches for raw context field names in
  `read-data/*.js`, no effect/network/provider execution terms in `read-data`,
  and no duplicate backend/device package family names in package source.
- Historical live proof used the retired aggregate writer and wrote `16`
  package records and `3` stored-byte records to
  `http://127.0.0.1:3012`.
- Live readback found identity-text records
  `package::context-feed::primitive-contract`,
  `package::context-feed::lens::default`, and
  `package::context-feed::projection::feed-contract`, plus stored bytes
  `package::context-feed::stored-bytes::context-feed-record-projection-lens`.
