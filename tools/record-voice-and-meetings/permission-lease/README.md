# permission-lease

**Depended on by:** `parts/record-audio` (`RecordAudioPanel`), `parts/record-video` (`RecordVideoPanel`), whose `things-to-store-and-run.json` carry the requirement rows.
**Depends on:** `parts/ui` (Button, Container, NamedIcon, Text).
## Dependencies
| Type | Signature / Shape | Role |
|------|-------------------|------|
| `CapabilityPermissionDescriptor` | `{ kind, operation_ref, capability_ref, adapter_ref, adapter_input, consent: { title, explanation, action_label }, denied: { title, explanation, recovery_path, recovery_subject?, in_browser?: { explanation, recovery_path } }, unavailable: { title, explanation } }` | One part's requirement, as its DATA declares it. |
| `CapabilityPermissionState` | `'undetermined' \| 'granted' \| 'denied-by-system' \| 'platform-unavailable'` | Where the capability stands. |
| `readCapabilityPermissionDescriptor` | `(source, operationRef) => CapabilityPermissionDescriptor \| null` | Reads the requirement for one operation from a part's records. |
| `registerCapabilityPermissionAdapter` | `(adapterRef, adapter) => void` | Adds an adapter for a capability source beyond the built-in browser media one. |
| `probeCapabilityPermission`, `requireCapabilityPermission` | adapter calls | Ask where the capability stands; ask for it before the operation runs. |
| `CapabilityPermissionDeniedError`, `CapabilityPermissionUnavailableError`, `isCapabilityPermissionDenied` | errors and a test | A refused or missing capability, told apart from other failures. |
| `recoverCapabilityPermission` | `(descriptor) => Promise<{ recovered, recovery_unavailable?, results?, tcc_client_name? }>` | Raises the computer's own permission sheet through a host bridge, when the host provides one. |
| `capabilityPermissionRecoveryAvailable` | `() => boolean` | Whether that bridge exists here. |
| `runsInAppWindow` | `() => boolean` | Whether the page runs in an app's own window (a native host registers `window.webkit.messageHandlers`) rather than a web browser. |
| `deniedNoticeHere` | `(descriptor) => denied notice` | The denied notice with its `in_browser` wording laid over it in a browser. |
| `CapabilityPermissionPrompt` | `({ descriptor, state, requesting, onRequest })` | The card itself. |
## Key Types / Functions
| File | Purpose |
|------|---------|
| `read-data/capability-permission.ts` | Reads a part's `capability-permission-requirement` DATA (consent, denied, unavailable notices), probes and requests the capability through an adapter (`capability-permission-adapter:browser-media` is built in), recovers a computer-level denial through a host bridge when one exists, and picks the denied notice for where the page runs (`deniedNoticeHere`: the `in_browser` wording in a web browser, the computer's own setting in an app window). |
| `show/CapabilityPermissionPrompt.tsx` | The card a recording part shows before it can record: the consent notice with its button, the denied notice as it reads here with how to turn it back on, or the unavailable notice. |
## Files
Asks for a device capability (microphone, camera) at the moment a part needs it, and says in plain words what to do when it is blocked, wherever the page runs.
