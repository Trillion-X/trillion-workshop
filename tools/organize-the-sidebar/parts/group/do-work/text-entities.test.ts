// packages/group/do-work/text-entities.test.ts
//
// Pure proof of the inline entity detector. No DOM — detectEntities is a plain text→spans function.
// Covers each built-in kind, the adversarial overlap cases (a URL that contains an @ / #frag; user-0c7e6a40@example.com is
// an email not a mention), the injected-map extensibility (a custom pattern with ZERO tokenizer change), the
// href builders, and the non-overlapping/sorted invariant.

import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { detectEntities, entityHref, entitiesOfKind, type EntityPattern } from '../../../do-work/text-entities.ts';

const kinds = (text: string) => detectEntities(text).map((e) => `${e.kind}:${e.value}`);

describe('detectEntities', () => {
  it('detects a URL, email, hashtag and mention in one sentence at correct spans', () => {
    const text = 'see https://a.com or mail user-ad9b96b3@example.com re #pottery cc @coach';
    const ents = detectEntities(text);
    // every span slices back to its value → indices are correct
    for (const e of ents) expect(text.slice(e.start, e.end)).toBe(e.value);
    expect(kinds(text)).toEqual(['url:https://a.com', 'email:user-ad9b96b3@example.com', 'hashtag:#pottery', 'mention:@coach']);
  });

  it('a trailing sentence punctuation is left OUTSIDE the URL', () => {
    expect(detectEntities('go to https://a.com/path.')[0]).toMatchObject({ kind: 'url', value: 'https://a.com/path' });
    expect(detectEntities('(see https://a.com)')[0].value).toBe('https://a.com');
  });

  it('a bare www. URL is detected and hrefs to https://', () => {
    const [e] = detectEntities('visit www.example.com now');
    expect(e).toMatchObject({ kind: 'url', value: 'www.example.com' });
    expect(entityHref(e)).toBe('https://www.example.com');
  });

  it('OVERLAP: a URL containing a #frag yields ONLY the URL (the inner hashtag is dropped)', () => {
    expect(kinds('open https://a.com/x#section please')).toEqual(['url:https://a.com/x#section']);
  });

  it('OVERLAP: user-0c7e6a40@example.com is an EMAIL, never a @mention of bar', () => {
    expect(kinds('ping user-0c7e6a40@example.com today')).toEqual(['email:user-0c7e6a40@example.com']);
  });

  it('adjacent entities are BOTH detected (non-overlapping)', () => {
    expect(kinds('#a @b')).toEqual(['hashtag:#a', 'mention:@b']);
  });

  it('a conservative phone (with + country code) is detected and tel:-normalised', () => {
    const [e] = detectEntities('call +1 201 555 0123 anytime');
    expect(e.kind).toBe('phone');
    expect(entityHref(e)).toBe('tel:+12015550123');
    // a plain date-like number run is NOT a phone (no + or (area) code)
    expect(detectEntities('on 2026 06 24 at noon').length).toBe(0);
  });

  it('href builders: url→itself, email→mailto:, hashtag→null (a board action, not a link)', () => {
    expect(entityHref(detectEntities('https://a.com')[0])).toBe('https://a.com');
    expect(entityHref(detectEntities('user-ad9b96b3@example.com')[0])).toBe('mailto:user-ad9b96b3@example.com');
    expect(entityHref(detectEntities('#tag')[0])).toBeNull();
    expect(entityHref(detectEntities('@user')[0])).toBeNull();
  });

  it('is INJECTED-MAP extensible: a custom ticket pattern detects with ZERO tokenizer change (L090)', () => {
    const patterns: EntityPattern[] = [
      { kind: 'ticket', regex: /\bT-\d+\b/g, href: (v) => `/tickets/${v}` },
    ];
    const ents = detectEntities('fixes T-42 and T-7', patterns);
    expect(ents.map((e) => e.value)).toEqual(['T-42', 'T-7']);
    expect(entityHref(ents[0], patterns)).toBe('/tickets/T-42');
  });

  it('entitiesOfKind extracts every value of a kind (the auto-tag emergent use)', () => {
    expect(entitiesOfKind('#a hi #b then #a again', 'hashtag')).toEqual(['#a', '#b', '#a']);
  });

  it('empty / entity-free text → [] and the result is always sorted + non-overlapping', () => {
    expect(detectEntities('')).toEqual([]);
    expect(detectEntities('just some plain words')).toEqual([]);
    const ents = detectEntities('a https://a.com b user-ad9b96b3@example.com c #d e @f');
    for (let i = 1; i < ents.length; i += 1) expect(ents[i].start).toBeGreaterThanOrEqual(ents[i - 1].end);
  });
});
