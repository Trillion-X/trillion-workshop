// packages/group/show/item-add-strategies.test.ts
//
// The blind producer registry: a shelf entry's addStrategy decides HOW an item
// is produced, with injected pick/store capabilities. Proves empty/pick/produce
// + unknown-key tolerance, with ZERO engine or DOM (capabilities are injected).

import { describe, expect, it, vi } from 'vitest';
import { ADD_STRATEGIES, addStrategyFor, type AddShelfEntry, type PickedBytes } from './item-add-strategies';

const noPick = vi.fn(async (): Promise<PickedBytes[]> => []);
const noStore = vi.fn(async () => 'cas://unused');

describe('item-add-strategies — blind producer registry', () => {
  it('empty strategy places the shelf default text, no I/O', async () => {
    const tool: AddShelfEntry = { kind: 'note', label: 'Note', addStrategy: 'empty', defaultText: 'New note' };
    const draft = await addStrategyFor('empty')({ tool, pickFiles: noPick, storeBytes: noStore });
    expect(draft).toEqual({ kind: 'note', text: 'New note' });
    expect(noPick).not.toHaveBeenCalled();
    expect(noStore).not.toHaveBeenCalled();
  });

  it('empty strategy seeds defaultExtra into the draft extra (one-click Shape tool)', async () => {
    // The Shape shelf row is `empty` + a seeded `extra.shape` — the blind strategy
    // spreads defaultExtra without knowing what "shape" means (L090).
    const tool: AddShelfEntry = { kind: 'note', label: 'Shape', addStrategy: 'empty', defaultExtra: { shape: 'ellipse' } };
    const draft = await addStrategyFor('empty')({ tool, pickFiles: noPick, storeBytes: noStore });
    expect(draft).toEqual({ kind: 'note', text: undefined, extra: { shape: 'ellipse' } });
  });

  it('empty strategy copies defaultExtra (placed item never aliases the shelf DATA)', async () => {
    const defaultExtra = { shape: 'diamond', tags: ['idea'] };
    const tool: AddShelfEntry = { kind: 'note', label: 'Shape', addStrategy: 'empty', defaultExtra };
    const draft = await addStrategyFor('empty')({ tool, pickFiles: noPick, storeBytes: noStore });
    const extra = draft && !Array.isArray(draft) ? draft.extra : null;
    expect(extra).toEqual({ shape: 'diamond', tags: ['idea'] });
    expect(extra).not.toBe(defaultExtra); // a fresh object — mutating the item won't corrupt the shelf
  });

  it('empty strategy with no defaultExtra emits NO extra key (back-compat)', async () => {
    const tool: AddShelfEntry = { kind: 'note', label: 'Note', addStrategy: 'empty', defaultText: 'New note' };
    const draft = await addStrategyFor('empty')({ tool, pickFiles: noPick, storeBytes: noStore });
    expect(draft && !Array.isArray(draft) ? 'extra' in draft : true).toBe(false);
  });

  it('#214: empty strategy copies a declared footprint onto the draft w/h (live surface)', async () => {
    const tool: AddShelfEntry = { kind: 'note', label: 'Live surface', addStrategy: 'empty', defaultW: 380, defaultH: 300 };
    const draft = await addStrategyFor('empty')({ tool, pickFiles: noPick, storeBytes: noStore });
    const d = draft && !Array.isArray(draft) ? draft : null;
    expect(d?.w).toBe(380);
    expect(d?.h).toBe(300);
  });

  it('#214: empty strategy with NO footprint emits NO w/h key (placeItem falls back to DEFAULTS)', async () => {
    const tool: AddShelfEntry = { kind: 'note', label: 'Note', addStrategy: 'empty' };
    const draft = await addStrategyFor('empty')({ tool, pickFiles: noPick, storeBytes: noStore });
    const d = draft && !Array.isArray(draft) ? draft : null;
    expect(d ? 'w' in d : true).toBe(false);
    expect(d ? 'h' in d : true).toBe(false);
  });

  it('pick strategy: native pick → store → draft carries CAS src + real contentType', async () => {
    const pickFiles = vi.fn(async (prefixes: readonly string[]): Promise<PickedBytes[]> => {
      expect(prefixes).toEqual(['image/']);
      return [{ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png', name: 'court.png' }];
    });
    const storeBytes = vi.fn(async (bytes: Uint8Array, ct: string) => {
      expect(bytes.byteLength).toBe(3);
      expect(ct).toBe('image/png');
      return '/cas/abc?mime=image/png';
    });
    const tool: AddShelfEntry = { kind: 'image', label: 'Image', addStrategy: 'pick', acceptPrefixes: ['image/'] };
    const draft = await addStrategyFor('pick')({ tool, pickFiles, storeBytes });
    expect(draft).toEqual({ kind: 'image', src: '/cas/abc?mime=image/png', contentType: 'image/png', text: 'court.png' });
  });

  it('#215: pick strategy sizes an image to its natural aspect ratio via measureImage', async () => {
    const pickFiles = async (): Promise<PickedBytes[]> => [{ bytes: new Uint8Array([1]), contentType: 'image/png', name: 'tall.png' }];
    const storeBytes = async () => '/cas/x';
    const measureImage = vi.fn(async () => ({ w: 1000, h: 2000 })); // a 1:2 portrait
    const tool: AddShelfEntry = { kind: 'image', label: 'Image', addStrategy: 'pick', acceptPrefixes: ['image/'] };
    const draft = await addStrategyFor('pick')({ tool, pickFiles, storeBytes, measureImage });
    const d = draft && !Array.isArray(draft) ? draft : null;
    expect(measureImage).toHaveBeenCalledOnce();
    // 1:2 preserved, long edge capped at 480 → 240×480 (taller than wide, not squished).
    expect(d?.w).toBe(240);
    expect(d?.h).toBe(480);
  });

  it('#215: pick strategy adds NO w/h when measureImage returns null (decode fail / non-image)', async () => {
    const pickFiles = async (): Promise<PickedBytes[]> => [{ bytes: new Uint8Array([1]), contentType: 'image/png', name: 'x.png' }];
    const storeBytes = async () => '/cas/x';
    const measureImage = async () => null;
    const tool: AddShelfEntry = { kind: 'image', label: 'Image', addStrategy: 'pick', acceptPrefixes: ['image/'] };
    const draft = await addStrategyFor('pick')({ tool, pickFiles, storeBytes, measureImage });
    const d = draft && !Array.isArray(draft) ? draft : null;
    expect(d ? 'w' in d : true).toBe(false);
    expect(d ? 'h' in d : true).toBe(false);
  });

  it('#215: pick strategy never measures a NON-image file (a video is not decoded)', async () => {
    const pickFiles = async (): Promise<PickedBytes[]> => [{ bytes: new Uint8Array([1]), contentType: 'video/mp4', name: 'clip.mp4' }];
    const storeBytes = async () => '/cas/v';
    const measureImage = vi.fn(async () => ({ w: 1920, h: 1080 }));
    const tool: AddShelfEntry = { kind: 'media', label: 'Media', addStrategy: 'pick', acceptPrefixes: ['image/', 'video/'] };
    const draft = await addStrategyFor('pick')({ tool, pickFiles, storeBytes, measureImage });
    const d = draft && !Array.isArray(draft) ? draft : null;
    expect(measureImage).not.toHaveBeenCalled(); // guarded by contentType.startsWith('image/')
    expect(d ? 'w' in d : true).toBe(false);
  });

  it('pick strategy returns null when the user cancels (no bytes) — no placement', async () => {
    const tool: AddShelfEntry = { kind: 'image', label: 'Image', addStrategy: 'pick', acceptPrefixes: ['image/'] };
    const draft = await addStrategyFor('pick')({ tool, pickFiles: noPick, storeBytes: noStore });
    expect(draft).toBeNull();
    expect(noStore).not.toHaveBeenCalled();
  });

  it('an unknown strategy key falls back to empty placement (never a crash)', async () => {
    const tool: AddShelfEntry = { kind: 'whatever', label: 'X', addStrategy: 'not-registered-yet', defaultText: 'hi' };
    const draft = await addStrategyFor('not-registered-yet')({ tool, pickFiles: noPick, storeBytes: noStore });
    expect(draft).toEqual({ kind: 'whatever', text: 'hi' });
  });

  it('registry is open — adding a strategy key needs no consumer edit', () => {
    expect(Object.keys(ADD_STRATEGIES)).toEqual(expect.arrayContaining(['empty', 'pick', 'produce']));
  });

  const PRODUCER = {
    definitionId: 'action:some-producer',
    resultAddressTemplate: 'package::p::result::{id}',
    errorAddressTemplate: 'package::p::error::{id}',
  };

  it('produce strategy fires the tool producer (DATA) and carries the request id + status', async () => {
    const submitProducer = vi.fn(async (producer, input: Record<string, unknown>) => {
      expect(producer).toBe(PRODUCER);
      expect(input.instruction_text).toBe('a calm morning court');
      return { requestId: 'gen-123', submitted: false };
    });
    const tool: AddShelfEntry = { kind: 'pending', label: 'Produce', addStrategy: 'produce', defaultText: 'a calm morning court', producer: PRODUCER };
    const draft = await addStrategyFor('produce')({ tool, pickFiles: noPick, storeBytes: noStore, submitProducer });
    expect(submitProducer).toHaveBeenCalledOnce();
    expect(draft).toEqual({ kind: 'pending', text: 'a calm morning court', extra: { requestId: 'gen-123', status: 'unconfigured' } });
  });

  it('a producer submission marks the item pending until the result lands (injected clock stamps started_at)', async () => {
    const submitProducer = vi.fn(async () => ({ requestId: 'gen-9', submitted: true }));
    const tool: AddShelfEntry = { kind: 'pending', label: 'Produce', addStrategy: 'produce', defaultText: 'x', producer: PRODUCER };
    // `now` is injected (the leaf stays pure — no Date.now inside) → the draft stamps the EXACT clock value.
    const draft = await addStrategyFor('produce')({ tool, pickFiles: noPick, storeBytes: noStore, submitProducer, now: () => 1_700_000_000_000 });
    expect(draft && !Array.isArray(draft) ? draft.extra : null).toEqual({ requestId: 'gen-9', status: 'pending', started_at: 1_700_000_000_000 });
  });

  it('produce with NO producer wired places a plain instruction item (board stays blind)', async () => {
    const tool: AddShelfEntry = { kind: 'pending', label: 'Produce', addStrategy: 'produce', defaultText: 'x' };
    const draft = await addStrategyFor('produce')({ tool, pickFiles: noPick, storeBytes: noStore });
    expect(draft).toEqual({ kind: 'pending', text: 'x' });
  });

  it('a NO-ASK tool fires IMMEDIATELY — askText is wired but the tool declares no prompt (2026-07-09)', async () => {
    // Sam's report: clicking an EXISTING action opened a generic "What do you want to
    // create?" modal. The ask is DATA-declared (`defaultText` from the record's ask.prompt);
    // a tool with NO declared prompt is self-contained and must never ask.
    const submitProducer = vi.fn(async (_producer, input: Record<string, unknown>) => {
      expect(input.instruction_text).toBe(''); // real instruction lives in the record's input_template
      return { requestId: 'gen-direct', submitted: true };
    });
    const askText = vi.fn(async () => 'should never be called');
    const tool: AddShelfEntry = { kind: 'note', label: 'Summarize', addStrategy: 'produce', producer: PRODUCER };
    const draft = await addStrategyFor('produce')({ tool, pickFiles: noPick, storeBytes: noStore, submitProducer, askText });
    expect(askText).not.toHaveBeenCalled();
    expect(submitProducer).toHaveBeenCalledOnce();
    // Card text falls back to the action LABEL (no typed instruction to show).
    expect(draft && !Array.isArray(draft) ? draft.text : null).toBe('Summarize');
  });

  it('produce prompts the user for the producer input when askText is wired', async () => {
    const submitProducer = vi.fn(async (_producer, input: Record<string, unknown>) => {
      expect(input.instruction_text).toBe('launch a pottery academy'); // the USER's typed goal, not defaultText
      return { requestId: 'gen-7', submitted: true };
    });
    const askText = vi.fn(async () => '  launch a pottery academy  ');
    const tool: AddShelfEntry = { kind: 'note', label: 'Break down', addStrategy: 'produce', defaultText: 'What goal?', producer: PRODUCER };
    const draft = await addStrategyFor('produce')({ tool, pickFiles: noPick, storeBytes: noStore, submitProducer, askText, now: () => 1_700_000_000_042 });
    expect(askText).toHaveBeenCalledOnce();
    expect(draft).toEqual({ kind: 'note', text: 'launch a pottery academy', extra: { requestId: 'gen-7', status: 'pending', started_at: 1_700_000_000_042 } });
  });

  it('the leaf is PURE: with no `now` injected a fired producer carries NO started_at (no faked clock)', async () => {
    const submitProducer = vi.fn(async () => ({ requestId: 'gen-pure', submitted: true }));
    const tool: AddShelfEntry = { kind: 'pending', label: 'Produce', addStrategy: 'produce', defaultText: 'x', producer: PRODUCER };
    const draft = await addStrategyFor('produce')({ tool, pickFiles: noPick, storeBytes: noStore, submitProducer });
    // No injected clock → the strategy never calls Date.now itself; the card simply shows no elapsed timer.
    expect(draft && !Array.isArray(draft) ? draft.extra : null).toEqual({ requestId: 'gen-pure', status: 'pending' });
    expect(draft && !Array.isArray(draft) ? 'started_at' in (draft.extra ?? {}) : true).toBe(false);
  });

  it('produce with askText canceled/empty places nothing (no stray pending item)', async () => {
    const submitProducer = vi.fn();
    const tool: AddShelfEntry = { kind: 'note', label: 'Break down', addStrategy: 'produce', defaultText: 'What goal?', producer: PRODUCER };
    expect(await addStrategyFor('produce')({ tool, pickFiles: noPick, storeBytes: noStore, submitProducer, askText: async () => null })).toBeNull();
    expect(await addStrategyFor('produce')({ tool, pickFiles: noPick, storeBytes: noStore, submitProducer, askText: async () => '   ' })).toBeNull();
    expect(submitProducer).not.toHaveBeenCalled();
  });

  it('live-production hints (totalHint/workingLabel) ride into extra as opaque DATA', async () => {
    const submitProducer = vi.fn(async () => ({ requestId: 'gen-h', submitted: true }));
    const tool: AddShelfEntry = {
      kind: 'note', label: 'Produce', addStrategy: 'produce', defaultText: 'x',
      producer: PRODUCER, totalHint: 6, workingLabel: 'Working on it…',
    };
    const draft = await addStrategyFor('produce')({ tool, pickFiles: noPick, storeBytes: noStore, submitProducer });
    const extra = draft && !Array.isArray(draft) ? draft.extra : null;
    expect(extra).toEqual({ requestId: 'gen-h', status: 'pending', total_hint: 6, message: 'Working on it…' }); // no `now` injected → no started_at
  });

  it('owner per-producer timeout (timeoutMs) rides into extra so the board poll can honor it', async () => {
    const submitProducer = vi.fn(async () => ({ requestId: 'gen-t', submitted: true }));
    const tool: AddShelfEntry = {
      kind: 'note', label: 'Produce', addStrategy: 'produce', defaultText: 'x',
      producer: PRODUCER, timeoutMs: 600_000, // a slow AI breakdown wants longer than the 180s default
    };
    const draft = await addStrategyFor('produce')({ tool, pickFiles: noPick, storeBytes: noStore, submitProducer });
    const extra = draft && !Array.isArray(draft) ? draft.extra : null;
    expect(extra).toEqual({ requestId: 'gen-t', status: 'pending', timeoutMs: 600_000 }); // no `now` injected → no started_at
  });

  it('no live-production hints → extra carries only requestId + status (no stray keys, incl. no timeoutMs)', async () => {
    const submitProducer = vi.fn(async () => ({ requestId: 'gen-b', submitted: true }));
    const tool: AddShelfEntry = { kind: 'note', label: 'Produce', addStrategy: 'produce', defaultText: 'x', producer: PRODUCER };
    const draft = await addStrategyFor('produce')({ tool, pickFiles: noPick, storeBytes: noStore, submitProducer });
    const extra = draft && !Array.isArray(draft) ? draft.extra : null;
    expect(extra).toEqual({ requestId: 'gen-b', status: 'pending' }); // no `now` injected → no started_at (pure)
  });

  it('produce passes opaque input — never a `prompt` key (the board is blind to AI vocabulary)', async () => {
    const receivedInputs: Array<Record<string, unknown>> = [];
    const submitProducer = vi.fn(async (_producer, input: Record<string, unknown>) => {
      receivedInputs.push(input);
      return { requestId: 'x', submitted: true };
    });
    const tool: AddShelfEntry = { kind: 'note', label: 'Break down', addStrategy: 'produce', defaultText: 'Do the thing', producer: PRODUCER };
    await addStrategyFor('produce')({ tool, pickFiles: noPick, storeBytes: noStore, submitProducer });
    expect(receivedInputs).toHaveLength(1);
    // The input must carry the user's instruction — never an AI/chat-vocabulary key.
    expect('prompt' in receivedInputs[0]).toBe(false);
    expect(receivedInputs[0].instruction_text).toBe('Do the thing');
  });

  it('text-source producer: pasted lines become MANY drafts (one item per line)', async () => {
    const askText = vi.fn(async () => 'court at dawn\n  the vibe: calm  \n\nserve in slow-mo');
    const tool: AddShelfEntry = { kind: 'note', label: 'Paste as cards', addStrategy: 'text-source', defaultText: 'Paste a list' };
    const drafts = await addStrategyFor('text-source')({ tool, pickFiles: noPick, storeBytes: noStore, askText });
    expect(Array.isArray(drafts)).toBe(true);
    expect(drafts).toEqual([
      { kind: 'note', text: 'court at dawn' },
      { kind: 'note', text: 'the vibe: calm' }, // trimmed
      { kind: 'note', text: 'serve in slow-mo' }, // blank line dropped
    ]);
  });

  it('text-source returns null when the user cancels or pastes nothing (no placement)', async () => {
    const tool: AddShelfEntry = { kind: 'note', label: 'Paste as cards', addStrategy: 'text-source' };
    expect(await addStrategyFor('text-source')({ tool, pickFiles: noPick, storeBytes: noStore, askText: async () => null })).toBeNull();
    expect(await addStrategyFor('text-source')({ tool, pickFiles: noPick, storeBytes: noStore, askText: async () => '   \n  ' })).toBeNull();
  });

  const linkTool: AddShelfEntry = { kind: 'link', label: 'Link', addStrategy: 'link', defaultText: 'Paste a link URL' };

  it('link strategy normalizes a scheme-less URL to https and places a link item', async () => {
    const draft = await addStrategyFor('link')({ tool: linkTool, pickFiles: noPick, storeBytes: noStore, askText: async () => 'pinterest.com/board' });
    expect(draft).toEqual({ kind: 'link', text: 'pinterest.com/board', src: 'https://pinterest.com/board' });
  });

  it('link strategy keeps an explicit scheme intact', async () => {
    const draft = await addStrategyFor('link')({ tool: linkTool, pickFiles: noPick, storeBytes: noStore, askText: async () => 'http://example.com/x' });
    expect(draft && !Array.isArray(draft) ? draft.src : null).toBe('http://example.com/x');
  });

  it('link strategy: a cancelled or empty prompt produces nothing (no junk item)', async () => {
    expect(await addStrategyFor('link')({ tool: linkTool, pickFiles: noPick, storeBytes: noStore, askText: async () => null })).toBeNull();
    expect(await addStrategyFor('link')({ tool: linkTool, pickFiles: noPick, storeBytes: noStore, askText: async () => '   ' })).toBeNull();
  });

  it('registry stays open — link is registered alongside the rest (no consumer edit)', () => {
    expect(Object.keys(ADD_STRATEGIES)).toEqual(expect.arrayContaining(['empty', 'pick', 'produce', 'text-source', 'link']));
  });
});

describe('item-add-strategies red-team (cont.98 batch-27)', () => {
  it('addStrategyFor falls back to placeEmpty for a prototype-named key (never returns Object.prototype/ctor)', async () => {
    for (const key of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) {
      const tool = { kind: 'note', label: 'x', addStrategy: key } as unknown as AddShelfEntry;
      const draft = await addStrategyFor(key)({ tool, pickFiles: noPick, storeBytes: noStore, askText: async () => null });
      // placeEmpty output for a bare tool — a resolved draft object with the tool's kind, NOT a function/prototype.
      expect(typeof draft).toBe('object');
      expect((draft as { kind: string }).kind).toBe('note');
    }
  });

  it('placeEmpty clamps a persisted Number.MAX_VALUE / Infinity defaultW/H to a finite board coord', async () => {
    const tool = { kind: 'note', label: 'big', addStrategy: 'empty', defaultW: Number.MAX_VALUE, defaultH: Infinity } as unknown as AddShelfEntry;
    const draft = await addStrategyFor('empty')({ tool, pickFiles: noPick, storeBytes: noStore, askText: async () => null });
    const d = draft as { w: number; h: number };
    expect(Number.isFinite(d.w)).toBe(true);
    expect(Number.isFinite(d.h)).toBe(true);
    expect(Math.abs(d.w)).toBeLessThanOrEqual(1e7);
    expect(Math.abs(d.h)).toBeLessThanOrEqual(1e7);
  });

  it('text-source caps a giant paste to at most MAX_TEXT_SOURCE_ITEMS drafts (no unbounded fan-out)', async () => {
    const tool = { kind: 'note', label: 'ts', addStrategy: 'text-source' } as unknown as AddShelfEntry;
    const huge = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n');
    const drafts = await addStrategyFor('text-source')({ tool, pickFiles: noPick, storeBytes: noStore, askText: async () => huge });
    expect(Array.isArray(drafts)).toBe(true);
    expect((drafts as readonly unknown[]).length).toBeLessThanOrEqual(5000);
  });
});
