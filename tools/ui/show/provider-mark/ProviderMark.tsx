import React from 'react';
import { cn } from '../cn';
import {
  resolveProviderMark,
  type ProviderIconRegistryRow,
  type ProviderIdentity,
} from './provider-icon-registry';

export interface ProviderMarkProps extends ProviderIdentity {
  registry: readonly ProviderIconRegistryRow[];
  size?: 'xs' | 'sm' | 'md' | 'lg';
  decorative?: boolean;
}

const PROVIDER_MARK_SIZE = {
  xs: 'size-4',
  sm: 'size-5',
  md: 'size-8',
  lg: 'size-10',
} as const;

const PROVIDER_MARK_PIXELS = {
  xs: 16,
  sm: 20,
  md: 32,
  lg: 40,
} as const;

const PROVIDER_IMAGE_SIZE = {
  xs: 'size-3.5',
  sm: 'size-[18px]',
  md: 'size-7',
  lg: 'size-9',
} as const;

const PROVIDER_IMAGE_PIXELS = {
  xs: 14,
  sm: 18,
  md: 28,
  lg: 36,
} as const;

export function ProviderMark({
  providerSlug,
  providerName,
  registry,
  size = 'sm',
  decorative = false,
}: ProviderMarkProps): React.ReactElement | null {
  const resolved = resolveProviderMark({ providerSlug, providerName }, registry);
  if (!resolved) return null;
  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : resolved.providerName}
      aria-hidden={decorative || undefined}
      data-provider-mark={resolved.providerSlug}
      data-provider-icon-id={resolved.iconId ?? 'monogram'}
      data-provider-mark-kind={resolved.image ? 'brand' : 'monogram'}
      className={cn(
        'inline-flex shrink-0 items-center justify-center border-0 bg-transparent p-0 align-middle',
        PROVIDER_MARK_SIZE[size],
      )}
      style={{
        width: PROVIDER_MARK_PIXELS[size],
        height: PROVIDER_MARK_PIXELS[size],
        borderWidth: 0,
        backgroundColor: 'transparent',
      }}
    >
      {resolved.image && resolved.imageUsesForeground && resolved.foregroundSvg ? (
        <span
          aria-hidden="true"
          data-provider-mark-image
          data-provider-mark-appearance="foreground"
          className={cn('block border-0 bg-transparent text-[var(--text-primary)]', PROVIDER_IMAGE_SIZE[size])}
          style={{
            width: PROVIDER_IMAGE_PIXELS[size],
            height: PROVIDER_IMAGE_PIXELS[size],
            color: 'var(--text-primary)',
          }}
          dangerouslySetInnerHTML={{ __html: resolved.foregroundSvg }}
        />
      ) : resolved.image ? (
        <img
          src={resolved.image}
          alt=""
          data-provider-mark-image
          data-provider-mark-appearance="original"
          className={cn('block border-0 bg-transparent object-contain', PROVIDER_IMAGE_SIZE[size])}
          style={{
            width: PROVIDER_IMAGE_PIXELS[size],
            height: PROVIDER_IMAGE_PIXELS[size],
            borderWidth: 0,
            backgroundColor: 'transparent',
          }}
        />
      ) : (
        <span
          aria-hidden="true"
          className="font-semibold leading-none text-[var(--text-secondary)]"
          data-provider-monogram
        >
          {resolved.providerName.charAt(0).toUpperCase()}
        </span>
      )}
    </span>
  );
}
