# tools/keep-the-shared-checkout-current/

Keeps one shared Workshop checkout on this computer at `origin/main`, every five minutes, without losing anyone's work. Landings commit through a private index, so the shared worktree falls behind within minutes; this pass brings it up without a person running `git reset` by hand.

## What one pass does

It refuses and touches nothing when the checkout is not on branch `main`, when `.git/index.lock` exists, when a merge, rebase, cherry-pick or revert is in progress, or when `git fetch origin` fails.

Otherwise, in order:

1. **Rescue.** If anything is uncommitted, untracked, or any commit is not on `origin/main`, the whole working state is saved as a local commit on `refs/rescue/workshop-shared-<YYYYMMDD-HHMMSS>`. The commit is built from a copy of the real index plus every working file (ignored files skipped), so it is never pushed. A clean checkout with no local commits makes no ref.
2. **Classify.** Every path changed between HEAD and origin, every dirty path, and every path a skipped pass left behind is compared by blob id against HEAD, origin, and the bytes on disk:
   - bytes already equal to origin: nothing to do;
   - clean (bytes equal HEAD) and edited in the last 120 seconds: skipped this pass, and remembered in `.git/keep-the-shared-checkout-current.json`;
   - clean and origin has a version: updated from origin;
   - clean and origin deleted it: moved to `~/.Trash/keep-the-shared-checkout-current-<time>/`;
   - anything else (someone's edit, an untracked file, a local deletion): kept, with the reason.
3. **Move.** HEAD and the index go to `origin/main` with `git reset --mixed`. The working tree is not touched by this step. HEAD is re-read just before it; if it moved, the pass stops and the next one retries.
4. **Write.** Clean paths take origin's bytes with `git checkout origin/main -- <path>`, only if the bytes still match what step 2 saw.
5. **Trash.** Clean paths origin deleted are renamed into the Trash folder. Nothing is deleted. A file that cannot be moved stays where it is and is reported.

It never runs `git reset --hard`, `git clean`, `git push`, `git gc`, or `rm`.

## Output

One JSON line on stdout: `outcome` (`ran`, `refused`, `stopped`, or `error`), `why`, `behind_before`, `behind_after`, `head_before`, `head_after`, `origin`, `local_commits`, `rescue_ref`, `updated`, `trashed`, `kept` and `skipped` (each with `why`).

## Files

| File | Purpose |
|------|---------|
| `do-work/keep-the-shared-checkout-current.mjs` | `keepCurrent(root, { trashRoot, now, beforeReset })` and its command line `--root <checkout>`. |
| `test/keep-the-shared-checkout-current.test.mjs` | Temporary repositories (a bare origin, a publisher, the shared checkout): a dirty overlap kept, an untracked clash kept with origin's version not written, an origin delete of a dirty file kept, an origin delete of a clean file moved to the Trash, HEAD moving mid-pass stops it, unpushed commits saved and reported, a recently edited file skipped and then written by the next pass, and `index.lock` a no-op. |
| `tool-rows.json` | `tool:keep-the-shared-checkout-current`, a `computer` run with `change-a-folder` and `start-a-program`, and its wake `every-five-minutes` (every 5 minutes, UTC). |
| `part.json` | The pass is public. |

## Run the tests

```
env -u GIT_INDEX_FILE node --test tools/keep-the-shared-checkout-current/test/keep-the-shared-checkout-current.test.mjs
```

## Why

The shared checkout falls 10 to 130 commits behind within minutes of landings, and lanes cannot test against origin until it is current. A hand-run reset brought it current on 2026-11-20 at 12:21 and 12:26 AM CST, without losing work, but that needs a person each time. This pass is the same procedure run by the engine on the Mac that holds the checkout.
