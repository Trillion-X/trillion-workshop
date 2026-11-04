// Presentation-only visual subjects. The signed-in runtime injects the guarded
// relation reader; a public panel with no durable relation performs no I/O.
// Canonical relation delivery still verifies permission, integrity and revocation
// at the same owner. Missing admission fails closed, never falls back to raw CAS.
import React from 'react'
import { createVisualLayerSubjectResolver } from '../../ui'
import type { AddressRef, VisualLayerDescriptor } from '../../ui/show/visual-layer-stack'
import type { CanonicalArtifactObjectUrl } from '../do-work/read-canonical-artifact-object-url'

type ArtifactSubjectReader = (relationRef: string) => Promise<CanonicalArtifactObjectUrl>
let readArtifactSubject: ArtifactSubjectReader = async () => { throw new Error('Guarded visual subjects are unavailable here.') }
export function setVisualLayerArtifactReader(read: ArtifactSubjectReader) { readArtifactSubject = read }

const CANONICAL_ARTIFACT_FAMILY = 'content-media-evidence.relation/v1'

function artifactKey(ref: AddressRef): string {
  return JSON.stringify([ref.family, ref.parts])
}

/** Persist only the owner-issued relation identity as an addressed visual subject. */
export function canonicalArtifactSubjectRef(
  relationRef: string,
): AddressRef {
  if (!relationRef.trim()) throw new Error('relation_ref is required')
  return {
    family: CANONICAL_ARTIFACT_FAMILY,
    parts: { relation_ref: relationRef.trim() },
  }
}

function readCanonicalArtifactSubject(ref: AddressRef): {
  relationRef: string
} | null {
  if (ref.family !== CANONICAL_ARTIFACT_FAMILY) return null
  return ref.parts.relation_ref?.trim() ? { relationRef: ref.parts.relation_ref.trim() } : null
}

function artifactSubjects(layers: readonly VisualLayerDescriptor[]): AddressRef[] {
  const byKey = new Map<string, AddressRef>()
  const visit = (rows: readonly VisualLayerDescriptor[]) => {
    for (const layer of rows) {
      const subject = layer.paint.input.subject
      if (subject && typeof subject === 'object' && !Array.isArray(subject)) {
        const candidate = subject as Partial<AddressRef>
        if (candidate.family === CANONICAL_ARTIFACT_FAMILY && candidate.parts) {
          const ref = candidate as AddressRef
          byKey.set(artifactKey(ref), ref)
        }
      }
      if (layer.children) visit(layer.children)
    }
  }
  visit(layers)
  return [...byKey.values()]
}

/**
 * Resolve transient dropped subjects immediately and durable relation subjects
 * after owner-verified readback. Every object URL is presentation-only and is
 * revoked when its layer disappears or the rendering surface unmounts.
 */
export function useVisualLayerSubjectResolver(
  layers: readonly VisualLayerDescriptor[],
): (ref: AddressRef) => string | null {
  const transientResolver = React.useMemo(() => createVisualLayerSubjectResolver(), [])
  const subjects = React.useMemo(() => artifactSubjects(layers), [layers])
  const subjectSignature = React.useMemo(() => subjects.map(artifactKey).sort().join('\n'), [subjects])
  const [urls, setUrls] = React.useState<ReadonlyMap<string, string>>(() => new Map())

  React.useEffect(() => {
    let cancelled = false
    const opened = new Map<string, Awaited<ReturnType<typeof readArtifactSubject>>>()
    setUrls(new Map())
    void Promise.all(subjects.map(async (ref) => {
      const decoded = readCanonicalArtifactSubject(ref)
      if (!decoded) return
      const openedUrl = await readArtifactSubject(decoded.relationRef)
      if (cancelled) {
        openedUrl.revoke()
        return
      }
      opened.set(artifactKey(ref), openedUrl)
      setUrls(new Map([...opened].map(([key, value]) => [key, value.url])))
    })).catch((error) => {
      if (!cancelled) console.error('[screen-arrangement] durable visual subject failed', error)
    })
    return () => {
      cancelled = true
      opened.forEach((value) => value.revoke())
    }
    // The signature is the exact durable-subject identity set. `subjects`
    // itself is derived from layer object identity and is intentionally folded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectSignature])

  return React.useCallback((ref: AddressRef): string | null => (
    readCanonicalArtifactSubject(ref)
      ? urls.get(artifactKey(ref)) ?? null
      : transientResolver(ref)
  ), [transientResolver, urls])
}

