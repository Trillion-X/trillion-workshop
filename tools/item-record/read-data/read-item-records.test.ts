// package://packages/item-record/read-data/read-item-records.test.ts
//
// Unit tests for decodeFeedItem and splitFeed.
// Covers: partition, dedup, sort, category extraction, legacy rows, missing fields.

import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { decodeFeedItem, decodeFeedItems, decodeFeedRowsForSubject, splitFeed } from './read-item-records.ts';

const admittedScope = {
  actor_ref: 'actor:server', session_ref: 'session:server', subject_ref: 'scope:test', action_ref: 'action:read', decision_proof: 'decision:test',
  revisions: { session_revision: 'session:1', policy_revision: 'policy:1', membership_revision: 'membership:1', resource_revision: 'resource:1' },
};

// ---------------------------------------------------------------------------
// decodeFeedItem — tolerance + field mapping
// ---------------------------------------------------------------------------

describe('decodeFeedItem', () => {
  it('decodes a full post row', () => {
    const row = {
      item_ref: 'item-record:post-1',
      actor_ref: 'actor:alice',
      target_ref: 'group:g1',
      created_at: '2026-06-10T10:00:00.000Z',
      fields: JSON.stringify({
        kind: 'post',
        title: 'Hello World',
        body: 'First post',
        categoryRef: 'cat:general',
      }),
    };
    const item = decodeFeedItem(row, 0);
    expect(item).not.toBeNull();
    expect(item!.id).toBe('post-1');
    expect(item!.kind).toBe('post');
    expect(item!.title).toBe('Hello World');
    expect(item!.body).toBe('First post');
    expect(item!.categoryRef).toBe('cat:general');
    expect(item!.actorRef).toBe('actor:alice');
    expect(item!.targetRef).toBe('group:g1');
    expect(item!.when).toBe('2026-06-10T10:00:00.000Z');
  });

  it('decodes a comment row with parentRef', () => {
    const row = {
      item_ref: 'item-record:comment-1',
      actor_ref: 'actor:bob',
      fields: JSON.stringify({
        kind: 'comment',
        body: 'Nice post!',
        parentRef: 'item-record:post-1',
      }),
    };
    const item = decodeFeedItem(row, 0);
    expect(item!.kind).toBe('comment');
    expect(item!.parentRef).toBe('post-1');
    expect(item!.body).toBe('Nice post!');
  });

  it('decodes a reaction row (no title/body required)', () => {
    const row = {
      item_ref: 'item-record:reaction-1',
      actor_ref: 'actor:carol',
      fields: JSON.stringify({
        kind: 'reaction',
        parentRef: 'item-record:post-1',
      }),
    };
    const item = decodeFeedItem(row, 0);
    expect(item).not.toBeNull();
    expect(item!.kind).toBe('reaction');
    expect(item!.parentRef).toBe('post-1');
    expect(item!.actorRef).toBe('actor:carol');
  });

  it('uses the open generic fallback when no kind is supplied', () => {
    const row = {
      item_ref: 'item-record:legacy-1',
      fields: JSON.stringify({ body: 'Old post without kind' }),
    };
    const item = decodeFeedItem(row, 0);
    expect(item!.kind).toBe('primary');
    expect(item!.body).toBe('Old post without kind');
  });

  it('returns null for rows with no content (no body, no title, not a reaction)', () => {
    const result = decodeFeedItem({ item_ref: 'x', fields: '{}' }, 0);
    expect(result).toBeNull();
  });

  it('tolerates completely missing fields key', () => {
    const row = { item_ref: 'item-record:bare-1', body: 'Direct body' };
    const item = decodeFeedItem(row, 0);
    expect(item!.body).toBe('Direct body');
    expect(item!.kind).toBe('primary');
  });

  it('tolerates fields as a parsed object (not a JSON string)', () => {
    const row = {
      item_ref: 'item-record:parsed-1',
      fields: { kind: 'post', body: 'Already parsed' },
    };
    const item = decodeFeedItem(row, 0);
    expect(item!.body).toBe('Already parsed');
  });

  it('falls back to row index as id when no id field present', () => {
    const item = decodeFeedItem({ body: 'no id field' }, 42);
    expect(item!.id).toBe('row-42');
  });
});

describe('decodeFeedRowsForSubject', () => {
  it('requires exact scope ownership and sorts newest posts first', () => {
    const items = decodeFeedRowsForSubject([
      { item_ref: 'item:older', scope_ref: 'community:one', created_at: '2026-09-22T12:00:00.000Z', fields: { kind: 'post', body: 'Older' } },
      { item_ref: 'item:newer', scope_ref: 'community:one', created_at: '2026-09-23T12:00:00.000Z', fields: { kind: 'post', body: 'Newer' } },
      { item_ref: 'item:foreign', scope_ref: 'community:two', created_at: '2026-09-24T12:00:00.000Z', fields: { kind: 'post', body: 'Foreign' } },
      { item_ref: 'item:unscoped', created_at: '2026-09-25T12:00:00.000Z', fields: { kind: 'post', body: 'Unscoped' } },
    ], 'community:one');
    expect(items.map((item) => item.body)).toEqual(['Newer', 'Older']);
  });

  it('does not decode rows when the requested subject is missing', () => {
    expect(decodeFeedRowsForSubject([{ scope_ref: 'community:one', fields: { body: 'No subject' } }], '')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// splitFeed — partition, dedup, sort, category extraction
// ---------------------------------------------------------------------------

describe('splitFeed', () => {
  function makePost(id: string, opts: Partial<{
    categoryRef: string | null;
    when: string;
    actorRef: string;
    title: string;
  }> = {}): ReturnType<typeof decodeFeedItem> {
    return decodeFeedItem({
      item_ref: id,
      actor_ref: opts.actorRef ?? 'actor:alice',
      created_at: opts.when ?? '2026-06-10T10:00:00.000Z',
      fields: {
        kind: 'post',
        title: opts.title ?? 'Post',
        body: 'body',
        categoryRef: opts.categoryRef ?? null,
      },
    }, 0)!;
  }

  function makeComment(id: string, parentRef: string, when = '2026-06-10T10:01:00.000Z'): ReturnType<typeof decodeFeedItem> {
    return decodeFeedItem({
      item_ref: id,
      actor_ref: 'actor:bob',
      created_at: when,
      fields: { kind: 'comment', body: 'comment body', parentRef },
    }, 0)!;
  }

  function makeReaction(id: string, parentRef: string, actorRef = 'actor:carol', when = '2026-06-10T10:02:00.000Z'): ReturnType<typeof decodeFeedItem> {
    return decodeFeedItem({
      item_ref: id,
      actor_ref: actorRef,
      created_at: when,
      fields: { kind: 'reaction', parentRef },
    }, 0)!;
  }

  it('partitions posts, comments, and reactions into correct buckets', () => {
    const post = makePost('item-record:p1');
    const comment = makeComment('item-record:c1', 'item-record:p1');
    const reaction = makeReaction('item-record:r1', 'item-record:p1');

    const split = splitFeed([post, comment, reaction]);

    expect(split.posts).toHaveLength(1);
    expect(split.posts[0].id).toBe('p1');
    expect(split.commentsByParent.get('p1')).toHaveLength(1);
    expect(split.reactionsByParent.get('p1')).toHaveLength(1);
  });

  it('deduplicates reactions: one per actor per parent (last write = most recent wins)', () => {
    // Feed is newest-first; split should keep only one per actor+parent
    const newer = makeReaction('item-record:r2', 'item-record:p1', 'actor:carol', '2026-06-10T12:00:00.000Z');
    const older = makeReaction('item-record:r1', 'item-record:p1', 'actor:carol', '2026-06-10T10:00:00.000Z');
    // decodeFeedItems sorts newest-first, then splitFeed sees newer first
    const items = [newer, older]; // already newest-first
    const split = splitFeed(items);
    const reactions = split.reactionsByParent.get('p1') ?? [];
    expect(reactions).toHaveLength(1);
    expect(reactions[0].id).toBe('r2');
  });

  it('allows multiple reactions from different actors on the same post', () => {
    const r1 = makeReaction('item-record:r1', 'item-record:p1', 'actor:alice');
    const r2 = makeReaction('item-record:r2', 'item-record:p1', 'actor:bob');
    const split = splitFeed([r1, r2]);
    expect(split.reactionsByParent.get('p1')).toHaveLength(2);
  });

  it('sorts comments within a thread oldest-first', () => {
    const old = makeComment('item-record:c1', 'item-record:p1', '2026-06-10T09:00:00.000Z');
    const young = makeComment('item-record:c2', 'item-record:p1', '2026-06-10T11:00:00.000Z');
    // feed arrives newest-first
    const split = splitFeed([young, old]);
    const thread = split.commentsByParent.get('p1') ?? [];
    expect(thread[0].id).toBe('c1');
    expect(thread[1].id).toBe('c2');
  });

  it('extracts distinct categoryRefs from posts, frequency desc', () => {
    const p1 = makePost('item-record:p1', { categoryRef: 'cat:general' });
    const p2 = makePost('item-record:p2', { categoryRef: 'cat:general' });
    const p3 = makePost('item-record:p3', { categoryRef: 'cat:announcements' });

    const split = splitFeed([p1, p2, p3]);
    expect(split.categories[0]).toBe('cat:general');
    expect(split.categories[1]).toBe('cat:announcements');
  });

  it('returns empty categories when no posts have categoryRef', () => {
    const post = makePost('item-record:p1', { categoryRef: null });
    const split = splitFeed([post]);
    expect(split.categories).toHaveLength(0);
  });

  it('falls back comment with missing parentRef to posts bucket', () => {
    const item = decodeFeedItem({
      item_ref: 'item-record:c-orphan',
      actor_ref: 'actor:alice',
      fields: { kind: 'comment', body: 'orphan comment' },
    }, 0)!;
    const split = splitFeed([item]);
    expect(split.posts).toHaveLength(1);
  });

  it('handles empty input gracefully', () => {
    const split = splitFeed([]);
    expect(split.posts).toHaveLength(0);
    expect(split.commentsByParent.size).toBe(0);
    expect(split.reactionsByParent.size).toBe(0);
    expect(split.categories).toHaveLength(0);
  });

  it('treats unknown kind as post', () => {
    const item = decodeFeedItem({
      item_ref: 'item-record:unknown-kind',
      fields: { kind: 'poll', body: 'a poll', title: 'Vote!' },
    }, 0)!;
    expect(item.kind).toBe('poll');
    const split = splitFeed([item]);
    expect(split.posts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// decodeFeedItems integration
// ---------------------------------------------------------------------------

describe('decodeFeedItems', () => {
  it('sorts rows newest-first', () => {
    const raw = [
      { item_ref: 'a', target_ref: 'scope:test', fields: JSON.stringify({ body: 'old' }), created_at: '2026-06-09T00:00:00.000Z' },
      { item_ref: 'b', target_ref: 'scope:test', fields: JSON.stringify({ body: 'new' }), created_at: '2026-06-10T00:00:00.000Z' },
    ];
    const items = decodeFeedItems(raw, undefined, admittedScope);
    expect(items[0].id).toBe('b');
    expect(items[1].id).toBe('a');
  });

  it('filters out rows with no content', () => {
    const raw = [
      { item_ref: 'empty', target_ref: 'scope:test', fields: '{}' },
      { item_ref: 'has-body', target_ref: 'scope:test', fields: JSON.stringify({ body: 'content' }) },
    ];
    const items = decodeFeedItems(raw, undefined, admittedScope);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('has-body');
  });
});

// ---------------------------------------------------------------------------
// pinned + media fields
// ---------------------------------------------------------------------------

describe('pinned and media decoding', () => {
  it('decodes pinned and image_url from fields', () => {
    const item = decodeFeedItem(
      { item_ref: 'p', fields: JSON.stringify({ body: 'announce', pinned: true, image_url: 'https://x/img.png' }) },
      0,
    );
    expect(item?.pinned).toBe(true);
    expect(item?.imageUrl).toBe('https://x/img.png');
  });

  it('defaults pinned false and imageUrl null', () => {
    const item = decodeFeedItem({ item_ref: 'q', fields: JSON.stringify({ body: 'plain' }) }, 0);
    expect(item?.pinned).toBe(false);
    expect(item?.imageUrl).toBeNull();
  });

  it('sorts pinned posts before newer unpinned posts', () => {
    const raw = [
      { item_ref: 'new', target_ref: 'scope:test', fields: JSON.stringify({ body: 'new' }), created_at: '2026-06-12T00:00:00.000Z' },
      { item_ref: 'pin', target_ref: 'scope:test', fields: JSON.stringify({ body: 'pinned', pinned: true }), created_at: '2026-06-01T00:00:00.000Z' },
    ];
    const items = decodeFeedItems(raw, undefined, admittedScope);
    expect(items[0].id).toBe('pin');
    expect(items[1].id).toBe('new');
  });
});
