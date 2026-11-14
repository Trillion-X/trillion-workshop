import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { AgentProfileList, type AgentProfileListProps } from './AgentProfileList';

type MountArgs = {
  el: HTMLElement;
  props?: Partial<AgentProfileListProps>;
};

function AgentProfileListRoot({ items, title }: AgentProfileListProps) {
  return (
    <ErrorBoundary zoneName="Agent profiles">
      <AgentProfileList items={items} title={title} />
    </ErrorBoundary>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  const items = Array.isArray(props.items) ? props.items : [];
  const title = typeof props.title === 'string' ? props.title : undefined;
  return mountReactSurface(el, <AgentProfileListRoot items={items} title={title} />);
}
