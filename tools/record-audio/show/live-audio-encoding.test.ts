import { describe, expect, it } from 'vitest';
import { chooseEncoding, createChunker, createChunkSender, loadChunkWorklet, pcm16Of, workletSource } from './live-audio-encoding';

describe('live audio encoding', () => {
  it('cuts uneven blocks into chunks of exactly the frame size and keeps the rest for next time', () => {
    const chunker = createChunker(4);
    expect(chunker.push(new Float32Array([1, 2, 3])).length).toBe(0);
    const out = chunker.push(new Float32Array([4, 5, 6, 7, 8, 9]));
    expect(out.map(chunk => Array.from(chunk))).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
    expect(chunker.pendingSamples()).toBe(1);
  });

  it('turns samples into clamped 16-bit integers', () => {
    expect(Array.from(pcm16Of(new Float32Array([0, 1, -1, 2, -3, 0.5])))).toEqual([0, 32767, -32767, 32767, -32767, 16384]);
  });

  it('uses Opus only when wanted, supported and accepted; otherwise PCM', () => {
    expect(chooseEncoding({ wanted: 'opus', browserHasOpus: true, routeAcceptsOpus: true })).toBe('opus');
    expect(chooseEncoding({ wanted: 'opus', browserHasOpus: true, routeAcceptsOpus: false })).toBe('pcm16');
    expect(chooseEncoding({ wanted: 'opus', browserHasOpus: false, routeAcceptsOpus: true })).toBe('pcm16');
    expect(chooseEncoding({ wanted: 'pcm16', browserHasOpus: true, routeAcceptsOpus: true })).toBe('pcm16');
  });

  it('sends PCM bytes, sends Opus when the encoder works, and falls back to PCM for every later chunk when it throws', () => {
    const sent: Array<[number, string]> = [];
    const pcm = createChunkSender((bytes, encoding) => sent.push([bytes.byteLength, encoding]), 'pcm16');
    pcm.push(new Float32Array(4));
    expect(sent).toEqual([[8, 'pcm16']]);
    let fell = 0; let failNext = false; let emit: (bytes: Uint8Array) => void = () => {};
    const sender = createChunkSender((bytes, encoding) => sent.push([bytes.byteLength, encoding]), 'opus', (onChunk) => {
      emit = onChunk;
      return { encode() { if (failNext) throw new Error('encoder lost'); emit(new Uint8Array(3)); }, close() {} };
    }, () => { fell += 1; });
    sent.length = 0;
    sender.push(new Float32Array(4));
    failNext = true;
    sender.push(new Float32Array(4));
    sender.push(new Float32Array(4));
    expect(sent).toEqual([[3, 'opus'], [8, 'pcm16'], [8, 'pcm16']]);
    expect(fell).toBe(1);
    expect(sender.encoding()).toBe('pcm16');
  });

  it('has a worklet source that registers a processor posting full chunks, and reports a browser without worklets', async () => {
    const posted: number[][] = [];
    const registered: Record<string, new () => { process(inputs: Float32Array[][]): boolean }> = {};
    const scope = { AudioWorkletProcessor: class { port = { postMessage: (data: Float32Array) => posted.push(Array.from(data)) }; }, registerProcessor: (name: string, kind: never) => { registered[name] = kind; } };
    new Function('AudioWorkletProcessor', 'registerProcessor', workletSource(4))(scope.AudioWorkletProcessor, scope.registerProcessor);
    const processor = new registered['trillion-chunk-processor']();
    expect(processor.process([[new Float32Array([1, 2, 3])]])).toBe(true);
    processor.process([[new Float32Array([4, 5, 6])]]);
    expect(posted).toEqual([[1, 2, 3, 4]]);
    expect(await loadChunkWorklet({}, 4)).toBe(false);
  });
});
