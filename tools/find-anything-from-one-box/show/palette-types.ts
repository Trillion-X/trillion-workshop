export interface PaletteItemSource {
  readonly target: string;
  readonly recordId: string;
  readonly sourcePath: string;
  readonly publishedRecord: unknown;
}

export interface PaletteItem {
  readonly id: string;
  readonly target: string | null;
  readonly group: string;
  readonly title: string;
  readonly description: string;
  readonly renderHint?: string;
  readonly raw: unknown;
  readonly source: PaletteItemSource;
}

export interface PaletteSearchResult {
  readonly item: PaletteItem;
  readonly queryText: string;
  readonly score: number;
  readonly matches: ReadonlyArray<{
    readonly key: string;
    readonly indices: ReadonlyArray<readonly [number, number]>;
  }>;
}
