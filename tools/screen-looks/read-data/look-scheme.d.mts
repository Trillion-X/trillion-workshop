export type Rgba = [number, number, number, number];

export function parseColour(text: string): Rgba | null;
export function toLinear(channel: number): number;
export function contrast(a: Rgba, b: Rgba): number;
export function colourOf(value: string | undefined): Rgba | null;
export function screenLookScheme(
  resolvedVariables: Record<string, string | undefined>,
  groundRole: string,
): 'light' | 'dark' | null;
