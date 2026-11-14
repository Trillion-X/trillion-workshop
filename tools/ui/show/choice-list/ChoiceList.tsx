// parts/ui/show/choice-list/ChoiceList.tsx
//
// PURPOSE
//   A short list of places or things a person ticks, any number of them: each row its mark, its name, an optional
//   quiet line under it, and a round tick at the end that fills in when chosen. The whole row is the control. Used
//   wherever a person picks where something goes (the places a share lands, the lists a page is saved to). Rows can
//   nest: a row's `depth` (0 at the top) sets it in under the row above it, so a tree read in order (a pursuit and the
//   pursuits under it) draws as a tree, the same way the sidebar's lists show it.
//
// PROVENANCE
//   Anatomy from Cosmos' save sheet (rows with a picture, name and a line under it, a round tick at the end, the save
//   button below: mobbin.com/screens/a3d24572-61a1-474f-bd72-917f2c27edc9), Julienne's Add to collection (the chosen
//   row outlined with a filled tick: mobbin.com/screens/db8a2bd4-15d1-4b9e-8ec5-1373e7ed1678) and SchoolAI's Add to
//   collections (mobbin.com/screens/d58dc26b-6b34-4899-b057-8865af711084). Written fresh against the coss tokens.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: rows are the caller's DATA ({ id, label, detail?, icon?, depth? }), in the order they are drawn; nothing
//      here names a place or knows what nesting means for it.
//   2. Each row is one checkbox to assistive technology (role="checkbox", aria-checked), reached by Tab and toggled by
//      Space or Enter; the list is named by the caller.
//   3. Chosen reads at a glance without colour alone: the tick fills and shows a check, and the row's edge firms.
//   4. Choosing and unchoosing are never a snap: the fill fades and the check pops in or shrinks out (200 ms), and
//      stands still for a person who asked for less motion. This is the iPhone sheet's round check (ChoiceSheet.swift,
//      a symbol replace) in the web's one shared list.

import React from 'react';
import { CheckIcon } from 'lucide-react';
import { cn } from '../cn';
import { NamedIcon } from '../icon';

export type ChoiceListItem = { id: string; label: string; detail?: string | null; icon?: string | null; depth?: number | null };

export type ChoiceListProps = {
  items: readonly ChoiceListItem[];
  chosen: readonly string[];
  onToggle: (id: string) => void;
  /** Names the list for assistive technology. */
  label: string;
  className?: string;
};

export function ChoiceList({ items, chosen, onToggle, label, className }: ChoiceListProps) {
  const picked = new Set(chosen);
  return (
    <div data-slot="choice-list" role="group" aria-label={label} className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {items.map(item => {
        const on = picked.has(item.id);
        return (
          <button key={item.id} type="button" role="checkbox" aria-checked={on} data-chosen={on || undefined} onClick={() => onToggle(item.id)}
            data-depth={item.depth || undefined} aria-level={item.depth ? item.depth + 1 : undefined}
            style={item.depth ? { marginInlineStart: `calc(${item.depth} * var(--choice-list-step, 1.25rem))`, width: `calc(100% - ${item.depth} * var(--choice-list-step, 1.25rem))` } : undefined}
            className={cn(
              'group/choice flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl border bg-transparent px-3 py-2.5 text-left outline-none transition-colors',
              'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
              on ? 'border-foreground/28 bg-accent' : 'border-transparent',
            )}>
            <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted text-foreground/80">
              <NamedIcon name={item.icon ?? undefined} fallback="Circle" size="sm" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium text-foreground">{item.label}</span>
              {item.detail ? <span className="truncate text-xs text-muted-foreground">{item.detail}</span> : null}
            </span>
            <span aria-hidden className={cn(
              'flex size-5 shrink-0 items-center justify-center rounded-full [corner-shape:round] border transition-colors',
              on ? 'border-primary bg-primary text-primary-foreground' : 'border-foreground/24 text-transparent group-hover/choice:border-foreground/40',
            )}>
              <CheckIcon className={cn('size-3 transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none', on ? 'scale-100 opacity-100' : 'scale-50 opacity-0')} strokeWidth={3} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
