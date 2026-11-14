import React from 'react';
import type { AgentProfile } from '../read-data/read-ai-agent-profiles';

export type AgentProfileListProps = {
  items: readonly AgentProfile[];
  title?: string;
};

export function AgentProfileList({ items, title = 'Agent profiles' }: AgentProfileListProps) {
  return (
    <section data-package="ai-agent-profile" data-surface="ai-agent-profile-list">
      <header>
        <h2>{title}</h2>
      </header>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <h3>{item.label ?? item.id}</h3>
            {item.description ? <p>{item.description}</p> : null}
            {item.tool_refs.length > 0 ? <p>{item.tool_refs.join(', ')}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
