// packages/calendar-booker/show/descriptor-surface.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The blind descriptor renderer. Given one `ViewDescriptor` and a capability
// map, it performs a single O(1) lookup `caps.get(node.render_kind)` and renders
// the bound primitive. It is the generic dispatcher of enum dissolution / L090:
// it NEVER enumerates `render_kind` values, never branches on identity, never
// names a product concept. All bindings live in the leaf capability pack
// (`render-capability-map.tsx`), which is DATA passed in as a prop.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS (grep-enforced by the U1 test)
// =============================================================================
//
// 1. ZERO `render_kind` string literals in this file.
// 2. ZERO binding-table object/Map literals in this file.
// 3. ZERO `if (kind === …)` / `switch (kind)` identity branches. The single
//    `if (!Render)` is a presence check (capability missing), not identity.
// 4. An unknown `render_kind` renders `UnknownDescriptorFallback` — it NEVER
//    throws and NEVER guesses a primitive.
//
// =============================================================================

import * as React from 'react';
import { HelpCircle } from 'lucide-react';
import { Container, EmptyPlaceholder, Text } from '@/packages/ui';
import type { ViewDescriptor } from '@/packages/calendar-booker/show/view-descriptor';
import type { RenderProps } from '@/packages/calendar-booker/show/render-capability-map';

/**
 * Honest fallback for a `render_kind` with no bound capability. Renders the
 * (already human) label if present and a neutral placeholder — never a crash,
 * never a humanized guess. The unbound key is exposed only as a data attribute
 * for diagnostics, never as visible product copy.
 */
export function UnknownDescriptorFallback({ node }: { node: ViewDescriptor }): React.ReactElement {
  return (
    <Container layout="vertical" gap="2xs" data-unknown-kind={node.render_kind}>
      {node.label ? (
        <Text variant="label" color="muted">
          {node.label}
        </Text>
      ) : null}
      <EmptyPlaceholder icon={HelpCircle} message="This part isn’t available in this view yet." />
    </Container>
  );
}

/**
 * Render one descriptor node by data-selected capability. Recursion into
 * children is the bound primitive's responsibility (e.g. `group`, `preview.embed`,
 * `status.card`), which calls back into `DescriptorSurface` for each child.
 */
export function DescriptorSurface(props: RenderProps): React.ReactElement {
  const Render = props.caps.get(props.node.render_kind);
  if (!Render) return <UnknownDescriptorFallback node={props.node} />;
  return <Render {...props} />;
}

export default DescriptorSurface;
