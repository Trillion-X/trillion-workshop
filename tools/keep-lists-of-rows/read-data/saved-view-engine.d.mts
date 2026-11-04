export type SavedViewSurface = {columnWidths?: Record<string, number>; compact?: boolean; align?: Record<string, 'left' | 'center' | 'right'>; frozen?: number; detail?: string | null; timeline?: string | null};
export type SavedViewDisplay = {as: string; settings?: Record<string, unknown>; surface?: SavedViewSurface};
export type ProjectionRow = {id: string; title?: string; values: Record<string, unknown>; [key: string]: unknown};
export type ProjectionField = {id: string; kind?: string; [key: string]: unknown};
export type SavedTimeBound = {value?: unknown; binding?: unknown; refs?: unknown[]};
export type ProjectionContext = {now?: number; readRecord?: (id: string) => Promise<unknown>; evaluateBinding?: (binding: unknown, context: {now: number; refs: Record<string, unknown>}) => unknown | Promise<unknown>; resolveTimeBound?: (point: SavedTimeBound, now: number) => Promise<number | null>};
export function normalizeSavedView(input: Record<string, unknown>, fieldIds: string[]): Record<string, unknown> & {id?: string; label: string; search: string; display?: SavedViewDisplay};
export function projectSavedView<Row extends ProjectionRow, Field extends ProjectionField>(options: ProjectionContext & {view: Record<string, unknown>; fields: Field[]; rows: Row[]; ruleKindOf?: (kind: string | undefined) => string | undefined; filterRows?: (input: {tree: unknown; fields: {id: string; kind?: string}[]; rows: Record<string, unknown>[]}) => Promise<{matches: number[]; incomplete?: unknown[]}> | {matches: number[]; incomplete?: unknown[]}}): Promise<{view: ReturnType<typeof normalizeSavedView>; fields: Field[]; rows: Row[]; groups: {path: string[]; row_ids: string[]}[]; total: number}>;

export function resolveSavedViewTimeBound(point: SavedTimeBound | undefined | null, context: ProjectionContext & {now: number}): Promise<number | null>;
export function calendarBucket(value: unknown, bucket: string, timeZone: string, now?: number): string;
export function calendarBucketSpan(value: string, bucket: string, timeZone: string, now?: number): {start: string; end: string; min: number; max: number} | null;
