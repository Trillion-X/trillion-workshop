import { BUNDLED_PROVIDER_ICON_SOURCES } from './provider-icon-assets';

export interface ProviderIconVector {
  view_box: string;
  path: string;
  color: string;
}

export interface ProviderIconBundledAsset {
  kind: 'bundled-svg';
  id: string;
}

export interface ProviderIconRegistryEntry {
  kind: 'provider-icon';
  provider_slug: string;
  icon_id: string;
  asset?: ProviderIconBundledAsset;
  svg?: ProviderIconVector;
  /** Where a public account handle on this provider lives, as DATA. The link
   * is `prefix + handle + suffix`; a provider without this row simply has no
   * profile link, so nothing here knows any provider by name. */
  profile_link?: ProviderProfileLink;
}

export interface ProviderProfileLink {
  prefix: string;
  suffix: string;
}

export type ProviderIconRegistryRow =
  | ProviderIconRegistryEntry
  | { payload?: unknown }
  | Record<string, unknown>;

export interface ProviderIdentity {
  providerSlug: string;
  providerName: string;
}

export interface ResolvedProviderMark {
  providerSlug: string;
  providerName: string;
  iconId: string | null;
  image: string | null;
  /** Sanitized inline artwork for monochrome marks. Inline SVG can inherit the
   * active theme foreground; an SVG loaded through img or mask cannot do that
   * reliably in every native WebKit presenter. */
  foregroundSvg?: string | null;
  /** True when the source artwork is a single near-black silhouette. Rendering
   * it with the current foreground keeps the same mark readable in light and
   * dark themes without provider-specific branches. */
  imageUsesForeground?: boolean;
}

const SVG_NUMBER_SOURCE = String.raw`-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?`;
const SVG_VIEW_BOX_PATTERN = new RegExp(`^${SVG_NUMBER_SOURCE}(?:[ ,]+${SVG_NUMBER_SOURCE}){3}$`, 'i');
const SVG_PATH_PATTERN = /^[MmZzLlHhVvCcSsQqTtAaEe0-9+\-.,\s]+$/;
const SVG_PATH_COMMAND_PATTERN = /[MmZzLlHhVvCcSsQqTtAa]/;
const SVG_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const BUNDLED_ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/;
const MAX_PROVIDER_ICON_PATH_LENGTH = 250_000;

const BUNDLED_PROVIDER_ICON_ASSETS = new Map(Object.entries(BUNDLED_PROVIDER_ICON_SOURCES));

function validVector(viewBox: string, path: string, color: string): boolean {
  return SVG_VIEW_BOX_PATTERN.test(viewBox)
    && path.length <= MAX_PROVIDER_ICON_PATH_LENGTH
    && SVG_PATH_PATTERN.test(path)
    && SVG_PATH_COMMAND_PATTERN.test(path)
    && SVG_COLOR_PATTERN.test(color);
}

function safeBundledSvg(source: string): boolean {
  if (!/^\s*<svg\b/i.test(source) || !/<\/svg>\s*$/i.test(source)) return false;
  if (/<(?:script|foreignObject|iframe|object|embed|audio|video|link|meta)\b/i.test(source)) return false;
  if (/\son[a-z]+\s*=/i.test(source)) return false;
  if (/@import\b/i.test(source)) return false;
  if (/\b(?:href|src)\s*=\s*["']?(?!#)/i.test(source)) return false;
  if (/url\(\s*["']?(?:https?:|data:|\/\/)/i.test(source)) return false;
  return true;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function payload(row: ProviderIconRegistryRow): Record<string, unknown> | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const carrier = row as Record<string, unknown>;
  const value = carrier.payload ?? carrier;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeProviderSlug(value: unknown): string {
  return text(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function readProviderIconRegistry(rows: readonly ProviderIconRegistryRow[]): ProviderIconRegistryEntry[] {
  const entries = new Map<string, ProviderIconRegistryEntry>();
  for (const row of rows) {
    const value = payload(row);
    if (value?.kind !== 'provider-icon') continue;
    const providerSlug = normalizeProviderSlug(value.provider_slug);
    const iconId = text(value.icon_id);
    if (!providerSlug || !iconId) continue;
    const assetValue = value.asset;
    const asset = assetValue && typeof assetValue === 'object' && !Array.isArray(assetValue)
      ? assetValue as Record<string, unknown>
      : null;
    const assetId = text(asset?.id);
    const bundledSource = asset?.kind === 'bundled-svg' && BUNDLED_ASSET_ID_PATTERN.test(assetId)
      ? BUNDLED_PROVIDER_ICON_ASSETS.get(assetId)
      : undefined;
    const validAsset = Boolean(bundledSource && safeBundledSvg(bundledSource));

    const svg = value.svg;
    const vector = svg && typeof svg === 'object' && !Array.isArray(svg)
      ? svg as Record<string, unknown>
      : null;
    const viewBox = text(vector?.view_box);
    const path = text(vector?.path);
    const color = text(vector?.color);
    const validLegacyVector = Boolean(viewBox && path && color && validVector(viewBox, path, color));
    if (!validAsset && !validLegacyVector) continue;
    const link = value.profile_link && typeof value.profile_link === 'object' && !Array.isArray(value.profile_link)
      ? value.profile_link as Record<string, unknown>
      : null;
    const profileLink = link && safeProfilePrefix(text(link.prefix))
      ? { prefix: text(link.prefix), suffix: text(link.suffix) }
      : null;
    entries.set(providerSlug, {
      kind: 'provider-icon',
      provider_slug: providerSlug,
      icon_id: iconId,
      ...(validAsset ? { asset: { kind: 'bundled-svg', id: assetId } } : {}),
      ...(validLegacyVector ? { svg: { view_box: viewBox, path, color } } : {}),
      ...(profileLink ? { profile_link: profileLink } : {}),
    });
  }
  return [...entries.values()];
}

function safeProfilePrefix(prefix: string): boolean {
  try {
    const url = new URL(prefix);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

const PROFILE_HANDLE_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** The public profile address of `handle` on a provider, when the provider's
 * registry row declares where profiles live and the handle is a plain handle.
 * Returns '' otherwise; a caller never guesses an address. */
export function providerProfileUrl(
  registryRows: readonly ProviderIconRegistryRow[],
  providerSlug: unknown,
  handle: unknown,
): string {
  const plain = text(handle).replace(/^@/, '');
  if (!PROFILE_HANDLE_PATTERN.test(plain)) return '';
  const slug = normalizeProviderSlug(providerSlug);
  const link = readProviderIconRegistry(registryRows).find((entry) => entry.provider_slug === slug)?.profile_link;
  return link ? `${link.prefix}${encodeURIComponent(plain)}${link.suffix}` : '';
}

function svgDataUrl(vector: ProviderIconVector): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vector.view_box}"><path fill="${vector.color}" d="${vector.path}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function bundledAssetDataUrl(asset: ProviderIconBundledAsset): string | null {
  const source = BUNDLED_PROVIDER_ICON_ASSETS.get(asset.id);
  return source && safeBundledSvg(source)
    ? `data:image/svg+xml,${encodeURIComponent(source)}`
    : null;
}

function darkNeutralHex(value: string): boolean {
  const match = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return false;
  const compact = match[1];
  const expanded = compact.length === 3
    ? compact.split('').map((part) => `${part}${part}`).join('')
    : compact;
  const channels = [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16));
  return Math.max(...channels) <= 48 && Math.max(...channels) - Math.min(...channels) <= 18;
}

/** Icon packs commonly ship black silhouette SVGs that disappear on a dark
 * surface. Detect that visual class from the asset itself; provider identity is
 * deliberately irrelevant. Multi-color, gradient, white, and branded-color
 * artwork stays byte-for-byte original. */
function bundledAssetUsesForeground(asset: ProviderIconBundledAsset): boolean {
  const source = BUNDLED_PROVIDER_ICON_ASSETS.get(asset.id);
  if (!source || /<(?:linearGradient|radialGradient)\b/i.test(source)) return false;
  const paints = [...source.matchAll(/\b(?:fill|stroke)=["']([^"']+)["']/gi)]
    .map((match) => match[1].trim())
    .filter((paint) => !/^(?:none|transparent)$/i.test(paint));
  // No explicit paint means SVG's default black fill (OpenAI is authored this way).
  return paints.length === 0 || paints.every(darkNeutralHex);
}

function fitInlineSvg(source: string, addDefaultForeground: boolean): string {
  return source.replace(/<svg\b([^>]*)>/i, (_match, rawAttributes: string) => {
    const attributes = rawAttributes
      .replace(/\s(?:width|height|style)=["'][^"']*["']/gi, '');
    const defaultForeground = addDefaultForeground ? ' fill="currentColor"' : '';
    return `<svg${defaultForeground}${attributes} width="100%" height="100%" style="display:block">`;
  });
}

function bundledAssetForegroundSvg(asset: ProviderIconBundledAsset): string | null {
  const source = BUNDLED_PROVIDER_ICON_ASSETS.get(asset.id);
  if (!source || !safeBundledSvg(source) || !bundledAssetUsesForeground(asset)) return null;
  const paints = [...source.matchAll(/\b(?:fill|stroke)=["']([^"']+)["']/gi)]
    .map((match) => match[1].trim())
    .filter((paint) => !/^(?:none|transparent)$/i.test(paint));
  const themed = source.replace(
    /\b(fill|stroke)=(["'])([^"']+)\2/gi,
    (attribute, name: string, quote: string, value: string) => (
      darkNeutralHex(value.trim())
        ? `${name}=${quote}currentColor${quote}`
        : attribute
    ),
  );
  return fitInlineSvg(themed, paints.length === 0);
}

function vectorForegroundSvg(vector: ProviderIconVector): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vector.view_box}" width="100%" height="100%" style="display:block"><path fill="currentColor" d="${vector.path}"/></svg>`;
}

export function resolveProviderMark(
  identity: ProviderIdentity,
  registryRows: readonly ProviderIconRegistryRow[],
): ResolvedProviderMark | null {
  const providerSlug = normalizeProviderSlug(identity.providerSlug);
  const providerName = text(identity.providerName) || providerSlug;
  if (!providerSlug || !providerName) return null;
  const entry = readProviderIconRegistry(registryRows)
    .find((candidate) => candidate.provider_slug === providerSlug);
  const image = entry?.asset
    ? bundledAssetDataUrl(entry.asset)
    : entry?.svg
      ? svgDataUrl(entry.svg)
      : null;
  const imageUsesForeground = Boolean(image && (
    entry?.asset
      ? bundledAssetUsesForeground(entry.asset)
      : entry?.svg && darkNeutralHex(entry.svg.color)
  ));
  const foregroundSvg = imageUsesForeground
    ? entry?.asset
      ? bundledAssetForegroundSvg(entry.asset)
      : entry?.svg
        ? vectorForegroundSvg(entry.svg)
        : null
    : null;
  return {
    providerSlug,
    providerName,
    iconId: image ? entry?.icon_id ?? null : null,
    image,
    ...(image ? {
      foregroundSvg,
      imageUsesForeground,
    } : {}),
  };
}
