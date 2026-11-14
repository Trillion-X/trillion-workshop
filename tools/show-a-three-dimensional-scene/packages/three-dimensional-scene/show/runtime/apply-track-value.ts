import { Color, Euler, Quaternion, Vector2, Vector3, Vector4 } from 'three';

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export function applyTrackValue(target: object, propertyPath: string, value: unknown): void {
  const segments = propertyPath.split('.');
  if (!segments.length || segments.length > 8 || segments.some((segment) => FORBIDDEN.has(segment))) throw new Error('unsafe property path');
  let owner: Record<string, unknown> = target as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    if (!own(owner, segment) || !owner[segment] || typeof owner[segment] !== 'object') throw new Error(`property path unavailable: ${propertyPath}`);
    owner = owner[segment] as Record<string, unknown>;
  }
  const key = segments.at(-1)!;
  if (!own(owner, key)) throw new Error(`property path unavailable: ${propertyPath}`);
  const current = owner[key];
  if (current instanceof Vector2 && Array.isArray(value)) current.fromArray(value as number[]);
  else if (current instanceof Vector3 && Array.isArray(value)) current.fromArray(value as number[]);
  else if (current instanceof Vector4 && Array.isArray(value)) current.fromArray(value as number[]);
  else if (current instanceof Quaternion && Array.isArray(value)) current.fromArray(value as number[]).normalize();
  else if (current instanceof Euler && Array.isArray(value)) current.fromArray(value as [number, number, number]);
  else if (current instanceof Color && (typeof value === 'string' || typeof value === 'number')) current.set(value);
  else if (typeof current === 'number' && typeof value === 'number' && Number.isFinite(value)) owner[key] = value;
  else if (typeof current === 'boolean' && typeof value === 'boolean') owner[key] = value;
  else throw new Error(`unsupported track value for ${propertyPath}`);
}
