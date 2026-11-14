// @vitest-environment jsdom
// Proof for the board find-and-replace BRIDGE: it must replace across BOTH plain-text notes and rich
// html notes (text nodes only — tags preserved, no injection), skip connectors + furniture, keep
// `text` as the html plain projection, count correctly, and no-op cleanly.

import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, patchItem, readItems } from '../read-data/group-board-model';
import { applyTextReplace, countBoardMatches, replaceInHtml } from './board-text-replace';

const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };

function board() {
  let g = emptyGraph();
  const put = (args: Record<string, unknown>) =>
    (g = placeItem(g, PARENT, { nodeRef: { family: 'test.item', parts: { id: args.memberId } }, x: 0, y: 0, w: 100, h: 40, ...args } as never));
  put({ memberId: 'plain', kind: 'note', text: 'ship v1 and v1' });
  put({ memberId: 'rich', kind: 'note', text: 'Deploy v1 today, then v1' });
  g = patchItem(g, PARENT, 'rich', { html: '<p>Deploy <b>v1</b> today, then <i>v1</i></p>' }); // html set via patch (not placeItem)
  // A real connector is self-describing via extra.fromMemberId/toMemberId (itemIsConnector) — excluded.
  put({ memberId: 'conn', kind: 'connector', text: 'v1 edge label', extra: { fromMemberId: 'plain', toMemberId: 'none' } });
  put({ memberId: 'region-heading:lane:v1', kind: 'note', text: 'v1 lane', extra: { regionHeading: true } }); // furniture — excluded
  put({ memberId: 'none', kind: 'note', text: 'nothing to change' });
  return g;
}

const byId = (g: ReturnType<typeof emptyGraph>) => Object.fromEntries(readItems(g, PARENT).map((i) => [i.memberId, i]));

describe('applyTextReplace — plain + rich notes, furniture excluded', () => {
  it('replaces in a plain note and in a rich note (html text nodes) — tags preserved', () => {
    const { graph, matchCount, itemCount, touchedMemberIds } = applyTextReplace(board(), PARENT, { find: 'v1', replaceWith: 'v2' });
    const items = byId(graph);
    expect(items.plain.text).toBe('ship v2 and v2');
    // rich: html text nodes replaced, <b>/<i> tags intact; text refreshed to new plain projection
    expect(items.rich.html).toBe('<p>Deploy <b>v2</b> today, then <i>v2</i></p>');
    expect(items.rich.text).toBe('Deploy v2 today, then v2');
    expect(matchCount).toBe(4); // 2 in plain + 2 in rich
    expect(itemCount).toBe(2);
    expect(touchedMemberIds.sort()).toEqual(['plain', 'rich']);
  });

  it('never touches connectors or region-heading furniture (even though their text matches)', () => {
    const items = byId(applyTextReplace(board(), PARENT, { find: 'v1', replaceWith: 'v2' }).graph);
    expect(items.conn.text).toBe('v1 edge label'); // connector untouched
    expect(items['region-heading:lane:v1'].text).toBe('v1 lane'); // furniture untouched
  });

  it('no match → the SAME graph reference (trivially detectable no-op)', () => {
    const g = board();
    expect(applyTextReplace(g, PARENT, { find: 'zzz', replaceWith: 'q' }).graph).toBe(g);
  });

  it('scopeIds limits the replace to a selection', () => {
    const { graph, touchedMemberIds } = applyTextReplace(board(), PARENT, { find: 'v1', replaceWith: 'v2', scopeIds: ['plain'] });
    expect(touchedMemberIds).toEqual(['plain']);
    expect(byId(graph).rich.text).toBe('Deploy v1 today, then v1'); // rich excluded
  });

  it('a markup-looking replacement is inserted as TEXT, never parsed (no injection)', () => {
    const { graph } = applyTextReplace(board(), PARENT, { find: 'v1', replaceWith: '<img src=x onerror=alert(1)>' });
    const html = byId(graph).rich.html as string;
    // the angle brackets are escaped in the text node — no real <img> element created
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });
});

describe('countBoardMatches — preview equals effect (rich notes counted in plain text)', () => {
  it('counts across plain + rich, excludes connectors + furniture', () => {
    // plain: 2, rich: 2, none: 0; connector + furniture excluded → 4
    expect(countBoardMatches(board(), PARENT, { find: 'v1' })).toBe(4);
    expect(countBoardMatches(board(), PARENT, { find: 'v1' })).toBe(applyTextReplace(board(), PARENT, { find: 'v1', replaceWith: 'x' }).matchCount);
  });
});

describe('replaceInHtml — pure text-node replace', () => {
  it('replaces only in text nodes, refreshes textContent, counts occurrences', () => {
    const r = replaceInHtml('<p>a <b>cat</b> and a cat</p>', { find: 'cat', replaceWith: 'dog' });
    expect(r.html).toBe('<p>a <b>dog</b> and a dog</p>');
    expect(r.text).toBe('a dog and a dog');
    expect(r.count).toBe(2);
  });

  it('does not match inside tag names / attributes (structure is safe)', () => {
    // 'p' appears in the tag but must NOT be replaced — only visible text.
    const r = replaceInHtml('<p>keep the p</p>', { find: 'p', replaceWith: 'X', caseSensitive: true });
    expect(r.html).toBe('<p>keeX the X</p>'); // the <p> tags survive; text 'p's replaced
    expect(r.count).toBe(2);
  });

  it('literal replacement with a $-token is inserted VERBATIM in rich html (no corruption)', () => {
    // batch-6: the HTML text-node replace shares the replacementFor SSOT, so "$5"/"$&" are literal.
    const r = replaceInHtml('<p>cost here</p>', { find: 'cost', replaceWith: '$5', caseSensitive: true });
    expect(r.html).toBe('<p>$5 here</p>'); // literal "$5", NOT "" (the old $5 group-ref corruption)
    expect(r.text).toBe('$5 here');
    expect(r.count).toBe(1);
  });

  it('regex replacement backreference still works in rich html (feature preserved)', () => {
    const r = replaceInHtml('<b>ab</b>', { find: '(a)(b)', replaceWith: '$2$1', regex: true, caseSensitive: true });
    expect(r.html).toBe('<b>ba</b>');
    expect(r.count).toBe(1);
  });

  const richBoard = (html: string, text: string) => {
    let g = emptyGraph();
    g = placeItem(g, PARENT, { nodeRef: { family: 'test.item', parts: { id: 'rich' } }, x: 0, y: 0, w: 100, h: 40, memberId: 'rich', kind: 'note', text } as never);
    return patchItem(g, PARENT, 'rich', { html });
  };

  it('countBoardMatches equals the actual replace effect for a match SPANNING a tag boundary', () => {
    // "cat" is displayed but split across a <b> boundary as `<b>ca</b>t`, so replaceInHtml (per text
    // node) can NOT replace it. The old countBoardMatches counted the FLATTENED plain text ("cat")
    // and reported 1 — a preview that promised a replacement the effect could not deliver (count 1 vs
    // effect 0). The count must now equal the effect. Convergence batch-6 (Codex #6).
    const g = richBoard('<b>ca</b>t', 'cat');
    const opts = { find: 'cat', caseSensitive: true } as const;
    const count = countBoardMatches(g, PARENT, opts);
    const effect = applyTextReplace(g, PARENT, { ...opts, replaceWith: 'dog' }).matchCount;
    expect(count).toBe(effect); // structurally equal — no over-promise
    expect(count).toBe(0); // the cross-boundary "cat" is genuinely unreplaceable per node
  });

  it('countBoardMatches still counts a within-node rich match (count == effect, both 1)', () => {
    const g = richBoard('<b>cat</b> nap', 'cat nap');
    const opts = { find: 'cat', caseSensitive: true } as const;
    const count = countBoardMatches(g, PARENT, opts);
    const effect = applyTextReplace(g, PARENT, { ...opts, replaceWith: 'dog' }).matchCount;
    expect(count).toBe(effect);
    expect(count).toBe(1); // "cat" lives entirely inside the <b> node → counted AND replaceable
  });
});
