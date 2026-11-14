# Capability map: where each freedom lives

Every capability an AI session might need is owned by an existing package.
This package only carries requests; the owners below do the work.

| You want to… | Owner package | Seam | Status today |
|---|---|---|---|
| Run process/job work | `run-a-job-on-your-stuff`, `process-session` | `action:run-a-job-on-your-stuff.run-process-job`, `action:run-a-job-on-your-stuff.run-guarded-process-tool` | live actions exist (verify execution per app; workflow→compute.process dispatch lane tracked in the harness-bridge plan) |
| Read a local file | `local-files` | `action:read-local-file`, `action:read-local-file-range` | live |
| Edit a local file | `file-editor` | `action:write-local-text-file` | live action record; execution gated by the workflow→compute.process lane |
| Move a path to Trash | `local-files` | `action:move-local-path-to-trash` | live |
| Recursively enumerate local files | `local-files` + the app carrier's native target | `action:scan-local-files` � `local.files scan_files` | action declared; current Trillion carrier still rejects `scan_files` |
| Watch files appear/change | `file-glob-observer`, `observed-content` | `observe-file-glob-source` | live |
| Search by meaning | `meaning-search` | `find-similar` | live |
| Make an HTTP request | `http-client` (via research-workspace) | `action:research-gather` dispatches `slot::http-client` with connector DATA | live |
| Connect a service/login | `service-connections`, `credentials-vault` | `connect-service-connection` etc. | live |
| Drive a web page | `browser-session-actions`, `browser-pool` (+ Obscura first) | `research-browser-interact` | live (observe lane inactive) |
| Ask a running app | `send-requests-to-an-engine` | this package's 4 tools (`list_running_app_actions` with input schemas, `find_running_app_records`, `call_running_app_action`, `read_running_app_record`); long calls use bounded `timeoutMs` | live |
| Read the package store | any engine via declared DATA | `connectionId: "bitfield-package-store"` on any bridge tool; exact-record reads use `read_running_app_record` (addressMode `multihash-hex`) | live; static catalog is deleted by decision |
| Install a package | `install-one-app-open-bundle-into-this-computer` | owner script | dev-side |
| Converge an installed app | `converge-one-installed-app-to-its-current-handle` | owner script | dev-side |
| Change package source → engine | `make-packages-match-their-source` | front-door script | dev-side |
| Run package checks | `run-the-declared-checks-for-chosen-packages` | owner script | dev-side |
| Read AI CLI transcripts | `ai-cli-conversations` | `ingest-agent-session-artifacts` | live |
| Schedule future work | `timed-action`, `trigger-engine`, `clock-ticker` | `timed-action.*` | live |
| Start worker sessions | `ai-work-control`, `process-session` | `submit-objective` | live |
| Publish content | `content-distribution` | `queue-publish` | live |
| Record video/audio | `record-video`, `record-audio` | `save-recorded-file` | live |

## The deletion-test result

No new package is needed for any row above. Missing rows are DATA additions
(declared action rows) to existing packages, made through
`make-packages-match-their-source`, then published to the store.
