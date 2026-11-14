# Connectable Services

Package-owned catalog of outside services that can be connected.

## Rules

- The visible surface label is `Available services`.
- The surface is scoped to `placeable-surface-list::connections-workspace`, not the main workspace.
- This package owns service catalog data; the `Connections` workspace only hosts it.
- Google discovery facts point Gmail and Google Calendar domains at the account-backed `oauth-account` shape; the credential option itself lives in `service-connections` as `google-account`.

## Live Import

Source edits are proposal material. Write this package into the active Bitfield Studio log with:

```bash
BITFIELD_SHELL_URL=<carrier-url> node /workspace/the-owner/dev/bitfield-runtime-kit/references/background-runner-shell/scripts/apply-package-delta-live.mjs --package-set-folder <runtime-package-set-folder> --partition <running-partition> --package connectable-services
```

## Proof Log

- 2026-06-18 historical proof: the retired aggregate writer wrote 37 records and `package::connectable-services::entry-bytes::connectable-services` (`1f:570899f57cca4f28c9327f67dda01be98edfe46c4c083d6fd88a57bb04642e11`). That retired command is not an activation instruction.
