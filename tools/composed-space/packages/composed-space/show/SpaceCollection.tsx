import React from 'react';

type OpenField = { ref?: unknown; label?: unknown; key?: unknown };
type OpenAction = { ref?: unknown; label?: unknown };
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Field/action records are supplied as data. Unknown fields stay visible by their reference. */
export function SpaceCollection({ items, fields = [], actions = [], onItemAction }: {
  items: Array<{ item_ref: string; fields?: unknown }>;
  fields?: OpenField[];
  actions?: OpenAction[];
  onItemAction?: (itemRef: string, actionRef: string) => void;
}) {
  const visibleFields = fields.length ? fields : [{ ref: 'unmapped-fields', label: 'Unmapped fields' }];
  return <div data-space-layout="open-layout">
    {items.map((item) => {
      const values = object(item.fields);
      return <article key={item.item_ref} data-space-item={item.item_ref}>
        {visibleFields.map((field, index) => {
          const ref = text(field.ref ?? field.key) || `field-${index}`;
          const label = text(field.label) || ref.replace(/[-_]/g, ' ');
          const value = values[ref];
          return <p key={ref}><strong>{label}: </strong>{value === undefined ? 'Not provided' : typeof value === 'string' ? value : JSON.stringify(value)}</p>;
        })}
        {actions.map((action, index) => {
          const ref = text(action.ref) || `action-${index}`;
          return <button key={ref} type="button" onClick={() => onItemAction?.(item.item_ref, ref)}>{text(action.label) || ref.replace(/[-_]/g, ' ')}</button>;
        })}
      </article>;
    })}
  </div>;
}
