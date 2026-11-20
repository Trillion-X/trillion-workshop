// packages/local-files/read-data/names-and-content-identities-from-a-folder-tree.test.mjs
//
// Each case names the failure it prevents, and three of them are failures this corpus already
// suffered rather than hypotheticals: a permission-denied directory on a real camera card, a
// 54 GB single file in the measured Expansion corpus, and a resumed publish that must address the
// same row it stopped on.

import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  contentIdentityOfOneFile,
  namesAndContentIdentitiesFromAFolderTree,
} from "./names-and-content-identities-from-a-folder-tree.mjs";

function treeWith(files) {
  const root = tempFolder(path.join(tmpdir(), "folder-tree-"));
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return root;
}

const collect = async (generator) => { const rows = []; for await (const row of generator) rows.push(row); return rows; };
const sha256Of = (text) => createHash("sha256").update(text).digest("hex");

test("A ROW CARRIES THE NAME AND THE IDENTITY THE PUBLISHER CONSUMES, in the shape it already takes", async () => {
  // The whole point of this reader is that its output drops into publishNamespaceRecords without a
  // translation step. If these field names drift, the rows publish and address nothing.
  const root = treeWith({ "clip.mp4": "one", "sub/deeper/note.txt": "two" });
  const rows = await collect(namesAndContentIdentitiesFromAFolderTree(root));

  assert.deepEqual(rows.map((row) => row.name), ["clip.mp4", "sub/deeper/note.txt"]);
  assert.equal(rows[0].sha256Hex, sha256Of("one"));
  assert.equal(rows[1].sha256Hex, sha256Of("two"));
  assert.equal(rows[0].storedPath, path.join(root, "clip.mp4"));
  assert.equal(rows[0].byteLength, 3);
});

test("THE NAME IS POSIX-SPELLED AND RELATIVE, because a name outlives the place the volume is mounted", async () => {
  // `storedPath` is where the bytes are right now; `name` is what a human and an address use. A
  // card remounted at a different path must not produce a different name for the same footage.
  const root = treeWith({ "a/b/c.mp4": "x" });
  const [row] = await collect(namesAndContentIdentitiesFromAFolderTree(root));
  assert.equal(row.name, "a/b/c.mp4");
  assert.ok(path.isAbsolute(row.storedPath));
});

test("AN UNREADABLE DIRECTORY SKIPS AND THE WALK CONTINUES, because a card's .Trashes must not eat the ingest", async () => {
  // Measured on a real DJI card: `.Trashes` answers permission-denied. A walk that throws there
  // reports a short file count rather than an error, which is the quietest possible data loss.
  const root = treeWith({ "first.mp4": "one", "later.mp4": "two" });
  const reported = [];
  const rows = await collect(namesAndContentIdentitiesFromAFolderTree(root, {
    onUnreadable: (report) => reported.push(report),
    openDirectory: async (directory) => {
      if (directory.endsWith("blocked")) { const error = new Error("denied"); error.code = "EACCES"; throw error; }
      const { opendir } = await import("node:fs/promises");
      return opendir(directory);
    },
    skipEntry: () => false,
  }));

  assert.equal(rows.length, 2, "both readable files survived");
  // And an unreadable FILE is reported without ending the walk either.
  const withBadFile = await collect(namesAndContentIdentitiesFromAFolderTree(root, {
    onUnreadable: (report) => reported.push(report),
    identityOf: async (absolute) => {
      if (absolute.endsWith("first.mp4")) { const error = new Error("denied"); error.code = "EACCES"; throw error; }
      return { sha256Hex: sha256Of("two"), byteLength: 3 };
    },
  }));
  assert.deepEqual(withBadFile.map((row) => row.name), ["later.mp4"]);
  assert.ok(reported.some((report) => report.relativePath === "first.mp4" && report.reason === "EACCES"));
});

test("THE ORDER IS STABLE ACROSS RUNS, because a resumed publish addresses rows by position", async () => {
  // publishNamespaceRecords resumes at `startRow`. If the walk order moves between runs, row N on
  // the second run is different bytes than row N on the first, and the resume silently skips and
  // duplicates rather than continuing.
  const root = treeWith({ "b.mp4": "b", "a.mp4": "a", "m/z.mp4": "z", "m/a.mp4": "a2" });
  const first = await collect(namesAndContentIdentitiesFromAFolderTree(root));
  const second = await collect(namesAndContentIdentitiesFromAFolderTree(root));
  assert.deepEqual(first.map((row) => row.name), second.map((row) => row.name));
  assert.deepEqual(first.map((row) => row.name), ["a.mp4", "b.mp4", "m/a.mp4", "m/z.mp4"]);
});

test("A SYMLINK IS NEITHER FOLLOWED NOR HASHED, because a link makes a tree a graph and can publish bytes from outside the root", async () => {
  const root = treeWith({ "real.mp4": "r" });
  const outside = treeWith({ "secret.txt": "s" });
  symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  symlinkSync(outside, path.join(root, "loop"));

  const rows = await collect(namesAndContentIdentitiesFromAFolderTree(root));
  assert.deepEqual(rows.map((row) => row.name), ["real.mp4"]);
});

test("WHAT TO SKIP IS THE CALLER'S, so this reader holds no filesystem's list of noise names", async () => {
  // A hardcoded `.DS_Store`/`.Trashes`/thumbnail list would be an enumeration of one filesystem's
  // habits, and the next source spells its noise differently. The predicate is the seam.
  const root = treeWith({ "keep.mp4": "k", ".DS_Store": "junk", "THMBNL/x.thm": "t" });
  const rows = await collect(namesAndContentIdentitiesFromAFolderTree(root, {
    skipEntry: ({ name }) => name === ".DS_Store" || name === "THMBNL",
  }));
  assert.deepEqual(rows.map((row) => row.name), ["keep.mp4"]);
});

test("THE HASH IS STREAMED, because one measured file in this corpus is 54 GB", async () => {
  // The sibling digest owner uses readFileSync, which is right for the small artifacts it serves
  // and would take the process down here. This asserts the reader never asks for the whole file at
  // once: it consumes an async iterable of chunks and never calls a whole-file read.
  const chunks = ["abc", "def", "ghi"];
  const identity = await contentIdentityOfOneFile("/pretend", {
    openStream: () => (async function* () { for (const chunk of chunks) yield Buffer.from(chunk); })(),
  });
  assert.equal(identity.sha256Hex, sha256Of("abcdefghi"));
  assert.equal(identity.byteLength, 9);
});
