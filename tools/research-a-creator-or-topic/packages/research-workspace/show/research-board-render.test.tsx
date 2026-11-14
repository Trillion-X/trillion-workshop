// package-set://bitfield-studio/packages/research-workspace/show/research-board-render.test.tsx
//
// #14 RENDER VERIFICATION — the gathered videos actually render as human-readable board rows,
// and the "paste a channel" Add control renders. jsdom render (no studio auth needed): the live
// in-app screenshot is operator-gated (real signed session), but VisualDatabaseSurface takes a
// `model` prop, so we can feed it the REAL feed shape through visual-database's own decode and
// assert the human sees the titles. Locks #14's render path against regression. DATA shapes are
// copied verbatim from bitfield-studio live (research-workspace.fields / .views /
// research-workspace-source-feed, 2026-07-01).
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeVisualDatabaseModel } from '@/packages/visual-database/read-data/visual-database';
import { VisualDatabaseSurface } from '@/packages/visual-database/show/VisualDatabaseSurface';
import { AddChannelPanel } from './AddChannelPanel';

afterEach(cleanup);

// Real live descriptors (dumped from the running studio).
const FIELDS = [
  { id: 'title', label: 'Video', paths: [['title']], role: 'title' },
  { id: 'duration', label: 'Length', paths: [['duration']], role: 'badge', shape: 'multi' },
  { id: 'published', label: 'Published', paths: [['published']], role: 'date' },
  { id: 'link', label: 'Watch', paths: [['url']], role: 'link' },
  { id: 'video_id', label: 'Video ID', paths: [['item_id']], role: 'id' },
  { id: 'description', label: 'Description', paths: [['description']], role: 'body' },
];
const VIEWS = { palette: [], views: [{ id: 'latest', kind: 'list', label: 'Latest videos', lanes: [], order: 0 }] };
// Real gathered items (the {items:[...]} feed shape visual-database reads via raw.items).
const FEED = {
  count: 3,
  error: null,
  items: [
    { description: '', item_id: 'iYlODtkyw_I', published: '', duration: ['35:05'], title: 'Survive 30 Days Chained To A Stranger, Win $250,000', url: 'https://www.youtube.com/watch?v=iYlODtkyw_I' },
    { description: '', item_id: '__fmDj0ZJ1Q', published: '', duration: ['32:08'], title: '50 YouTube Legends Fight For $1,000,000', url: 'https://www.youtube.com/watch?v=__fmDj0ZJ1Q' },
    { description: '', item_id: 'GpQSUjNsNm0', published: '', duration: ['32:15'], title: '7 Days Stranded in The Arctic', url: 'https://www.youtube.com/watch?v=GpQSUjNsNm0' },
  ],
};

describe('research board render (#14)', () => {
  it('renders the gathered videos as human-readable board rows', () => {
    const model = decodeVisualDatabaseModel({ records: FEED, fields: FIELDS as never, views: VIEWS as never, actions: undefined });
    render(<VisualDatabaseSurface model={model} />);
    // The user sees each video's title (the visual-database `title` role field).
    expect(screen.getByText(/7 Days Stranded in The Arctic/)).toBeTruthy();
    expect(screen.getByText(/Survive 30 Days Chained To A Stranger/)).toBeTruthy();
    expect(screen.getByText(/50 YouTube Legends Fight For \$1,000,000/)).toBeTruthy();
    // enriched metadata: the video length badge renders alongside the title
    expect(screen.getByText('35:05')).toBeTruthy();
  });

  it('decodes the real feed into exactly the gathered rows (no fabricated/empty rows)', () => {
    const model = decodeVisualDatabaseModel({ records: FEED, fields: FIELDS as never, views: VIEWS as never, actions: undefined });
    // visual-database projects raw.items into records; the count matches the gathered videos.
    expect(model.records.length).toBe(3);
    expect(model.records.map((r) => r.title)).toContain('7 Days Stranded in The Arctic');
  });

  it('renders the paste-a-channel Add control when configured', () => {
    const config = {
      title: 'Research a channel',
      placeholder: 'Paste a YouTube channel…',
      addLabel: 'Add',
      gatherTarget: 'slot::workflow',
      definitionId: 'action:research-gather',
      paramKey: 'channel_id',
      gatherTemplate: { fetch_target: 'compute.process', feed_address: 'research-workspace-source-feed' },
    };
    render(<AddChannelPanel config={config} />);
    // The paste input is present (the user can type a channel and Add it).
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});
