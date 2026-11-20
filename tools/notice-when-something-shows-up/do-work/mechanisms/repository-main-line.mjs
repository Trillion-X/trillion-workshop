#!/usr/bin/env node
/**
 * tools/notice-when-something-shows-up/do-work/mechanisms/repository-main-line.mjs
 *
 * Purpose
 *   One waiting mechanism: wait for a repository's main line to move, and say what
 *   the move did to the code in flattened words a formula can test. Any repository on
 *   a host whose compare API answers (GitHub today), with the repository, the branch,
 *   the park folder names and the thresholds all DATA in the waiter row.
 *
 * Non-negotiable invariants
 *   - It names no repository, no tool and no workflow. The row says which repository and
 *     branch; the kinds a workflow reads come from the row's thresholds, not from code.
 *   - Cost is DATA. A move becomes a fact only when a kind holds (a park folder took
 *     code in or out, or enough lines or files were removed). A move with no kind holding
 *     is read, its head kept, and told to nobody, so no AI run wakes for a small edit.
 *   - One fact per read covers the whole range from the last head kept to the new head.
 *     Its event key is the new head, so telling it again after a restart is one fact.
 *   - The kept state is one head commit id. A refused tell leaves the head where it was,
 *     so the same range is told again. A range that no longer exists (a force push) is
 *     not told; the head is reset to the new main line and the reset is reported as detail.
 *   - It holds no credential: the repository is public and the compare API is read
 *     without one. A private repository would name a credential descriptor, not a secret.
 *
 * Settings (mechanism_settings)
 *   repository              "owner/name", or the repository's https address (required)
 *   where                   the name the fact is told under, no secret (default: repository)
 *   api_base                the host's API root (default https://api.github.com)
 *   branch                  the main line (default "main")
 *   park_folders            folder names that mark code parked for a later home, glob-like with a
 *                           leading or trailing `*` (default ["from-*"]). A removed file under one
 *                           of them counts as parked; a renamed file into one counts as parked too.
 *   removed_lines_at_least  removed lines (deletions of removed files plus deletions of changed files) that
 *                           make a removal worth a kind (default 40)
 *   removed_files_at_least  removed files that make a removal worth a kind (default 2)
 *   park_at_least           parked files that make a park worth a kind (default 1)
 *   look_again_seconds      how long between reads (default 300)
 *
 * Kinds (the fact's `kinds`, JSON text, only when a kind holds)
 *   "old-code-parked"   a park folder took code in (renamed into it) or lost code under it (removed under it)
 *   "old-code-removed"  lines or files were removed past the thresholds above
 *
 * Fact fields (detail): where, place ("main"), change ("moved"), at (the head's commit time),
 *   key (the new head commit id), before (JSON {"base": "<kept head>"}), after (JSON with the counts and
 *   the old -> new paths, cut to fit one field and marked `cut` when it was), kinds.
 *
 * Limits
 *   The compare API lists at most 300 files and 250 commits. A read past that is told with
 *   `truncated: true`; its counts are then lower bounds and the kinds still hold.
 */
export const MECHANISM_REF = "package::notice-when-something-shows-up::mechanism::repository-main-line";
export const FIELD_BYTES = 1000;
const FILES_PER_COMPARE = 300;

export function describeMechanism() {
  return {
    mechanism_ref: MECHANISM_REF,
    detail_fields: ["where", "place", "change", "at", "key", "before", "after", "kinds"],
    conditions: ["became-reachable"],
  };
}

const whole = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : fallback);

export function readSettings(settings = {}) {
  const repository = typeof settings.repository === "string" ? settings.repository.trim().replace(/^https:\/\/[^/]+\//, "").replace(/\.git$/, "") : "";
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error("repository must be owner/name");
  return {
    repository,
    where: typeof settings.where === "string" && settings.where.trim() ? settings.where.trim() : repository,
    api_base: typeof settings.api_base === "string" && settings.api_base ? settings.api_base.replace(/\/+$/, "") : "https://api.github.com",
    branch: typeof settings.branch === "string" && settings.branch ? settings.branch : "main",
    park_folders: Array.isArray(settings.park_folders) ? settings.park_folders.map(String) : ["from-*"],
    removed_lines_at_least: whole(settings.removed_lines_at_least, 40),
    removed_files_at_least: whole(settings.removed_files_at_least, 2),
    park_at_least: whole(settings.park_at_least, 1),
    look_again_ms: (Number(settings.look_again_seconds) > 0 ? Number(settings.look_again_seconds) : 300) * 1000,
    replay: settings.replay && typeof settings.replay.from === "string" && typeof settings.replay.to === "string" ? { from: settings.replay.from, to: settings.replay.to } : null,
  };
}

/** Whether one path segment matches a park folder glob (`from-*`, `*-old`, or exact). */
export function isParkSegment(segment, patterns) {
  return patterns.some((pattern) => {
    if (pattern.startsWith("*") && pattern.endsWith("*")) return segment.includes(pattern.slice(1, -1));
    if (pattern.endsWith("*")) return segment.startsWith(pattern.slice(0, -1));
    if (pattern.startsWith("*")) return segment.endsWith(pattern.slice(1));
    return segment === pattern;
  });
}

/** Whether a path has a park folder anywhere above its file name. */
export function underPark(path, patterns) {
  const folders = String(path).split("/").slice(0, -1);
  return folders.some((segment) => isParkSegment(segment, patterns));
}

/** Text of at most FIELD_BYTES bytes, with `cut: true` when it had to be shortened. */
export function fitField(value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) <= FIELD_BYTES) return { text, cut: false };
  let list = [...(value.moves ?? [])];
  let removed = [...(value.removed ?? [])];
  for (;;) {
    const candidate = { ...value, moves: list, removed, cut: true };
    const next = JSON.stringify(candidate);
    if (Buffer.byteLength(next) <= FIELD_BYTES) return { text: next, cut: true };
    if (removed.length) removed = removed.slice(0, -1);
    else if (list.length) list = list.slice(0, -1);
    else return { text: JSON.stringify({ counts: value.counts, cut: true }).slice(0, FIELD_BYTES), cut: true };
  }
}

/** Read a compare answer into the flattened counts, paths and kinds. Pure: no network. */
export function summarize(compare, own) {
  const files = Array.isArray(compare.files) ? compare.files : [];
  const counts = { files: files.length, removed_files: 0, renamed_files: 0, added_files: 0, modified_files: 0, removed_lines: 0, parked_files: 0, commits: whole(compare.total_commits, 0) };
  const moves = [];
  const removed = [];
  for (const file of files) {
    const status = file.status;
    const deletions = whole(file.deletions, 0);
    if (status === "removed") {
      counts.removed_files += 1;
      counts.removed_lines += deletions;
      removed.push(file.filename);
      if (underPark(file.filename, own.park_folders)) counts.parked_files += 1;
    } else if (status === "renamed") {
      counts.renamed_files += 1;
      counts.removed_lines += deletions;
      moves.push({ old: file.previous_filename, new: file.filename });
      if (underPark(file.filename, own.park_folders)) counts.parked_files += 1;
    } else if (status === "added") counts.added_files += 1;
    else if (status === "modified" || status === "changed") {
      counts.modified_files += 1;
      counts.removed_lines += deletions;
    }
  }
  const truncated = files.length >= FILES_PER_COMPARE;
  const kinds = [];
  if (counts.parked_files >= own.park_at_least) kinds.push("old-code-parked");
  if (counts.removed_lines >= own.removed_lines_at_least || counts.removed_files >= own.removed_files_at_least) kinds.push("old-code-removed");
  return { counts: { ...counts, truncated }, moves, removed, kinds };
}

async function readJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { accept: "application/vnd.github+json", "user-agent": "notice-when-something-shows-up" } });
  if (!response.ok) {
    const error = new Error(`${url} answered ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/** Watch the main line: read the head, then each move since the kept head, and tell each move that holds a kind.
 *  Handlers: onTransition, signal, state ({head}), keepState, and for tests: fetch, now. */
/** Tell one move (base to head, from the compare answer) when a kind holds; the same transition the live read tells. */
async function tellMove(own, handlers, base, head, answer, one) {
  const fitted = fitField({ counts: one.counts, moves: one.moves, removed: one.removed.slice(0, 50) });
  const commit = answer.commits?.at(-1) ?? null;
  return handlers.onTransition({
    condition: "became-reachable",
    observed_identity: { where: own.where, place: own.branch },
    event_key: `${own.where}:${own.branch}:${head}`,
    state: { head },
    detail: {
      where: own.where,
      place: own.branch,
      change: "moved",
      at: commit?.commit?.committer?.date ?? new Date(handlers.now?.() ?? Date.now()).toISOString(),
      key: head,
      before: JSON.stringify({ base }),
      after: fitted.text,
      kinds: JSON.stringify(one.kinds),
    },
  });
}

/** A replay (the row's `replay: {from, to}`): read the one move from one commit to another, tell it when a kind holds,
 *  and return. Its fact is keyed by the `to` commit, so a restart tells the same fact again and the engine admits it once. */
async function replayOnce(own, handlers, fetchImpl) {
  const { from, to } = own.replay;
  const answer = await readJson(`${own.api_base}/repos/${own.repository}/compare/${from}...${to}`, fetchImpl);
  const one = summarize(answer, own);
  if (one.kinds.length) await tellMove(own, handlers, from, to, answer, one);
}

export async function watchForTransitions(settings, handlers) {
  const own = readSettings(settings);
  const signal = handlers.signal;
  const keepState = handlers.keepState ?? (async () => {});
  const fetchImpl = handlers.fetch ?? fetch;
  if (own.replay) return replayOnce(own, handlers, fetchImpl);
  const headUrl = `${own.api_base}/repos/${own.repository}/commits/${encodeURIComponent(own.branch)}`;
  let state = handlers.state?.head ? handlers.state : null;
  try {
    while (!signal?.aborted) {
      const head = (await readJson(headUrl, fetchImpl)).sha;
      if (state === null) {
        state = { head };
        await keepState(state);
      } else if (head !== state.head) {
        const base = state.head;
        const compareUrl = `${own.api_base}/repos/${own.repository}/compare/${base}...${head}`;
        let answer = null;
        try {
          answer = await readJson(compareUrl, fetchImpl);
        } catch (error) {
          if (error.status !== 404 && error.status !== 422) throw error;
        }
        if (answer === null) {
          state = { head };
          await keepState(state);
        } else {
          const one = summarize(answer, own);
          if (one.kinds.length) {
            const told = await tellMove(own, handlers, base, head, answer, one);
            if (told !== false) {
              state = { head };
              await keepState(state);
            }
          } else {
            state = { head };
            await keepState(state);
          }
        }
      }
      if (signal?.aborted) return;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, own.look_again_ms);
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  } finally {
    if (state) await keepState(state).catch(() => {});
  }
}
