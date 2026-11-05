import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  makeAppearancePreset,
  presetKeyWrites,
  applyPresetToExtra,
  presetIsEmpty,
} from '../../../show/appearance-presets.ts';
import { builtInPresetById } from '../../../show/appearance-preset-catalog.ts';

describe('makeAppearancePreset — capture a named appearance profile', () => {
  it('keeps only meaningful keys (drops empty/null/undefined so re-apply never clobbers a cascade fallback)', () => {
    const p = makeAppearancePreset('p1', 'Focus', {
      sizeMode: 'scroll',
      containerVariant: 'ghost',
      blank: '',
      nope: null,
      gone: undefined,
    });
    expect(p).toEqual({ id: 'p1', name: 'Focus', profile: { sizeMode: 'scroll', containerVariant: 'ghost' } });
  });

  it('an undefined/empty profile yields a no-op preset', () => {
    expect(makeAppearancePreset('p', 'Empty', undefined).profile).toEqual({});
    expect(presetIsEmpty(makeAppearancePreset('p', 'Empty', {}))).toBe(true);
  });
});

describe('presetKeyWrites — the per-key writes that apply through the P1 cascade paths', () => {
  it('emits one {key,value} per meaningful key, in stable sorted order (deterministic re-apply)', () => {
    const p = makeAppearancePreset('p', 'Look', { sizeMode: 'fill', containerVariant: 'elevated' });
    expect(presetKeyWrites(p)).toEqual([
      { key: 'containerVariant', value: 'elevated' },
      { key: 'sizeMode', value: 'fill' },
    ]);
  });

  it('is GENERIC over keys — a key this leaf never heard of still applies (L090)', () => {
    const p = makeAppearancePreset('p', 'Future', { cornerStyle: 'squircle', markerGlyph: 'star' });
    expect(presetKeyWrites(p)).toEqual([
      { key: 'cornerStyle', value: 'squircle' },
      { key: 'markerGlyph', value: 'star' },
    ]);
  });

  it('an empty / undefined preset yields zero writes', () => {
    expect(presetKeyWrites(undefined)).toEqual([]);
    expect(presetKeyWrites(makeAppearancePreset('p', 'E', {}))).toEqual([]);
  });

  it('the built-in board looks that theme CONNECTORS apply their style keys through the same generic path', () => {
    // Flowchart re-styles the board's idle connectors (elbow + arrows) AND the notes (Card) in one
    // apply — the connector-style cascade keys flow through the SAME presetKeyWrites (zero special-casing).
    const flow = presetKeyWrites(builtInPresetById('flowchart'));
    expect(flow).toContainEqual({ key: 'connectorRouting', value: 'elbow' });
    expect(flow).toContainEqual({ key: 'connectorArrow', value: 'end' });
    expect(flow).toContainEqual({ key: 'containerVariant', value: 'elevated' });
    // Mind map: curved + no arrows; Blueprint: dashed straight lines — all pure DATA, no code path.
    expect(presetKeyWrites(builtInPresetById('mindmap'))).toContainEqual({ key: 'connectorArrow', value: 'none' });
    expect(presetKeyWrites(builtInPresetById('blueprint'))).toContainEqual({ key: 'connectorDashed', value: true });
  });
});

describe('applyPresetToExtra — item-tier apply is a pure merge (preset wins, rest preserved)', () => {
  it('folds the preset onto an existing extra bag without touching unrelated keys', () => {
    const extra = { rotation: 12, sizeMode: 'fit', href: 'x' };
    const p = makeAppearancePreset('p', 'Look', { sizeMode: 'scroll', containerVariant: 'ghost' });
    expect(applyPresetToExtra(extra, p)).toEqual({
      rotation: 12, // untouched
      href: 'x', // untouched
      sizeMode: 'scroll', // preset wins
      containerVariant: 'ghost', // preset adds
    });
  });

  it('applying an empty preset returns the bag unchanged (no-op)', () => {
    const extra = { sizeMode: 'fit' };
    expect(applyPresetToExtra(extra, makeAppearancePreset('p', 'E', {}))).toEqual({ sizeMode: 'fit' });
    expect(applyPresetToExtra(undefined, undefined)).toEqual({});
  });
});
