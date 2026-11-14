// packages/service-connections/read-data/read-source-offers.ts
//
// Generic source-offer projection. A source is any owner that can expose a
// selectable value and materialize it into a declared output contract. Local
// files, connected services, generators, recordings, and unseen sources are
// configurations of this one descriptor; connector identity is optional DATA.

export interface SourceOfferAvailability {
  readonly is_available: boolean;
  readonly reason?: string;
  readonly authority_ref?: string;
  readonly [extension: string]: unknown;
}

export interface SourceOfferSelectionSchema {
  readonly control: string;
  readonly fields?: readonly Readonly<Record<string, unknown>>[];
  readonly [extension: string]: unknown;
}

export interface SourceOfferMaterializer {
  readonly target: string;
  readonly payload_template?: Readonly<Record<string, unknown>>;
  readonly [extension: string]: unknown;
}

export interface SourceOfferProvenance {
  readonly source_ref: string;
  readonly confidence_field?: string;
  readonly [extension: string]: unknown;
}

export type SourceOfferOutputContract = string | Readonly<Record<string, unknown>>;

export interface SourceOffer {
  readonly kind: 'source.offer';
  readonly id: string;
  readonly label: string;
  readonly availability: SourceOfferAvailability;
  readonly selection_schema: SourceOfferSelectionSchema;
  readonly materializer: SourceOfferMaterializer;
  readonly output_contract: SourceOfferOutputContract;
  readonly provenance: SourceOfferProvenance;
  readonly presentation?: Readonly<Record<string, unknown>>;
  readonly connection_ref?: string;
  /** Original validated descriptor, including unknown extension fields. */
  readonly descriptor: Readonly<Record<string, unknown>>;
}

export interface SourceDecoderDescriptor {
  source_ref: string;
  decoder_capability_ref: string;
  decoder_process_module: { script_address: string };
  location?: { kind: string; data: Record<string, unknown> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asAvailability(value: unknown): SourceOfferAvailability | null {
  if (!isRecord(value) || typeof value.is_available !== 'boolean') return null;
  return {
    ...value,
    is_available: value.is_available,
    ...(asString(value.reason) ? { reason: asString(value.reason) } : {}),
    ...(asString(value.authority_ref) ? { authority_ref: asString(value.authority_ref) } : {}),
  };
}

function asSelectionSchema(value: unknown): SourceOfferSelectionSchema | null {
  if (!isRecord(value)) return null;
  const control = asString(value.control);
  if (!control) return null;
  const fields = Array.isArray(value.fields)
    ? value.fields.filter((field): field is Record<string, unknown> => isRecord(field))
    : undefined;
  return { ...value, control, ...(fields ? { fields } : {}) };
}

function asMaterializer(value: unknown): SourceOfferMaterializer | null {
  if (!isRecord(value)) return null;
  const target = asString(value.target);
  if (!target) return null;
  return {
    ...value,
    target,
    ...(isRecord(value.payload_template) ? { payload_template: value.payload_template } : {}),
  };
}

function asOutputContract(value: unknown): SourceOfferOutputContract | null {
  if (isRecord(value)) return value;
  const text = asString(value);
  return text || null;
}

function asProvenance(value: unknown): SourceOfferProvenance | null {
  if (!isRecord(value)) return null;
  const source_ref = asString(value.source_ref);
  if (!source_ref) return null;
  return {
    ...value,
    source_ref,
    ...(asString(value.confidence_field) ? { confidence_field: asString(value.confidence_field) } : {}),
  };
}

export function decodeSourceOffer(value: unknown): SourceOffer | null {
  if (!isRecord(value) || value.kind !== 'source.offer') return null;
  const id = asString(value.id);
  const label = asString(value.label);
  const availability = asAvailability(value.availability);
  const selection_schema = asSelectionSchema(value.selection_schema);
  const materializer = asMaterializer(value.materializer);
  const output_contract = asOutputContract(value.output_contract);
  const provenance = asProvenance(value.provenance);
  if (!id || !label || !availability || !selection_schema || !materializer || !output_contract || !provenance) {
    return null;
  }
  return {
    kind: 'source.offer',
    id,
    label,
    availability,
    selection_schema,
    materializer,
    output_contract,
    provenance,
    ...(isRecord(value.presentation) ? { presentation: value.presentation } : {}),
    ...(asString(value.connection_ref) ? { connection_ref: asString(value.connection_ref) } : {}),
    descriptor: value,
  };
}

/** Decode every valid descriptor. Availability is owner DATA, not inferred from
 * connector catalogs or a second client-side connection list. */
export function readSourceOffers(published: unknown): SourceOffer[] {
  if (!Array.isArray(published)) return [];
  const byId = new Map<string, SourceOffer>();
  for (const row of published) {
    if (!isRecord(row)) continue;
    const offer = decodeSourceOffer(row.payload);
    if (offer && !byId.has(offer.id)) byId.set(offer.id, offer);
  }
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

export function groupSourceOffersByCategory(offers: readonly SourceOffer[]): Map<string, SourceOffer[]> {
  const groups = new Map<string, SourceOffer[]>();
  for (const offer of offers) {
    const group = isRecord(offer.presentation) ? asString(offer.presentation.group) : '';
    const key = group || offer.provenance.source_ref;
    groups.set(key, [...(groups.get(key) ?? []), offer]);
  }
  return groups;
}

function sourceLabel(sourceRef: string): string {
  const segment = sourceRef.split(':').filter(Boolean).at(-1) ?? sourceRef;
  return segment
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.length <= 2 ? word.toUpperCase() : `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

/** Produce generic picker options from currently available descriptors. The
 * validated descriptor rides as `record`; the consumer never imports this owner. */
export function sourceOffersAsOptions(offers: readonly SourceOffer[]): Array<{
  value: string;
  label: string;
  record: SourceOffer;
}> {
  return offers
    .filter((offer) => offer.availability.is_available)
    .map((offer) => ({
      value: offer.id,
      label: `${sourceLabel(offer.provenance.source_ref)} · ${offer.label}`,
      record: offer,
    }));
}

/** Lookup a source decoder descriptor from published observed-content rows. */
export function readSourceDecoderDescriptor(
  published: unknown,
  source_ref: string,
): SourceDecoderDescriptor | null {
  if (!Array.isArray(published)) return null;
  for (const row of published) {
    if (!isRecord(row)) continue;
    const payload = row.payload;
    if (!isRecord(payload)
      || payload.table !== 'attribute_fact'
      || payload.property_id !== 'prop:observed_content:conversation_source_descriptor'
      || payload.subject_id !== source_ref) continue;
    const descriptors = Array.isArray(payload.value_json) ? payload.value_json : [payload.value_json];
    for (const descriptor of descriptors) {
      if (!isRecord(descriptor) || !isRecord(descriptor.decoder_process_module)) continue;
      const decoder_capability_ref = asString(descriptor.decoder_capability_ref);
      const script_address = asString(descriptor.decoder_process_module.script_address);
      if (!decoder_capability_ref || !script_address) continue;
      return {
        source_ref,
        decoder_capability_ref,
        decoder_process_module: { script_address },
        ...(isRecord(descriptor.location) ? { location: descriptor.location as SourceDecoderDescriptor['location'] } : {}),
      };
    }
  }
  return null;
}
