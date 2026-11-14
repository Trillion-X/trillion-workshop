// package://packages/item-record/show/mount-item-composer.tsx
//
// Inline composer surface: a textarea + submit button that creates a real
// item-record via the generic create-item-record owner-action. Mounted as a
// Component node inside a composition (package_entry → item-record/item-composer)
// so authoring happens IN PLACE. The new record flows back through the live
// item-records feed and materializes with zero extra wiring (the feed's bound
// node is reactive after the write-boundary refresh).
//
// FULLY DATA-DRIVEN (L090 / enum-dissolution): the component NEVER hardcodes an
// item kind. Every semantic is read from surface_input:
//   - kind        : opaque item kind ('post', 'comment', 'announcement', …). The
//                   scene DATA declares it; a reply composer is the SAME component
//                   with kind='comment' + a parent_ref. Bare-mount falls back to
//                   'post' only so a naked mount still works.
//   - parent_ref  : optional parent item's item_ref (a reply/comment binds this to
//                   the post it answers; the feed scene resolves {field:'item_ref'}
//                   per record so each post's inline composer targets that post).
//   - target_ref  : the admitted community subject coordinate.
//   - label       : placeholder copy. submit_label: button copy. compact: dense form.
// Identity is server-only; the component supplies no actor.

import React from 'react';
import { Button, Container, Text, Textarea, mountReactMaterial, type ReactMaterialMountArgs } from '@/packages/ui';
import { createItemRecord } from '@/packages/item-record/do-work/create-item-record';
import { resolveComposerConfig, composerEventRef } from '@/packages/item-record/read-data/composer-config';

function ItemComposer(props: Record<string, unknown>) {
  // ALL behavior is DATA (resolved by the pure, unit-tested config resolver).
  const { kind, parentRef, targetRef, scopeRef, label, submitLabel, compact } = resolveComposerConfig(props);

  const [body, setBody] = React.useState('');
  const [status, setStatus] = React.useState<'idle' | 'posting' | 'error'>('idle');

  const post = React.useCallback(async () => {
    const text = body.trim();
    if (!text || status === 'posting') return;
    setStatus('posting');
    try {
      // eventRef is a unique id per item (the action requires it); it is NOT a
      // community ref — the community is targetRef. Time/randomness come from the
      // browser globals available in this render context.
      const eventRef = composerEventRef(kind, Date.now(), Math.random().toString(36).slice(2, 8));
      await createItemRecord({
        eventRef,
        scopeRef,
        targetRef,
        kind,
        parentRef,
        body: text,
      });
      window.dispatchEvent(new CustomEvent('item-record:changed', { detail: { scopeRef } }));
      setBody('');
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  }, [body, status, targetRef, scopeRef, kind, parentRef]);

  return (
    <Container layout="vertical" gap="sm" padding={compact ? 'sm' : 'md'}>
      <Textarea
        value={body}
        onChange={(e) => setBody((e.target as HTMLTextAreaElement).value)}
        placeholder={label}
        rows={compact ? 2 : 3}
        aria-label={label}
      />
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="flex-end">
        {status === 'error' ? <Text variant="body-xs" color="secondary">Could not send — try again.</Text> : null}
        <Button variant="primary" size="sm" disabled={!body.trim() || status === 'posting'} onClick={post}>
          {status === 'posting' ? `${submitLabel}…` : submitLabel}
        </Button>
      </Container>
    </Container>
  );
}

export default function mount({ el, props = {} }: ReactMaterialMountArgs) {
  return mountReactMaterial(el, <ItemComposer {...props} />, props, 'item-composer material');
}
