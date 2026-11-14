import { describe, expect, it } from 'vitest';
import data from './live-audio-stream.json';
import { chooseCodec, codecLine, createDuplicateDrop, createLiveStream, layerState, type CodecConditions, type SocketLike } from './live-audio-stream';

const base: CodecConditions = { browserHasOpus: true, routeAcceptsOpus: true, layerFlag: false, layerModelReady: false, rung: 0 };
const fakeSocket = () => { const sent: ArrayBufferLike[] = []; const socket = { readyState: 1, bufferedAmount: 0, send: (bytes: ArrayBufferLike) => { sent.push(bytes); }, close: () => {}, sent } as SocketLike & { sent: ArrayBufferLike[] }; return socket; };
const turns = (stream: ReturnType<typeof createLiveStream>, first: number) => { stream.heard({ event: 'StartOfTurn' }); return first; };

describe('live audio stream', () => {
  it('speaks sixteen-bit sound while the table rows are off, and the row the table allows once flipped', () => {
    expect(chooseCodec(base).id).toBe('pcm16');
    const on = { ...data, codecs: data.codecs.map(row => ({ ...row, enabled: true })) };
    expect(chooseCodec(base, on).id).toBe('opus-fec');
    expect(chooseCodec({ ...base, routeAcceptsOpus: false }, on).id).toBe('pcm16');
  });

  it('uses the layered row only on the last rung and only when its layer is ready', () => {
    const on = { ...data, codecs: data.codecs.map(row => ({ ...row, enabled: true })) };
    const ready = { ...base, layerFlag: true, layerModelReady: true };
    expect(chooseCodec(ready, on).id).toBe('opus-fec');
    expect(chooseCodec({ ...ready, rung: 2 }, on).id).toBe('opus-neural-layer');
    expect(chooseCodec({ ...ready, layerModelReady: false, rung: 2 }, on).id).toBe('opus-fec');
    expect([layerState(false, true), layerState(true, false), layerState(true, true)]).toEqual(['off', 'enabled', 'ready']);
    expect(JSON.parse(codecLine(chooseCodec({ ...ready, rung: 2 }, on), { ...ready, rung: 2 }, on))).toMatchObject({ codec: 'opus-neural-layer', layers: ['neural'], fec_extra_percent: 20, rung: 'lowest', layer: 'ready' });
  });

  it('drops a repeated line per channel and keeps the same words from another channel', () => {
    const drop = createDuplicateDrop(3);
    expect(drop.fresh('a', 'Hello there.')).toBe(true);
    expect(drop.fresh('a', 'hello   there')).toBe(false);
    expect(drop.fresh('b', 'Hello there')).toBe(true);
  });

  it('numbers chunks, bounds the resend buffer and replays from the last confirmed turn less the overlap after a lost connection', () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const lines: string[] = [];
    const later: (() => void)[] = [];
    const stream = createLiveStream({ open: () => { const socket = fakeSocket(); sockets.push(socket); return socket; }, isOpen: socket => socket.readyState === 1, chunkSeconds: 4, conditions: base, onLine: line => lines.push(line), schedule: run => { later.push(run); } });
    expect(JSON.parse(lines[0]).codec).toBe('pcm16');
    stream.connect();
    const chunk = new Float32Array([0, 1, -1]);
    for (let index = 0; index < 3; index += 1) stream.push(chunk);
    expect(Array.from(new Int16Array(sockets[0].sent[1]))).toEqual([0, 32767, -32767]);
    turns(stream, 0);
    for (let index = 0; index < 3; index += 1) stream.push(chunk);
    expect(stream.heard({ event: 'EndOfTurn', transcript: 'first words' })).toBe(true);
    for (let index = 0; index < 2; index += 1) stream.push(chunk);
    expect(stream.buffered()).toBe(5);
    expect(stream.lost(() => {})).toBe(true);
    later[0]();
    expect(sockets).toHaveLength(2);
    // The turn began at chunk 3, so chunk 2 is the last confirmed; the replay starts two chunks of overlap earlier and holds no more than is kept.
    expect(sockets[1].sent.length).toBeGreaterThan(0);
    expect(sockets[1].sent.length).toBeLessThanOrEqual(stream.buffered());
    expect(stream.heard({ event: 'EndOfTurn', transcript: 'First words.' })).toBe(false);
  });

  it('keeps no more than the resend window of audio and gives up after the allowed reconnects', () => {
    const stream = createLiveStream({ open: fakeSocket, isOpen: () => false, chunkSeconds: 4, conditions: base, schedule: run => { run(); } });
    stream.connect();
    for (let index = 0; index < 30; index += 1) stream.push(new Float32Array(2));
    expect(stream.buffered()).toBe(Math.round(data.resend.seconds / 4));
    let gaveUp = 0;
    const answers = Array.from({ length: data.resend.most_reconnects + 1 }, () => stream.lost(() => { gaveUp += 1; }));
    expect(answers).toEqual([true, true, true, false]);
    expect(gaveUp).toBe(1);
  });
});
