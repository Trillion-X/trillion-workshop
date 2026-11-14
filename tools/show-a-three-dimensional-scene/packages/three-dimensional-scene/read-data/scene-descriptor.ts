export type CapabilityRef = { registry?: string; capabilityId: string };
export type AddressRef = { address: string; sha256?: string; mediaType?: string };
export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export type SceneAssetDescriptor = {
  id: string;
  loader: CapabilityRef;
  input: Record<string, unknown>;
  /** Descriptor-owned source substitutions selected before loader/cache identity. */
  qualityVariants?: Partial<Record<'high' | 'medium' | 'low' | 'fallback', { input: Record<string, unknown> }>>;
  attachTo?: string;
  objectNamePrefix?: string;
  delivery?: { blocking?: boolean };
  transform?: {
    position?: Vec3;
    rotation?: Vec3;
    scale?: Vec3;
  };
  animation?: {
    source?: AddressRef;
    clipName?: string;
    clipIndex?: number;
    autoplay?: boolean;
    loop?: boolean;
    timeScale?: number;
    startOffset?: number;
  };
};

export type SceneDriverDescriptor = {
  id: string;
  capability: CapabilityRef;
  input: Record<string, unknown>;
  clamp?: readonly [number, number];
};

export type SceneViewportProfile = 'desktop' | 'tablet' | 'mobile';

export type SceneKeyframe = {
  at: number;
  value: unknown;
  easing?: CapabilityRef;
  /** Optional composition values for constrained viewport profiles. */
  responsive?: { mobile?: unknown; tablet?: unknown };
};

export type SceneTrackDescriptor = {
  id: string;
  driverId: string;
  target: { object: string; propertyPath: string };
  interpolation: CapabilityRef;
  keyframes: readonly SceneKeyframe[];
};

export type SceneInteractionDescriptor = {
  id: string;
  object: string;
  activation: readonly CapabilityRef[];
  output: { name: string; value: unknown };
  accessibleLabel: string;
};

export type SemanticSceneSection = {
  id: string;
  eyebrow?: string;
  heading: string;
  body: string;
  claimState: string;
  stationId?: string;
  action?: { label: string; href: string };
};

export type SceneQualityPolicy = {
  maxDevicePixelRatio: number;
  maxActiveLights: number;
  maxTrianglesDesktop: number;
  maxTrianglesMobile: number;
  maxTextureBytes: number;
  maxAnimationFpsDesktop?: number;
  maxAnimationFpsMobile?: number;
  suspendWhenHidden: boolean;
  renderOnlyWhenDirty: boolean;
};

export type SceneSurfaceMaterialDescriptor = {
  id: string;
  materialNames: readonly string[];
  preset: 'wood' | 'stone' | 'plaster' | 'metal' | 'fabric' | 'tile' | 'soil';
  seed: number;
  textureSize?: 128 | 256 | 512 | 1024;
  repeat?: readonly [number, number];
  colorA: string;
  colorB: string;
  roughness?: number;
  metalness?: number;
  normalStrength?: number;
};

export type ThreeDimensionalSceneDescriptor = {
  schema: 'three-dimensional-scene/v1';
  id: string;
  revision: string;
  title: string;
  canvasLabel: string;
  camera: {
    objectId: string;
    fov: number;
    near: number;
    far: number;
    position: Vec3;
    quaternion?: Quat;
    lookAt?: Vec3;
    responsiveFov?: { mobile?: number; tablet?: number };
  };
  background: { color: string; alpha: number };
  environment?: {
    fog?: { color: string; density: number };
    toneMapping?: 'aces' | 'none';
    exposure?: number;
    shadows?: boolean;
  };
  surfaceMaterials?: readonly SceneSurfaceMaterialDescriptor[];
  assets: readonly SceneAssetDescriptor[];
  drivers: readonly SceneDriverDescriptor[];
  tracks: readonly SceneTrackDescriptor[];
  interactions: readonly SceneInteractionDescriptor[];
  semanticSections: readonly SemanticSceneSection[];
  quality: SceneQualityPolicy;
  fallbackPoster?: { loader: CapabilityRef; input: Record<string, unknown>; alt: string };
};

export type SceneDescriptorIssue = { path: string; code: string; message: string };
export type ReadSceneDescriptorRequest = { source: unknown };
export type ReadSceneDescriptorReply =
  | { ok: true; descriptor: ThreeDimensionalSceneDescriptor }
  | { ok: false; issues: readonly SceneDescriptorIssue[] };
