# tools/turn-a-finished-decision-into-an-anonymous-public/

Turn a finished decision into an anonymous public story of what was weighed, what was chosen and how it turned out, and keep or take it down.

This folder has no row yet and nothing here is wired: no tool row, kit, route, screen or publish call. Publishing a story to the public is live, so wiring waits for the owner's word.

The old Worker files that were held here (`from-an-older-version/`) were moved out of the Workshop in commit 332230b33 and kept in the parked repository, not here. The ports below are the current owner's code, written from those bytes; `moved-from.json` still names the old paths.

## Files

| File | Purpose |
|------|---------|
| `read-data/story-settings.json` | DATA: the kinds (one marked fallback), the privacy lists (not-identifying words, legal-entity words, places, the checking model's context), the rewrite limits (`max_tokens`, `check_max_tokens`, `rounds`, `facts_limit_characters`), the page size and freshness, the page words, and the two prompts (writer, checker). Operator-only fields are not here: the never-publish list, the operator's held kinds and the canonical origin are the caller's. |
| `read-data/story-facts.mjs` | Pure: `isFinished`, `latestResult`, `storyFacts` (the decision's facts, retracted evidence dropped, the length cap), `kindOf` (unlisted kind to fallback), `mintStoryId` and `isStoryId` (20 hex characters from BLAKE3 of fresh random bytes). |
| `read-data/write-a-story.mjs` | `privateRewrite` (redact, one writer, plain pass, second-model check, up to `rounds` tries) and `writeStory` (the story shape, held kinds, the held-kind refusal sentence, which the caller passes as `words`). The model call is the caller's `ask(model, system, user, maxTokens)`; the model ids are the caller's `models`. The plain pass is `tools/learn-from-everyones-results/read-data/plain-privacy-pass.mjs`, not a copy. |
| `read-data/story-shelf.mjs` | Pure: `shelfOf` and `shelfPage` (newest first, keyset cursor, kind filter), `storyCounts` (every kind, fallback for unlisted), `takeDown` (withdrawn, never listed again). |
| `read-data/story-publication.mjs` | Pure: `storiesOn` (the owner's choice or the default row, from `tools/choose-whether-my-decisions-are-shared-show`), `basisOf`, `storyStep` (`write`, `unchanged`, `withdrawn` or `skip`). |
| `test/*.test.mjs` | Tests for the five modules above, with a fake model adapter and example.com fixtures. |

## Tests

Run from the Workshop root: `env -u GIT_INDEX_FILE node --test tools/turn-a-finished-decision-into-an-anonymous-public/test/*.test.mjs`.

## Not here

- The publish and take-down calls to the pool (`tools/publish-an-approved-insight` owns the insight path; its id minting is injected and could use `mintStoryId`).
- The share entry that `tools/decide-with-a-method` (`shareADecision`) keeps and sends through `tools/learn-from-everyones-results`. It covers the redaction and the second-model verdict for the five-field entry; it does not write a story.
- The worked-answer sentences for `thinking`: the caller passes them in.
- `tools/workspace-screens/web/src/story-pages.mjs` imports `./story-settings.json`, which is in no owner's tree. This folder holds the DATA now; pointing that import here is a change for the owner's word.
