// src/workspace/board-of.tsx
//
// PURPOSE
//   The one way a workspace screen shows records on the board (parts/group, tool:screen-board): `BoardOf` opens the
//   live board beside the screen, its records drawn as cards and lines that follow them (a workflow's steps, a run
//   lighting up, the AI on a job and its tools), with the board's pen, shapes, notes, frames, collapse and tidy around
//   them; `BoardStill` draws the same records as a still picture of that board (a hover card), through the board's own
//   picture export, so the small picture and the board never disagree.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A source is the board's own (parts/group/do-work/board-source.ts): addresses to read, write and act on, or the
//      records themselves (`cards`, `lines`) with what to call; nothing here names a kind of record.
//   2. Records handed over directly are read again by the board each time they change, so their cards follow them;
//      where each card sits stays the person's.
//   3. A still picture places nothing anywhere: it is planned on an empty board and drawn, never kept.
//   4. Every element is a shared component; this file writes no markup.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React, { useEffect, useMemo, useRef } from 'react';
import { Container } from '../../parts/ui';
import { ImageBlock } from '../../parts/ui/show/image-block/ImageBlock';
import type { BoardSource } from '../../parts/group/do-work/board-source';
import { boardSourcePicture } from '../../parts/group/do-work/board-source-picture';

type Send = string | ((body: Record<string, unknown>) => unknown);
type PaletteRow = { id: string; label: string; icon?: string; detail?: string; section?: string };
/** What a source can add from the board: the rows to search (an address answering `{ rows }` for `?q=`, or a function
 *  of the words typed), where a chosen one is sent (`{ kind, at }`, answering `{ id }`), and the button's words. */
type Adds = { palette?: string | ((words: string) => PaletteRow[] | Promise<PaletteRow[]>); add?: Send; add_label?: string; add_placeholder?: string };
/** Where the board reads records (an address) and sends edits and actions, or the records themselves. */
export type BoardOfSource =
  | ({ key: string; read: string; write?: Send; act?: Send } & Adds)
  | ({ key: string; cards: BoardSource['cards']; lines: BoardSource['lines']; write?: Send; act?: Send } & Adds);

/** The live board, opened on `boardId`, drawing `source` (invariants 1–2). */
export function BoardOf({ boardId, title, source }: { boardId: string; title: string; source: BoardOfSource }) {
  const host = useRef<HTMLDivElement>(null);
  // The board is opened once per board and source key; what the records say now is read through `latest`, and a
  // change to them tells the board to read again.
  const latest = useRef(source);
  latest.current = source;
  const listeners = useRef(new Set<() => void>());
  const inline = 'cards' in source;
  const content = inline ? JSON.stringify([source.cards, source.lines]) : source.read;
  useEffect(() => { for (const notify of listeners.current) notify(); }, [content]);
  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    const now = latest.current;
    const send = (pick: 'write' | 'act' | 'add') => {
      const given = now[pick];
      if (!given) return undefined;
      return typeof given === 'string' ? given : (body: Record<string, unknown>) => {
        const current = latest.current[pick];
        return typeof current === 'function' ? current(body) : undefined;
      };
    };
    const write = send('write');
    const act = send('act');
    const add = send('add');
    const palette = typeof now.palette === 'string' ? now.palette : now.palette ? (words: string) => {
      const current = latest.current.palette;
      return typeof current === 'function' ? current(words) : [];
    } : undefined;
    const handed = {
      key: now.key,
      ...('cards' in now
        ? {
          read: () => {
            const current = latest.current;
            return 'cards' in current ? { key: current.key, cards: current.cards, lines: current.lines } : null;
          },
          changes: (notify: () => void) => { listeners.current.add(notify); return () => { listeners.current.delete(notify); }; },
        }
        : { read: now.read }),
      ...(write ? { write } : {}),
      ...(act ? { act } : {}),
      ...(palette && add ? { palette, add, ...(now.add_label ? { add_label: now.add_label } : {}), ...(now.add_placeholder ? { add_placeholder: now.add_placeholder } : {}) } : {}),
    };
    let unmount: (() => void) | null = null;
    let gone = false;
    void Promise.all([import('./tool-screen'), import('./screen-mounts')]).then(([module, mounts]) => {
      if (!gone) unmount = module.mountToolScreen(element, { surfaceInput: { tool_id: 'tool:screen-board', board_id: boardId, title, source: handed } }, mounts.screens);
    });
    return () => { gone = true; unmount?.(); };
  }, [boardId, title, source.key, inline]);
  return <Container ref={host} layout="vertical" flex="1" minHeight="0" data-board-of={boardId} />;
}

/** The records of `source` as a still picture of the board they would be drawn on (invariant 3). */
export function BoardStill({ source, label }: { source: BoardSource; label: string }) {
  const picture = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(boardSourcePicture(source))}`, [source]);
  return <ImageBlock src={picture} alt={label} width="full" objectFit="contain" rounded="md" />;
}
