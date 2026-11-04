// PORTED FROM: bitfield-packages/packages/chat/show/participant-mark-spec.ts @ e99ac5976
// packages/chat/show/participant-mark-spec.ts
//
// The single mapping from a data-owned addressed-participant mark into the
// universal ui/ DisplayMark spec. Every chat surface (sidebar rows, config bar,
// view header, participant browser) renders participant identity through this
// one mapping + DisplayMark — there is no second participant-mark renderer
// (L069 / L030). The package records own all mark facts (icon, logo, colors);
// this only translates them, preserving the precedence logoUrl > text > iconName.

import type { DisplayMarkSpec } from '../../ui/show/display-mark';
import type {
  AddressedParticipantDisplayMark,
} from '../read-data/read-addressed-exchange-participants';

export interface ParticipantMarkSource {
  participantRef?: string;
  label?: string;
  displayMark?: AddressedParticipantDisplayMark;
}

/** A blank mark — every field null. Used when a participant reaches a renderer
 *  without a populated `displayMark` (e.g. a pinned/selected participant assembled
 *  outside `readDisplayMark`). The renderer must NEVER crash on a missing mark: a
 *  participant with only a label still gets a valid monogram (L063 — the whole
 *  "participant missing its mark" crash category is eliminated, not patched). */
const EMPTY_MARK: AddressedParticipantDisplayMark = {
  iconName: null,
  logoUrl: null,
  text: null,
  background: null,
  foreground: null,
  border: null,
};

export function participantToMarkSpec(participant: ParticipantMarkSource): DisplayMarkSpec {
  const mark = participant?.displayMark ?? EMPTY_MARK;
  const base: Pick<DisplayMarkSpec, 'image' | 'monogram' | 'glyph'> = mark.logoUrl
    ? { image: mark.logoUrl }
    : mark.text
      ? { monogram: mark.text }
      : { glyph: mark.iconName ?? 'MessageCircle' };
  return {
    name: participant?.label || participant?.participantRef || 'Chat',
    ...base,
    shape: 'person',
    tint: {
      ...(mark.background ? { background: mark.background } : {}),
      ...(mark.foreground ? { foreground: mark.foreground } : {}),
      ...(mark.border ? { border: mark.border } : {}),
    },
  };
}
