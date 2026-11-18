import { resolveInstallInputs } from './resolve-install-inputs';

/** Prepares install inputs from the catalog the caller hands in (its current catalog, read by the caller from its own store).
 *  Nothing is read here: a missing or unreadable catalog grants nothing. */
export function resolveCurrentInstallInputs(input: { package_identity: string; package_set?: string }, catalog: unknown) {
  const value = typeof catalog === 'string' ? (() => { try { return JSON.parse(catalog); } catch { return undefined; } })() : catalog;
  return resolveInstallInputs(value, { package_identity: input.package_identity, package_set: input.package_set });
}
