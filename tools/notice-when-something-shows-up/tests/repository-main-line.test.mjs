// Tests for the repository main-line leaf: the flattened kinds on each move, the cost thresholds, and the watch loop
// over a stand-in compare API (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSettings, summarize, fitField, underPark, watchForTransitions } from "../do-work/mechanisms/repository-main-line.mjs";

const own = readSettings({ repository: "example-owner/example-repo" });
const file = (filename, status, deletions = 0, previous) => ({ filename, status, deletions, ...(previous ? { previous_filename: previous } : {}) });

test("a rename that keeps everything has no kind and is told to nobody", () => {
  const one = summarize({ files: [file("tools/a/new-name.mjs", "renamed", 0, "tools/a/old-name.mjs")], total_commits: 1 }, own);
  assert.deepEqual(one.kinds, []);
  assert.equal(one.counts.renamed_files, 1);
});

test("a delete with no new home is old-code-removed once the thresholds hold", () => {
  const one = summarize({ files: [file("tools/x/a.mjs", "removed", 30), file("tools/x/b.mjs", "removed", 25)], total_commits: 1 }, own);
  assert.deepEqual(one.kinds, ["old-code-removed"]);
  assert.equal(one.counts.removed_lines, 55);
});

test("one small removed file is not enough to wake a run", () => {
  const one = summarize({ files: [file("tools/x/a.mjs", "removed", 5)], total_commits: 1 }, own);
  assert.deepEqual(one.kinds, []);
});

test("a move across repositories (removed under a park folder) is old-code-parked and removed", () => {
  const one = summarize({ files: [file("tools/x/from-bitfield-packages/a.mjs", "removed", 12), file("tools/x/from-bitfield-packages/b.mjs", "removed", 9)], total_commits: 1 }, own);
  assert.deepEqual(one.kinds, ["old-code-parked", "old-code-removed"]);
  assert.equal(one.counts.parked_files, 2);
});

test("a folder park (renamed into from-*) is old-code-parked and the paths are kept", () => {
  const one = summarize({ files: [file("tools/from-an-older-version/tool.mjs", "renamed", 0, "tools/tool.mjs")], total_commits: 1 }, own);
  assert.deepEqual(one.kinds, ["old-code-parked"]);
  assert.deepEqual(one.moves, [{ old: "tools/tool.mjs", new: "tools/from-an-older-version/tool.mjs" }]);
});

test("a partial-file removal (a few lines out of a kept file) is not told", () => {
  const one = summarize({ files: [file("tools/x/keep.mjs", "modified", 3)], total_commits: 1 }, own);
  assert.deepEqual(one.kinds, []);
});

test("a commit with nothing removed must not fire", () => {
  const one = summarize({ files: [file("tools/x/new.mjs", "added"), file("tools/x/keep.mjs", "modified", 0)], total_commits: 1 }, own);
  assert.deepEqual(one.kinds, []);
});

test("a read at the compare limit is marked truncated", () => {
  const files = Array.from({ length: 300 }, (_, i) => file(`tools/x/${i}.mjs`, "added"));
  assert.equal(summarize({ files, total_commits: 250 }, own).counts.truncated, true);
});

test("a long move list is cut to one fact field and marked", () => {
  const removed = Array.from({ length: 60 }, (_, i) => `tools/from-old/${"x".repeat(40)}-${i}.mjs`);
  const fitted = fitField({ counts: {}, moves: [], removed });
  assert.equal(fitted.cut, true);
  assert.ok(Buffer.byteLength(fitted.text) <= 1000);
});

test("only folders above the file name count as park folders", () => {
  assert.equal(underPark("tools/from-x/a.mjs", ["from-*"]), true);
  assert.equal(underPark("tools/from-x.mjs", ["from-*"]), false);
});

test("the watch loop keeps the first head, tells a move that holds a kind once, and moves its head after the tell", async () => {
  const compares = [{ files: [file("tools/from-old/a.mjs", "removed", 80)], total_commits: 1, commits: [{ commit: { committer: { date: "2026-11-19T03:05:25Z" } } }] }];
  const heads = ["h1", "h2", "h2", "h2"];
  const told = [];
  const kept = [];
  const controller = new AbortController();
  const fetch = async (url) => {
    if (url.includes("/compare/")) return { ok: true, status: 200, json: async () => compares.shift() };
    const sha = heads.shift() ?? "h2";
    if (heads.length === 0) setTimeout(() => controller.abort(), 20);
    return { ok: true, status: 200, json: async () => ({ sha }) };
  };
  await watchForTransitions({ repository: "example-owner/example-repo", look_again_seconds: 0.001 }, {
    signal: controller.signal,
    fetch,
    keepState: async (state) => kept.push(state),
    onTransition: async (transition) => { told.push(transition); return true; },
  });
  assert.equal(told.length, 1);
  assert.equal(told[0].detail.key, "h2");
  assert.equal(told[0].detail.change, "moved");
  assert.deepEqual(JSON.parse(told[0].detail.kinds), ["old-code-parked", "old-code-removed"]);
  assert.equal(kept[0].head, "h1");
  assert.equal(kept.at(-1).head, "h2");
});

test("a refused tell keeps the head where it was, so the same move is told again", async () => {
  const kept = [];
  const controller = new AbortController();
  let heads = 0;
  const fetch = async (url) => {
    if (url.includes("/compare/")) return { ok: true, status: 200, json: async () => ({ files: [file("tools/from-old/a.mjs", "removed", 80)], total_commits: 1 }) };
    heads += 1;
    if (heads >= 3) controller.abort();
    return { ok: true, status: 200, json: async () => ({ sha: heads === 1 ? "h1" : "h2" }) };
  };
  await watchForTransitions({ repository: "example-owner/example-repo", look_again_seconds: 0.001 }, {
    signal: controller.signal,
    fetch,
    state: { head: "h1" },
    keepState: async (state) => kept.push(state),
    onTransition: async () => false,
  });
  assert.equal(kept.every((state) => state.head === "h1"), true);
});

test("a replay tells one move between two commits once, keyed by the to commit, and returns", async () => {
  const told = [];
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => ({ files: [file("tools/from-old/a.mjs", "removed", 80)], total_commits: 1, commits: [{ commit: { committer: { date: "2026-11-19T03:05:25Z" } } }] }) };
  };
  await watchForTransitions({ repository: "example-owner/example-repo", replay: { from: "c0", to: "c1" } }, {
    fetch,
    onTransition: async (transition) => { told.push(transition); return true; },
  });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /compare\/c0\.\.\.c1$/);
  assert.equal(told.length, 1);
  assert.equal(told[0].event_key, "example-owner/example-repo:main:c1");
  assert.equal(told[0].detail.key, "c1");
  assert.deepEqual(JSON.parse(told[0].detail.kinds), ["old-code-parked", "old-code-removed"]);
});

test("a replay of a commit with nothing removed tells nothing", async () => {
  const told = [];
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ files: [file("tools/x/new.mjs", "added")], total_commits: 1 }) });
  await watchForTransitions({ repository: "example-owner/example-repo", replay: { from: "c0", to: "c1" } }, {
    fetch,
    onTransition: async (transition) => { told.push(transition); return true; },
  });
  assert.equal(told.length, 0);
});
