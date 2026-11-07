export type TitleList = {title_field?: string | null; fields?: {id: string; kind?: string; derive?: unknown}[]};
export type TitleKind = {id: string; carries?: {key: string; defaults?: Record<string, unknown>}};
export type TitleRequest = {binding: Record<string, unknown>; rows: unknown[]};
export type TitleAnswer = {values: unknown[]; errors: unknown[]};
export function titleText(value: unknown): string | null;
export function prepareListTitles(list: TitleList, values: unknown[], options?: {fieldKinds?: TitleKind[]}): {
  request: TitleRequest | null;
  finish(answer?: unknown): (string | null)[];
};
