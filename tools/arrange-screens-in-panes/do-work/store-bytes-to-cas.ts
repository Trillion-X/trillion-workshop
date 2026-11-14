// packages/screen-arrangement/do-work/store-bytes-to-cas.ts
//
// SSOT REDIRECT. The generic content-addressed byte store was promoted out of
// this feature package into the shared `cas-store` leaf so sibling features
// (group/board, public-scene-share) consume it without depending on
// screen-arrangement. This file re-exports the ONE definition so existing
// in-package importers keep their path; there is no second copy (L030/SSOT).

export {
  storeBytesToCas,
  type CanonicalArtifactStorageRef,
  type CasMaterializationMetadata,
  type CasNamespace,
} from '@/packages/cas-store/do-work/store-bytes-to-cas'
