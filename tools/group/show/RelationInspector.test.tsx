// @vitest-environment jsdom
// packages/group/show/RelationInspector.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { RelationInspector } from './RelationInspector';
import { buildRelationGraph } from '../read-data/relationship-graph';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const node = (memberId: string): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, extra: {} } as unknown as BoardItem);
const conn = (memberId: string, from: string, to: string, relationKind?: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to, ...(relationKind ? { relationKind } : {}) } } as unknown as BoardItem);

// deploy depends-on build & test; build blocks ship. Chain: deploy -> build -> ship.
const items: BoardItem[] = [
  node('build'), node('test'), node('deploy'), node('ship'),
  conn('c1', 'deploy', 'build', 'depends-on'),
  conn('c2', 'deploy', 'test', 'depends-on'),
  conn('c3', 'build', 'ship', 'blocks'),
];
const graph = buildRelationGraph(items);
const titleOf = (id: string) => id.toUpperCase();

describe('RelationInspector', () => {
  it('shows the transitive UPSTREAM cone (what a card waits on beyond its direct prerequisites)', () => {
    // ship's direct prereq is build; deploy is the transitive-upstream shown on the ↑ line.
    const { container } = render(<RelationInspector graph={graph} memberId="ship" titleOf={titleOf} />);
    expect(container.textContent).toMatch(/waits on 1 upstream: DEPLOY/);
  });

  it('shows the transitive DOWNSTREAM ripple (unchanged behaviour)', () => {
    // deploy -> build -> ship, so beyond direct {build,test}, ship ripples downstream.
    const { container } = render(<RelationInspector graph={graph} memberId="deploy" titleOf={titleOf} />);
    expect(container.textContent).toMatch(/ripples to 1 more: SHIP/);
  });

  it('offers "Select impact cone" and clicking it selects self + all up/downstream', () => {
    const picks: string[][] = [];
    const { container } = render(
      <RelationInspector graph={graph} memberId="build" titleOf={titleOf} onSelectImpact={(ids) => picks.push([...ids])} />,
    );
    const btn = container.querySelector('[data-select-cone="build"]');
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    // build's cone here: itself + upstream {deploy} + downstream {ship} (build blocks ship)
    expect(picks[0]).toEqual(['build', 'deploy', 'ship']);
  });

  it('shows no cone action when no callback is given', () => {
    const { container } = render(<RelationInspector graph={graph} memberId="build" titleOf={titleOf} />);
    expect(container.querySelector('[data-select-cone]')).toBeNull();
  });
});
