// src/workspace/slot-in-the-page.ts
//
// PURPOSE
//   Runs a compiled slot in this page: a WebAssembly module built for WASI (wasm32-wasip1) that speaks the shared
//   buffer exchange every Bitfield slot speaks. At start it hands over three buffers (`__init_buffers`: request, reply,
//   commands); each request is written into the request buffer and `handle_query(length)` called; the slot writes its
//   reply into the reply buffer and says how long it is (`__notify_ready`). The composition engine (crates/composition-
//   engine, answering `slot::composition-engine` for the Write screen) runs this way, so laying out a document needs no
//   server.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The module's bytes are fetched once, the first time its target is asked, never with the page.
//   2. A slot runs one request at a time; requests asked while one runs wait their turn in order.
//   3. A request larger than the slot's request buffer, or a slot that answers it with a failure (-1), is refused in
//      words; nothing is cut short silently.
//   4. The only outside calls a slot gets are the few WASI ones it imports: random bytes, the clock, its text output
//      (shown in the console) and its environment (empty). Everything else is refused at start.

type Exports = { memory: WebAssembly.Memory; init: () => void; handle_query: (length: number) => number };
type Buffers = { request: number; requestCap: number; reply: number; replyCap: number };

const WASI_OK = 0;

/** A started slot: send it a request's bytes, get its reply's bytes. */
export type SlotInThePage = (request: Uint8Array) => Uint8Array;

/** Fetch and start the slot whose compiled bytes are served at `bytesAddress`. */
export async function startSlotInThePage(bytesAddress: string, name: string): Promise<SlotInThePage> {
  let exports: Exports | null = null;
  let buffers: Buffers | null = null;
  let replyLength = 0;
  const memory = () => new DataView(exports!.memory.buffer);
  const bytesAt = (at: number, length: number) => new Uint8Array(exports!.memory.buffer, at, length);
  let output = '';
  const wasi = {
    random_get(at: number, length: number) { crypto.getRandomValues(bytesAt(at, length)); return WASI_OK; },
    clock_time_get(_clock: number, _precision: bigint, at: number) { memory().setBigUint64(at, BigInt(Date.now()) * 1_000_000n, true); return WASI_OK; },
    fd_write(_fd: number, vectors: number, count: number, writtenAt: number) {
      const view = memory();
      let written = 0;
      for (let index = 0; index < count; index += 1) {
        const at = view.getUint32(vectors + index * 8, true);
        const length = view.getUint32(vectors + index * 8 + 4, true);
        output += new TextDecoder().decode(bytesAt(at, length).slice());
        written += length;
      }
      view.setUint32(writtenAt, written, true);
      const lines = output.split('\n');
      output = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) console.warn(`[${name}] ${line}`);
      return WASI_OK;
    },
    environ_sizes_get(countAt: number, sizeAt: number) { memory().setUint32(countAt, 0, true); memory().setUint32(sizeAt, 0, true); return WASI_OK; },
    environ_get() { return WASI_OK; },
    proc_exit(code: number) { throw new Error(`${name} stopped (exit ${code}).`); },
    sched_yield() { return WASI_OK; },
  };
  const env = {
    __init_buffers(request: number, requestCap: number, reply: number, replyCap: number) {
      buffers = { request, requestCap, reply, replyCap };
      return 0;
    },
    __notify_ready(_commandLength: number, length: number) { replyLength = length; return 0; },
  };
  const response = await fetch(bytesAddress);
  if (!response.ok) throw new Error(`${name} could not be fetched (${response.status}).`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), { env, wasi_snapshot_preview1: wasi });
  exports = instance.exports as unknown as Exports;
  exports.init();
  if (!buffers) throw new Error(`${name} did not hand over its buffers when it started.`);
  const { request: requestAt, requestCap, reply: replyAt } = buffers as Buffers;
  return request => {
    if (request.byteLength > requestCap) throw new Error(`This change is larger than ${name} takes at once (${requestCap} bytes).`);
    bytesAt(requestAt, request.byteLength).set(request);
    replyLength = 0;
    const answered = exports!.handle_query(request.byteLength);
    if (answered < 0) throw new Error(`${name} could not apply this change.`);
    return bytesAt(replyAt, replyLength).slice();
  };
}

/**
 * The answer for a target served by a slot in this page: the request's payload as JSON bytes in, the reply's bytes
 * out. The slot starts the first time the target is asked; each request waits for the one before it.
 */
export function slotAnswer(bytesAddress: () => Promise<string>, name: string) {
  let started: Promise<SlotInThePage> | null = null;
  let turn: Promise<unknown> = Promise.resolve();
  return (payload: unknown): Promise<Uint8Array> => {
    started ??= bytesAddress().then(address => startSlotInThePage(address, name)).catch(error => { started = null; throw error; });
    const run = turn.then(() => started!).then(slot => slot(new TextEncoder().encode(JSON.stringify(payload))));
    turn = run.catch(() => {});
    return run;
  };
}
