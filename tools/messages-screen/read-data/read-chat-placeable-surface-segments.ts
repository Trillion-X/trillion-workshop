// PORTED FROM: bitfield-packages/packages/chat/read-data/read-chat-placeable-surface-segments.ts @ e99ac5976
// packages/chat/read-data/read-chat-placeable-surface-segments.ts
//
// Splits assistant text into markdown and machine-readable placeable-surface
// blocks. The parser only knows the generic surface payload shape.

import { readPlaceableSurfacePayloadFromUnknown, type PlaceableSurfacePayload } from '../../ui/show/placeable-surface-intent';

export const CHAT_PLACEABLE_SURFACE_FENCE = 'bitfield-placeable-surface';
export const CHAT_WORK_REQUEST_FENCE = 'bitfield-work-request';

export type ChatPlaceableSurfaceSegment =
  | {
      kind: 'text';
      content: string;
    }
  | {
      kind: 'placeable-surface';
      payload: PlaceableSurfacePayload;
      source: string;
    };

// Tolerant of what models ACTUALLY emit (L116): the closing fence may have no
// preceding newline (`{...}```), CRLF line endings (`\r\n`), or be indented (the
// model nested the block in a list). The original required a bare `\n` before the
// close, so a real codex reply whose fence used CRLF or no trailing newline fell
// through to raw text instead of rendering inline. Opening still requires the exact
// language tag (optionally space + trailing text) so `json` / `bitfield-...-x` do
// not match.
const SURFACE_FENCE_PATTERN = /```bitfield-placeable-surface(?:[ \t][^\n]*)?\r?\n([\s\S]*?)\r?\n?[ \t]*```/g;
const WORK_REQUEST_FENCE_PATTERN = /```bitfield-work-request(?:[ \t][^\n]*)?\n[\s\S]*?\n```/g;

function pushTextSegment(segments: ChatPlaceableSurfaceSegment[], content: string): void {
  const visibleContent = content.replace(WORK_REQUEST_FENCE_PATTERN, '\n\nPackage action requested.\n\n');
  if (visibleContent.length === 0) return;
  const previous = segments.at(-1);
  if (previous?.kind === 'text') {
    previous.content += visibleContent;
    return;
  }
  segments.push({ kind: 'text', content: visibleContent });
}

export function splitChatPlaceableSurfaceSegments(content: string): ChatPlaceableSurfaceSegment[] {
  const segments: ChatPlaceableSurfaceSegment[] = [];
  let cursor = 0;

  for (const match of content.matchAll(SURFACE_FENCE_PATTERN)) {
    const source = match[0];
    const json = match[1];
    const index = match.index ?? 0;

    pushTextSegment(segments, content.slice(cursor, index));
    const payload = readPlaceableSurfacePayloadFromUnknown(json);
    if (payload) {
      segments.push({
        kind: 'placeable-surface',
        payload,
        source,
      });
    } else {
      pushTextSegment(segments, source);
    }
    cursor = index + source.length;
  }

  pushTextSegment(segments, content.slice(cursor));
  return segments.length > 0 ? segments : [{ kind: 'text', content }];
}
