// packages/ui/show/reorder-control/ReorderControl.tsx
//
// Generic accessible reorder control. It owns no item state and no
// persistence: every modality emits one complete ordered-ID result through
// the caller's callback. The caller paints insertion feedback from `preview`.

import React from 'react';

import { Button } from '../button';
import {
  MoveTargetStatus,
  moveTargetMessage,
  useReorderFeedback,
} from '../drop-indicator';
import { ExpandableTabs } from '../expandable-tabs';
import { NamedIcon } from '../icon';
import {
  beforeIdForTarget,
  orderChanged,
  reorderBeforeId,
  reorderIds,
} from './reorder-operation';

export const REORDER_DRAG_MIME = 'application/x-bitfield-reorder-id';

export interface ReorderPreview {
  movedId: string;
  beforeId: string | null;
}

export interface ReorderControlProps {
  ids: readonly string[];
  itemId: string;
  label: string;
  orientation: 'horizontal' | 'vertical';
  onReorder: (orderedIds: string[], movedId: string) => void;
  onPreviewChange?: (preview: ReorderPreview | null) => void;
  /** Resolves opaque IDs into the human names used by reorder feedback. */
  getItemLabel?: (id: string) => string;
  className?: string;
}

export function readReorderDragId(dataTransfer: DataTransfer): string {
  return dataTransfer.getData(REORDER_DRAG_MIME);
}

export function ReorderControl({
  ids,
  itemId,
  label,
  orientation,
  onReorder,
  onPreviewChange,
  getItemLabel,
  className,
}: ReorderControlProps) {
  const pointerPreview = React.useRef<ReorderPreview | null>(null);
  const controlRef = React.useRef<HTMLSpanElement>(null);
  const {
    isOwner,
    message,
    publish,
  } = useReorderFeedback(controlRef);
  const from = ids.indexOf(itemId);
  const previousWord = orientation === 'horizontal' ? 'left' : 'up';
  const nextWord = orientation === 'horizontal' ? 'right' : 'down';
  const previousIcon = orientation === 'horizontal' ? 'ChevronLeft' : 'ChevronUp';
  const nextIcon = orientation === 'horizontal' ? 'ChevronRight' : 'ChevronDown';
  const itemLabel = React.useCallback((id: string) => {
    const explicit = getItemLabel?.(id);
    if (explicit) return explicit;
    const target = typeof document === 'undefined'
      ? undefined
      : [...document.querySelectorAll<HTMLElement>('[data-reorder-target-id]')]
        .find((candidate) => candidate.dataset.reorderTargetId === id);
    const targetLabel = target?.dataset.reorderTargetLabel
      ?? target?.dataset.fieldLabel;
    if (targetLabel) return targetLabel;
    const handleLabel = target
      ?.querySelector<HTMLElement>('[data-reorder-handle][aria-label]')
      ?.getAttribute('aria-label')
      ?.replace(/^Reorder\s+/, '');
    return handleLabel
      || id.replace(/[-_:]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
  }, [getItemLabel]);

  const announceOrder = React.useCallback((orderedIds: readonly string[]) => {
    const movedIndex = orderedIds.indexOf(itemId);
    const beforeId = movedIndex < 0 ? null : orderedIds[movedIndex + 1] ?? null;
    publish(
      moveTargetMessage(label, beforeId === null ? null : itemLabel(beforeId)),
      { movingLabel: label },
    );
  }, [itemId, itemLabel, label, publish]);

  const commit = React.useCallback((next: string[]) => {
    if (orderChanged(ids, next)) {
      onReorder(next, itemId);
      announceOrder(next);
    }
    onPreviewChange?.(null);
  }, [announceOrder, ids, itemId, onPreviewChange, onReorder]);

  const commitBefore = React.useCallback((beforeId: string | null) => {
    commit(reorderBeforeId(ids, itemId, beforeId));
  }, [commit, ids, itemId]);

  const commitKey = React.useCallback((key: string) => {
    const targetIndex = key === 'Home'
      ? 0
      : key === 'End'
        ? ids.length
        : key === 'ArrowUp' || key === 'ArrowLeft'
          ? from - 1
          : key === 'ArrowDown' || key === 'ArrowRight'
            ? from + 2
            : null;
    if (targetIndex === null || targetIndex < 0 || targetIndex > ids.length) return;
    commit(reorderIds(ids, itemId, targetIndex));
  }, [commit, from, ids, itemId]);

  const previewFromPoint = React.useCallback((clientX: number, clientY: number) => {
    const element = document.elementFromPoint?.(clientX, clientY);
    const target = element instanceof Element
      ? element.closest<HTMLElement>('[data-reorder-target-id]')
      : null;
    const targetId = target?.dataset.reorderTargetId;
    if (!target || !targetId || !ids.includes(targetId)) return;
    const rect = target.getBoundingClientRect();
    const after = orientation === 'horizontal'
      ? clientX >= rect.left + rect.width / 2
      : clientY >= rect.top + rect.height / 2;
    const beforeId = beforeIdForTarget(ids, targetId, after);
    const preview = { movedId: itemId, beforeId };
    pointerPreview.current = preview;
    onPreviewChange?.(preview);
    const targetLabel = beforeId === null
      ? null
      : target.dataset.reorderTargetLabel
        ?? target.dataset.fieldLabel
        ?? itemLabel(beforeId);
    publish(moveTargetMessage(label, targetLabel), { movingLabel: label });
  }, [ids, itemId, itemLabel, label, onPreviewChange, orientation, publish]);

  const cancelPreview = React.useCallback(() => {
    pointerPreview.current = null;
    onPreviewChange?.(null);
    publish('');
  }, [onPreviewChange, publish]);

  return (
    <span
      ref={controlRef}
      role="group"
      aria-label={`Move ${label}`}
      data-reorder-control
      className={className}
      onClick={(event) => event.stopPropagation()}
    >
      {isOwner ? <MoveTargetStatus message={message} /> : null}
      <Button
        variant="ghost"
        size="icon-xs"
        targetRole="reorder"
        draggable
        data-reorder-handle
        aria-label={`Reorder ${label}`}
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home End Escape"
        style={{ touchAction: 'none' }}
        onDragStart={(event) => {
          event.stopPropagation();
          event.dataTransfer.setData(REORDER_DRAG_MIME, itemId);
          event.dataTransfer.effectAllowed = 'move';
          const preview = { movedId: itemId, beforeId: itemId };
          onPreviewChange?.(preview);
          announceOrder(ids);
        }}
        onDragEnd={(event) => {
          event.stopPropagation();
          cancelPreview();
        }}
        onPointerDown={(event) => {
          if (event.pointerType === 'mouse' || event.button > 0) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          const preview = { movedId: itemId, beforeId: itemId };
          pointerPreview.current = preview;
          onPreviewChange?.(preview);
          announceOrder(ids);
        }}
        onPointerMove={(event) => {
          if (!pointerPreview.current) return;
          event.preventDefault();
          previewFromPoint(event.clientX, event.clientY);
        }}
        onPointerUp={(event) => {
          if (!pointerPreview.current) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          const preview = pointerPreview.current;
          pointerPreview.current = null;
          commitBefore(preview.beforeId);
        }}
        onPointerCancel={cancelPreview}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelPreview();
            return;
          }
          if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          commitKey(event.key);
        }}
      >
        <NamedIcon name={orientation === 'horizontal' ? 'GripHorizontal' : 'GripVertical'} size="sm" aria-hidden />
      </Button>
      <ExpandableTabs
        mode="action"
        size="sm"
        targetRole="reorder"
        ariaLabel={`Move ${label} one place`}
        items={[
          { id: 'previous', label: `Move ${label} ${previousWord}`, icon: previousIcon, disabled: from <= 0 },
          { id: 'next', label: `Move ${label} ${nextWord}`, icon: nextIcon, disabled: from < 0 || from >= ids.length - 1 },
        ]}
        onSelect={(id) => commitKey(id === 'previous'
          ? (orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp')
          : (orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown'))}
      />
    </span>
  );
}
