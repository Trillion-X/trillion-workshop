// tools/receive-files-over-ftp/test/receive-pushed-files.test.mjs
//
// Hostile proof for the receiver. A real listener on a loopback port, a hand-rolled sender speaking the protocol over
// raw sockets (so no client library's forgiveness hides a defect), and a scratch directory that is removed afterwards.
// Senders, device names and folders here are made up.
//
//   a half-transferred file is invisible: no note until the last byte is flushed
//   custody is acknowledged only after the note exists
//   the content identity in the note is the BLAKE3 identity of the bytes on disk
//   a path that escapes the folder is refused, both absolute and relative
//   a wrong password is refused and yields no identity
//   a finished unit cannot be deleted or renamed over the wire
//   active mode is refused, so the receiver never dials out
//   no sender is built in: settings with none do not start

import assert from "node:assert/strict";
import test from "node:test";
import { connect } from "node:net";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeHashCodeHexFromBytes } from "../../content-identity/read-data/identity.mjs";

import {
  completionNote,
  identifySender,
  identityOfFile,
  mediaTypeForName,
  passiveReply,
  readSettings,
  resolveInsideRoot,
  runReceiver,
} from "../do-work/receive-pushed-files.mjs";

const SENDERS = [{ login: "scanner", password: "push-it", handed_over_by: "device:front-desk-scanner" }];
const RECEIVER = path.join(import.meta.dirname, "..", "do-work", "receive-pushed-files.mjs");

function settingsFor(overrides = {}) {
  return readSettings({ listen_host: "127.0.0.1", listen_port: 0, senders: SENDERS, media_types_by_extension: { pdf: "application/pdf" }, ...overrides });
}

/** A minimal control-channel client: send a line, collect the reply. */
class Control {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.waiters = [];
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      this.drain();
    });
  }
  drain() {
    // A reply is complete when a line starts with three digits and a space.
    while (this.waiters.length) {
      const lines = this.buffer.split("\r\n");
      const end = lines.findIndex((line) => /^\d{3} /.test(line));
      if (end < 0) return;
      const reply = lines.slice(0, end + 1).join("\r\n");
      this.buffer = lines.slice(end + 1).join("\r\n");
      this.waiters.shift()(reply);
    }
  }
  reply() {
    return new Promise((resolve) => { this.waiters.push(resolve); this.drain(); });
  }
  async send(line) {
    const pending = this.reply();
    this.socket.write(`${line}\r\n`, "latin1");
    return pending;
  }
}

async function open(port) {
  const socket = connect({ host: "127.0.0.1", port });
  await new Promise((resolve) => socket.once("connect", resolve));
  const control = new Control(socket);
  const banner = await control.reply();
  assert.match(banner, /^220 /);
  return control;
}

function passivePort(reply) {
  const extended = reply.match(/\(\|\|\|(\d+)\|\)/);
  if (extended) return Number(extended[1]);
  const classic = reply.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
  assert.ok(classic, `not a passive reply: ${reply}`);
  return Number(classic[5]) * 256 + Number(classic[6]);
}

async function login(control) {
  assert.match(await control.send("USER scanner"), /^331 /);
  assert.match(await control.send("PASS push-it"), /^230 /);
}

async function withReceiver(body, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "receive-pushed-files-test."));
  const controller = new AbortController();
  try {
    const receiver = await runReceiver({ settings: settingsFor(), root, signal: controller.signal, log: () => {}, ...options });
    await body({ root, receiver });
    await receiver.close();
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
}

test("pure: paths that escape the folder are refused, inside ones resolve", () => {
  const root = "/place";
  assert.equal(resolveInsideRoot(root, "/", "../etc/passwd"), null);
  assert.equal(resolveInsideRoot(root, "/", "/../x"), null);
  assert.equal(resolveInsideRoot(root, "/sub", "../../x"), null);
  assert.deepEqual(resolveInsideRoot(root, "/", "clip.mp4"), { virtual: "/clip.mp4", relative: "clip.mp4", absolute: "/place/clip.mp4" });
  assert.equal(resolveInsideRoot(root, "/sub", "a/../b.mp4"), null, "a parent segment anywhere is refused, even one that would stay inside");
  assert.deepEqual(resolveInsideRoot(root, "/sub", "./b.mp4"), { virtual: "/sub/b.mp4", relative: "sub/b.mp4", absolute: "/place/sub/b.mp4" });
  assert.equal(resolveInsideRoot(root, "/", "/").relative, "");
});

test("pure: a sender identity is the opaque string its row maps the login to, never the login", () => {
  assert.equal(identifySender(SENDERS, "scanner", "push-it"), "device:front-desk-scanner");
  assert.equal(identifySender(SENDERS, "scanner", "push-i"), null);
  assert.equal(identifySender(SENDERS, "scanner", "push-it!"), null);
  assert.equal(identifySender(SENDERS, "someone", "push-it"), null);
  assert.equal(identifySender([], "scanner", "push-it"), null);
  assert.equal(identifySender(SENDERS, "scanner", undefined), null);
});

test("pure: media type comes from the settings table and falls back to the generic type", () => {
  const table = settingsFor({ media_types_by_extension: { mp4: "video/mp4" } }).media_types_by_extension;
  assert.equal(mediaTypeForName("inbox/clips/C0001.MP4", table), "video/mp4");
  assert.equal(mediaTypeForName("notes.xyz", table), "application/octet-stream");
  assert.equal(mediaTypeForName("noext", table), "application/octet-stream");
  assert.equal(mediaTypeForName("a.mp4", settingsFor({ media_types_by_extension: undefined }).media_types_by_extension), "application/octet-stream");
});

test("pure: the note carries the identity it is given and the passive reply splits the port", () => {
  const note = completionNote({ contentIdentity: `1f:${"ab".repeat(32)}`, byteLength: 3, mediaType: "video/mp4", finishedAtMs: 5, handedOverBy: "h" });
  assert.equal(note.content_identity, `1f:${"ab".repeat(32)}`);
  assert.deepEqual(Object.keys(note), ["content_identity", "byte_length", "media_type", "finished_at_ms", "handed_over_by"]);
  assert.equal(passiveReply("192.168.1.20", 2130), "227 Entering Passive Mode (192,168,1,20,8,82)");
  assert.throws(() => passiveReply("::1", 1));
});

test("pure: settings have no sender built in, listen on loopback unless told otherwise, and need all three words of a sender", () => {
  assert.throws(() => readSettings({}), /at least one sender/);
  assert.throws(() => readSettings({ senders: [{ login: "a", password: "", handed_over_by: "x" }] }), /There is no built-in sender/);
  assert.throws(() => readSettings({ senders: [{ login: "a", handed_over_by: "x" }] }), /at least one sender/);
  const settings = readSettings({ senders: SENDERS });
  assert.equal(settings.listen_host, "127.0.0.1");
  assert.equal(settings.listen_port, 2121);
  assert.equal(settings.completion_note_suffix, ".finished.json");
  assert.deepEqual(settings.media_types_by_extension, {});
  assert.equal(readSettings({ senders: SENDERS, listen_host: "0.0.0.0", listen_port: 2200, media_types_by_extension: { ".MP4": "video/mp4" } }).media_types_by_extension.mp4, "video/mp4");
  assert.equal(readSettings({ senders: SENDERS, listen_port: 70000 }).listen_port, 2121);
});

test("the identity of a file is the BLAKE3 identity of its bytes, however long the file is", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "receive-identity-test."));
  try {
    const small = path.join(folder, "abc.bin");
    await writeFile(small, "abc");
    assert.equal(identityOfFile(small), "1f:6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85");
    const big = path.join(folder, "big.bin");
    const bytes = Buffer.from(Uint8Array.from({ length: (1 << 20) * 2 + 4321 }, (_, index) => index % 251));
    await writeFile(big, bytes);
    assert.equal(identityOfFile(big), makeHashCodeHexFromBytes(bytes));
    const empty = path.join(folder, "empty.bin");
    await writeFile(empty, "");
    assert.equal(identityOfFile(empty), "1f:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("live: a pushed file lands, the note is written last, the ack comes after the note, and the identity is the bytes' BLAKE3", async () => {
  const finished = [];
  await withReceiver(async ({ root, receiver }) => {
    const control = await open(receiver.address.port);
    assert.match(await control.send("PWD"), /^530 /, "nothing before login");
    await login(control);
    assert.match(await control.send("MKD inbox/scans"), /^257 /);
    const port = passivePort(await control.send("EPSV"));
    const storReply = control.send("STOR inbox/scans/page-0001.pdf");
    const data = connect({ host: "127.0.0.1", port });
    await new Promise((resolve) => data.once("connect", resolve));
    assert.match(await storReply, /^150 /);

    // Bytes are flowing and there is NO note yet.
    const first = Buffer.alloc(300_000, 1);
    const second = Buffer.alloc(200_000, 2);
    data.write(first);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(stat(path.join(root, "inbox/scans/page-0001.pdf.finished.json")), "no note while the transfer is open");

    const completion = control.reply();
    data.end(second);
    const done = await completion;
    assert.match(done, /^226 /);

    // By the time the ack arrived, the note existed with the right identity.
    const note = JSON.parse(await readFile(path.join(root, "inbox/scans/page-0001.pdf.finished.json"), "utf8"));
    assert.equal(note.content_identity, makeHashCodeHexFromBytes(Buffer.concat([first, second])));
    assert.match(note.content_identity, /^1f:[0-9a-f]{64}$/);
    assert.equal(note.byte_length, 500_000);
    assert.equal(note.media_type, "application/pdf");
    assert.equal(note.finished_at_ms, 1_800_000_000_000);
    assert.equal(note.handed_over_by, "device:front-desk-scanner");
    assert.equal((await stat(path.join(root, "inbox/scans/page-0001.pdf"))).size, 500_000);
    assert.equal(finished.length, 1);
    assert.equal(finished[0].relative_name, "inbox/scans/page-0001.pdf");

    // A finished unit is this computer's now.
    assert.match(await control.send("DELE inbox/scans/page-0001.pdf"), /^550 /);
    assert.match(await control.send("RNFR inbox/scans/page-0001.pdf"), /^350 /);
    assert.match(await control.send("RNTO inbox/scans/page-0002.pdf"), /^550 /);
    assert.match(await control.send("STOR inbox/scans/page-0001.pdf"), /^553 /, "a finished name is not overwritten");

    // Escapes and active mode are refused.
    assert.match(await control.send("STOR ../outside.bin"), /^553 /);
    assert.match(await control.send("CWD /.."), /^550 /);
    assert.match(await control.send("PORT 127,0,0,1,4,1"), /^502 /);
    assert.match(await control.send("SIZE inbox/scans/page-0001.pdf"), /^213 500000/);
    assert.match(await control.send("QUIT"), /^221 /);
    control.socket.destroy();
    data.destroy();
  }, { nowMs: () => 1_800_000_000_000, onFinished: (note) => finished.push(note) });
});

test("live: a wrong password yields no session and nothing can be stored", async () => {
  await withReceiver(async ({ receiver }) => {
    const control = await open(receiver.address.port);
    assert.match(await control.send("USER scanner"), /^331 /);
    assert.match(await control.send("PASS nope"), /^530 /);
    assert.match(await control.send("EPSV"), /^530 /);
    assert.match(await control.send("STOR x.bin"), /^530 /);
    control.socket.destroy();
  });
});

test("live: a sender may delete a file that has no note yet, and only that", async () => {
  await withReceiver(async ({ root, receiver }) => {
    await writeFile(path.join(root, "unfinished.bin"), "partial");
    await writeFile(path.join(root, "done.bin"), "whole");
    await writeFile(path.join(root, "done.bin.finished.json"), "{}");
    const control = await open(receiver.address.port);
    await login(control);
    assert.match(await control.send("DELE unfinished.bin"), /^250 /);
    await assert.rejects(stat(path.join(root, "unfinished.bin")));
    assert.match(await control.send("DELE done.bin"), /^550 /);
    assert.equal(await readFile(path.join(root, "done.bin"), "utf8"), "whole");
    assert.match(await control.send("DELE ../outside.bin"), /^550 /);
    control.socket.destroy();
  });
});

test("the command starts from a settings file, prints where it listens, and stops on a signal; with no sender it refuses to start", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "receive-cli-test."));
  try {
    const settingsFile = path.join(folder, "settings.json");
    const inbox = path.join(folder, "inbox");
    await writeFile(settingsFile, JSON.stringify({ listen_port: 0, senders: SENDERS }));
    const empty = path.join(folder, "empty.json");
    await writeFile(empty, JSON.stringify({ senders: [] }));
    const refused = await new Promise((done) => execFile(process.execPath, [RECEIVER, "--folder", inbox, "--settings", empty], (error, stdout, stderr) => done({ code: error?.code, stderr })));
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /cannot start: settings need at least one sender/);
    const usage = await new Promise((done) => execFile(process.execPath, [RECEIVER], (error, stdout, stderr) => done({ code: error?.code, stderr })));
    assert.match(usage.stderr, /usage: receive-pushed-files\.mjs --folder/);

    const child = execFile(process.execPath, [RECEIVER, "--folder", folder, "--settings", settingsFile]);
    const listening = await new Promise((resolve, reject) => {
      let text = "";
      child.stdout.on("data", (chunk) => { text += chunk; if (text.includes("\n")) resolve(JSON.parse(text.split("\n")[0])); });
      child.on("exit", () => reject(new Error("the receiver stopped before it was listening")));
    });
    assert.equal(listening.listening.host, "127.0.0.1");
    const control = await open(listening.listening.port);
    await login(control);
    assert.match(await control.send("QUIT"), /^221 /);
    control.socket.destroy();
    const stopped = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    child.kill("SIGTERM");
    assert.deepEqual(await stopped, { code: 0, signal: null });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
