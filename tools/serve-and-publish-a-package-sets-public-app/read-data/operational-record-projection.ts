export type JsonRecord = Record<string, unknown>;

export type HostedExperienceProjection = {
  intent: JsonRecord;
  authorityManifest: JsonRecord;
  publication: JsonRecord;
};

type ExactRef = {
  address: string;
  revision: string;
  object_hash: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function payload(record: JsonRecord): JsonRecord {
  return isRecord(record.payload) ? record.payload : record;
}

function exactRef(value: unknown, label: string): ExactRef {
  if (!isRecord(value)) throw new Error(`${label} must be an exact reference`);
  return {
    address: requiredText(value.address, `${label}.address`),
    revision: requiredText(value.revision, `${label}.revision`),
    object_hash: requiredText(value.object_hash, `${label}.object_hash`),
  };
}

function recordIdentity(record: JsonRecord): ExactRef {
  const value = payload(record);
  return {
    address: requiredText(record.address ?? value.address ?? value.id, 'record.address'),
    revision: requiredText(record.revision ?? value.revision, 'record.revision'),
    object_hash: requiredText(record.object_hash ?? value.object_hash, 'record.object_hash'),
  };
}

function sameIdentity(left: ExactRef, right: ExactRef): boolean {
  return left.address === right.address
    && left.revision === right.revision
    && left.object_hash === right.object_hash;
}

function resolveExact(records: readonly JsonRecord[], ref: ExactRef, kind: string): JsonRecord {
  const matches = records.filter((candidate) => {
    const value = payload(candidate);
    return value.kind === kind && sameIdentity(recordIdentity(candidate), ref);
  });
  if (matches.length !== 1) {
    throw new Error(`expected one ${kind} at ${ref.address}@${ref.revision}; found ${matches.length}`);
  }
  return payload(matches[0]);
}

function publicationByRef(records: readonly JsonRecord[], publicationRef: string): JsonRecord {
  const matches = records.filter((candidate) => {
    const value = payload(candidate);
    return value.kind === 'published-experience-publication'
      && (candidate.address === publicationRef || value.address === publicationRef || value.id === publicationRef);
  });
  if (matches.length !== 1) {
    throw new Error(`expected one published experience ${publicationRef}; found ${matches.length}`);
  }
  return payload(matches[0]);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function exactRoots(value: unknown, label: string): unknown {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must contain roots`);
  return canonical(value.map((item, index) => exactRef(item, `${label}[${index}]`)));
}

/**
 * Hosted Public App's caller-ready read boundary.
 *
 * EEAF supplies complete intent/manifest/publication values. This owner verifies
 * their exact links and hands consumers one finished projection. Runtime Kit
 * sealed-closure membership remains referenced by identity; it is never copied
 * into this logical projection.
 */
export function materializeHostedExperienceProjection(
  records: readonly JsonRecord[],
  publicationRef: string,
): HostedExperienceProjection {
  const publication = publicationByRef(records, publicationRef);
  const intent = resolveExact(
    records,
    exactRef(publication.intent_ref, 'publication.intent_ref'),
    'published-experience-intent',
  );
  const authorityManifest = resolveExact(
    records,
    exactRef(publication.authority_manifest_ref, 'publication.authority_manifest_ref'),
    'experience-authority-manifest',
  );
  exactRef(publication.sealed_closure_ref, 'publication.sealed_closure_ref');
  requiredText(publication.signed_closure_multihash, 'publication.signed_closure_multihash');
  exactRef(publication.apply_proof_ref, 'publication.apply_proof_ref');
  requiredText(publication.apply_proof_multihash, 'publication.apply_proof_multihash');

  const publicationRoots = exactRoots(publication.root_refs, 'publication.root_refs');
  const manifestRoots = exactRoots(authorityManifest.root_refs, 'authority_manifest.root_refs');
  const intentRoots = exactRoots(intent.root_refs, 'intent.root_refs');
  if (
    JSON.stringify(publicationRoots) !== JSON.stringify(manifestRoots)
    || JSON.stringify(publicationRoots) !== JSON.stringify(intentRoots)
  ) {
    throw new Error('publication, authority manifest, and intent root identities do not match');
  }
  const accessRef = requiredText(publication.access_ref, 'publication.access_ref');
  if (
    requiredText(authorityManifest.access_ref, 'authority_manifest.access_ref') !== accessRef
    || requiredText(intent.access_ref, 'intent.access_ref') !== accessRef
  ) {
    throw new Error('publication, authority manifest, and intent access refs do not match');
  }
  for (const forbidden of [
    'sealed_closure_members',
    'projected_files',
    'component_bytes',
    'artifact_bytes',
  ]) {
    if (forbidden in authorityManifest || forbidden in publication || forbidden in intent) {
      throw new Error(`logical hosted record copied Runtime Kit membership: ${forbidden}`);
    }
  }
  return { intent, authorityManifest, publication };
}
