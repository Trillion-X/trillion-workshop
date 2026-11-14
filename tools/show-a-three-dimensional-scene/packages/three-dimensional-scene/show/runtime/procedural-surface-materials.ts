import {
  Color,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  TangentSpaceNormalMap,
  UnsignedByteType,
  Vector2,
  type Material,
  type Object3D,
} from 'three';
import type { SceneSurfaceMaterialDescriptor } from '../../read-data/scene-descriptor';

type Tier = 'low' | 'medium' | 'high' | 'fallback';

const fract = (value: number) => value - Math.floor(value);
const hash = (x: number, y: number, seed: number) => fract(Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123);
const smooth = (value: number) => value * value * (3 - 2 * value);
const noise = (x: number, y: number, seed: number) => {
  const ix = Math.floor(x); const iy = Math.floor(y); const fx = smooth(fract(x)); const fy = smooth(fract(y));
  const a = hash(ix, iy, seed); const b = hash(ix + 1, iy, seed); const c = hash(ix, iy + 1, seed); const d = hash(ix + 1, iy + 1, seed);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
};
const fbm = (x: number, y: number, seed: number) => {
  let value = 0; let amplitude = 0.55; let frequency = 1;
  for (let octave = 0; octave < 5; octave += 1) { value += noise(x * frequency, y * frequency, seed + octave * 19) * amplitude; frequency *= 2.03; amplitude *= 0.48; }
  return value / 1.066;
};
const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

function heightAt(preset: SceneSurfaceMaterialDescriptor['preset'], u: number, v: number, seed: number) {
  const broad = fbm(u * 4, v * 4, seed);
  if (preset === 'wood') return 0.5 + Math.sin((u * 18 + broad * 2.8) * Math.PI) * 0.17 + (fbm(u * 35, v * 5, seed + 7) - 0.5) * 0.13;
  if (preset === 'tile') {
    const grout = Math.min(fract(u * 4), 1 - fract(u * 4), fract(v * 4), 1 - fract(v * 4));
    return grout < 0.035 ? 0.12 : 0.66 + (broad - 0.5) * 0.08;
  }
  if (preset === 'fabric') return 0.48 + Math.sin(u * 220 * Math.PI) * 0.035 + Math.sin(v * 180 * Math.PI) * 0.035 + (broad - 0.5) * 0.08;
  if (preset === 'metal') return 0.54 + (fbm(u * 80, v * 5, seed) - 0.5) * 0.05;
  if (preset === 'plaster') return 0.5 + (fbm(u * 24, v * 24, seed) - 0.5) * 0.2 + (broad - 0.5) * 0.18;
  if (preset === 'soil') return 0.42 + (fbm(u * 18, v * 18, seed) - 0.5) * 0.38;
  return 0.48 + (fbm(u * 13, v * 13, seed) - 0.5) * 0.31 + (broad - 0.5) * 0.2;
}

function texture(bytes: Uint8Array, size: number, colorSpace: typeof SRGBColorSpace | typeof NoColorSpace) {
  const value = new DataTexture(bytes, size, size, undefined, UnsignedByteType);
  value.colorSpace = colorSpace; value.wrapS = RepeatWrapping; value.wrapT = RepeatWrapping;
  value.minFilter = LinearMipmapLinearFilter; value.magFilter = LinearFilter; value.generateMipmaps = true; value.needsUpdate = true;
  return value;
}

function buildMaterial(definition: SceneSurfaceMaterialDescriptor, tier: Tier) {
  const requested = definition.textureSize ?? 512;
  const size = tier === 'low' ? Math.min(128, requested) : tier === 'medium' ? Math.min(256, requested) : requested;
  const count = size * size; const albedo = new Uint8Array(count * 4); const normal = new Uint8Array(count * 4); const roughness = new Uint8Array(count * 4);
  const heights = new Float32Array(count); const a = new Color(definition.colorA); const b = new Color(definition.colorB);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) heights[y * size + x] = heightAt(definition.preset, x / size, y / size, definition.seed);
  const strength = definition.normalStrength ?? 1;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const index = y * size + x; const byte = index * 4; const h = heights[index];
    const left = heights[y * size + ((x - 1 + size) % size)]; const right = heights[y * size + ((x + 1) % size)];
    const down = heights[((y - 1 + size) % size) * size + x]; const up = heights[((y + 1) % size) * size + x];
    const nx = (left - right) * strength * 3; const ny = (down - up) * strength * 3; const nz = 1; const length = Math.hypot(nx, ny, nz);
    const colorBand = Math.max(0, Math.min(1, h * 0.76 + fbm(x / size * 2, y / size * 2, definition.seed + 101) * 0.24));
    albedo[byte] = clampByte(mix(a.r, b.r, colorBand) * 255); albedo[byte + 1] = clampByte(mix(a.g, b.g, colorBand) * 255); albedo[byte + 2] = clampByte(mix(a.b, b.b, colorBand) * 255); albedo[byte + 3] = 255;
    normal[byte] = clampByte((nx / length * 0.5 + 0.5) * 255); normal[byte + 1] = clampByte((ny / length * 0.5 + 0.5) * 255); normal[byte + 2] = clampByte((nz / length * 0.5 + 0.5) * 255); normal[byte + 3] = 255;
    const r = Math.max(0, Math.min(1, (definition.roughness ?? 0.8) + (0.5 - h) * 0.18)); roughness[byte] = roughness[byte + 1] = roughness[byte + 2] = clampByte(r * 255); roughness[byte + 3] = 255;
  }
  const map = texture(albedo, size, SRGBColorSpace); const normalMap = texture(normal, size, NoColorSpace); const roughnessMap = texture(roughness, size, NoColorSpace);
  const repeat = definition.repeat ?? [1, 1]; for (const item of [map, normalMap, roughnessMap]) item.repeat.set(repeat[0], repeat[1]);
  const material = new MeshStandardMaterial({ name: `surface:${definition.id}`, color: 0xffffff, map, normalMap, roughnessMap, roughness: 1, metalness: definition.metalness ?? (definition.preset === 'metal' ? 0.72 : 0.02) });
  material.normalMapType = TangentSpaceNormalMap; material.normalScale = new Vector2(1, 1); material.dithering = true;
  return material;
}

export function createProceduralSurfaceMaterials(definitions: readonly SceneSurfaceMaterialDescriptor[] | undefined, tier: Tier) {
  const byMaterialName = new Map<string, Material>(); const owned = new Set<Material>();
  for (const definition of definitions ?? []) {
    const material = buildMaterial(definition, tier); owned.add(material);
    for (const name of definition.materialNames) byMaterialName.set(name, material);
  }
  return {
    apply(root: Object3D) {
      root.traverse((object) => {
        const mesh = object as Object3D & { isMesh?: boolean; material?: Material | Material[] };
        if (!mesh.isMesh || !mesh.material) return;
        const current = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const next = current.map((material) => byMaterialName.get(material.name) ?? material);
        mesh.material = Array.isArray(mesh.material) ? next : next[0];
      });
    },
    dispose() { for (const material of owned) { const value = material as MeshStandardMaterial; value.map?.dispose(); value.normalMap?.dispose(); value.roughnessMap?.dispose(); material.dispose(); } owned.clear(); },
  };
}
