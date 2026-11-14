// package-set://bitfield-studio/packages/packing-list/read-data/packing-list.ts

import type { OperationRecord } from '../../operation-records/read-data/operation-records.ts';

export type PackingStatus = string;

export interface PackingItem {
  id: string;
  listId: string;
  label: string;
  category: string;
  status: PackingStatus;
  quantity: Record<string, unknown>;
  travelerRef?: string;
  containerRef?: string;
  taskRef?: string;
  dependencyRefs: string[];
}

export interface PackingContainer {
  id: string;
  label: string;
  parentContainerRef?: string;
}

export interface PackingDependency {
  id: string;
  itemRef: string;
  dependsOnRef: string;
  reason?: string;
}

export interface PackingList {
  id: string;
  tripRef?: string;
  name: string;
  items: PackingItem[];
  containers: PackingContainer[];
  dependencies: PackingDependency[];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function valueAt(row: Record<string, unknown>, camel: string, snake = camel): unknown {
  return row[camel] ?? row[snake];
}

function optionalString(row: Record<string, unknown>, camel: string, snake = camel): string | undefined {
  const value = string(valueAt(row, camel, snake));
  return value || undefined;
}

function packingStatus(value: unknown): PackingStatus {
  return string(value) || 'planned';
}

export function decodePackingList(raw: unknown): PackingList {
  const root = object(raw);
  const tripRef = string(valueAt(root, 'tripRef', 'trip_ref'));
  return {
    id: string(root.id),
    name: string(root.name),
    ...(tripRef ? { tripRef } : {}),
    items: array(root.items).map((entry) => {
      const row = object(entry);
      const travelerRef = optionalString(row, 'travelerRef', 'traveler_ref');
      const containerRef = optionalString(row, 'containerRef', 'container_ref');
      const taskRef = optionalString(row, 'taskRef', 'task_ref');
      return {
        id: string(row.id),
        listId: string(valueAt(row, 'listId', 'list_id')),
        label: string(row.label),
        category: string(row.category),
        status: packingStatus(row.status),
        quantity: object(row.quantity),
        dependencyRefs: stringArray(valueAt(row, 'dependencyRefs', 'dependency_refs')),
        ...(travelerRef ? { travelerRef } : {}),
        ...(containerRef ? { containerRef } : {}),
        ...(taskRef ? { taskRef } : {}),
      };
    }).filter((item) => item.id),
    containers: array(root.containers).map((entry) => {
      const row = object(entry);
      const parentContainerRef = optionalString(row, 'parentContainerRef', 'parent_container_ref');
      return {
        id: string(row.id),
        label: string(row.label),
        ...(parentContainerRef ? { parentContainerRef } : {}),
      };
    }).filter((container) => container.id),
    dependencies: array(root.dependencies).map((entry) => {
      const row = object(entry);
      const reason = optionalString(row, 'reason');
      return {
        id: string(row.id),
        itemRef: string(valueAt(row, 'itemRef', 'item_ref')),
        dependsOnRef: string(valueAt(row, 'dependsOnRef', 'depends_on_ref')),
        ...(reason ? { reason } : {}),
      };
    }).filter((dependency) => dependency.id),
  };
}

export function packingProgress(list: PackingList): { packed: number; total: number; ratio: number } {
  const total = list.items.filter((item) => item.status !== 'not-needed').length;
  const packed = list.items.filter((item) => item.status === 'packed' || item.status === 'acquired').length;
  return { packed, total, ratio: total === 0 ? 0 : packed / total };
}

export function itemsByCategory(list: PackingList): Record<string, PackingItem[]> {
  return list.items.reduce<Record<string, PackingItem[]>>((groups, item) => {
    const key = item.category || 'uncategorized';
    groups[key] = [...(groups[key] ?? []), item];
    return groups;
  }, {});
}

function statePriority(status: string): OperationRecord['priority'] {
  if (status === 'missing') return 'high';
  if (status === 'packed' || status === 'acquired' || status === 'not-needed') return 'done';
  return 'normal';
}

function statusLabel(status: string): string {
  return status.replace(/[-_]/g, ' ');
}

export function buildPackingOperations(list: PackingList): OperationRecord[] {
  const dependencyByItem = new Map<string, PackingDependency[]>();
  for (const dependency of list.dependencies) {
    dependencyByItem.set(dependency.itemRef, [...(dependencyByItem.get(dependency.itemRef) ?? []), dependency]);
  }
  return list.items.map<OperationRecord>((item) => {
    const priority = statePriority(item.status);
    const dependencies = [...item.dependencyRefs, ...(dependencyByItem.get(item.id) ?? []).map((dependency) => dependency.dependsOnRef)];
    const linkRefs = [list.tripRef, item.travelerRef, item.containerRef, item.taskRef, item.listId].filter((entry): entry is string => Boolean(entry));
    return {
      id: `operation:packing-list:item:${item.id}`,
      ownerPackage: 'packing-list',
      source: { package: 'packing-list', type: 'packing_item', id: item.id },
      kindDescriptor: `packing-list.category.${item.category || 'uncategorized'}`,
      stateDescriptor: `packing-list.state.${item.status}`,
      priority,
      priorityDescriptor: `operation.priority.${priority}`,
      linkRefs,
      dependencyRefs: dependencies,
      evidenceRefs: item.taskRef ? [item.taskRef] : [],
      candidateFactRefs: [],
      transitions: item.status === 'packed' ? [] : [{
        id: `transition:packing-list:pack:${item.id}`,
        ownerPackage: 'packing-list',
        actionDefinitionId: 'action:packing-list:update-status',
        label: 'Mark packed',
        input: { itemId: item.id, status: 'packed' },
        targetStateDescriptor: 'packing-list.state.packed',
        modeHints: ['now', 'next'],
      }],
      display: {
        title: item.label || item.id,
        status: statusLabel(item.status),
        reason: item.status === 'missing' ? 'Required item is missing' : item.status === 'planned' ? 'Not packed yet' : 'Packing item tracked',
        detail: [item.category, item.containerRef, item.taskRef, ...dependencies].filter((entry): entry is string => Boolean(entry)),
      },
      privacyClass: 'personal',
      modeHints: ['inventory', ...(priority === 'high' ? ['now' as const, 'risks' as const] : ['next' as const])],
      sortKey: `${priority === 'high' ? '0' : priority === 'normal' ? '1' : '9'}:${item.category}:${item.label}:${item.id}`,
    };
  });
}

export function decodePackingOperationFeed(raw: unknown): OperationRecord[] {
  return buildPackingOperations(decodePackingList(raw));
}
