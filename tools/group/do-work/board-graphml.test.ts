// packages/group/do-work/board-graphml.test.ts
import { describe, it, expect } from 'vitest';
import { boardToGraphml } from './board-graphml';
import type { BoardItem } from '../read-data/group-board-model';

const card = (memberId: string, text: string): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text, extra: {} } as unknown as BoardItem);
const edge = (memberId: string, from: string, to: string, kind = 'depends-on'): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to, relationKind: kind } } as unknown as BoardItem);

describe('boardToGraphml', () => {
  it('emits a well-formed GraphML skeleton with the attribute keys', () => {
    const xml = boardToGraphml([card('a', 'Alpha')]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<graphml xmlns="http://graphml.graphdrawing.org/xmlns">');
    expect(xml).toContain('<key id="importance" for="node" attr.name="importance" attr.type="double"/>');
    expect(xml).toContain('<key id="community" for="node" attr.name="community" attr.type="int"/>');
    expect(xml.trimEnd().endsWith('</graphml>')).toBe(true);
  });

  it('one node per content card with label + degree; one edge per connector with its relation', () => {
    const xml = boardToGraphml([card('a', 'Alpha'), card('b', 'Beta'), edge('e1', 'a', 'b')]);
    expect(xml).toContain('<data key="label">Alpha</data>');
    expect(xml).toContain('<data key="label">Beta</data>');
    expect((xml.match(/<node /g) ?? []).length).toBe(2);
    expect((xml.match(/<edge /g) ?? []).length).toBe(1);
    expect(xml).toContain('<data key="relation">depends-on</data>');
    expect(xml).toContain('<data key="degree">1</data>'); // each endpoint touched by one connector
  });

  it('enriches nodes with PageRank importance + a community index (the b147/b148 composition)', () => {
    // hub endorsed by a,b → higher importance than a leaf; a+b+hub form one community (index 0).
    const xml = boardToGraphml([card('hub', 'Hub'), card('a', 'A'), card('b', 'B'), edge('e1', 'a', 'hub'), edge('e2', 'b', 'hub')]);
    const hubBlock = xml.slice(xml.indexOf('<data key="label">Hub</data>'));
    const hubImportance = Number(/<data key="importance">([\d.]+)<\/data>/.exec(hubBlock)?.[1]);
    expect(hubImportance).toBeGreaterThan(0);
    expect(xml).toMatch(/<data key="community">\d+<\/data>/);
  });

  it('XML-escapes card text so it cannot break the document', () => {
    const xml = boardToGraphml([card('a', 'Tom & <Jerry> "quote" \'apos\'')]);
    expect(xml).toContain('<data key="label">Tom &amp; &lt;Jerry&gt; &quot;quote&quot; &apos;apos&apos;</data>');
    expect(xml).not.toContain('<Jerry>');
  });

  it('excludes connectors + sections from nodes and drops a dangling connector', () => {
    const items = [card('a', 'A'), { ...card('sec', ''), isSection: true } as BoardItem, edge('e1', 'a', 'ghost')];
    const xml = boardToGraphml(items);
    expect((xml.match(/<node /g) ?? []).length).toBe(1); // only 'a'
    expect((xml.match(/<edge /g) ?? []).length).toBe(0); // dangling a→ghost dropped by the graph SSOT
  });

  it('is deterministic', () => {
    const build = () => [card('a', 'A'), card('b', 'B'), edge('e1', 'a', 'b')];
    expect(boardToGraphml(build())).toBe(boardToGraphml(build()));
  });
});
