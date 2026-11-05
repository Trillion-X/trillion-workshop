// packages/group/show/appearance-preset-catalog.readCatalog.test.ts
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  APPEARANCE_PRESET_CATALOG_KIND,
  BUILT_IN_APPEARANCE_PRESETS,
  readAppearancePresetCatalog,
} from '../../../show/appearance-preset-catalog.ts';
import { presetKeyWrites } from '../../../show/appearance-presets.ts';

const rec = (presets: unknown) => ({ payload: { kind: APPEARANCE_PRESET_CATALOG_KIND, presets } });

describe('readAppearancePresetCatalog — presets as user-extensible DATA (via mergeCatalog)', () => {
  it('returns the built-in looks verbatim when no DATA presets exist', () => {
    expect(readAppearancePresetCatalog([]).map((p) => p.id)).toEqual(BUILT_IN_APPEARANCE_PRESETS.map((p) => p.id));
  });

  it('APPENDS a user-defined preset with an opaque profile bag (one DATA row, zero code)', () => {
    const cat = readAppearancePresetCatalog([rec([{ id: 'midnight', name: 'Midnight', profile: { containerVariant: 'panel', padding: 'lg' } }])]);
    const midnight = cat.find((p) => p.id === 'midnight');
    expect(midnight?.name).toBe('Midnight');
    expect(midnight?.profile).toEqual({ containerVariant: 'panel', padding: 'lg' });
    expect(cat.length).toBe(BUILT_IN_APPEARANCE_PRESETS.length + 1);
  });

  it('a DATA row overrides a built-in preset by id in place', () => {
    const cat = readAppearancePresetCatalog([rec([{ id: 'classic', name: 'Classic (mine)', profile: { padding: 'xs' } }])]);
    expect(cat[0].id).toBe('classic');
    expect(cat[0].name).toBe('Classic (mine)');
    expect(cat.length).toBe(BUILT_IN_APPEARANCE_PRESETS.length);
  });

  it('a preset with no/invalid profile is a valid no-op (empty bag), not dropped', () => {
    const cat = readAppearancePresetCatalog([rec([{ id: 'bare', name: 'Bare' }])]);
    expect(cat.find((p) => p.id === 'bare')?.profile).toEqual({});
  });

  it('skips rows missing id or name', () => {
    const cat = readAppearancePresetCatalog([rec([{ name: 'no id' }, { id: 'ok', name: 'Ok' }])]);
    expect(cat.length).toBe(BUILT_IN_APPEARANCE_PRESETS.length + 1);
    expect(cat.some((p) => p.id === 'ok')).toBe(true);
  });

  it('the built-in "Bubble map" preset defaults the node SHAPE — proof a new cascade key is instantly presettable (L069), zero apply-path change', () => {
    const bubble = BUILT_IN_APPEARANCE_PRESETS.find((p) => p.id === 'bubble-map');
    expect(bubble).toBeTruthy();
    // The preset carries `shape` alongside container/connector keys — the apply path (presetKeyWrites
    // → setBoardAppearanceKey) never enumerates keys, so this fell out for free once shape joined the cascade.
    expect(bubble!.profile.shape).toBe('ellipse');
    expect(bubble!.profile.connectorRouting).toBe('curved');
  });

  it('cont.26 (E4) — the Sketch preset bundles the cont.26 axes (named brushstroke + border + font) as pure DATA', () => {
    const sketch = BUILT_IN_APPEARANCE_PRESETS.find((p) => p.id === 'sketch');
    expect(sketch).toBeTruthy();
    // The cont.26 cascade keys are instantly presettable — L069 emergence, zero apply-path code. The
    // connector look is now the NAMED Line-style axis ('pencil'), not a raw roughness number (the collapse).
    expect(String(sketch!.profile.connectorStrokeStyle)).toBe('pencil'); // pencil connector brushstroke
    expect(String(sketch!.profile.borderStrokeStyle)).toBe('pencil'); // pencil note-border brushstroke (Line-style for borders)
    expect(String(sketch!.profile.fontFamily)).toContain('Comic'); // handwritten font
    // presetKeyWrites (the generic apply path) emits every key blindly — it never enumerates them.
    const keys = presetKeyWrites(sketch).map((w) => w.key);
    expect(keys).toContain('connectorStrokeStyle');
    expect(keys).toContain('fontFamily');
  });
});
