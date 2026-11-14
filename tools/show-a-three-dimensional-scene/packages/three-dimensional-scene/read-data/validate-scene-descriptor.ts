import type { SceneDescriptorIssue, ThreeDimensionalSceneDescriptor } from './scene-descriptor';

const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const PATH_SEGMENT = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const FORBIDDEN_PATH = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_ISSUES = 128;

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const capability = (value: unknown) => nonEmpty(object(value)?.capabilityId);
const tuple = (value: unknown, length: number) => Array.isArray(value) && value.length === length && value.every(finite);

export function validateSceneDescriptor(source: unknown): readonly SceneDescriptorIssue[] {
  const issues: SceneDescriptorIssue[] = [];
  const issue = (path: string, code: string, message: string) => {
    if (issues.length < MAX_ISSUES) issues.push({ path, code, message });
  };
  const root = object(source);
  if (!root) return [{ path: '$', code: 'object.required', message: 'descriptor must be an object' }];
  if (root.schema !== 'three-dimensional-scene/v1') issue('schema', 'schema.invalid', 'schema must equal three-dimensional-scene/v1');
  for (const field of ['id', 'revision', 'title', 'canvasLabel'] as const) {
    if (!nonEmpty(root[field])) issue(field, 'text.required', `${field} must be non-empty text`);
  }
  if (nonEmpty(root.id) && !ID.test(root.id)) issue('id', 'id.invalid', 'id is not stable');

  const camera = object(root.camera);
  if (!camera) issue('camera', 'object.required', 'camera is required');
  else {
    if (!nonEmpty(camera.objectId)) issue('camera.objectId', 'text.required', 'camera objectId is required');
    if (!finite(camera.fov) || camera.fov < 10 || camera.fov > 100) issue('camera.fov', 'range.invalid', 'fov must be 10..100');
    const responsiveFov = object(camera.responsiveFov);
    if (camera.responsiveFov !== undefined && !responsiveFov) issue('camera.responsiveFov', 'object.required', 'responsiveFov must be an object');
    if (responsiveFov) for (const field of ['mobile', 'tablet'] as const) {
      if (responsiveFov[field] !== undefined && (!finite(responsiveFov[field]) || Number(responsiveFov[field]) < 10 || Number(responsiveFov[field]) > 100)) issue(`camera.responsiveFov.${field}`, 'range.invalid', `${field} fov must be 10..100`);
    }
    if (!finite(camera.near) || !finite(camera.far) || camera.near <= 0 || camera.near >= camera.far) issue('camera', 'range.invalid', 'camera requires 0 < near < far');
    if (!tuple(camera.position, 3)) issue('camera.position', 'vec3.invalid', 'position must be a finite vec3');
    if (camera.quaternion !== undefined && !tuple(camera.quaternion, 4)) issue('camera.quaternion', 'quat.invalid', 'quaternion must be a finite quat');
    if (camera.lookAt !== undefined && !tuple(camera.lookAt, 3)) issue('camera.lookAt', 'vec3.invalid', 'lookAt must be a finite vec3');
  }
  const background = object(root.background);
  if (!background || !nonEmpty(background.color) || !finite(background.alpha) || background.alpha < 0 || background.alpha > 1) {
    issue('background', 'background.invalid', 'background requires color and alpha 0..1');
  }
  const environment = object(root.environment);
  if (root.environment !== undefined && !environment) issue('environment', 'object.required', 'environment must be an object');
  if (environment) {
    const fog = object(environment.fog);
    if (environment.fog !== undefined && (!fog || !nonEmpty(fog.color) || !finite(fog.density) || fog.density <= 0 || fog.density > 1)) {
      issue('environment.fog', 'fog.invalid', 'fog requires color and density in (0, 1]');
    }
    if (environment.toneMapping !== undefined && environment.toneMapping !== 'aces' && environment.toneMapping !== 'none') issue('environment.toneMapping', 'enum.invalid', 'toneMapping must be aces or none');
    if (environment.exposure !== undefined && (!finite(environment.exposure) || environment.exposure <= 0 || environment.exposure > 8)) issue('environment.exposure', 'range.invalid', 'exposure must be in (0, 8]');
    if (environment.shadows !== undefined && typeof environment.shadows !== 'boolean') issue('environment.shadows', 'boolean.required', 'shadows must be boolean');
  }

  if (root.surfaceMaterials !== undefined && !Array.isArray(root.surfaceMaterials)) issue('surfaceMaterials', 'array.required', 'surfaceMaterials must be an array');
  const surfaceIds = new Set<string>();
  const surfacePresets = new Set(['wood', 'stone', 'plaster', 'metal', 'fabric', 'tile', 'soil']);
  (Array.isArray(root.surfaceMaterials) ? root.surfaceMaterials : []).forEach((row, index) => {
    const value = object(row); const base = `surfaceMaterials[${index}]`;
    if (!value || !nonEmpty(value.id) || !ID.test(value.id)) issue(`${base}.id`, 'id.invalid', 'surface material id is invalid');
    else if (surfaceIds.has(value.id)) issue(`${base}.id`, 'id.duplicate', `duplicate id ${value.id}`);
    else surfaceIds.add(value.id);
    if (!Array.isArray(value?.materialNames) || value.materialNames.length === 0 || value.materialNames.some((name) => !nonEmpty(name))) issue(`${base}.materialNames`, 'selector.invalid', 'materialNames requires non-empty names');
    if (!surfacePresets.has(String(value?.preset))) issue(`${base}.preset`, 'enum.invalid', 'surface preset is invalid');
    if (!Number.isSafeInteger(value?.seed) || Number(value?.seed) < 0) issue(`${base}.seed`, 'integer.nonnegative', 'seed must be a non-negative integer');
    if (value?.textureSize !== undefined && ![128, 256, 512, 1024].includes(Number(value.textureSize))) issue(`${base}.textureSize`, 'enum.invalid', 'textureSize must be 128, 256, 512, or 1024');
    if (value?.repeat !== undefined && (!tuple(value.repeat, 2) || (value.repeat as number[]).some((component) => component <= 0 || component > 128))) issue(`${base}.repeat`, 'range.invalid', 'repeat components must be in (0, 128]');
    for (const field of ['colorA', 'colorB'] as const) if (!nonEmpty(value?.[field])) issue(`${base}.${field}`, 'text.required', `${field} is required`);
    for (const field of ['roughness', 'metalness'] as const) if (value?.[field] !== undefined && (!finite(value[field]) || Number(value[field]) < 0 || Number(value[field]) > 1)) issue(`${base}.${field}`, 'range.invalid', `${field} must be 0..1`);
    if (value?.normalStrength !== undefined && (!finite(value.normalStrength) || value.normalStrength < 0 || value.normalStrength > 4)) issue(`${base}.normalStrength`, 'range.invalid', 'normalStrength must be 0..4');
  });

  const collections = ['assets', 'drivers', 'tracks', 'interactions', 'semanticSections'] as const;
  for (const collection of collections) if (!Array.isArray(root[collection])) issue(collection, 'array.required', `${collection} must be an array`);
  const ids = (collection: typeof collections[number]) => {
    const seen = new Set<string>();
    const rows = Array.isArray(root[collection]) ? root[collection] : [];
    rows.forEach((row, index) => {
      const id = object(row)?.id;
      if (!nonEmpty(id) || !ID.test(id)) issue(`${collection}[${index}].id`, 'id.invalid', 'id is invalid');
      else if (seen.has(id)) issue(`${collection}[${index}].id`, 'id.duplicate', `duplicate id ${id}`);
      else seen.add(id);
    });
    return seen;
  };
  ids('assets');
  const driverIds = ids('drivers');
  ids('tracks'); ids('interactions'); ids('semanticSections');

  (Array.isArray(root.assets) ? root.assets : []).forEach((row, index) => {
    const value = object(row);
    if (!value || !capability(value.loader) || !object(value.input)) issue(`assets[${index}]`, 'asset.invalid', 'asset requires loader and opaque input');
    const qualityVariants = object(value?.qualityVariants);
    if (value?.qualityVariants !== undefined && !qualityVariants) issue(`assets[${index}].qualityVariants`, 'object.required', 'qualityVariants must be an object');
    if (qualityVariants) {
      for (const key of Object.keys(qualityVariants)) {
        if (!['high', 'medium', 'low', 'fallback'].includes(key)) issue(`assets[${index}].qualityVariants.${key}`, 'tier.invalid', 'quality variant tier must be high, medium, low, or fallback');
        else if (!object(object(qualityVariants[key])?.input)) issue(`assets[${index}].qualityVariants.${key}.input`, 'object.required', 'quality variant requires opaque input');
      }
    }
    const delivery = object(value?.delivery);
    if (value?.delivery !== undefined && !delivery) issue(`assets[${index}].delivery`, 'object.required', 'asset delivery must be an object');
    if (delivery?.blocking !== undefined && typeof delivery.blocking !== 'boolean') issue(`assets[${index}].delivery.blocking`, 'boolean.required', 'blocking must be boolean');
    const transform = object(value?.transform);
    if (value?.transform !== undefined && !transform) issue(`assets[${index}].transform`, 'object.required', 'asset transform must be an object');
    if (transform) {
      for (const field of ['position', 'rotation', 'scale'] as const) {
        if (transform[field] !== undefined && !tuple(transform[field], 3)) issue(`assets[${index}].transform.${field}`, 'vec3.invalid', `${field} must be a finite vec3`);
      }
      if (tuple(transform.scale, 3) && (transform.scale as number[]).some((component) => component === 0 || Math.abs(component) > 1000)) issue(`assets[${index}].transform.scale`, 'range.invalid', 'scale components must be non-zero and bounded');
    }
    const animation = object(value?.animation);
    if (value?.animation !== undefined && !animation) issue(`assets[${index}].animation`, 'object.required', 'asset animation must be an object');
    if (animation) {
      const animationSource = object(animation.source);
      if (animation.source !== undefined && (!animationSource || !nonEmpty(animationSource.address))) issue(`assets[${index}].animation.source`, 'address.invalid', 'animation source requires an address');
      if (animation.clipName !== undefined && !nonEmpty(animation.clipName)) issue(`assets[${index}].animation.clipName`, 'text.required', 'clipName must be non-empty text');
      if (animation.clipIndex !== undefined && (!Number.isSafeInteger(animation.clipIndex) || Number(animation.clipIndex) < 0)) issue(`assets[${index}].animation.clipIndex`, 'integer.nonnegative', 'clipIndex must be a non-negative integer');
      for (const field of ['autoplay', 'loop'] as const) if (animation[field] !== undefined && typeof animation[field] !== 'boolean') issue(`assets[${index}].animation.${field}`, 'boolean.required', `${field} must be boolean`);
      if (animation.timeScale !== undefined && (!finite(animation.timeScale) || animation.timeScale < 0 || animation.timeScale > 8)) issue(`assets[${index}].animation.timeScale`, 'range.invalid', 'timeScale must be 0..8');
      if (animation.startOffset !== undefined && (!finite(animation.startOffset) || animation.startOffset < 0 || animation.startOffset > 86400)) issue(`assets[${index}].animation.startOffset`, 'range.invalid', 'startOffset must be 0..86400 seconds');
    }
  });
  (Array.isArray(root.drivers) ? root.drivers : []).forEach((row, index) => {
    const value = object(row);
    if (!value || !capability(value.capability) || !object(value.input)) issue(`drivers[${index}]`, 'driver.invalid', 'driver requires capability and opaque input');
    if (value?.clamp !== undefined && (!tuple(value.clamp, 2) || (value.clamp as number[])[0] > (value.clamp as number[])[1])) issue(`drivers[${index}].clamp`, 'range.invalid', 'clamp must ascend');
  });
  (Array.isArray(root.tracks) ? root.tracks : []).forEach((row, index) => {
    const value = object(row); const target = object(value?.target);
    if (!value || !nonEmpty(value.driverId) || !driverIds.has(value.driverId)) issue(`tracks[${index}].driverId`, 'driver.missing', 'track driver does not exist');
    if (!capability(value?.interpolation)) issue(`tracks[${index}].interpolation`, 'capability.invalid', 'interpolation capability is required');
    if (!target || !nonEmpty(target.object)) issue(`tracks[${index}].target.object`, 'selector.invalid', 'target object is required');
    const path = target?.propertyPath;
    const segments = typeof path === 'string' ? path.split('.') : [];
    if (segments.length < 1 || segments.length > 8 || segments.some((segment) => !PATH_SEGMENT.test(segment) || FORBIDDEN_PATH.has(segment))) {
      issue(`tracks[${index}].target.propertyPath`, 'property-path.invalid', 'property path is not allowlisted');
    }
    const keyframes = Array.isArray(value?.keyframes) ? value.keyframes : [];
    if (keyframes.length < 2) issue(`tracks[${index}].keyframes`, 'keyframes.too-few', 'at least two keyframes are required');
    let prior = -Infinity;
    keyframes.forEach((keyframe, frameIndex) => {
      const frame = object(keyframe); const at = frame?.at;
      if (!finite(at) || at <= prior) issue(`tracks[${index}].keyframes[${frameIndex}].at`, 'keyframe.order', 'keyframes must be finite and strictly ascending');
      if (finite(at)) prior = at;
      const easing = frame?.easing;
      if (easing !== undefined && !capability(easing)) issue(`tracks[${index}].keyframes[${frameIndex}].easing`, 'capability.invalid', 'easing capability is invalid');
      const responsive = object(frame?.responsive);
      if (frame?.responsive !== undefined && !responsive) issue(`tracks[${index}].keyframes[${frameIndex}].responsive`, 'object.required', 'responsive keyframe values must be an object');
      if (responsive) {
        const unsupported = Object.keys(responsive).filter((profile) => profile !== 'mobile' && profile !== 'tablet');
        if (unsupported.length) issue(`tracks[${index}].keyframes[${frameIndex}].responsive`, 'profile.invalid', 'responsive keyframe profiles must be mobile or tablet');
      }
    });
  });
  (Array.isArray(root.interactions) ? root.interactions : []).forEach((row, index) => {
    const value = object(row);
    if (!value || !nonEmpty(value.object)) issue(`interactions[${index}].object`, 'selector.invalid', 'interaction object is required');
    if (!nonEmpty(value?.accessibleLabel)) issue(`interactions[${index}].accessibleLabel`, 'a11y.label-required', 'accessible label is required');
    if (!Array.isArray(value?.activation) || value.activation.length === 0 || value.activation.some((entry) => !capability(entry))) issue(`interactions[${index}].activation`, 'capability.invalid', 'activation capabilities are required');
    const output = object(value?.output);
    if (!output || !nonEmpty(output.name)) issue(`interactions[${index}].output`, 'output.invalid', 'output name is required');
  });
  const sections = Array.isArray(root.semanticSections) ? root.semanticSections : [];
  if (sections.length === 0) issue('semanticSections', 'semantic.required', 'at least one semantic section is required');
  sections.forEach((row, index) => {
    const value = object(row);
    for (const field of ['heading', 'body', 'claimState'] as const) if (!nonEmpty(value?.[field])) issue(`semanticSections[${index}].${field}`, 'text.required', `${field} is required`);
  });
  const quality = object(root.quality);
  if (!quality) issue('quality', 'object.required', 'quality policy is required');
  else {
    if (!finite(quality.maxDevicePixelRatio) || quality.maxDevicePixelRatio < 1 || quality.maxDevicePixelRatio > 2) issue('quality.maxDevicePixelRatio', 'range.invalid', 'DPR must be 1..2');
    for (const field of ['maxActiveLights', 'maxTrianglesDesktop', 'maxTrianglesMobile', 'maxTextureBytes'] as const) {
      if (!Number.isSafeInteger(quality[field]) || Number(quality[field]) <= 0) issue(`quality.${field}`, 'integer.positive', `${field} must be a positive integer`);
    }
    for (const field of ['maxAnimationFpsDesktop', 'maxAnimationFpsMobile'] as const) {
      if (quality[field] !== undefined && (!finite(quality[field]) || Number(quality[field]) < 1 || Number(quality[field]) > 120)) issue(`quality.${field}`, 'range.invalid', `${field} must be 1..120`);
    }
    for (const field of ['suspendWhenHidden', 'renderOnlyWhenDirty'] as const) if (typeof quality[field] !== 'boolean') issue(`quality.${field}`, 'boolean.required', `${field} must be boolean`);
  }
  const poster = object(root.fallbackPoster);
  if (root.fallbackPoster !== undefined && (!poster || !capability(poster.loader) || !object(poster.input) || !nonEmpty(poster.alt))) issue('fallbackPoster', 'poster.invalid', 'fallback poster is invalid');
  return issues;
}

export function isThreeDimensionalSceneDescriptor(value: unknown): value is ThreeDimensionalSceneDescriptor {
  return validateSceneDescriptor(value).length === 0;
}
