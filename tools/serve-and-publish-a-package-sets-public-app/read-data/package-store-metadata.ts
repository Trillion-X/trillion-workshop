import type { Metadata } from 'next';
import packageContract from '../things-to-store-and-run.json' with { type: 'json' };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function packagePayloads(): readonly JsonRecord[] {
  return Array.isArray(packageContract.things)
    ? packageContract.things
      .map((thing) => (isRecord(thing) && isRecord(thing.payload) ? thing.payload : undefined))
      .filter(isRecord)
    : [];
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`metadata descriptor field ${field} must be a non-empty string`);
  }
  return value;
}

function metadataDescriptor(entryName: string): JsonRecord {
  const descriptor = packagePayloads().find(
    (payload) => payload.kind === 'operational-record.metadata-descriptor.v1'
      && payload.entry_name === entryName,
  );
  if (!descriptor) throw new Error(`metadata descriptor missing for entry ${entryName}`);
  return descriptor;
}

export function materializeMetadata(entryName = 'package-store-metadata'): Metadata {
  const descriptor = metadataDescriptor(entryName);
  const title = readString(descriptor.title, 'title');
  const description = readString(descriptor.description, 'description');
  const siteUrl = readString(descriptor.site_url, 'site_url');
  const brandName = readString(descriptor.brand_name, 'brand_name');
  const imageUrl = readString(descriptor.image_url, 'image_url');
  return {
    applicationName: title,
    alternates: { canonical: '/' },
    description,
    icons: descriptor.icons as Metadata['icons'],
    manifest: readString(descriptor.manifest, 'manifest'),
    metadataBase: new URL(siteUrl),
    openGraph: {
      description,
      images: [
        {
          alt: readString(descriptor.image_alt, 'image_alt'),
          height: Number(descriptor.image_height),
          url: imageUrl,
          width: Number(descriptor.image_width),
        },
      ],
      locale: readString(descriptor.locale, 'locale'),
      siteName: brandName,
      title,
      type: 'website',
      url: '/',
    },
    title,
    twitter: {
      card: 'summary',
      description,
      images: [imageUrl],
      title,
    },
  };
}

export const packageStoreMetadata = materializeMetadata();
