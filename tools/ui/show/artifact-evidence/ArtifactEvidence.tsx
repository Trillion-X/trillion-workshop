// parts/ui/show/artifact-evidence/ArtifactEvidence.tsx
//
// PURPOSE
//   A source artifact with the surrounding facts that make it understandable. The consumer resolves opaque
//   Namespace identity to its authorized bytes address and content type; this part shows the artifact itself
//   through FilePreview and renders caller-named references and context without knowing a product or record kind.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This part owns no record, approval, publication or completion state.
//   2. Names, references and context are supplied by the current source owner.
//   3. The actual artifact uses the shared FilePreview; an identity or schema dump is never a substitute.
import * as React from 'react';
import { Container } from '../container';
import { Text } from '../text';
import { Button } from '../button';
import { FilePreview } from '../file-preview/FilePreview';

export type EvidenceReference = { label: string; value: string; address?: string };
export type ArtifactEvidenceProps = {
  artifacts?: readonly { url: string; contentType: string; label: string }[];
  references?: readonly EvidenceReference[];
  context?: readonly EvidenceReference[];
  heightPx?: number;
  onOpenReference?: (reference: EvidenceReference) => void;
};

/** Shared, domain-blind source artifact and its named provenance/status facts. */
export function ArtifactEvidence({ artifacts = [], references = [], context = [], heightPx = 360, onOpenReference }: ArtifactEvidenceProps) {
  if (!artifacts.length && !references.length && !context.length) return null;
  return (
    <Container layout="vertical" gap="sm" data-artifact-evidence="">
      {artifacts.map((artifact, index) => <Container key={`artifact:${index}`} heightPx={heightPx} minHeight="0"><FilePreview url={artifact.url} contentType={artifact.contentType} label={artifact.label} autoPlay={false} /></Container>)}
      {references.map((item, index) => (
        <Container key={`reference:${index}`} layout="horizontal" gap="xs" alignItems="center">
          <Text variant="body" wrap="preserve">{item.label}: {item.value}</Text>
          {item.address && onOpenReference ? <Button size="xs" variant="ghost" onClick={() => onOpenReference(item)}>Open</Button> : null}
        </Container>
      ))}
      {context.map((item, index) => <Text key={`context:${index}`} variant="body" wrap="preserve">{item.label}: {item.value}</Text>)}
    </Container>
  );
}
