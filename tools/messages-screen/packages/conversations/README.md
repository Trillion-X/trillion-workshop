# conversations package source

Source proposal material for CS-034 conversations.

Active backend contract:

- `package::conversations::input::addressed-exchange-conversations`
- `package::conversations::input::addressed-exchange-turns`
- `package::conversations::input::addressed-exchange-message-pages`
- `package::conversations::projection::record-action-set-v1`

Record-list and message-page projections are computed outputs from the public
projection sources, not durable descriptor rows. The historical descriptor
addresses must not be restored. Source rows such as saved sessions and
transcripts are input/provenance data, not the active TypeScript backend
contract.

The package owns no visible conversation surface entry. Chat is the live surface
and consumes these public owner sources; no separate Conversations panel or
selector-address reader may be restored.

It also owns `action:upsert-addressed-exchange-participant`, the translation
boundary from a caller-described participant/way into canonical addressed
participant and way-to-reach attribute facts. Callers supply opaque references,
labels, and adapter JSON. The action canonicalizes those values without
classifying the participant as a human, agent, service, group, or any other
closed kind.

## Live addressed voice

`package::conversations::exchange-profile::live-addressed-voice` is generic
conversation DATA. It names only the exchange/modality semantics, generic task
substitutions, transcript/end/browser policies, and opaque references to the
service-connections owner. `action:conversations.open-addressed-exchange`
remains external-effect free: voice reach is deferred to the referenced route
and connection owners. Browser proof is bound to the passing Vapi/OpenAI
Realtime call; phone reach remains explicitly `NOT_RUN` and founder-gated.
