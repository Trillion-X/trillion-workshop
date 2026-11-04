//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The pure, dependency-light foundation shared by every field editor: the
// editor CONTRACT (props + component type) and the small value-free helpers
// (label humanization, event stop, domain tone→color). Isolated from
// field-editors.tsx so editors can be authored AND unit-tested WITHOUT dragging
// the heavy attachment/file (CodeMirror) import graph in behind them.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero I/O, zero React runtime import (types only), zero domain vocabulary.
// 2. This is a leaf: it imports ONLY read-data types. Nothing here may import a
//    show-layer component, or the isolation it exists to provide collapses.
// =============================================================================

import type React from 'react';
import type {
  VisualDatabaseActionDescriptor,
  VisualDatabaseFieldDescriptor,
  VisualDatabaseFieldDomainValue,
  VisualDatabaseModel,
  VisualDatabaseRecord,
} from '../read-data/visual-database';

export interface FieldEditorProps {
  record: VisualDatabaseRecord;
  descriptor: VisualDatabaseFieldDescriptor;
  value: unknown;
  domain: readonly VisualDatabaseFieldDomainValue[];
  /** Durable commit; null clears the field. */
  commit: (value: unknown) => void;
  readOnly: boolean;
  /** Actions declared in data for THIS field (action.fieldId === descriptor.id)
   *  — offered per chosen value that carries a record reference. */
  fieldActions?: readonly VisualDatabaseActionDescriptor[];
  /** Needed to resolve action prompt options from feed records. */
  model?: VisualDatabaseModel;
}

/**
 * Target-identified capability supplied by the composition owner. Visual Database
 * knows only the caller-ready request/result contract and never imports the
 * stateful package that executes it.
 */
export interface FieldEditorOwnerTarget<Request, Result> {
  readonly target: string;
  readonly invoke: (target: string, request: Request) => Promise<Result>;
}

export interface AttachmentReadRequest {
  readonly path: string;
}

export interface AttachmentReadResult {
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly contentType?: string;
}

export interface AttachmentRevealRequest {
  readonly path: string;
}

export interface AttachmentEditorProps {
  readonly target: string;
  readonly filePath: string;
  readonly hideHeader: boolean;
}

export interface AttachmentEditorOwnerCapability {
  readonly target: string;
  readonly Component: React.ComponentType<AttachmentEditorProps>;
}

export interface FieldEditorOwnerCapabilities {
  readonly attachment?: {
    readonly read?: FieldEditorOwnerTarget<AttachmentReadRequest, AttachmentReadResult>;
    readonly reveal?: FieldEditorOwnerTarget<AttachmentRevealRequest, void>;
    readonly editor?: AttachmentEditorOwnerCapability;
  };
}

export type FieldEditorComponent = React.ComponentType<FieldEditorProps>;

export function humanize(segment: string): string {
  return segment.replace(/[-_]+/g, ' ').trim();
}

export function stop(event: React.MouseEvent): void {
  event.stopPropagation();
}

/** Semantic fallback → status color CSS value for legacy values that do not
 *  yet carry an exact identity color. */
export function toneColor(tone: string | undefined): string {
  switch (tone) {
    case 'success': return 'var(--status-success, #34c759)';
    case 'warning': return 'var(--status-warning, #f59e0b)';
    case 'error': return 'var(--status-error, #ef4444)';
    case 'info': return 'var(--status-info, #3b82f6)';
    case 'accent': return 'var(--accent-primary, #8b5cf6)';
    default: return 'var(--text-muted, #9ca3af)';
  }
}

export function domainValueColor(value: VisualDatabaseFieldDomainValue | undefined): string {
  return value?.color ?? toneColor(value?.tone);
}
