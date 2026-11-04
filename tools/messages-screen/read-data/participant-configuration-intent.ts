// PORTED FROM: bitfield-packages/packages/chat/read-data/participant-configuration-intent.ts @ e99ac5976
import type { AddressedParticipantInfo } from './read-addressed-exchange-participants';
import type { PlaceableSurfacePayload, PlaceableSurfaceRecord } from '../../ui/show/placeable-surface-intent';

function metadataString(participant: AddressedParticipantInfo, key: string): string | null {
  const value = participant.metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Build a package-blind configuration handoff. The current catalog proves that
 * one eligible surface accepts the participant's semantic kind; screen
 * arrangement resolves that owner after emission. No package name, route,
 * component, or editor vocabulary crosses this boundary.
 */
export function participantConfigurationIntent(
  participant: AddressedParticipantInfo,
  surfaces: readonly PlaceableSurfaceRecord[],
): PlaceableSurfacePayload | null {
  const kind = metadataString(participant, 'participantKind');
  if (!kind || !surfaces.some((surface) => (
    !surface.disabled && surface.acceptsMaterialKinds.includes(kind)
  ))) return null;

  const subjectRef = participant.participantRef.trim();
  if (!subjectRef) return null;
  return {
    id: `configure-participant:${encodeURIComponent(subjectRef)}`,
    title: `Configure ${participant.label}`,
    target: null,
    packageEntry: null,
    materialTarget: null,
    material: { kind, subject_ref: subjectRef, display_label: participant.label },
    surfaceInput: { subject_ref: subjectRef, display_label: participant.label },
  };
}
