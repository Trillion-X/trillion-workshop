# ai-agent-profile

This package owns declarative AI-agent profile and role-definition records.
Startup scaffolds compose boot state; they do not seed `agent_role` capability
data. Role definitions and profile records remain data and are consumed by the
generic agent/profile and work-control paths.

## Browser mount boundaries

`ai-agent-profile-list` and `agent-card` are self-mounting package entries. The
list entry normalizes caller-supplied props, then mounts the unchanged pure
`AgentProfileList` through the shared `ui` React mount and error-boundary
primitives. Package entry files must never export a bare hook-capable React
component to the Runtime Kit mount path.

## Addressable participant publication

Each non-deleted `ai-agent-profile` delta publishes that profile's canonical
opaque reference, label, and default way to reach through the generic
`action:upsert-addressed-exchange-participant` owner action in `conversations`.
The adapter declares the `ai-records-producer` request/reply protocol as DATA;
the profile package does not implement Chat, AI execution, conversation
storage, or transport routing. New profiles therefore become addressable
without profile-name branches or additional UI code.
