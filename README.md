# Trillion Workshop

The open-source tools [Trillion](https://gettrillion.ai) offers to every person's AI. When an AI asks Trillion for a job ("work out my unit economics", "read this web page", "check this video before it goes out"), Trillion finds the tool here by its job, runs it, checks what it gave back and hands the answer to the AI.

Each tool is one folder: its code, the rows that tell Trillion what it does and how to run it, a README and its tests. Fork the repository, add or improve a tool, and open a pull request. Once it is merged, Trillion offers it to everyone.

## Files

| File | Purpose |
|------|---------|
| `export-records-as-list-rows` | Turns records kept in files (JSON, tab-separated text, markdown tables) into the rows that fill a person's Trillion lists, by a mapping the person writes (runs on the person's computer; sends nothing) | `tool:export-records-as-list-rows` |
| `tools/<name>/` | One tool folder: its code (`do-work/`, often `read-data/`), `tool-rows.json` (the rows Trillion reads), `README.md`, `part.json` and `test/`. |
| `tools/tools-from-github/` | Other people's open-source repositories offered as tools that run on the person's own computer, read from GitHub by `index-github-tools.mjs`. |
| `licence-classes.json` | The licence classes a row may name, which licences each covers and where each lets a tool run. |
| `test/every-tool-row.test.mjs` | Checks every folder's rows the way Trillion reads them: files named exist, licence classes are listed, ids are unique. |
| `test/lockfile-licences.test.mjs` | Checks every package in `package-lock.json` has a licence `licence-classes.json` lists, in a class that lets it run wherever this repository's tools run. |
| `test/intake-rows.test.mjs` | Checks `docs/intake-2026-11-01.json`: each intake item is tied to a tool row that is here, or recorded as unreachable with why and what closes it. |
| `test/every-process-row-selector.test.mjs` | Runs every row that runs a program on its own sample, as the container runner does, and checks its `result_selector` finds a value in the program's last JSON line (`"$"` for a program that prints the value itself, `"$.result"` for one that prints `{ result }`); a sample seeds its records, answers its internet requests from recorded replies (`test-helpers/stand-in-egress.mjs`) and gives made-up held values; lists by name every row it could not prove that way. |
| `test-helpers/run-a-row.mjs` | Runs one such row on this computer: its packed files laid at their places, its argv and stdin filled, the stand-in records door seeded with the sample's records for a row that reads records, the stand-in egress for a row with `"internet": true`, and made-up values for what it mounts. |
| `test-helpers/stand-in-egress.mjs` | The stand-in for the engine's loopback proxy: answers a sample's requests from its recorded replies over TLS, with a certificate authority made for the test run, and refuses any request it has no reply for. Its settings (the proxy and trust settings a program gets, how long a recorded reply is good for) are `test-helpers/stand-in-egress.json`. |
| `test-helpers/vitest-shim.mjs` | The part of vitest's API the `.test.ts` files use, on `node:test`. |
| `test-helpers/tool-catalogue.mjs`, `test-helpers/write-tool-catalogue.mjs`, `test/tool-catalogue-is-current.test.mjs` | The tool catalogue below, generated from every folder's `tool-rows.json`: `node test-helpers/write-tool-catalogue.mjs` rewrites it (`npm run catalogue`), and the test fails when it is stale. |
| `test-helpers/tool-rows.mjs` | Reads every folder's rows; both root tests use it. |
| `test-helpers/lockfile-licences.mjs` | Judges a lock's licences against the licence classes. |
| `test/every-item-has-its-kit.test.mjs`, `test-helpers/every-item-kit.mjs`, `test/items-without-a-kit.json` | Every Workshop item ships with its kit (L082, `tools/workflows/kit-template.json`): each workflow and tool has one kit file beside it (`<its folder>/kits/<its id without its prefix>.json`) that passes `kitProblems`. An item with no kit is refused unless the dated `items-without-a-kit.json` names it from before kits; that list may only shrink, and the push gate refuses a push that adds an id to it. |
| `package.json` | `npm test` runs every test here; `npm run check-kits` runs the kit gate alone. |
| `CONTRIBUTING.md` | How to add or change a tool. |
| `SECURITY.md` | How to report a problem privately, and what the rows promise about files, secrets, network and private addresses. |
| `LICENSE` | Apache License 2.0. |

## The tools

<!-- tool-catalogue:start -->
Generated from each folder's `tool-rows.json` by `node test-helpers/write-tool-catalogue.mjs`; do not edit it by hand. 1470 tools in 318 folders. A tool's job, inputs, outputs and sample run are in its row. `test/tool-catalogue-is-current.test.mjs` fails when this table is stale.

| Folder | Tools |
|---|---|
| `admit-attachments-to-a-message` | `tool:admit-attachments-to-a-message` |
| `ai-readiness` | `tool:check-a-page-for-search-and-answer-engines` |
| `answer-questions-about-many-states` | `tool:answer-questions-about-many-states`, `tool:get-a-classifier-ready-on-this-mac` |
| `app-release-access` | `tool:fulfill-setup-access`, `tool:read-app-distribution` |
| `ask-a-small-model-for-a-verdict` | `tool:answer-a-checks-questions-with-a-model-on-this-computer`, `tool:answer-questions-about-a-state`, `tool:ask-a-small-model-for-a-verdict`, `tool:calibrate-a-checks-questions-on-lines-i-ruled-on`, `tool:find-where-the-line-should-go`, `tool:fit-pass-and-fail-lines`, `tool:get-the-judges-ready`, `tool:recognise-a-repeat`, `tool:route-to-the-owner-that-answers`, `tool:see-which-models-can-judge`, `tool:tell-it-when-it-was-wrong` |
| `ask-questions-sort-answers-follow-up` | `tool:check-form-answers`, `tool:make-quiz-questions`, `tool:read-answer-progress`, `tool:read-form-results`, `tool:read-latest-answers-as-lines`, `tool:save-a-form`, `tool:score-answers-and-pick-segment`, `tool:submit-form-answers` |
| `assemble-a-plan-into-a-cut` | `tool:apply-new-titles-to-my-plans`, `tool:assemble-a-plan-into-a-cut`, `tool:regroup-a-plans-segments`, `tool:string-my-cuts-into-one-reel`, `tool:voice-the-lines-of-my-plans` |
| `audio-transcription` | `tool:hear-a-link`, `tool:hear-a-recording`, `tool:move-word-starts-to-where-the-voice-starts`, `tool:read-transcript-files-and-captions-into-timed-words`, `tool:time-words-in-a-recording`, `tool:transcribe-audio-and-repair-whisper-loops` |
| `benchmark-small-local-models` | `tool:check-takes-are-complete-with-a-small-local-model`, `tool:fill-a-scripts-blanks-with-small-local-models`, `tool:label-video-frames-with-small-local-models`, `tool:rank-candidate-clips-for-a-slot-with-small-local-models`, `tool:rank-my-titles-with-a-small-local-model`, `tool:sample-shots-and-frames-from-my-format-library`, `tool:score-small-model-labels-against-my-labels`, `tool:time-a-small-local-decider` |
| `better-auth-official` | `tool:run-official-better-auth` |
| `better-auth` | `tool:run-better-auth-sign-in` |
| `book-time` | `tool:cancel-a-booking-on-my-calendar`, `tool:change-a-booking-status`, `tool:check-when-i-am-busy`, `tool:find-open-times`, `tool:make-a-calendar-invite`, `tool:move-a-booking-on-my-calendar`, `tool:put-a-booking-on-my-calendar`, `tool:request-a-booking` |
| `brand-kit` | `tool:resolve-a-brand` |
| `bring-in-new-items-from-this-computer` | `tool:look-for-the-places-on-this-computer` |
| `bring-in-what-i-write-elsewhere` | `tool:check-incoming-attachments` |
| `browse-and-publish-what-my-ai-can-use` | `tool:make-marketplace-tiles-with-their-icons`, `tool:read-rows-as-marketplace-shelf-items` |
| `browse-my-recordings-and-media` | `tool:list-my-recordings-and-media` |
| `browse-public-page` | `tool:list-the-videos-a-site-plays`, `tool:read-a-link`, `tool:read-public-web-page` |
| `browser-saved-items` | `tool:organize-saved-browser-tabs` |
| `build-a-screen-from-patches` | `tool:apply-a-view-patch`, `tool:build-a-screen-spec-from-a-patch-stream`, `tool:make-a-view-patch` |
| `build-and-send-a-sales-contract` | `tool:plan-what-a-sent-deal-sets-up` |
| `calendar` | `tool:lay-out-a-calendar-view`, `tool:read-calendar-events`, `tool:read-time-blocks` |
| `calibrate-a-camera-frame` | `tool:calibrate-a-camera-frame` |
| `carry-a-computer-to-a-meeting-point` | `tool:carry-a-computer-to-a-meeting-point` |
| `carry-an-account-into-its-own-records` | `tool:check-imported-history-receipt` |
| `challenges` | `tool:check-challenge-definitions`, `tool:enroll-an-observer-in-challenges` |
| `check-a-computer-from-outside` | `tool:check-a-computer-from-outside` |
| `check-a-folder-against-my-rules` | `tool:check-a-folder-against-my-rules`, `tool:check-an-archive-against-my-rules`, `tool:rewrite-control-bytes-as-escapes` |
| `check-a-packages-declared-permissions` | `tool:check-a-packages-declared-permissions` |
| `check-a-port-against-its-source` | `tool:check-a-reference-adaptation-contract` |
| `check-a-rendered-video` | `tool:check-a-cuts-speech-against-its-plan`, `tool:check-a-rendered-video`, `tool:check-each-cut-of-my-plans-by-ear` |
| `check-a-videos-motion-against-a-reference` | `tool:check-a-videos-motion-against-a-reference`, `tool:list-the-longest-still-holds-of-my-video` |
| `check-against-a-persons-rules-and-verdicts` | `tool:check-a-films-copy`, `tool:check-against-a-persons-rules-and-verdicts`, `tool:check-copy`, `tool:check-every-piece-is-covered`, `tool:make-examples-from-where-a-person-stands`, `tool:split-a-document-into-pieces` |
| `check-bundle-package-boundaries` | `tool:check-a-bundle-against-package-boundaries` |
| `check-declared-places-keep-what-is-written-there` | `tool:check-declared-places-keep-what-is-written-there` |
| `check-deleted-code-names-its-home` | `tool:check-deleted-code-names-its-home` |
| `check-documents-agree-with-their-source` | `tool:check-documents-agree-with-their-source` |
| `check-every-claim-against-its-facts-and-sources` | `tool:check-every-claim-against-its-facts-and-sources`, `tool:make-plain-text-extracts-of-claim-sources` |
| `check-every-screen-at-every-width` | `tool:check-given-pages-at-every-width` |
| `check-every-tool-call` | `tool:check-a-check-rows-fixtures` |
| `check-how-an-installed-app-is-hardened` | `tool:check-an-app` |
| `check-new-names` | `tool:check-new-names` |
| `check-where-work-is-kept` | `tool:check-where-work-is-kept` |
| `check-words-for-personal-data` | `tool:check-personal-data` |
| `choose-and-save-local-files` | `tool:plan-choosing-and-saving-files-on-my-computer` |
| `choose-the-feed-each-widget-shows` | `tool:choose-the-feed-each-widget-shows` |
| `choose-whether-my-decisions-are-shared-show` | `tool:read-sharing-state` |
| `cite-principles-from-captions` | `tool:cite-principles-from-captions` |
| `collect-and-rank-viewer-questions` | `tool:collect-and-rank-viewer-questions` |
| `compare-two-ai-builds-on-trap-tasks` | `tool:compare-two-ai-builds-on-trap-tasks` |
| `compare-voice-and-music-models` | `tool:make-and-measure-every-voice-take-of-a-line`, `tool:measure-narration-takes`, `tool:render-music-note-events-to-a-test-wav`, `tool:say-a-narration-line-in-a-cloned-voice-model`, `tool:say-a-narration-line-in-a-kokoro-voice`, `tool:say-lines-in-a-candidate-voice-model`, `tool:score-how-alike-lines-sound-to-a-reference-voice` |
| `compose-thumbnails-from-layout-templates` | `tool:compose-thumbnails-from-layout-templates` |
| `connect-a-service-and-seal-its-key` | `tool:check-the-x-connection`, `tool:connect-an-account-by-signing-in-to-the-service`, `tool:keep-a-facebook-pages-token`, `tool:list-every-connection`, `tool:list-the-facebook-pages-a-sign-in-reaches`, `tool:trade-a-facebook-sign-in-code-for-its-short-token`, `tool:trade-a-gmail-sign-in-code-for-its-tokens`, `tool:trade-a-short-facebook-token-for-a-long-one`, `tool:trade-a-short-instagram-token-for-a-long-one`, `tool:trade-a-short-threads-token-for-a-long-one`, `tool:trade-a-threads-sign-in-code-for-its-short-token`, `tool:trade-a-tool-servers-sign-in-code-for-its-tokens`, `tool:trade-a-youtube-sign-in-code-for-its-tokens`, `tool:trade-an-instagram-sign-in-code-for-its-short-token`, `tool:trade-an-x-sign-in-code-for-its-tokens` |
| `connected-drives` | `tool:get-a-drive-icon`, `tool:list-a-drive-folder`, `tool:list-connected-drives`, `tool:name-what-holds-a-drive`, `tool:see-what-is-on-a-drive` |
| `connections` | `tool:list-connections` |
| `conversations` | `tool:count-my-ai-conversations-per-app`, `tool:import-conversation-exports-from-my-files`, `tool:import-my-conversations-from-a-source`, `tool:keep-what-i-said-to-an-ai`, `tool:list-the-conversation-sources-on-this-computer`, `tool:list-the-kinds-of-conversation-export-i-can-read`, `tool:read-an-export-of-my-conversations`, `tool:resume-importing-my-conversations`, `tool:show-how-far-my-conversation-import-is` |
| `coordination-sessions` | `tool:plan-an-event`, `tool:run-a-session-step`, `tool:work-a-session-catalog` |
| `copy-a-site` | `tool:copy-a-site` |
| `credit-kept-lines-to-their-writer` | `tool:credit-kept-lines-to-their-writer` |
| `cross-techniques-with-a-goal` | `tool:cross-techniques-with-a-goal`, `tool:say-why-a-technique-works` |
| `customer-follow-up` | `tool:add-a-customer`, `tool:record-a-customer-step`, `tool:see-where-each-customer-is`, `tool:set-a-customer-target` |
| `decide-agent-actions` | `tool:check-an-action-policy`, `tool:decide-an-agent-action` |
| `decide-when-things-show` | `tool:keep-a-show-rule`, `tool:keep-a-show-type`, `tool:see-when-things-show`, `tool:share-a-kept-show-type`, `tool:stop-sharing-a-show-type`, `tool:switch-a-kept-show-type`, `tool:take-a-show-rule-away`, `tool:take-a-show-type-away` |
| `decide-with-a-method` | `tool:add-decision-evidence`, `tool:answer-the-decisions-route`, `tool:answer-the-pursuits-page`, `tool:bring-back-similar-decisions`, `tool:end-a-decision`, `tool:make-the-decision`, `tool:read-a-method`, `tool:record-a-persons-own-decision`, `tool:record-method-answers`, `tool:report-a-decision-result`, `tool:say-what-was-done`, `tool:see-my-decisions`, `tool:share-a-decision`, `tool:start-a-decision` |
| `describe-connected-accounts` | `tool:describe-connected-accounts` |
| `describe-the-workshop` | `tool:derive-current-api-description-rows`, `tool:describe-a-tool`, `tool:manage-my-api-descriptions`, `tool:read-my-api-descriptions` |
| `document-sections` | `tool:build-a-quoted-section-from-entries`, `tool:place-a-section-in-a-markdown-document` |
| `documents-as-list-rows` | `tool:change-a-document-row`, `tool:read-documents-as-list-rows`, `tool:read-namespace-documents-as-list-rows`, `tool:split-a-document-into-item-documents` |
| `draw-ink-marks` | `tool:find-the-ink-mark-to-erase`, `tool:see-the-ink-marks-on-a-space`, `tool:turn-a-drawn-stroke-into-a-mark-shape` |
| `draw-lists-on-a-canvas` | `tool:fade-live-ink-marks` |
| `drive-the-screen` | `tool:drive-the-screen`, `tool:find-on-the-screen`, `tool:look-at-the-screen`, `tool:screen-actions` |
| `edit-a-copy-of-a-premiere-project` | `tool:edit-a-copy-of-a-premiere-project`, `tool:insert-frame-holds-into-a-filmcraft-project-copy` |
| `edit-a-document-together` | `tool:open-the-document-a-pursuit-edits-together` |
| `edit-text-and-code` | `tool:replace-one-piece-of-text-in-a-file`, `tool:replace-several-pieces-of-text-in-files` |
| `email-sending-domains` | `tool:add-an-email-sending-domain`, `tool:check-an-email-sending-domain`, `tool:list-email-sending-domains`, `tool:list-sending-keys`, `tool:make-a-sending-key`, `tool:read-an-email-sending-domain`, `tool:remove-a-sending-key` |
| `evaluate-progress` | `tool:check-claims-are-grounded`, `tool:check-corroboration`, `tool:decide-a-nudge`, `tool:hold-back-on-risk`, `tool:pick-fired-rules`, `tool:score-questionnaire-responses`, `tool:stitch-facts-into-people`, `tool:work-out-measures` |
| `export-browser-login-cookies-for-yt-dlp` | `tool:export-browser-login-cookies-for-yt-dlp` |
| `export-documents-to-files` | `tool:export-a-document-to-a-file`, `tool:export-a-markdown-book-to-word`, `tool:list-the-file-formats-an-export-can-make`, `tool:write-a-web-page-from-a-record` |
| `export-records-as-list-rows` | `tool:build-records-to-write`, `tool:export-records-as-list-rows`, `tool:publish-a-list-view-as-a-file`, `tool:put-records-into-my-account`, `tool:read-what-shipped` |
| `field-values` | `tool:plan-a-column-fill`, `tool:set-fields-by-rules`, `tool:settle-field-values` |
| `file-spoken-moments-into-topic-buckets` | `tool:file-spoken-moments-into-topic-buckets` |
| `fill-a-list-from-a-feed` | `tool:fill-a-list-from-a-feed` |
| `fill-a-template-without-changing-its-words` | `tool:check-words-against-a-word-template`, `tool:fill-a-word-template`, `tool:make-a-word-template`, `tool:make-spoken-line-candidates-one-slot-at-a-time`, `tool:re-time-events-tied-to-words`, `tool:write-a-word-template-from-the-words-i-keep-and-the-slots` |
| `find-a-spoken-passage-in-word-times` | `tool:find-a-spoken-passage-in-word-times` |
| `find-files-in-an-index` | `tool:find-files-in-an-index` |
| `find-media-for-a-description` | `tool:find-media-for-a-description` |
| `find-outlier-videos-against-their-channel-median` | `tool:find-outlier-videos-against-their-channel-median` |
| `find-pictures-by-colour-and-likeness` | `tool:find-pictures-by-colour-and-likeness` |
| `find-tool-servers-in-a-catalog` | `tool:find-tool-servers-in-a-catalog` |
| `fine-tune-a-small-model-on-a-persons-rules` | `tool:build-training-rows-from-a-persons-rules`, `tool:score-held-out-lines-with-a-small-model`, `tool:train-a-small-model-on-a-persons-rules` |
| `follow-my-ai-command-line-runs` | `tool:allow-my-ai-command-line-tools-in-a-folder`, `tool:read-an-ai-command-line-run-as-events` |
| `form-groups-and-matches` | `tool:advance-a-community-matchmaker`, `tool:answer-in-a-community`, `tool:assign-helpers-under-capacity`, `tool:change-my-groups`, `tool:check-community-matching-settings`, `tool:check-match-evidence`, `tool:choose-configurations`, `tool:forget-a-person-in-a-community`, `tool:form-matches`, `tool:read-my-community-matches`, `tool:read-my-groups`, `tool:regroup-a-tree` |
| `formula-engine` | `tool:classify-a-record`, `tool:evaluate-a-formula`, `tool:filter-rows-by-rules`, `tool:list-comparisons` |
| `free-what-the-list-says-can-be-got-back` | `tool:free-what-the-list-says-can-be-got-back` |
| `funnels-and-offers` | `tool:draft-a-funnel`, `tool:measure-funnel-stages`, `tool:read-a-funnel-definition`, `tool:walk-a-funnel` |
| `gate-telemetry-by-privacy` | `tool:gate-telemetry-by-privacy` |
| `gather-words-from-people` | `tool:approve-words-to-show`, `tool:ask-people-for-words`, `tool:keep-the-words-a-person-gave`, `tool:read-words-that-may-show` |
| `generate-and-judge-sound-effects` | `tool:bring-an-effects-layer-to-a-reference-loudness`, `tool:check-a-sound-effect-palette`, `tool:fetch-free-sound-effects-with-their-licences`, `tool:find-music-windows-that-follow-a-loudness-arc`, `tool:judge-one-shot-sounds-as-whole-sounds`, `tool:judge-sound-effect-candidates-and-pick-one-per-sound`, `tool:listen-to-music-windows-against-a-film-brief`, `tool:listen-to-sound-effects-and-find-clean-trims`, `tool:make-a-sound-effect-palette`, `tool:place-sound-effect-cues-into-an-effects-layer`, `tool:score-soundtrack-variants-by-ear`, `tool:search-freesound-for-free-sound-effects`, `tool:search-mixkit-for-free-sound-effects` |
| `generate-content-drafts` | `tool:check-a-presentation-plans-readiness`, `tool:choose-a-content-style`, `tool:compile-a-presentation-plan` |
| `generate-fill-scripts-for-formats` | `tool:generate-fill-scripts-for-formats` |
| `generate-images` | `tool:generate-images` |
| `generate-speech` | `tool:generate-speech`, `tool:say-with-a-voice-model`, `tool:voices` |
| `get-there` | `tool:find-nearest-places`, `tool:route-buttons` |
| `git-changes` | `tool:commit-changes`, `tool:see-a-files-change`, `tool:see-changes-in-a-project`, `tool:stage-changes`, `tool:unstage-changes` |
| `grade-and-repair-speech-audio` | `tool:clone-speech-that-repair-could-not-fix`, `tool:enhance-speech`, `tool:find-glitches-in-a-generated-voice-take`, `tool:grade-and-repair-speech-audio`, `tool:list-the-speech-in-my-edit-plans-to-grade`, `tool:listen-to-a-generated-voice-take-word-by-word`, `tool:measure-speech-in-my-recordings`, `tool:pick-the-cleanest-speech-to-clone-from`, `tool:read-back-repaired-speech`, `tool:score-voice-takes-against-the-voice-i-want`, `tool:silence-the-ticks-in-a-generated-voice-takes-pauses`, `tool:time-words-to-where-the-voice-starts` |
| `guard-ai-spending` | `tool:may-this-spend-go-ahead`, `tool:read-spend-rails`, `tool:record-a-spend`, `tool:reserve-a-spend-within-budget`, `tool:reset-daily-spend` |
| `guided-tours` | `tool:check-if-a-tour-step-may-advance`, `tool:find-the-event-that-starts-one-tour`, `tool:find-the-tour-an-event-starts`, `tool:step-through-a-guided-tour` |
| `hold-a-computer-quiet` | `tool:device-holds`, `tool:focus`, `tool:hold-a-device-quiet`, `tool:release-a-device` |
| `hold-one-thing-until-done` | `tool:answer-the-needs-you-hold-route`, `tool:change-what-holds-me`, `tool:see-what-holds-me` |
| `hold-to-it` | `tool:hold-to-it` |
| `how-someone-does-their-thing` | `tool:brief-a-profile`, `tool:check-a-draft-against-a-profile`, `tool:find-repeated-voice-edits`, `tool:keep-a-profile`, `tool:keep-a-voice-edit`, `tool:save-voice` |
| `import-markdown-to-editable-document` | `tool:import-markdown-as-editable-document`, `tool:import-markdown-file-as-editable-document` |
| `internet-archive` | `tool:read-internet-archive-item`, `tool:search-internet-archive` |
| `judge-words` | `tool:judge-against-rules`, `tool:make-a-plain-work-title` |
| `keep-a-long-job-resumable` | `tool:job` |
| `keep-a-record-library-valid` | `tool:adopt-reviewed-evidence-into-my-library`, `tool:check-a-record-library`, `tool:gate-a-pieces-delivery-checklist`, `tool:measure-a-reference-video`, `tool:pin-video-frames-as-evidence-pages`, `tool:rebuild-files-derived-from-my-records`, `tool:work-a-piece-through-a-question-bank` |
| `keep-a-secret-by-name` | `tool:keep-a-secret-by-name` |
| `keep-a-video-packaging-ledger` | `tool:add-reviewed-videos-to-a-packaging-ledger`, `tool:check-a-compiled-packaging-template-against-the-ledger`, `tool:check-a-packaging-intake-against-the-ledger`, `tool:project-a-packaging-ledger-into-template-source` |
| `keep-action-surfaces-complete` | `tool:keep-action-surfaces-complete` |
| `keep-an-ai-loop-from-spinning` | `tool:check-a-model-loops-calls` |
| `keep-an-elestio-firewall` | `tool:keep-an-elestio-firewall`, `tool:keep-every-elestio-firewall` |
| `keep-and-wake-ai-sessions-on-this-computer` | `tool:cancel-a-codex-run-on-this-computer`, `tool:connect-an-ai-app-on-this-computer-to-my-account`, `tool:manage-claude-cloud-sessions`, `tool:manage-harness`, `tool:read-a-codex-run-on-this-computer`, `tool:set-up-account-hooks-in-an-ai-app-on-this-computer`, `tool:start-a-codex-run-on-this-computer` |
| `keep-copies-in-step` | `tool:answer-the-catch-up-here-route`, `tool:say-how-this-device-stands`, `tool:see-if-my-copies-are-in-step`, `tool:settle-two-versions` |
| `keep-goals-and-focus` | `tool:order-my-goals-under-the-goals-they-serve` |
| `keep-lists-of-rows` | `tool:read-a-fields-history`, `tool:work-out-history-values` |
| `keep-measurements-current` | `tool:keep-measurements-current`, `tool:refresh-measurement-history`, `tool:refresh-provider-prices` |
| `keep-my-calendar-in-my-accounts-own-records-with-its-lists-files` | `tool:answer-the-calendar-page-route` |
| `keep-my-records-on-this-device` | `tool:pack-my-device-copys-settle-upload` |
| `keep-private-sites-out-of-capture` | `tool:capture-exclusion` |
| `keep-the-last-good-answer` | `tool:ask-a-web-address-or-give-the-last-answer` |
| `know-who-is-in-this` | `tool:enrol-a-voice-or-face`, `tool:enroll-someone`, `tool:find-faces`, `tool:keep-who-appeared`, `tool:who-is-in-this` |
| `lay-out-a-diagram` | `tool:compare-two-diagrams`, `tool:lay-out-a-diagram` |
| `learn-from-everyones-results` | `tool:add-a-shared-situation`, `tool:how-similar-results-turned-out`, `tool:randomize-a-result` |
| `leave-out-steps-for-devices-i-do-not-own` | `tool:leave-out-steps-for-devices-i-do-not-own` |
| `legal-document-builder` | `tool:make-a-sales-contract`, `tool:write-legal-documents` |
| `lessons-and-learning-paths` | `tool:list-the-courses-a-learner-is-on`, `tool:plan-an-evaluation-write`, `tool:show-the-courses-a-learner-is-on`, `tool:work-out-where-a-learner-stands` |
| `list-a-repositorys-place-inputs` | `tool:list-a-repositorys-place-inputs` |
| `list-clips-that-are-parts-of-a-series` | `tool:list-clips-that-are-parts-of-a-series` |
| `list-tools-for-an-ai` | `tool:fit-a-tool-list-in-a-budget`, `tool:pick-the-release-a-host-runs`, `tool:say-a-tools-hints-in-its-description`, `tool:tell-if-a-tool-changes-anything` |
| `listen-for-a-while` | `tool:ask-what-was-said`, `tool:caption-what-is-heard`, `tool:hear-for-a-device`, `tool:listen`, `tool:listen-for-a-while`, `tool:name-a-heard-voice` |
| `live-market-prices` | `tool:list-public-prediction-markets`, `tool:read-prediction-market-order-book`, `tool:read-price-bars-from-my-market-data-account` |
| `live-match-scores` | `tool:read-live-matches`, `tool:score-a-match` |
| `live-namespace` | `tool:your-files`, `tool:your-files-names` |
| `lock-out-stale-pages` | `tool:answer-which-page-builds-may-keep-working` |
| `look-at-screen` | `tool:look-at-screen` |
| `make-a-contact-sheet-of-pictures-or-video-frames` | `tool:make-a-contact-sheet-of-pictures-or-video-frames` |
| `make-a-frame-contact-sheet-of-a-video-section` | `tool:make-a-frame-contact-sheet-of-a-video-section` |
| `make-a-lut-for-log-footage` | `tool:make-a-lut-for-log-footage` |
| `make-a-video-playable-at-ingest` | `tool:decide-a-video-at-ingest` |
| `make-things-feel-good` | `tool:pick-a-small-good-moment` |
| `match-picks` | `tool:check-pick-copy`, `tool:prepare-a-match-pick-record`, `tool:tally-match-picks` |
| `match-rows` | `tool:match-rows` |
| `measure-a-characters-voice-lines-and-staging` | `tool:catalog-a-channels-videos-by-format`, `tool:code-the-comments-that-name-a-character`, `tool:collect-the-comments-that-name-a-character`, `tool:count-a-characters-turns-from-caption-marks`, `tool:count-a-shows-running-jokes-in-its-captions`, `tool:find-high-pitched-stretches-of-a-recording`, `tool:find-when-a-character-speaks`, `tool:list-what-a-character-says`, `tool:measure-how-a-show-stages-a-characters-turns`, `tool:sum-a-characters-time-per-video` |
| `measure-first-frame` | `tool:measure-first-frame` |
| `measurement-ledger` | `tool:cost-measurement-ledger` |
| `measurement-workspace` | `tool:measurement-workspace` |
| `media-analysis` | `tool:media-analysis` |
| `media-composition` | `tool:add-captions`, `tool:apply-a-pair-state-message`, `tool:arrange-videos`, `tool:blur-faces-not-agreed`, `tool:change-speed-over-a-range`, `tool:cut-and-caption`, `tool:export-editor-timeline`, `tool:extract-sound`, `tool:find-action-moments`, `tool:find-beats`, `tool:find-events-against-a-running-baseline`, `tool:find-recurring-voices`, `tool:find-scene-changes`, `tool:find-silence`, `tool:grade-a-video`, `tool:layer-pictures-over-video`, `tool:match-colour`, `tool:measure-loudness`, `tool:mix-sound-layers`, `tool:name-a-voice`, `tool:pick-cover-frame`, `tool:point-editor-projects-at-new-places`, `tool:reframe-video`, `tool:render-an-edit`, `tool:suggest-media-cuts`, `tool:use-an-app-on-this-computer` |
| `messages-screen` | `tool:list-my-conversations-newest-first` |
| `models-on-this-computer` | `tool:ask-a-model`, `tool:get-free-models` |
| `motion-film-template` | `tool:plan-a-motion-films-soundtrack-premix`, `tool:premix-a-motion-films-soundtrack`, `tool:write-the-icon-shapes-a-motion-film-uses` |
| `move-code-between-trees` | `tool:move-code-between-trees` |
| `move-records-through-declared-states` | `tool:check-a-pipeline`, `tool:check-a-stage-move` |
| `move-the-public-door` | `tool:cut-a-hostname-over-to-a-new-address`, `tool:release-a-host-of-the-public-door`, `tool:rent-a-host-for-the-public-door`, `tool:see-where-the-public-door-runs` |
| `name-my-next-commitment` | `tool:name-my-next-commitment` |
| `name-voices-from-the-call` | `tool:name-voices-from-the-call` |
| `notice-what-needs-attention` | `tool:notice-what-needs-attention` |
| `notice-when-something-shows-up` | `tool:notice-when-something-shows-up` |
| `notifications` | `tool:choose-my-notification-choice`, `tool:my-browser-push-application-key`, `tool:my-notification-choice`, `tool:my-notification-devices`, `tool:my-notification-events`, `tool:record-a-notification`, `tool:register-my-live-activity`, `tool:register-my-notification-device`, `tool:remove-my-notification-device`, `tool:send-live-activity-update`, `tool:send-notification-to-my-devices` |
| `office-files` | `tool:change-cells-or-words-in-an-office-file`, `tool:describe-a-presentation-runtime`, `tool:edit-a-presentations-text`, `tool:read-an-office-file` |
| `open-a-meeting-link` | `tool:open-meeting-link`, `tool:read-meeting-link` |
| `open-a-prompt-in-a-local-ai-app` | `tool:open-in-ai` |
| `opponent-game-plan` | `tool:prepare-a-match-plan`, `tool:scout-an-opponent` |
| `page-critic` | `tool:critique-a-public-page` |
| `paid-access` | `tool:check-a-buyer-may-open`, `tool:give-a-buyer-a-paid-file-link`, `tool:open-a-paid-file-for-a-buyer`, `tool:seal-a-paid-file`, `tool:see-who-holds-paid-access` |
| `pair-unknown-senders` | `tool:approve-a-pairing-code`, `tool:list-paired-senders`, `tool:pair-an-unknown-sender`, `tool:unpair-a-sender` |
| `person-list` | `tool:find-people`, `tool:rank-people-by-activity` |
| `person-profile` | `tool:lay-out-a-profile` |
| `pick-a-screen-as-you-type` | `tool:fill-screen-inputs-from-words`, `tool:pick-a-screen-for-typed-words` |
| `pin-files-by-content` | `tool:check-prose-against-its-writing-rules`, `tool:check-quotes-against-their-source-bytes`, `tool:pin-files-by-content` |
| `plan-my-time` | `tool:plan-my-time` |
| `plan-tasks-and-todo-lists` | `tool:change-a-task`, `tool:finish-a-task`, `tool:give-a-task`, `tool:see-tasks`, `tool:see-who-can-take-work`, `tool:sort-mail-into-built-in-task-lists`, `tool:take-a-task` |
| `plan-trips` | `tool:measure-a-checklist`, `tool:rank-open-trip-things` |
| `pointillist-film` | `tool:render-a-pointillist-frame`, `tool:render-a-pointillist-target-animation`, `tool:render-pointillist-frames-over-time` |
| `poker` | `tool:rank-poker-hands`, `tool:run-a-poker-table`, `tool:view-a-poker-table-for-a-player` |
| `pour-example-rows-into-my-list` | `tool:pour-example-rows-into-my-list` |
| `practice-and-review` | `tool:list-what-is-due`, `tool:schedule-next-review` |
| `predict-viewer-response-to-a-video` | `tool:predict-viewer-response-to-a-video` |
| `print-here` | `tool:print`, `tool:printers` |
| `publish-a-changelog` | `tool:record-a-publishing-step`, `tool:see-what-work-is-ready-to-publish` |
| `publish-a-site-at-its-own-address` | `tool:attach_domain`, `tool:let_go_of_site_address`, `tool:name_site`, `tool:publish_site`, `tool:site_addresses` |
| `publish-content-for-discovery` | `tool:prepare-public-content-for-discovery` |
| `published-destinations` | `tool:check-a-destination-is-honest`, `tool:find-a-destination` |
| `pull-a-time-window-from-a-stored-camera-file` | `tool:pull-a-time-window-from-a-stored-camera-file` |
| `pull-from-connected-accounts` | `tool:link-signal-on-this-computer`, `tool:pull-my-discord-messages`, `tool:pull-my-instagram-comments`, `tool:pull-my-instagram-messages`, `tool:pull-my-messenger-messages`, `tool:pull-my-pinterest-pins`, `tool:pull-my-signal-messages`, `tool:pull-my-slack-messages`, `tool:pull-my-telegram-messages`, `tool:pull-my-x-bookmarks`, `tool:read-my-signal-messages-on-this-computer` |
| `put-an-object-in-an-s3-store` | `tool:put-an-object-in-an-s3-store` |
| `put-picked-options-into-a-filmcraft-project` | `tool:build-a-filmcraft-option-preview`, `tool:make-a-fresh-viewer-review-pack-of-a-preview`, `tool:make-a-working-preview-of-a-stitched-opening`, `tool:publish-a-checked-filmcraft-preview`, `tool:put-a-picked-option-into-a-filmcraft-project` |
| `quote-untrusted-words` | `tool:quote-untrusted-words` |
| `rank-library-formats-against-concepts` | `tool:rank-library-formats-against-concepts` |
| `rank-records-for-review` | `tool:accept-or-pass-on-a-ranked-record` |
| `read-a-list-view` | `tool:read-a-list-view` |
| `read-and-edit-the-saved-configurations-others-shared` | `tool:answer-the-configurations-page` |
| `read-and-write-mail` | `tool:delete-a-mail-draft`, `tool:find-mail`, `tool:find-my-mailbox`, `tool:list-mail-drafts`, `tool:list-new-mail`, `tool:list-send-as-addresses`, `tool:organize-a-conversation`, `tool:organize-mail`, `tool:read-a-conversation`, `tool:read-a-mail`, `tool:read-a-mail-draft`, `tool:read-mail-headers`, `tool:restore-a-conversation`, `tool:restore-mail`, `tool:save-a-mail-draft`, `tool:send-a-mail-draft`, `tool:set-a-mail-signature`, `tool:trash-a-conversation`, `tool:trash-mail` |
| `read-my-other-ais-files` | `tool:other-ai-files` |
| `read-objects-in-an-s3-store` | `tool:read-objects-in-an-s3-store` |
| `read-other-ais-setups` | `tool:read-ai-setups` |
| `read-rows-from-a-rest-service` | `tool:read-rows-from-a-rest-service` |
| `read-the-menu-bar-settings` | `tool:read-the-menu-bar-settings` |
| `read-what-is-on-screen` | `tool:parse-snapshot`, `tool:read-what-is-on-screen` |
| `receive-files-over-ftp` | `tool:receive-files-over-ftp` |
| `recently-deleted-and-storage` | `tool:delete-archive-and-put-back-my-files`, `tool:set-deleted-files-keep-for` |
| `recently-deleted` | `tool:read-deleted-files-keep-for` |
| `record-a-job-shown-once` | `tool:record-a-demonstration` |
| `record-a-web-page` | `tool:record-a-web-demo` |
| `record-cameras-and-microphones-all-day` | `tool:plan-clock-aligned-recording-pieces` |
| `record-graph` | `tool:find-how-records-connect`, `tool:read-the-graph-around-a-record` |
| `record-my-screen` | `tool:rebuild-a-screen-recording-from-its-chunks` |
| `record-the-screen` | `tool:places-left-out-of-screen-capture`, `tool:record-the-screen` |
| `record-video-with-teleprompter` | `tool:turn-a-presentation-plan-into-a-teleprompter-session` |
| `referral-codes-and-rewards` | `tool:give-referral-rewards`, `tool:make-a-referral-code`, `tool:withdraw-a-referral-code`, `tool:work-out-referral-codes` |
| `register-my-account-in-my-ai-apps` | `tool:register-my-account-in-my-ai-apps` |
| `render-a-motion-graphics-overlay` | `tool:render-a-motion-graphics-overlay`, `tool:render-an-overlay-insert-for-a-cut` |
| `reply-by-keyword-rule` | `tool:decide-the-replies`, `tool:send-a-reply-on-instagram`, `tool:send-a-reply-on-youtube` |
| `reply-templates` | `tool:expand-a-reply-template` |
| `research-a-creator-or-topic` | `tool:brief-a-prospect`, `tool:keep-a-prospect`, `tool:keep-channels-latest-videos-and-captions`, `tool:keep-forum-posts-from-a-public-archive`, `tool:keep-public-posts-by-link`, `tool:list-a-channels-latest-videos`, `tool:list-the-items-in-a-saved-file`, `tool:list-the-latest-items-of-a-feed`, `tool:read-a-videos-captions`, `tool:search-the-public-web`, `tool:write-a-profile-request` |
| `resync-an-elestio-pipeline` | `tool:resync-an-elestio-pipeline` |
| `revenue-ledger` | `tool:add-up-revenue` |
| `review-what-a-list-says` | `tool:find-cold-rows`, `tool:find-rows-needing-review`, `tool:heat-of-a-row` |
| `run-a-signed-events-effects-once` | `tool:turn-signed-events-into-effects-once` |
| `run-an-installed-apps-command-line` | `tool:run-an-installed-apps-command-line` |
| `run-experiments` | `tool:choose-what-a-visitor-sees`, `tool:credit-outcomes-to-candidates`, `tool:read-experiment-results` |
| `run-sql-in-my-database` | `tool:run-sql-in-my-database` |
| `run-the-connections-and-automations-my-computers-carry-keeping` | `tool:carry-connections` |
| `run-tools-in-my-signed-in-browser` | `tool:act-in-my-browser`, `tool:drive-my-browser`, `tool:read-a-page-in-my-browser` |
| `run-work-later-or-on-a-repeat` | `tool:plan-recurring-windows`, `tool:when-to-run-next` |
| `running-programs` | `tool:choose-programs-left-running`, `tool:list-running-programs`, `tool:stop-programs-left-running` |
| `save-what-you-watch-and-read` | `tool:find-new-or-changed-files`, `tool:observe-something-i-watched-or-read`, `tool:read-my-saved-bookmarks-and-pins`, `tool:read-my-saved-x-posts` |
| `saved-examples` | `tool:answer-the-saved-examples-page` |
| `say-what-the-menu-bar-mark-shows` | `tool:say-what-the-menu-bar-mark-shows` |
| `screen-looks` | `tool:read-current-worn-look`, `tool:resolve-a-look` |
| `search-everything-with-one-question` | `tool:answer-the-search-page-route`, `tool:make-a-picture-vector-set-of-my-videos`, `tool:make-a-vector-set-from-picture-vectors-my-apps-kept`, `tool:search-everything-in-a-small-container`, `tool:search-everything-with-one-question`, `tool:search-one-of-my-lists` |
| `see-a-pursuit-through-the-lens` | `tool:see-a-pursuit-through-the-lens` |
| `see-and-limit-what-each-ai-can-reach` | `tool:read-ai-apps` |
| `see-what-is-being-worked-on` | `tool:join-what-is-being-worked-on-into-a-tree` |
| `see-what-my-ais-did` | `tool:keep-an-ai-activity-row`, `tool:read-ai-activity` |
| `see-what-my-business-took-in-this-month` | `tool:read-business`, `tool:stripe-events-read_money_since` |
| `seller-payment-setup` | `tool:build-a-sellers-payment-setup-request` |
| `send-messages` | `tool:pace-sends-from-an-inbox`, `tool:save-interest-in-an-email-update`, `tool:send-a-message-on-this-mac`, `tool:send-a-text`, `tool:send-an-email`, `tool:send-due-email-lessons`, `tool:sign-someone-up-for-an-email-course`, `tool:sort-bounces-and-replies`, `tool:stop-an-email-course`, `tool:who-agreed-to-get-which-emails`, `tool:write-a-message-body-from-a-document` |
| `send-to-a-place` | `tool:add-to-notion`, `tool:post-to-slack`, `tool:send-to-a-webhook` |
| `serve-command-line-mcp-servers-on-the-web` | `tool:ask-a-command-line-mcp-server-once` |
| `set-up-my-account` | `tool:read-setup`, `tool:see-what-is-left-to-set-up` |
| `settings` | `tool:read-a-tool-setting` |
| `settle-amounts-and-reconcile` | `tool:post-balanced-entries`, `tool:reconcile-lines-against-a-statement`, `tool:report-on-accrual-or-cash`, `tool:settle-amounts-between-lists`, `tool:total-quote-lines` |
| `shape-a-thought-into-my-content-formats` | `tool:answer-the-content-formats-page` |
| `share-anything` | `tool:end-shares-whose-condition-failed`, `tool:share-anything` |
| `share-links` | `tool:read-link-page` |
| `show-any-file-as-itself` | `tool:choose-how-each-file-is-shown` |
| `show-my-automations-on-the-signed-in-page-what-sets` | `tool:list-my-automations` |
| `show-my-screens-from-a-catalogue-of-reads-and-layouts` | `tool:business`, `tool:get-started`, `tool:look` |
| `show-the-media-library-and-search-what-was` | `tool:answer-the-media-page` |
| `show-the-signed-in-persons-message-inbox-and-tell` | `tool:answer-the-message-page-routes` |
| `show-what-a-tool-would-give-members` | `tool:show-what-a-tool-would-give-members` |
| `sign-a-mac-app-update` | `tool:sign-a-mac-app-update` |
| `sign-in-with-a-passkey` | `tool:judge-a-new-sign-in-password` |
| `slot-table` | `tool:keep-keyed-things-in-a-fixed-memory-budget` |
| `social-posts` | `tool:approve-a-post`, `tool:check-a-connection`, `tool:check-a-post`, `tool:draft-a-post`, `tool:list-my-youtube-videos`, `tool:list-post-destinations`, `tool:publish-a-post-now`, `tool:read-a-thread-summary`, `tool:read-post-calendar`, `tool:read-youtube-comments`, `tool:see-how-each-post-did`, `tool:send-a-post`, `tool:set-a-post-to-go-at-its-time`, `tool:take-back-a-post`, `tool:use-a-snippet` |
| `sort-youtube-watch-later-into-playlists` | `tool:make-youtube-playlists-from-a-sort-plan`, `tool:plan-sorting-youtube-watch-later-into-playlists`, `tool:read-my-youtube-watch-later-and-playlists` |
| `space-members` | `tool:check-someone-is-in-a-space`, `tool:choose-the-name-i-show-in-a-space`, `tool:join-a-space`, `tool:leave-a-space`, `tool:list-a-spaces-members` |
| `start-a-computer` | `tool:check-a-sign-up`, `tool:give-back-a-computer`, `tool:read-a-computer`, `tool:read-a-computer-price`, `tool:rent-a-machine`, `tool:start-a-computer` |
| `stream-an-answer-in-keyed-parts` | `tool:merge-a-streamed-answer` |
| `suggest-connections-from-links` | `tool:suggest-connections-from-links` |
| `suggest-what-to-ask-on-a-screen` | `tool:list-ideas-for-what-to-ask-on-a-screen` |
| `suggest-zooms-from-pointer-moves` | `tool:suggest-zooms` |
| `sync-files-between-my-computers` | `tool:keep-a-local-file-in-my-files`, `tool:say-where-file-sync-stands` |
| `take-me-there` | `tool:take-me-there` |
| `take-payments` | `tool:cancel-a-stripe-subscription`, `tool:cancel-prepared-resource-usage-report`, `tool:check-a-stripe-event`, `tool:check-what-a-buyer-paid`, `tool:correct-resource-usage-settlement`, `tool:count-a-paid-installment-in-stripe`, `tool:find-a-completed-stripe-checkout`, `tool:keep-completed-stripe-checkouts-as-payment-events`, `tool:keep-resource-usage-observation`, `tool:list-completed-stripe-checkouts`, `tool:list-ended-stripe-subscriptions`, `tool:look-up-a-stripe-checkout`, `tool:manage-usage-pricing`, `tool:observe-live-usage`, `tool:open-the-billing-page-for-one-purchase-and-show-the-card`, `tool:pay-someone-a-share-through-stripe`, `tool:price-a-sale`, `tool:price-resource-usage`, `tool:read-resource-usage-report`, `tool:read-resource-usage-settlement`, `tool:read-stripe-promotion-codes`, `tool:read-stripe-promotion-codes-in-test-mode`, `tool:reconcile-resource-usage-report`, `tool:rehearse-a-billing-page-in-stripe-test-mode`, `tool:rehearse-a-payment-schedule-in-stripe-test-mode`, `tool:report-resource-usage`, `tool:schedule-the-later-payments-in-stripe`, `tool:set-up-someone-i-pay-in-stripe`, `tool:set-up-stripe-payment-links`, `tool:settle-shared-resource-cost`, `tool:show-one-purchase-plan-card-and-receipts`, `tool:show-which-offers-a-buyer-may-see`, `tool:start-a-stripe-checkout`, `tool:start-a-stripe-checkout-that-pays-someone-else`, `tool:tag-a-stripe-subscription` |
| `take-pictures-out-of-a-zip-archive` | `tool:take-pictures-out-of-a-zip-archive` |
| `take-requests` | `tool:hand-a-request-to-its-owner`, `tool:my-requests`, `tool:take-a-request` |
| `tell-a-repeated-capture-from-a-new-one` | `tool:capture-dedupe` |
| `tell-ais-how-to-act` | `tool:keep-my-account-in-your-instructions`, `tool:read-how-ais-are-told` |
| `tell-one-person-something-through-every-way-they` | `tool:answer-the-tell-notices-route` |
| `tell-our-own-voice-from-what-was-heard` | `tool:tell-our-own-voice-from-what-was-heard` |
| `tools-from-github` | `tool:github:blaizzy-mlx-video`, `tool:github:breakthrough-pyscenedetect`, `tool:github:coreyhaines31-marketingskills`, `tool:github:danielgatis-rembg`, `tool:github:docling-project-docling`, `tool:github:facebookresearch-demucs`, `tool:github:ffmpeg-ffmpeg`, `tool:github:ggml-org-whisper.cpp`, `tool:github:govijr-fix-storage`, `tool:github:govijr-terminal-mac`, `tool:github:govijr-terminal-phone`, `tool:github:m-bain-whisperx`, `tool:github:mflux-community-mflux`, `tool:github:microsoft-markitdown`, `tool:github:mikf-gallery-dl`, `tool:github:ocrmypdf-ocrmypdf`, `tool:github:ohf-voice-piper1-gpl`, `tool:github:systran-faster-whisper`, `tool:github:tesseract-ocr-tesseract`, `tool:github:xinntao-real-esrgan`, `tool:github:yt-dlp-yt-dlp`, `tool:github:zenbu-labs-terminal-browser` |
| `tours-screen` | `tool:dismiss-waiting-tours`, `tool:list-waiting-tours`, `tool:list-workspace-tours` |
| `track-and-compare-movement` | `tool:line-up-two-movements`, `tool:plan-a-side-by-side-movement-comparison`, `tool:read-peoples-poses-from-a-video`, `tool:track-a-selected-object-in-a-video` |
| `trading` | `tool:check-live-orders-with-the-broker`, `tool:check-paper-orders-with-the-broker`, `tool:look-up-instruments-at-my-live-broker`, `tool:look-up-instruments-at-my-paper-broker`, `tool:place-live-orders-from-a-trading-policy`, `tool:place-paper-orders-from-a-trading-policy` |
| `traffic-attribution` | `tool:break-down-visits-and-sales`, `tool:make-tracked-link`, `tool:measure-ad-return`, `tool:prepare-ad-conversions` |
| `train-and-evaluate-a-writing-voice-classifier` | `tool:audit-what-a-voice-classifier-was-trained-on`, `tool:evaluate-a-writing-voice-classifier`, `tool:score-writing-with-a-voice-adapter`, `tool:train-a-writing-voice-adapter` |
| `transcript-reader` | `tool:edit-a-transcript` |
| `treg` | `tool:call-a-treg-endpoint`, `tool:read-a-treg-call`, `tool:read-a-treg-endpoint-and-its-price`, `tool:read-my-treg-balance`, `tool:read-my-treg-team`, `tool:search-the-treg-catalog` |
| `triage-against-priorities` | `tool:brief-a-triage`, `tool:settle-a-triage` |
| `turn-a-folder-of-agent-skills-into-workflows` | `tool:turn-my-agent-skills-into-workflows` |
| `turn-caption-quotes-into-analysis-device-rows` | `tool:turn-caption-quotes-into-analysis-device-rows` |
| `turn-frames-into-slides` | `tool:turn-frames-into-slides` |
| `turn-the-decision-methods-own-sources-into-workflows` | `tool:measure-source-coverage` |
| `type-what-i-say` | `tool:dictate`, `tool:type-dictated-text` |
| `unit-economics` | `tool:work-out-unit-economics` |
| `upload-a-file-to-a-signed-slot` | `tool:upload-a-file-to-a-signed-slot` |
| `use-your-tools-from-a-shell` | `tool:use-your-tools-from-a-shell` |
| `walk-a-new-person-through-first-setup` | `tool:start-or-resume-the-first-setup`, `tool:walk-a-new-person-through-first-setup` |
| `walk-a-new-person-through-setup` | `tool:keep-what-my-devices-report-about-themselves` |
| `walk-nested-input-within-limits` | `tool:check-nested-input` |
| `walk-through-an-app-like-its-users` | `tool:map-an-apps-screens-and-controls`, `tool:read-what-a-running-app-shows`, `tool:walk-through-an-app-like-its-users` |
| `watch-and-keep-a-live-camera` | `tool:plan-the-address-a-live-camera-streams-to` |
| `watch-my-sources` | `tool:watch-my-sources` |
| `what-a-paste-becomes` | `tool:decide-what-a-paste-becomes` |
| `what-is-waiting-on-me` | `tool:finish-what-is-waiting-on-me`, `tool:read-what-is-waiting-on-me`, `tool:verify-waiting-on-me-completion`, `tool:what-is-waiting-on-me` |
| `what-runs-on-its-own` | `tool:see-what-runs-on-its-own` |
| `where-a-person-stands` | `tool:count-real-rulings`, `tool:count-where-a-person-stands`, `tool:keep-rulings-on-lines`, `tool:keep-where-you-stand`, `tool:make-examples-from-picks`, `tool:make-examples-from-rulings`, `tool:plan-a-stance-reload`, `tool:read-where-you-stand` |
| `who-does-each-step` | `tool:what-can-my-account-do`, `tool:who-does-each-step` |
| `wikimedia-commons` | `tool:assess-wikimedia-commons-file-reuse`, `tool:read-wikimedia-commons-file-metadata`, `tool:search-wikimedia-commons-files` |
| `words-as-picture-vector` | `tool:words-as-picture-vector` |
| `work-breakdown` | `tool:add-work-item`, `tool:check-proof-of-finished-work`, `tool:list-tasks-and-what-blocks-them`, `tool:roll-up-work-completion` |
| `work-on-connected-drives` | `tool:media-eject`, `tool:media-file-places`, `tool:media-transfer`, `tool:media-work`, `tool:media-work-control` |
| `work-out-a-recipes-nutrients-from-fooddata-central` | `tool:work-out-a-recipes-nutrients-from-fooddata-central` |
| `workflows` | `tool:choose-the-workflows-that-fire`, `tool:gate-a-piece-against-a-checklist`, `tool:generate-a-checklist-from-my-text`, `tool:measure-page-citation-coverage`, `tool:record-checklist-gate-changes`, `tool:write-a-source-copy`, `workflow:account-for-every-ask-in-a-message`, `workflow:act-on-feedback-with-judgment`, `workflow:act-on-my-notice`, `workflow:add-a-human-approval-and-revision-loop-to-an-agent`, `workflow:admit-an-audience-question-to-private-drafts`, `workflow:adopt-a-named-tool-or-repository`, `workflow:adopt-a-stated-way-of-working-with-ai`, `workflow:answer-an-insult-or-a-passive-aggressive-remark`, `workflow:answer-commenters-with-videos`, `workflow:answer-comments-and-messages`, `workflow:ask-for-ten-and-keep-the-winner`, `workflow:audit-a-site-against-its-references-for-originality`, `workflow:audit-an-app-store-listing`, `workflow:audit-an-email-program-from-its-numbers`, `workflow:be-funny-without-hurting-anyone`, `workflow:brief-a-creator-with-one-full-brief`, `workflow:bring-an-old-sites-content-into-the-sellers-own-store`, `workflow:bring-back-unengaged-email-subscribers`, `workflow:bring-in-a-framework`, `workflow:bring-in-my-processes`, `workflow:bring-newly-shared-items-into-one-list`, `workflow:browse-inspiration-clips`, `workflow:build-a-best-x-for-y-comparison`, `workflow:build-a-campaign-world-from-a-two-sentence-concept`, `workflow:build-a-design-system-from-the-ui-an-app-already-ships`, `workflow:build-a-living-workbook-for-a-numeric-strategy`, `workflow:build-a-paid-social-campaign-in-three-audience-stages`, `workflow:build-a-pipeline-that-makes-and-posts-short-videos-on-a-schedule`, `workflow:build-a-short-video-shop-around-one-hero-product`, `workflow:build-a-site-that-does-not-look-ai-made`, `workflow:build-a-soundtrack-from-real-recordings`, `workflow:build-a-targeted-lead-list-for-cold-outreach`, `workflow:build-a-voice-agent-that-handles-calls`, `workflow:build-an-ad-hook-for-the-buyers-stage`, `workflow:build-an-agent-that-answers-from-the-persons-own-documents`, `workflow:build-an-agent-that-researches-and-returns-a-cited-report`, `workflow:build-an-agent-that-sorts-incoming-mail-and-drafts-replies`, `workflow:build-an-audience-with-traffic-hopper-and-conversion`, `workflow:build-an-unpaid-creator-network-around-a-product`, `workflow:build-muscle-with-hard-sessions-enough-food-and-sleep`, `workflow:build-the-abilities-the-work-needs`, `workflow:build-the-landing-page`, `workflow:buy-and-deliver`, `workflow:capture-a-set-of-ui-references-with-evidence-and-prompts`, `workflow:capture-a-whole-page-as-one-trustworthy-image`, `workflow:carry-each-lesson-into-the-next-work`, `workflow:change-a-databases-shape-without-stopping-what-uses-it`, `workflow:check-a-change-for-security-holes`, `workflow:check-a-claim-and-explain-it-in-plain-words`, `workflow:check-a-customer-support-case-before-it-is-closed`, `workflow:check-a-decision-against-your-map`, `workflow:check-every-computer-from-outside`, `workflow:check-my-code-against-my-rules`, `workflow:check-that-a-new-customer-pays-for-their-own-acquisition-fast`, `workflow:check-what-a-standing-system-did-this-week`, `workflow:check-what-changed-and-fix-what-failed`, `workflow:choose-a-change-worth-making`, `workflow:choose-a-product-by-timing-differentiation-and-landed-margin`, `workflow:choose-a-product-category-where-the-leader-has-stopped-caring`, `workflow:choose-and-package-a-long-video-idea-then-read-where-viewers-leave`, `workflow:choose-audience-countries-by-payout`, `workflow:choose-four-products-for-one-person`, `workflow:choose-how-to-price-automation-work`, `workflow:choose-marketing-moves-that-fit-the-stage-budget-and-time`, `workflow:choose-testimonials-for-relevance-and-give-sales-a-list`, `workflow:choose-the-model-and-effort-for-a-task`, `workflow:choose-the-next-move-that-matters-most`, `workflow:choose-where-to-source-a-product-by-category-and-quality-control`, `workflow:choose-which-ai-answers-me`, `workflow:choose-who-hosts-an-automation-and-hand-it-over`, `workflow:claim-a-public-name`, `workflow:clean-and-reformat-content-for-where-it-will-be-pasted`, `workflow:close-the-books-and-report-cash-each-month`, `workflow:combine-several-ai-answers`, `workflow:compare-designs-by-simulating-them-forward`, `workflow:compare-several-designs-of-one-piece-of-interface`, `workflow:compress-a-work-segment-into-observations-that-survive-context-loss`, `workflow:connect-every-ai-to-one-memory-list`, `workflow:contact-a-booker-right-after-they-book`, `workflow:cut-spending-in-one-expense-area`, `workflow:decide-a-source-message`, `workflow:deepen-a-request-like-a-top-professional`, `workflow:deliver-a-finished-automation-project`, `workflow:deliver-a-message-as-a-row-of-my-list`, `workflow:deliver-it-and-keep-it-sustainable`, `workflow:derive-the-useful-outcome-of-a-mechanism`, `workflow:describe-what-happens-before-naming-it`, `workflow:design-a-converting-email-and-load-it-as-image-slices`, `workflow:design-a-pricing-page`, `workflow:design-a-recurring-marketing-check`, `workflow:design-an-upgrade-moment-that-asks-after-value`, `workflow:design-popups-and-banners-that-convert-without-annoying`, `workflow:direct-and-render-a-short-motion-film`, `workflow:document-the-journey-in-public-before-launch`, `workflow:draw-a-technical-illustration-of-how-something-works`, `workflow:draw-the-task-map-of-one-page`, `workflow:earn-links-and-mentions-for-the-pages-that-need-them`, `workflow:earn-press-coverage`, `workflow:estimate-the-total-cost-of-a-technical-project`, `workflow:estimate-what-an-existing-codebase-would-cost-to-build`, `workflow:expand-then-compress-an-idea-to-its-smallest-falsifiable-system`, `workflow:explain-an-idea-as-a-physical-isometric-figure`, `workflow:explain-how-a-web-interface-was-built`, `workflow:fetch-a-social-post-by-link`, `workflow:file-what-needs-the-person`, `workflow:fill-in-a-lean-canvas-with-evidence`, `workflow:finance-inventory-with-debt-tied-to-sell-through`, `workflow:find-a-partner-and-plan-a-joint-campaign`, `workflow:find-ad-angles-in-customers-own-words`, `workflow:find-and-attack-the-one-constraint-on-growth`, `workflow:find-and-test-the-short-video-formats-that-sell-your-app`, `workflow:find-anything-across-my-rows`, `workflow:find-content-pillars-by-testing-each-idea-three-times`, `workflow:find-moments-in-a-recording`, `workflow:find-out-what-someone-wants-and-influence-them-fairly`, `workflow:find-the-deepest-root-cause-of-a-bug`, `workflow:find-the-gaps-between-a-design-and-its-target`, `workflow:find-the-move-from-what-is-already-in-a-persons-world`, `workflow:find-the-recording-of-a-heard-line`, `workflow:find-the-words-people-understand-and-act-on`, `workflow:find-the-words-then-the-channel-then-the-product`, `workflow:find-their-own-map`, `workflow:find-unexplored-ground`, `workflow:find-what-a-person-values-from-what-they-do`, `workflow:find-what-your-pursuits-leave-out`, `workflow:find-where-someone-appeared`, `workflow:find-where-the-steward-ladder-breaks`, `workflow:find-where-you-played-small`, `workflow:find-winning-ads-by-testing-ideas-against-formats`, `workflow:first-win`, `workflow:fix-a-program-or-game-that-crashes-or-will-not-start`, `workflow:fix-a-slow-or-failing-network-connection-in-an-app`, `workflow:fix-low-frame-rate-and-lag`, `workflow:fix-missing-or-broken-sound`, `workflow:flirt-with-playful-teasing`, `workflow:follow-through`, `workflow:follow-up-with-people-who-engaged`, `workflow:forecast-what-a-solution-will-change`, `workflow:forge-a-skill-from-reference-data`, `workflow:gather-answers-before-a-sales-call`, `workflow:get-a-first-client-with-free-tools-and-a-recorded-walkthrough`, `workflow:get-a-needed-service-account-and-pay-for-it`, `workflow:get-a-product-listed-in-the-directories-that-fit-it`, `workflow:get-a-rented-room-ready-after-a-stay`, `workflow:get-a-stalled-agent-moving-again`, `workflow:get-customers-by-mastering-one-way-first`, `workflow:get-emails-out-of-spam-and-keep-them-in-the-inbox`, `workflow:get-found-in-search-and-answer-engines`, `workflow:get-past-a-black-screen-or-a-stuck-loading-screen`, `workflow:get-past-a-wall-called-impossible`, `workflow:get-the-first-hundred-reviews`, `workflow:give-a-row-its-workflows`, `workflow:give-or-end-access-by-hand`, `workflow:give-paid-buyers-access`, `workflow:give-people-a-way-to-find-and-get-it`, `workflow:ground-a-screen-in-real-product-references`, `workflow:grow-a-social-account-with-daily-posts-and-collaborations`, `workflow:grow-a-subscription-program-from-first-order-to-win-back`, `workflow:grow-an-audience-on-x`, `workflow:grow-on-reddit-without-selling-first`, `workflow:grow-one-persons-brand-to-a-million-dollars`, `workflow:grow-the-one-tree`, `workflow:grow-the-sign-up-list-with-a-tested-form`, `workflow:hand-to-an-agent`, `workflow:handle-a-customer-access-case`, `workflow:handle-every-inbox-daily`, `workflow:have-every-decision-maker-on-the-call`, `workflow:hire-a-remote-worker-through-a-paid-trial`, `workflow:hire-by-treating-applicants-like-customers`, `workflow:hire-help-for-a-step`, `workflow:hold-places-in-a-finite-pool`, `workflow:hold-us-to-it`, `workflow:hold-your-ground-in-an-argument-without-fighting`, `workflow:improve-a-signup-flow`, `workflow:improve-an-offer-that-is-not-selling`, `workflow:infinity`, `workflow:join-a-pursuit-with-a-password-only-i-keep`, `workflow:join-anonymous-visits-to-the-conversion-you-own`, `workflow:judge-an-affiliate-program-before-joining`, `workflow:judge-sound-by-measurement`, `workflow:judge-whether-a-product-idea-is-worth-launching`, `workflow:judge-whether-a-pursuit-is-worth-the-persons-time`, `workflow:keep-a-change-under-review-until-it-is-clean`, `workflow:keep-a-changelog-from-what-shipped`, `workflow:keep-a-conversation-going-with-someone-new`, `workflow:keep-a-conversation-lively-with-someone-you-like`, `workflow:keep-a-date-from-going-quiet-or-cancelling`, `workflow:keep-a-link-in-bio-page`, `workflow:keep-a-member-profile`, `workflow:keep-a-product-positioning-record`, `workflow:keep-a-running-owners-own-counters-a-readers-place`, `workflow:keep-a-search-that-found-no-tool`, `workflow:keep-a-short-list`, `workflow:keep-a-task-plan-as-one-editable-record`, `workflow:keep-a-titled-block-of-source-words`, `workflow:keep-anonymous-interaction-counts`, `workflow:keep-booked-calls-close-to-the-booking-day`, `workflow:keep-commercial-events-once`, `workflow:keep-community-events-and-rsvps`, `workflow:keep-community-space-records`, `workflow:keep-conversation-summaries`, `workflow:keep-customer-journeys-and-their-choices`, `workflow:keep-customers-buying-by-fitting-the-repeat-purchase-to-the-product`, `workflow:keep-customers-by-finding-why-they-leave`, `workflow:keep-customers-steps-and-targets`, `workflow:keep-cut-suggestions-for-a-recording`, `workflow:keep-each-accounts-setup-access-request-in-a-book`, `workflow:keep-each-ais-identity-profile`, `workflow:keep-each-payment-where-the-seller-keeps-their-rows`, `workflow:keep-each-task-input-and-list-on-the-one-record-book`, `workflow:keep-each-told-change-in-the-history`, `workflow:keep-each-workshop-task-whole-and-a-small-index`, `workflow:keep-every-pursuit-moving-with-a-board-and-a-weekly-pulse`, `workflow:keep-how-much-each-way-of-matching-is-worth`, `workflow:keep-how-records-are-related`, `workflow:keep-how-someone-does-their-thing`, `workflow:keep-how-tools-are-used`, `workflow:keep-it-working`, `workflow:keep-item-records`, `workflow:keep-media-edits-and-versions`, `workflow:keep-my-calendar-tasks-and-proposals`, `workflow:keep-my-changes-to-the-shipped-defaults`, `workflow:keep-my-private-reactions`, `workflow:keep-my-search-index-beside-a-copy-of-my-results`, `workflow:keep-my-sidebar`, `workflow:keep-new-payments-from-a-seller-account`, `workflow:keep-note-tasks-and-tags`, `workflow:keep-observations-and-their-corrections`, `workflow:keep-one-notice-list-to-a-persons-ais`, `workflow:keep-operation-work-records`, `workflow:keep-pages-cited-by-answer-engines`, `workflow:keep-paid-access-grants`, `workflow:keep-pooled-results`, `workflow:keep-practice-cards-and-grades`, `workflow:keep-records-as-long-as-their-keep-rule-says`, `workflow:keep-reports-once-per-submission`, `workflow:keep-saved-examples`, `workflow:keep-space-descriptors-as-revisions`, `workflow:keep-store-reviews`, `workflow:keep-tasks-handed-between-anyone`, `workflow:keep-that-a-sign-in-or-key-request-arrived`, `workflow:keep-the-history-of-anything`, `workflow:keep-the-owners-receipt`, `workflow:keep-the-persons-snippets`, `workflow:keep-the-tools-i-used`, `workflow:keep-tool-settings`, `workflow:keep-what-a-list-says-true`, `workflow:keep-what-was-learned-usable-by-others`, `workflow:keep-what-you-find-in-lists`, `workflow:keep-when-the-person-was-last-seen`, `workflow:keep-where-the-person-stands-on-a-record`, `workflow:keep-which-notifications-the-person-has-read`, `workflow:keep-who-appeared-in-a-recording`, `workflow:launch-a-first-product-to-a-list-built-first`, `workflow:launch-a-product-with-seeded-creators-and-one-exclusive-offer`, `workflow:lead-me-to-it`, `workflow:learn-the-person`, `workflow:legal-pages-and-support`, `workflow:let-a-member-in-by-an-emailed-code-and-say-what-they-may-open`, `workflow:let-a-person-into-a-pursuit`, `workflow:lift-a-stores-sales-per-visitor-offer-first-then-trust`, `workflow:list-the-people-my-prints-can-name`, `workflow:list-what-my-ais-sent-out`, `workflow:list-your-product-in-every-ai-connector-store`, `workflow:lock-in`, `workflow:make-a-bold-promise-believable-to-a-skeptical-buyer`, `workflow:make-a-brand-book-and-decks`, `workflow:make-a-business-run-without-its-founder`, `workflow:make-a-cover-from-outside-inspiration`, `workflow:make-a-custom-product-from-a-sketch-to-an-approved-sample`, `workflow:make-a-font-from-measured-references`, `workflow:make-a-personalised-explainer-video-on-any-topic-for-a-learner`, `workflow:make-a-piece-in-a-format`, `workflow:make-a-piece-with-a-known-device`, `workflow:make-a-piece-with-a-known-edit-technique`, `workflow:make-a-plain-product-category-feel-premium-and-worth-belonging-to`, `workflow:make-a-service-call-us-and-keep-its-signing-secret`, `workflow:make-a-sound-in-code-and-improve-it-by-listening`, `workflow:make-a-strong-first-impression-when-speaking`, `workflow:make-a-video-export-faster-and-smaller`, `workflow:make-adapt-or-update-a-skill`, `workflow:make-ads-from-winning-reference-ads`, `workflow:make-ads-that-differ-in-who-what-how-and-shape`, `workflow:make-an-ad-with-ai-while-a-person-decides`, `workflow:make-an-ai-tool-last-longer-inside-its-usage-limit`, `workflow:make-an-image-that-does-its-job`, `workflow:make-and-improve-a-skill-by-testing`, `workflow:make-content-in-volume-with-outside-help`, `workflow:make-founder-content-that-is-specific-unique-and-relatable`, `workflow:make-it-easy-to-recognize-and-use`, `workflow:make-it-once-for-everyone`, `workflow:make-it-perform`, `workflow:make-it-work-and-test-it-against-reality`, `workflow:make-media-from-a-stated-generation-recipe`, `workflow:make-one-piece-of-content-from-audience-to-publish`, `workflow:make-short-videos-from-footage`, `workflow:make-static-ads-one-change-at-a-time`, `workflow:make-the-person-understand-a-result`, `workflow:make-the-piece-without-waiting-for-the-person`, `workflow:make-the-pre-call-message-personal`, `workflow:make-the-speech-sound-good`, `workflow:manage-member-billing`, `workflow:map-style-values-onto-existing-design-tokens`, `workflow:map-the-customer-journey-into-a-channel-library`, `workflow:mark-my-notices-read`, `workflow:match-the-ad-format-to-the-buyers-stage`, `workflow:measure-a-sport-technique-from-footage`, `workflow:measure-how-a-codebase-is-growing`, `workflow:measure-the-funnel-and-set-a-baseline`, `workflow:measure-what-a-computer-can-still-take`, `workflow:method-build-a-product`, `workflow:method-build-the-real-thing`, `workflow:method-change-code`, `workflow:method-contact-reality`, `workflow:method-design-a-feature`, `workflow:method-do-it-completely`, `workflow:method-find-the-constraints`, `workflow:method-hold-to-the-hardest-test`, `workflow:method-name-question-delete`, `workflow:method-name-things-by-what-they-do`, `workflow:method-plan-only-what-helps`, `workflow:method-research-plan-build`, `workflow:method-tell-a-story`, `workflow:method-test-a-design-against-every-case`, `workflow:mine-topics-from-short-form-for-long-form`, `workflow:move-a-computers-pinned-code-to-the-newest-released-commit`, `workflow:move-a-dated-plan`, `workflow:move-a-match-from-messages-to-a-first-meeting`, `workflow:move-an-app-onto-an-existing-design-system`, `workflow:move-past-fear-of-speaking-to-strangers-in-small-steps`, `workflow:name-event-inboxes`, `workflow:name-the-recording-behind-transcript-lines`, `workflow:newsletter-for-a-pursuit`, `workflow:onboard-a-new-client-in-the-first-day`, `workflow:onboard-new-buyers-in-five-days`, `workflow:open-a-conversation-with-a-stranger-you-like`, `workflow:open-a-short-video-with-a-loop-and-pay-it-off-slowly`, `workflow:organize-documentation-by-how-the-reader-uses-it`, `workflow:out-launch-a-new-launch`, `workflow:personalized-reach-out`, `workflow:pick-the-next-growth-channel-by-revenue-stage`, `workflow:place-pursuits-on-a-life-map`, `workflow:plan-a-free-tool-that-earns-leads`, `workflow:plan-a-launch-as-a-content-campaign`, `workflow:plan-a-lead-magnet-that-brings-qualified-emails`, `workflow:plan-a-sale-season-as-a-run-of-different-offers`, `workflow:plan-a-sites-structure`, `workflow:plan-a-text-message-program`, `workflow:plan-and-open-a-small-food-or-drink-shop`, `workflow:plan-and-run-a-first-date`, `workflow:plan-run-and-read-paid-ad-campaigns`, `workflow:point-a-domain-at-a-computer`, `workflow:port-without-losing-anything`, `workflow:position-a-product-as-luxury-with-story-and-scarcity`, `workflow:possibility-to-proof`, `workflow:post-a-weekly-build-in-public-update`, `workflow:post-on-social-channels-on-a-schedule`, `workflow:prepare-a-home-for-a-fast-sale`, `workflow:print-and-deliver`, `workflow:prototype-a-product-flow-in-motion`, `workflow:prove-a-backup-restores-on-a-spare-computer`, `workflow:prove-the-launch-on-the-real-url`, `workflow:publish-a-project-as-a-public-repository`, `workflow:publish-articles-and-newsletter-on-a-cadence`, `workflow:put-a-households-money-in-order`, `workflow:put-a-sites-commit-live-on-the-sellers-own-computer`, `workflow:put-it-in-the-world`, `workflow:put-it-where-it-belongs`, `workflow:query-and-change-list-rows`, `workflow:question-the-belief-until-it-holds`, `workflow:quintillion`, `workflow:raise-prices-and-keep-the-customers-worth-keeping`, `workflow:raise-the-bar-the-work-is-held-to`, `workflow:raise-the-price-by-asking-what-would-need-to-be-true`, `workflow:rank-records-for-review`, `workflow:reach-companies-with-a-long-open-job-post`, `workflow:reach-local-businesses-by-zip-code`, `workflow:reach-the-people-it-matters-to`, `workflow:read-a-saved-record-and-show-its-value-the-same`, `workflow:read-a-shops-numbers-and-lift-its-profit`, `workflow:read-a-source-message-work`, `workflow:read-ad-numbers-to-choose-the-fix`, `workflow:read-before-deciding`, `workflow:read-cost-measurements`, `workflow:read-glance-feeds`, `workflow:read-my-device-notices`, `workflow:read-my-notices`, `workflow:read-one-workspace-record-by-its-label-and-save-a-change`, `workflow:read-the-surroundings-around-a-person`, `workflow:read-the-week-and-make-more-of-what-won`, `workflow:read-what-i-pulled-from-an-account`, `workflow:real-life-cases`, `workflow:record-a-polished-walkthrough-video-of-a-real-browser`, `workflow:recover-abandoned-carts-with-instant-answers-and-timed-conversations`, `workflow:recover-failed-payments-and-win-back`, `workflow:recover-people-who-left-a-cart-or-checkout`, `workflow:recover-people-who-looked-at-a-product-and-left`, `workflow:recreate-a-screen-from-a-screenshot`, `workflow:remember-which-tool-was-chosen-for-a-job`, `workflow:remind-a-booker-on-a-timed-ladder`, `workflow:report-a-result-the-reader-can-use`, `workflow:report-how-stable-a-system-is-from-evidence`, `workflow:repurpose-other-peoples-best-content-into-your-own-voice`, `workflow:research-brief-and-study`, `workflow:research-what-everyone-says`, `workflow:retention-and-referral`, `workflow:reverse-engineer-how-something-grows`, `workflow:review-a-change-for-defects`, `workflow:review-a-launch-video-against-its-checks`, `workflow:review-a-screen-before-it-ships`, `workflow:review-an-interface-change`, `workflow:rewrite-a-broad-condition`, `workflow:roast-a-draft-with-your-skeptical-buyer`, `workflow:route-each-row-change`, `workflow:run-a-cold-email-channel`, `workflow:run-a-community`, `workflow:run-a-course-from-list-rows`, `workflow:run-a-creative-learning-loop`, `workflow:run-a-creator-partnership-program`, `workflow:run-a-guest-show-to-reach-target-buyers`, `workflow:run-a-linkedin-content-system`, `workflow:run-a-micro-creator-program-with-briefs-and-usage-rights`, `workflow:run-a-ninety-day-daily-block-of-proof-leads-and-conversations`, `workflow:run-a-sale-weekend-with-a-staged-offer-and-primed-lists`, `workflow:run-a-sales-call-by-a-stated-framework`, `workflow:run-a-sales-pipeline-from-signals-to-booked-calls`, `workflow:run-a-slideshow-page-that-sells-a-small-digital-product`, `workflow:run-a-support-inbox`, `workflow:run-a-text-message-program-that-earns-more-than-it-costs`, `workflow:run-each-command-in-a-shared-space-exactly-once`, `workflow:run-each-command-once`, `workflow:run-events-for-pipeline-not-applause`, `workflow:run-one-drawn-gauntlet-case`, `workflow:run-paid-ads-by-a-stated-method`, `workflow:run-team-led-content`, `workflow:same-abilities-each-device-its-own-look`, `workflow:say-if-it-is-known-new-or-rechecked`, `workflow:scope-an-automation-project-on-an-unfamiliar-platform`, `workflow:score-a-business-on-product-audience-and-sales-channel`, `workflow:score-and-rewrite-copy-against-the-persons-copy-rules`, `workflow:sell-a-paid-working-session-to-a-business`, `workflow:sell-more-to-each-customer-after-the-first-yes`, `workflow:sell-what-the-pursuit-makes`, `workflow:send-a-prospect-a-sample-made-for-them`, `workflow:send-a-video-before-the-call`, `workflow:send-each-new-notice-to-my-devices`, `workflow:send-each-post-at-its-time`, `workflow:send-my-batches-into-my-list`, `workflow:serve-content-ideas-each-morning`, `workflow:set-and-change-the-price-of-a-product`, `workflow:set-aside-a-recurring-hour-to-plan-and-clear-what-gets-skipped`, `workflow:set-up-a-business-on-the-account`, `workflow:set-up-a-checked-repository`, `workflow:set-up-a-first-online-shop-from-an-idea-to-launch-day`, `workflow:set-up-a-recurring-task-that-is-safe-to-repeat`, `workflow:set-up-a-standing-agent-loop`, `workflow:set-up-an-ai-assistant-project-that-remembers-its-work`, `workflow:set-up-brand-and-branded-emails`, `workflow:set-up-business-accounts-and-connections`, `workflow:set-up-lead-handling-from-first-touch-to-customer`, `workflow:set-up-your-checks`, `workflow:set-your-own-terms-before-selling-a-business`, `workflow:setup-with-your-ai`, `workflow:sharpen-the-words-of-a-domain-and-record-hard-decisions`, `workflow:ship-the-whole-branch-to-live`, `workflow:show-every-file-i-used-newest-first`, `workflow:show-every-state-of-a-component`, `workflow:show-interest-and-build-attraction`, `workflow:show-the-real-work-of-building-a-business-on-camera`, `workflow:sign-a-first-paying-client-for-an-automation-build`, `workflow:simulate-a-choice-forward`, `workflow:sort-every-task-by-whether-someone-else-can-take-it`, `workflow:source-a-screen-from-design-libraries`, `workflow:speed-up-ci-for-agent-speed-changes`, `workflow:split-a-job-between-a-lead-agent-and-helper-agents`, `workflow:split-a-list-into-groups-that-are-worth-sending-to`, `workflow:split-a-mixed-store-into-each-owners-data`, `workflow:split-what-must-be-certain-from-what-an-ai-may-reason`, `workflow:start-from-the-persons-own-work`, `workflow:start-reselling-goods-for-more-than-they-cost`, `workflow:start-selling-a-private-label-product-on-a-big-marketplace`, `workflow:start-selling-bought-goods-on-an-online-marketplace`, `workflow:stop-programs-left-running`, `workflow:storyboard-a-launch-video`, `workflow:stress-test-one-component-under-every-scenario-that-can-reach-it`, `workflow:take-a-person-out-of-a-pursuit`, `workflow:take-apart-a-winning-ad-before-copying-it`, `workflow:take-payments-with-stripe`, `workflow:take-refundable-deposits-for-a-free-event`, `workflow:teach-a-job-by-writing-showing-and-watching`, `workflow:teach-a-store-assistant-to-answer-for-the-store`, `workflow:tell-a-brand-story-as-origin-hero-and-promise`, `workflow:tell-me-when-something-changes`, `workflow:tell-the-owner-what-changed-for-each-person`, `workflow:tell-the-person`, `workflow:tell-the-person-what-waits`, `workflow:tell-when-a-wake-stops`, `workflow:test-a-business-model-one-belief-at-a-time`, `workflow:test-a-finding`, `workflow:test-an-app-end-to-end-and-fix-what-breaks`, `workflow:test-new-ads-apart-from-proven-ones`, `workflow:test-prices-and-change-a-page-for-each-visitor`, `workflow:total-a-list-or-view`, `workflow:trace-to-first-principles`, `workflow:track-show-rate-and-find-the-weak-stage`, `workflow:train-a-sales-team-with-a-script-and-daily-practice`, `workflow:treat-things-that-arrive-together-as-one-job`, `workflow:turn-a-code-change-into-a-review-report`, `workflow:turn-a-correction-into-workflows`, `workflow:turn-a-reference-video-into-a-rebuild-prompt`, `workflow:turn-a-set-of-ui-references-into-separate-original-builds`, `workflow:turn-a-source-into-steps`, `workflow:turn-a-web-page-into-reusable-interaction-prompts`, `workflow:turn-around-a-cold-reply-from-someone-you-spoke-to`, `workflow:turn-nerves-into-calm-confidence`, `workflow:turn-notes-into-finished-content`, `workflow:turn-one-long-recording-into-many-pieces`, `workflow:turn-research-into-a-plan`, `workflow:turn-sales-calls-into-ad-creative`, `workflow:turn-something-shared-into-what-you-can-use`, `workflow:turn-sources-into-every-useful-form`, `workflow:turn-what-you-said-into-content`, `workflow:understand-a-person-one-lens-at-a-time`, `workflow:understand-where-a-pursuit-is-starting-from`, `workflow:use-ai-to-write-and-design-emails-with-the-brands-context`, `workflow:validate-a-niche-with-free-ad-search-and-traffic-data`, `workflow:validate-and-launch-a-subscription-app`, `workflow:validate-with-a-test-store-then-build-a-brand-around-what-sells`, `workflow:walk-a-pursuit-through-your-map`, `workflow:weigh-a-marketing-decision-through-conflicting-expert-lenses`, `workflow:welcome-new-subscribers-with-a-short-series`, `workflow:win-a-first-client-as-a-new-designer`, `workflow:win-raving-fans-by-one-to-one-outreach`, `workflow:win-regular-local-customers-without-relying-on-social-posts`, `workflow:work-backward-from-a-ten-million-valuation`, `workflow:work-backwards-from-available-names`, `workflow:work-out-what-owning-a-small-business-really-pays-the-owner`, `workflow:work-out-what-to-save-each-month-to-reach-a-target-sum`, `workflow:work-out-which-marketing-caused-the-revenue`, `workflow:work-through-a-framework`, `workflow:work-with-micro-influencers-by-gifting-for-posts`, `workflow:write-a-cold-message-in-four-parts`, `workflow:write-a-dating-profile-that-starts-conversations`, `workflow:write-a-design-first-prompt-for-generating-a-screen`, `workflow:write-a-founder-ad`, `workflow:write-a-native-story-ad`, `workflow:write-a-problem-first-proposal-during-the-sales-call`, `workflow:write-a-research-prompt-without-the-answer-in-it`, `workflow:write-a-twelve-month-marketing-plan-by-funnel-stage`, `workflow:write-an-ad-script-with-a-villain-and-a-hero`, `workflow:write-and-iterate-ad-copy-from-real-customer-words`, `workflow:write-one-components-documentation-from-its-sources`, `workflow:write-product-words`, `workflow:write-short-email-copy-and-subject-lines-that-sell`, `workflow:x-mode` |
| `write-a-job-done-in-several-steps-have` | `tool:run-workflow-definition` |
| `write-a-post-for-each-place` | `tool:write-a-post-for-a-place` |
| `write-from-a-recipe` | `tool:check-writing-against-its-recipe`, `tool:check-writing-file`, `tool:compose-a-writing-instruction`, `tool:list-writing-recipes` |
| `write-message-models-for-every-app` | `tool:write-message-models-for-every-app` |
| `write-public-share-files` | `tool:write-public-share-files` |
<!-- tool-catalogue:end -->

## Key Types / Functions

| Type | Shape | Role |
|---|---|---|
| `tool-rows.json` | `{ "records": [{ "payload": <row> }] }` | The rows Trillion reads from a tool folder. |
| Tool row | `{ "kind": "ai-tool-descriptor", "id": "tool:<name>", "label", "job", "description", "input_schema", "output_schema", "invoke", "result_selector", "licence_class", "placements", "verify" }` | One tool: the job it is found by, what it takes and gives back, how it runs, where it may run, and a sample run that proves it works. |
| `invoke` (container) | `{ "kind": "container", "files": { "package_files": { "package": "<folder>", "paths": ["do-work"], "at": "/opt/<folder>" } }, "workdir", "argv": ["node", "do-work/<file>.mjs"], "stdin": { "fill": { "from": "input" } }, "stdout": "json" }` | Trillion packs the named files from this folder, runs `argv` in a sealed container with the input on standard input, and reads the last JSON line printed. |
| Row source | `{ "kind": "tool-row-source", "id": "source:<name>", "list": { "records": { "package": "<folder>", "kind": "ai-tool-descriptor" } } }` | Lists the rows kept in a folder's `records.json` instead of `tool-rows.json`. |
| `verify` | `[{ "kind": "sample-run", "input": {...}, "output_selector": "$.x", "contains": "..." }]` | Trillion runs the sample before offering the tool and refuses it when the output does not contain the expected text. |
| `admit-attachments-to-a-message` | Decides how many of the files sent with a message are accepted (per-turn cap, daily quota, size ceiling) and says which limit stopped the rest | `tool:admit-attachments-to-a-message` |
| `compare-two-ai-builds-on-trap-tasks` | Scores two builds of an AI's behaviour on the same trap tasks from the calls each run recorded, and says where they differ | `tool:compare-two-ai-builds-on-trap-tasks` |
| `take-pictures-out-of-a-zip-archive` | Takes the pictures (or a profile's files) out of a zip archive as titled bytes, bounded, never writing an entry by its name | `tool:take-pictures-out-of-a-zip-archive` |
| `show-what-a-tool-would-give-members` | Tells a space owner, before adding a tool for members, what it would give each member beyond their grants, what it reaches or could cost, and whether they must decide it | `tool:show-what-a-tool-would-give-members` |
| `describe-connected-accounts` | Says for each connected account which is primary, what its sign-in allowed, what is copied, what stays live and what Trillion may do | `tool:describe-connected-accounts` |
| `suggest-connections-from-links` | Names the services links in some words point at that are not connected yet, to offer connecting them | `tool:suggest-connections-from-links` |
| `find-pictures-by-colour-and-likeness` | Finds pictures by a typed or named colour (CIE-LAB) or like one picture (embedding, else palette) | `tool:find-pictures-by-colour-and-likeness` |

## Folder layout

```
trillion-workshop/
├── tools/
│   ├── unit-economics/
│   │   ├── do-work/work-out-unit-economics.mjs   the command the container runs
│   │   ├── read-data/                             pure functions it uses
│   │   ├── records.json                           its row (listed by tool-rows.json)
│   │   ├── tool-rows.json                         what Trillion reads
│   │   ├── part.json                              which files other code may import
│   │   └── README.md
│   ├── …one folder per tool
│   └── tools-from-github/                         repositories that run on the person's computer
├── licence-classes.json
└── test/every-tool-row.test.mjs
```

## The records a tool keeps

A tool row may hold `record_model`: the record kinds, indexes and links that tool keeps, in the shape of a record
model (`kinds`, `indexes`, `value_kinds`, `declared_by`, `field_kinds`, `links`, `relations`, `activities`). Trillion
reads the rows of the tools installed for a person and joins every tool's `record_model` into the one model their
records are kept by: a list one tool after another, an object by its keys. The engine itself names no kind but the
few it writes itself. Two tools may not declare one kind, one index or one key (`test/every-record-model.test.mjs`).

A kind row is `{ type, properties?, guard_properties?, parts?, erasable?, erasable_key?, erase_with?, erase_fields?,
stays_on_this_device?, table? }`: `erasable` fields are sealed under a key of the record's own, so erasing the record
erases their words; `stays_on_this_device: true` keeps every record of the kind off any road that leaves the
person's computer. An index row is `{ type, name, paths, where?, carry?, backfill? }`.
Each kind is declared by the tool whose job keeps it. A section the engine reads by name is declared by one tool:
`rules_and_runs` (the kinds its rules and workflow runs read and write) and `live_heads` (the record its live screen
heads read).

## Add a tool

1. Make `tools/<your-tool>/` with a command in `do-work/` that reads one JSON request on standard input and prints one JSON answer as its last line (`{"result": ...}`). It may not reach the internet unless its row says `"internet": true`.
2. Add `tools/<your-tool>/tool-rows.json` with one row per tool. Copy a row from `tools/move-records-through-declared-states/tool-rows.json` and change the `id`, `job` (plain words a person would use), `description`, schemas, `invoke` paths and the `verify` sample.
3. Add tests in `tools/<your-tool>/test/` and a `README.md`.
4. Run `npm test`. It checks your rows the way Trillion reads them.
5. Open a pull request.

See `CONTRIBUTING.md` for the rules a tool must follow.

## Dependencies

**Depends on:** Node 22.6 or later (type stripping for `.ts`), Python 3 for the Python tools, `@noble/hashes` (BLAKE3 identities; `npm install`).

**Depended on by:** Trillion, which installs this repository and reads every `tools/*/tool-rows.json` when it deploys.

## Licence

Apache License 2.0. See `LICENSE`.
