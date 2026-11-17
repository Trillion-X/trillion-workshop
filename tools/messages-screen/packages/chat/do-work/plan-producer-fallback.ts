import type { ProducerStatus } from '../read-data/read-chat-producer-status';

function modelKey(value: string): string {
  return value.replace(/^ai-model-descriptor:/, '');
}

export interface ProducerFallbackState {
  readonly currentModelId: string | null;
  readonly fallbackModelIds: readonly string[];
  readonly attemptedModelIds: readonly string[];
}

/**
 * Choose one declared fallback for a durable, model-bound rate-limit failure.
 * The caller reuses the existing producer request and human turn. Returning
 * null is terminal: malformed/unbound failures and exhausted chains never loop.
 */
export function planProducerFallback(
  status: ProducerStatus,
  state: ProducerFallbackState,
): { readonly modelId: string } | null {
  if (status.state !== 'error' || status.code !== 'rate_limited' || status.retryable !== true) return null;
  if (!status.modelId || !state.currentModelId) return null;
  if (modelKey(status.modelId) !== modelKey(state.currentModelId)) return null;

  const attempted = new Set(state.attemptedModelIds.map(modelKey));
  const currentIndex = state.fallbackModelIds.findIndex(
    (candidate) => modelKey(candidate) === modelKey(state.currentModelId!),
  );
  if (currentIndex < 0) return null;
  const next = state.fallbackModelIds
    .slice(currentIndex + 1)
    .find((candidate) => !attempted.has(modelKey(candidate)));
  return next ? { modelId: next } : null;
}

/** A prior attempt's durable error remains visible until the same request is overwritten. */
export function producerStatusMatchesCurrentModel(
  status: ProducerStatus,
  currentModelId: string | null,
): boolean {
  if (status.state !== 'error' || !status.modelId || !currentModelId) return true;
  return modelKey(status.modelId) === modelKey(currentModelId);
}

export function dispatchProducerFallback<T>(input: {
  readonly requestId: string;
  readonly instructionText: string;
  readonly modelId: string;
  readonly agentRef?: string;
  readonly submit: (value: {
    requestId: string;
    instructionText: string;
    modelId: string;
    agentRef?: string;
  }) => Promise<T>;
  readonly onAdvance: () => void;
  readonly onSubmitted: (submission: T) => void;
  readonly onFailed: (error: unknown) => void;
}): void {
  // Ownership advances before transport begins. A new owner-record event may
  // reenter React while submit is unresolved; it must already see this model.
  input.onAdvance();
  void input.submit({
    requestId: input.requestId,
    instructionText: input.instructionText,
    modelId: input.modelId,
    ...(input.agentRef ? { agentRef: input.agentRef } : {}),
  }).then(input.onSubmitted, input.onFailed);
}
