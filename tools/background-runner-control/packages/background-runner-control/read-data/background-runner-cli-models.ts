import type {
  BackgroundRunnerCliInfo,
  BackgroundRunnerModelOption,
} from '@/packages/background-runner-control/read-data/background-runner-cli-types';

const EMPTY_MODELS: BackgroundRunnerModelOption[] = [];

export function getBackgroundRunnerCliModels(
  clis: readonly BackgroundRunnerCliInfo[],
  cliId: string,
): readonly BackgroundRunnerModelOption[] {
  const entry = clis.find((cli) => cli.cli === cliId);
  return entry?.models ?? EMPTY_MODELS;
}

export function getBackgroundRunnerCliDefaultModelId(
  clis: readonly BackgroundRunnerCliInfo[],
  cliId: string,
): string | null {
  const models = getBackgroundRunnerCliModels(clis, cliId);
  if (models.length === 0) return null;
  const defaultModel = models.find((model) => model.isDefault);
  return defaultModel?.id ?? models[0]?.id ?? null;
}

export function getDefaultModelForVendor(clis: readonly BackgroundRunnerCliInfo[], vendor: string): string | null {
  const entry = clis.find((cli) => cli.providerIds.includes(vendor));
  return entry ? getBackgroundRunnerCliDefaultModelId(clis, entry.cli) : null;
}
