import React from 'react';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The owned sidebar composes @tanstack/react-virtual, which reads ResizeObserver.
// jsdom lacks it; a no-op polyfill keeps the header/search chrome deterministic
// (virtualized rows measure to 0 in jsdom, but the rail chrome we assert on renders).
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// STABLE reference, not a fresh [] per call. The real `useBitfieldData` returns
// the same object while the underlying data is unchanged, and the owned sidebar
// feeds its result straight into a useMemo dependency. A mock that allocates a
// new array every render makes that memo recompute forever, and the surface OOMs
// the test worker with no error message at all.
const EMPTY_BITFIELD_FEED: readonly never[] = Object.freeze([]);
vi.mock('@bitfield/runtime-kit/react', () => ({ useBitfieldData: vi.fn(() => EMPTY_BITFIELD_FEED) }));
vi.mock('@bitfield/runtime-kit', () => ({ sendRequestToBitfieldTarget: vi.fn() }));
vi.mock('@/packages/ui/show/placeable-surface-host', () => ({
  PlaceableSurfaceHost: ({ packageName, entryName }: { packageName: string; entryName: string }) => (
    <div data-testid="mounted-owner">{packageName}/{entryName}</div>
  ),
}));

import {
  AccessScopedContentView,
  containmentCollections,
  contentCollections,
  filterItemsWithAncestors,
  visibleViewerItems,
} from '../../../../shared-code/packages/access-scoped-content/show/AccessScopedContent';

const item = {
  id: 'item:1',
  content_ref: 'content:1',
  label: 'First principles',
  available: true,
  access_decision_ref: 'decision:1',
  access_decision_revision: 2,
  access_decision_current_revision: 2,
  render_surface: {
    schema: 'render-surface-descriptor/v1',
    package_entry: { package_name: 'documents', entry_name: 'composition-scene' },
    surface_input: { scene_address: 'scene:1' },
  },
};

describe('AccessScopedContentView', () => {
  afterEach(cleanup);

  it('mounts the exact arbitrary owner surface descriptor', () => {
    render(<AccessScopedContentView items={[item]} />);
    expect(screen.getByTestId('mounted-owner').textContent).toBe('documents/composition-scene');
  });

  it('does not mount an unknown renderer', () => {
    render(<AccessScopedContentView items={[{ ...item, render_surface: {} } as never]} />);
    expect(screen.queryByTestId('mounted-owner')).toBeNull();
    expect(screen.getByText('This content is not available right now.')).toBeTruthy();
  });

  it('unmounts immediately when the current access decision is revoked', () => {
    const view = render(<AccessScopedContentView items={[item]} />);
    expect(screen.getByTestId('mounted-owner')).toBeTruthy();
    view.rerender(<AccessScopedContentView items={[{ ...item, available: false }]} />);
    expect(screen.queryByTestId('mounted-owner')).toBeNull();
  });

  it('shows one explicit purchased-download action only for an available gated item', () => {
    const download = {
      ...item,
      required_access_refs: ['product-access:harness-owners'],
      render_surface: {
        ...item.render_surface,
        surface_input: {
          download_url: 'https://example.test/kit.zip',
          file_name: 'operator-kit.zip',
          download_label: 'Operator Kit',
        },
      },
    };
    const view = render(<AccessScopedContentView items={[download]} />);
    const link = screen.getByRole('link', { name: 'Download Operator Kit' });
    expect(link.getAttribute('href')).toBe('https://example.test/kit.zip');
    view.rerender(<AccessScopedContentView items={[{ ...download, available: false }]} />);
    expect(screen.queryByRole('link', { name: 'Download Operator Kit' })).toBeNull();
  });

  // REGRESSION GUARD (the reported bug): a multi-lesson program rendered its lesson
  // list stacked ON TOP of the video instead of the collapsible rail beside it.
  // The fix routes >1 lesson through the OWNED sidebar in a horizontal
  // layout. This asserts the rail chrome (its search input) renders ALONGSIDE the
  // player, so the two are side by side, not stacked-instead-of.
  const item2 = { ...item, id: 'item:2', content_ref: 'content:2', label: 'Footwork' };

  it('groups lessons under their authored programs and keeps their lesson order', () => {
    const collections = contentCollections([
      { ...item2, collection_ref: 'program:method', collection_label: 'Forehand Method 2.0', collection_order: 2, item_order: 2 },
      { ...item, collection_ref: 'program:first-principles', collection_label: 'The First Principles of Tennis', collection_order: 1, item_order: 1 },
      { ...item, id: 'item:3', label: 'Setup', collection_ref: 'program:method', collection_label: 'Forehand Method 2.0', collection_order: 2, item_order: 1 },
    ], 'Learn');
    expect(collections.map((collection) => collection.name)).toEqual([
      'The First Principles of Tennis',
      'Forehand Method 2.0',
    ]);
    expect(collections[1].items.map((lesson) => lesson.label)).toEqual(['Setup', 'Footwork']);
  });

  it('multi-lesson renders the collapsible lesson rail BESIDE the player', () => {
    render(<AccessScopedContentView items={[item, item2]} />);
    // Rail present: the owned sidebar's search input (default expanded state).
    expect(screen.getByPlaceholderText('Search lessons')).toBeTruthy();
    // Player present at the same time: the selected lesson's owner surface mounts.
    expect(screen.getByTestId('mounted-owner').textContent).toBe('documents/composition-scene');
  });

  // This used to assert the deleted rail's private DOM: an injected style block
  // overriding `> div:first-child`, inline color-mix backgrounds on hand-rolled
  // buttons, and a hardcoded 72px virtual row height. None of that survived the
  // move to the owned sidebar, and none of it should have: selection treatment,
  // focus ring and list inset are the sidebar's job now, applied to every surface
  // at once instead of being CSS-injected into one. What a LEARNER actually needs
  // is asserted instead, and that is what should have been asserted all along.
  it('marks the open lesson, moves that mark on click, and keeps a locked lesson visible but unopenable', () => {
    const onOpenItem = vi.fn();
    render(<AccessScopedContentView items={[item, item2, { ...item, id: 'locked', label: 'Locked lesson', available: false }]} onOpenItem={onOpenItem} />);

    // The owned sidebar gives every row a drag handle as well as the nav button,
    // so match the nav row exactly rather than by substring.
    const navRow = (label: string) =>
      screen.getAllByRole('button', { name: new RegExp(label) })
        .find((el) => !(el.getAttribute('aria-label') ?? '').startsWith('Drag'))!;
    const first = navRow('First principles');
    const second = navRow('Footwork');

    expect(first.getAttribute('aria-current')).toBe('true');
    expect(second.getAttribute('aria-current')).not.toBe('true');

    fireEvent.click(second);
    expect(onOpenItem).toHaveBeenCalledWith(item2);
    const locked = navRow('Locked lesson');
    expect(locked.hasAttribute('disabled')).toBe(true);
    fireEvent.click(locked);
    expect(onOpenItem).toHaveBeenCalledTimes(1);
    expect(second.getAttribute('aria-current')).toBe('true');
    expect(first.getAttribute('aria-current')).not.toBe('true');

    // The rail still owns a search field, so a long program stays navigable.
    expect(screen.getByPlaceholderText('Search lessons')).toBeTruthy();
  });

  it('opens nested, searchable lesson navigation in the compact layout', () => {
    const previousMatchMedia = globalThis.matchMedia;
    globalThis.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    try {
      const onOpenItem = vi.fn();
      render(<AccessScopedContentView items={[item, item2]} onOpenItem={onOpenItem} />);
      expect(screen.queryByRole('combobox')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /Course contents/ }));
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(screen.getByPlaceholderText('Search lessons')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /Footwork/ }));
      expect(onOpenItem).toHaveBeenCalledWith(item2);
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      globalThis.matchMedia = previousMatchMedia;
    }
  });

  it('single-lesson renders NO rail (player fills the surface)', () => {
    render(<AccessScopedContentView items={[item]} />);
    expect(screen.queryByPlaceholderText('Search lessons')).toBeNull();
    expect(screen.getByTestId('mounted-owner')).toBeTruthy();
  });

  it('a program opened on itself lists everything inside it, grouped by what contains it', () => {
    // The shape Julien has: one program, a module inside it, lessons inside the
    // module. Before this the surface picked the program row out of the library
    // and played it, so a paid course showed exactly one video and no way in.
    const program = { ...item, id: 'program', content_ref: 'content:program', label: 'First Principles' };
    const module1 = { ...item, id: 'module-1', content_ref: 'content:module-1', label: 'The Five Axioms', parent_ref: 'program' };
    const lesson1 = { ...item, id: 'lesson-1', content_ref: 'content:lesson-1', label: 'The Court', parent_ref: 'module-1' };
    const lesson2 = { ...item, id: 'lesson-2', content_ref: 'content:lesson-2', label: 'The Ball', parent_ref: 'module-1' };
    const other = { ...item, id: 'other-program', content_ref: 'content:other', label: 'Forehand Method' };

    render(
      <AccessScopedContentView
        items={[program, module1, lesson1, lesson2, other]}
        surfaceInput={{ access_item_id: 'program' }}
        title="First Principles"
      />,
    );

    expect(screen.getByText('The Court')).toBeTruthy();
    expect(screen.getByText('The Ball')).toBeTruthy();
    // The module is the heading its lessons sit under, not a row beside them.
    expect(screen.getByText('The Five Axioms')).toBeTruthy();
    // A different program's contents stay in that program.
    expect(screen.queryByText('Forehand Method')).toBeNull();
    expect(screen.getByPlaceholderText('Search lessons')).toBeTruthy();
  });

  it('a library of programs keeps every level, with lists inside lists', () => {
    // Julien's shape as it actually is: four programs in a library, one of them
    // holding a module that holds its own week. Grouping by immediate parent
    // scattered these into unrelated sections; grouping by outermost ancestor
    // crushed them flat. Neither is a course. Each program is a list, and a list
    // inside it is a list inside it, however deep it goes.
    const at = (id: string, label: string, parent?: string) => ({
      ...item,
      id,
      content_ref: `content:${id}`,
      label,
      ...(parent ? { parent_ref: parent } : {}),
    });
    const collections = containmentCollections([
      at('first-principles', 'The First Principles of Tennis'),
      at('video-course', 'Video course', 'first-principles'),
      at('week-one', 'Week one', 'video-course'),
      at('ball', 'The Ball', 'week-one'),
      at('court', 'The Court', 'video-course'),
      at('intro', 'Introduction', 'first-principles'),
      at('method', 'Forehand Method 2.0'),
      at('grip', 'The Grip', 'method'),
      at('free-clip', 'A free clip'),
    ], 'Learn', null);

    // At library level, unrelated standalone rows do not become a synthetic
    // "Learn" course ahead of the actual programs.
    expect(collections.map((collection) => collection.name))
      .toEqual(['The First Principles of Tennis', 'Forehand Method 2.0']);

    const principles = collections[0];
    expect(principles?.items.map((lesson) => lesson.label)).toEqual(['Introduction']);
    const videoCourse = principles?.collections?.[0];
    expect(videoCourse?.name).toBe('Video course');
    expect(videoCourse?.items.map((lesson) => lesson.label)).toEqual(['The Court']);
    const weekOne = videoCourse?.collections?.[0];
    expect(weekOne?.name).toBe('Week one');
    expect(weekOne?.items.map((lesson) => lesson.label)).toEqual(['The Ball']);

    // A program that holds one lesson is still a list, not a row that plays.
    expect(collections[1]?.items.map((lesson) => lesson.label)).toEqual(['The Grip']);

    // Opening a program still shows its direct lessons beside its modules.
    const inside = containmentCollections([
      at('first-principles', 'The First Principles of Tennis'),
      at('intro', 'Introduction', 'first-principles'),
      at('video-course', 'Video course', 'first-principles'),
      at('ball', 'The Ball', 'video-course'),
    ], 'Learn', 'first-principles');
    expect(inside[0]?.items.map((lesson) => lesson.label)).toEqual(['Introduction']);
    expect(inside[1]?.name).toBe('Video course');
  });

  it('a row naming its own ancestor as its parent stops instead of drawing forever', () => {
    const loop = [
      { ...item, id: 'a', content_ref: 'content:a', label: 'A', parent_ref: 'b' },
      { ...item, id: 'b', content_ref: 'content:b', label: 'B', parent_ref: 'a' },
    ];
    expect(() => containmentCollections(loop, 'Learn', null)).not.toThrow();
  });

  it('search retains every parent of a matching lesson so its course rail stays mounted', () => {
    const rows = [
      { ...item, id: 'program', content_ref: 'content:program', label: 'Program' },
      { ...item, id: 'module', content_ref: 'content:module', label: 'Module', parent_ref: 'content:program' },
      { ...item, id: 'lesson', content_ref: 'content:lesson', label: 'Describing All Five Axioms', parent_ref: 'content:module' },
      { ...item, id: 'other', content_ref: 'content:other', label: 'Other lesson', parent_ref: 'content:module' },
    ];
    const found = filterItemsWithAncestors(rows, 'Describing All Five');
    expect(found.map((row) => row.id)).toEqual(['program', 'module', 'lesson']);
    const collections = containmentCollections(found, 'Library', null);
    expect(collections[0]?.collections?.[0]?.items.map((row) => row.id)).toEqual(['lesson']);
  });

  it('keeps the visible lesson rail while searching for one nested lesson', () => {
    const rows = [
      { ...item, id: 'program', content_ref: 'content:program', label: 'Program' },
      { ...item, id: 'module', content_ref: 'content:module', label: 'Module', parent_ref: 'content:program' },
      { ...item, id: 'lesson', content_ref: 'content:lesson', label: 'Describing All Five Axioms', parent_ref: 'content:module' },
    ];
    render(<AccessScopedContentView items={rows} title="Library" />);
    fireEvent.change(screen.getByPlaceholderText('Search lessons'), { target: { value: 'Describing All Five' } });
    expect(screen.getByPlaceholderText('Search lessons')).toBeTruthy();
    expect(screen.getByTestId('mounted-owner')).toBeTruthy();
  });

  it('empty program shows the honest empty state, no rail', () => {
    render(<AccessScopedContentView items={[]} />);
    expect(screen.queryByPlaceholderText('Search lessons')).toBeNull();
    expect(screen.getByText('Nothing is available here yet.')).toBeTruthy();
  });


  // THE RENDER IS THE SEAM THE PURE TESTS CANNOT SEE.
  // A bundle whose every pure test passed was pushed live and the page never
  // finished loading, and nobody ever found out why, because the failure lives
  // between these owners and React, not inside either one. The note at the top
  // of this file names the exact mechanism: a value rebuilt on every render and
  // then used as a memo dependency spins forever with no error to read. So this
  // mounts the whole surface on the rows the app actually ships. A spin fails
  // here as a timeout instead of as a white screen a customer sees.
  it('mounts the shipped library rows without spinning', { timeout: 10000 }, () => {
    const setsFolder = path.join(
      path.dirname(fileURLToPath(import.meta.url)), '../../..', 'package-sets',
    );
    const shipped: { setName: string; rows: unknown[] }[] = [];
    for (const setName of readdirSync(setsFolder).sort()) {
      const folder = path.join(setsFolder, setName, 'package-set-records');
      let fileNames: string[] = [];
      try { fileNames = readdirSync(folder).sort(); } catch { continue; }
      for (const fileName of fileNames) {
        if (!fileName.endsWith('.json')) continue;
        const parsed = JSON.parse(readFileSync(path.join(folder, fileName), 'utf8'));
        const records = Array.isArray(parsed) ? parsed : parsed?.records;
        if (!Array.isArray(records)) continue;
        for (const record of records) {
          if (record?.address !== 'package-set-records::access-scoped-content-projection') continue;
          if (Array.isArray(record.payload) && record.payload.length > 0) {
            shipped.push({ setName, rows: record.payload });
          }
        }
      }
    }
    expect(shipped.length).toBeGreaterThan(0);
    for (const { setName, rows } of shipped) {
      cleanup();
      expect(() => render(<AccessScopedContentView items={rows as never} />), setName).not.toThrow();
    }
  });


  // THE RAIL IS ONLY THE OWNED SIDEBAR WHEN ALL FOUR ARRIVE TOGETHER.
  // `AppSidebar` returns the plain static content unless containerRef,
  // instanceId AND capabilities are all present. Dropping any one is invisible
  // in code, passes every other test in this file, and costs the learner the
  // whole rail: no move, no collapse, no undock, no hide, no resize. It had
  // been dropped here, while the comment above the rail claimed those abilities
  // already worked. This asserts the chrome, so the next omission fails.
  it('gives the lesson rail the sidebar chrome, not a static list', () => {
    const program = { ...item, id: 'program', content_ref: 'content:program', label: 'Program' };
    const lesson = { ...item2, id: 'lesson', content_ref: 'content:lesson', label: 'Lesson', parent_ref: 'program' };
    render(<AccessScopedContentView items={[program, lesson]} />);
    const labels = new Set([...document.querySelectorAll('[aria-label]')]
      .map((node) => node.getAttribute('aria-label')));
    // These exist only in the contained frame. A plain list has none of them.
    for (const label of ['Sidebar', 'Position', 'Move to left', 'Move to right', 'Move to top', 'Move to bottom']) {
      expect(labels.has(label), label).toBe(true);
    }
  });

  // The docked rail overlays the surface. If the player does not move out of
  // the space the rail takes, the rail sits on top of the video, which is what
  // learners saw the first time this rail shipped.
  it('keeps the player out from under the docked rail', () => {
    const program = { ...item, id: 'program', content_ref: 'content:program', label: 'Program' };
    const lesson = { ...item2, id: 'lesson', content_ref: 'content:lesson', label: 'Lesson', parent_ref: 'program' };
    render(<AccessScopedContentView items={[program, lesson]} />);
    const stage = document.querySelector('main');
    expect(stage?.style.marginLeft).toBe('var(--stage-inset-left, 0px)');
    expect(stage?.style.marginTop).toBe('var(--stage-inset-top, 0px)');
  });

  it('counts and lists only content the current viewer can open', () => {
    const gated = {
      ...item2,
      available: false,
      required_access_refs: ['product-access:harness-owners'],
    };
    expect(visibleViewerItems([item, gated])).toEqual([item]);
  });
});
