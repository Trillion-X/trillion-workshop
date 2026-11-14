export type SignedEventEffectsTargetInput = Record<string, unknown>;

export type SignedEventEffectsTargetReply = Record<string, unknown>;

export function admitSignedEventEffects(
  input?: SignedEventEffectsTargetInput,
): Promise<SignedEventEffectsTargetReply>;

export function listSignedEventEffects(
  input?: SignedEventEffectsTargetInput,
): Promise<SignedEventEffectsTargetReply>;
