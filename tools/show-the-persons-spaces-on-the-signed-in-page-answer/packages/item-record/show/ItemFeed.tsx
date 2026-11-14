'use client';

import React from 'react';
import { Card, Container, PlaceableSurfaceHost, Text } from '@/packages/ui';
import { readItemRecordFeed, ITEM_RECORD_FEED_REFRESH_EVENT } from '@/packages/item-record/do-work/read-item-record-feed';
import type { FeedItem } from '@/packages/item-record/read-data/read-item-records';

export interface ItemFeedProps {
  itemKindRef?: string | null;
  item_kind_ref?: string | null;
  scopeRef?: string | null;
  scope_ref?: string | null;
  targetRef?: string | null;
  target_ref?: string | null;
  [key: string]: unknown;
}

type SceneDescriptor = {
  package_entry: { package_name: string; entry_name: string };
  surface_input: Record<string, unknown>;
};

const readText = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;

function readSurfaceInput(props: ItemFeedProps): Record<string, unknown> {
  return props.surfaceInput && typeof props.surfaceInput === 'object' && !Array.isArray(props.surfaceInput)
    ? props.surfaceInput as Record<string, unknown>
    : props.surface_input && typeof props.surface_input === 'object' && !Array.isArray(props.surface_input)
      ? props.surface_input as Record<string, unknown> : props;
}

function readSceneDescriptor(input: Record<string, unknown>): SceneDescriptor | null {
  const scene = input.scene && typeof input.scene === 'object' && !Array.isArray(input.scene)
    ? input.scene as Record<string, unknown> : null;
  const entry = scene?.package_entry && typeof scene.package_entry === 'object' && !Array.isArray(scene.package_entry)
    ? scene.package_entry as Record<string, unknown> : null;
  const packageName = readText(entry?.package_name);
  const entryName = readText(entry?.entry_name);
  const surfaceInput = scene?.surface_input;
  return packageName && entryName && surfaceInput && typeof surfaceInput === 'object' && !Array.isArray(surfaceInput)
    ? { package_entry: { package_name: packageName, entry_name: entryName }, surface_input: surfaceInput as Record<string, unknown> }
    : null;
}

function FeedRows({ scopeRef, empty }: { scopeRef: string; empty: Record<string, unknown> | null }) {
  const [rows, setRows] = React.useState<FeedItem[]>([]);
  const [state, setState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const load = React.useCallback(async () => {
    try {
      setRows(await readItemRecordFeed(scopeRef));
      setState('ready');
    } catch {
      setState('error');
    }
  }, [scopeRef]);
  React.useEffect(() => {
    void load();
    const changed = (event: Event) => {
      const eventScope = (event as CustomEvent<{ scopeRef?: string }>).detail?.scopeRef;
      if (!eventScope || eventScope === scopeRef) void load();
    };
    window.addEventListener(ITEM_RECORD_FEED_REFRESH_EVENT, changed);
    return () => window.removeEventListener(ITEM_RECORD_FEED_REFRESH_EVENT, changed);
  }, [load, scopeRef]);
  if (state === 'loading') return <Text tone="muted" size="sm">Loading posts…</Text>;
  if (state === 'error') return <Text tone="muted" size="sm">Posts could not load. Reopen Feed to try again.</Text>;
  if (rows.length === 0) return <Card padding="lg"><Text weight="semibold" size="sm">{readText(empty?.title) ?? 'Start the conversation'}</Text><Text tone="muted" size="sm">{readText(empty?.body) ?? 'Share a question, a breakthrough, or what happened on court.'}</Text></Card>;
  return <Container layout="vertical" gap="md"><Text tone="muted" size="sm">{rows.length} {rows.length === 1 ? 'post' : 'posts'}</Text>{rows.map((post) => <Card key={post.id} padding="lg"><Container layout="vertical" gap="sm"><Text weight="semibold" size="sm">{post.author ?? 'Member'}</Text>{post.title ? <Text weight="semibold" size="sm">{post.title}</Text> : null}<Text size="sm">{post.body ?? ''}</Text></Container></Card>)}</Container>;
}

export function ItemFeed(props: ItemFeedProps) {
  const input = readSurfaceInput(props);
  const scene = readSceneDescriptor(input);
  if (!scene) {
    const empty = input.empty_state && typeof input.empty_state === 'object' && !Array.isArray(input.empty_state)
      ? input.empty_state as Record<string, unknown> : null;
    return <Card padding="lg"><Text weight="semibold" size="sm">{readText(empty?.title) ?? 'Feed unavailable'}</Text><Text tone="muted" size="sm">{readText(empty?.body) ?? 'Posts are not available right now.'}</Text></Card>;
  }
  const scopeRef = readText(scene.surface_input.scope_ref) ?? readText(scene.surface_input.target_ref);
  const empty = input.empty_state && typeof input.empty_state === 'object' && !Array.isArray(input.empty_state)
    ? input.empty_state as Record<string, unknown> : null;
  return <Container layout="vertical" gap="md" padding="md">
    <PlaceableSurfaceHost packageName={scene.package_entry.package_name} entryName={scene.package_entry.entry_name} surfaceInput={scene.surface_input} interactive />
    {scopeRef ? <FeedRows scopeRef={scopeRef} empty={empty} /> : <Text tone="muted" size="sm">Posts are unavailable right now.</Text>}
  </Container>;
}

export default ItemFeed;
