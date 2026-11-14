export type FormatCommandRow = { wrap?: [string, string]; prefix?: string; select_after?: string };
export function applyFormat(value: string, start: number, end: number, command: FormatCommandRow): { value: string; start: number; end: number };
