import React from 'react';
import type { ToolCatalogItem } from '../read-data/read-ai-tool-catalog';

export type ToolCatalogListProps = {
  items: readonly ToolCatalogItem[];
  title?: string;
};

export function ToolCatalogList({ items, title = 'Tool catalog' }: ToolCatalogListProps) {
  return (
    <section data-package="ai-tool-catalog" data-surface="ai-tool-catalog-list">
      <header>
        <h2>{title}</h2>
      </header>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <h3>{item.label ?? item.id}</h3>
            {item.description ? <p>{item.description}</p> : null}
            {item.handler_ref ? <p>{item.handler_ref}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
