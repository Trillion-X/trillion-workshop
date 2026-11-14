export interface LoginOption {
  methodFamily: string;
  label: string;
  identityProviderConfigId: string | null;
}

export interface LoginOptionsProjection {
  methods?: LoginOption[];
}

export function readLoginOptions(
  projection: LoginOptionsProjection | null | undefined,
): LoginOption[] {
  return projection?.methods ?? [];
}
