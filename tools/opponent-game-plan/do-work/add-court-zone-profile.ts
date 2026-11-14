import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  CourtZone,
  CourtZoneProfile,
  ScoutingSource,
  ShotRatingKey,
  ShotRatings,
  TennisHand,
  TennisPlayerStyle,
} from '../read-data/opponent-game-plan-types.ts';
import { SHOT_RATING_KEYS } from '../read-data/opponent-game-plan-types.ts';

export const ADD_COURT_ZONE_PROFILE_ACTION = 'action:opponent-game-plan.add-court-zone-profile';

export type CourtZoneProfileDraft = {
  profileId?: string;
  playerId: string;
  hand?: TennisHand;
  quadrantMeaning?: Partial<Record<CourtZone, string>>;
  strongestShot?: string;
  weakestShot?: string;
  playingStyle?: TennisPlayerStyle;
  winners?: { from?: CourtZone; to?: CourtZone; rallyContext?: string };
  errors?: { from?: CourtZone; rallyContext?: string };
  shotRatings?: Partial<Record<ShotRatingKey, number | null | undefined>>;
  source: ScoutingSource;
  now?: Date;
};

export type AddCourtZoneProfileInput = {
  profile_id: string;
  profile_record: CourtZoneProfile;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function normalizeShotRatings(values: Partial<Record<ShotRatingKey, number | null | undefined>> | undefined): ShotRatings {
  const ratings: ShotRatings = {};
  for (const key of SHOT_RATING_KEYS) {
    const value = values?.[key];
    if (value === null || value === undefined) continue;
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`${key} rating must be between 0 and 100`);
    }
    ratings[key] = value;
  }
  return ratings;
}

function cleanQuadrantMeaning(values: Partial<Record<CourtZone, string>> | undefined): Partial<Record<CourtZone, string>> | undefined {
  if (!values) return undefined;
  const clean: Partial<Record<CourtZone, string>> = {};
  for (const zone of ['A', 'B', 'C', 'D'] as const) {
    const value = values[zone]?.trim();
    if (value) clean[zone] = value;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

function cleanWinners(values: CourtZoneProfileDraft['winners']): CourtZoneProfile['winners'] {
  if (!values?.from && !values?.to && !values?.rallyContext?.trim()) return undefined;
  return {
    from: values.from,
    to: values.to,
    rallyContext: values.rallyContext?.trim() || undefined,
  };
}

function cleanErrors(values: CourtZoneProfileDraft['errors']): CourtZoneProfile['errors'] {
  if (!values?.from && !values?.rallyContext?.trim()) return undefined;
  return {
    from: values.from,
    rallyContext: values.rallyContext?.trim() || undefined,
  };
}

export function buildAddCourtZoneProfileInput(draft: CourtZoneProfileDraft): AddCourtZoneProfileInput {
  const profileId = draft.profileId ?? generatedId('profile-projection');
  return {
    profile_id: profileId,
    profile_record: {
      kind: 'profile-projection',
      profileId,
      subject: {
        id: draft.playerId,
        kind: 'tennis-player',
      },
      projectionKind: 'court-zone-profile',
      source: draft.source,
      sourceRefs: [draft.source.sourceId],
      payload: {
        hand: draft.hand,
        quadrantMeaning: cleanQuadrantMeaning(draft.quadrantMeaning),
        strongestShot: draft.strongestShot?.trim() || undefined,
        weakestShot: draft.weakestShot?.trim() || undefined,
        playingStyle: draft.playingStyle,
        winners: cleanWinners(draft.winners),
        errors: cleanErrors(draft.errors),
        shotRatings: normalizeShotRatings(draft.shotRatings),
      },
      createdAt: (draft.now ?? new Date()).toISOString(),
    },
  };
}

export function addCourtZoneProfile(input: AddCourtZoneProfileInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: ADD_COURT_ZONE_PROFILE_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
