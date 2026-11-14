import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { ToolCatalogList, type ToolCatalogListProps } from './ToolCatalogList';

type MountArgs = {
  el: HTMLElement;
  props?: Partial<ToolCatalogListProps>;
};

function ToolCatalogRoot({ items, title }: ToolCatalogListProps) {
  return (
    <ErrorBoundary zoneName="Tools">
      <ToolCatalogList items={items} title={title} />
    </ErrorBoundary>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  const items = Array.isArray(props.items) ? props.items : [];
  const title = typeof props.title === 'string' ? props.title : undefined;
  return mountReactSurface(el, <ToolCatalogRoot items={items} title={title} />);
}
