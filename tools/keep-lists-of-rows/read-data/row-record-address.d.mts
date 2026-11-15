export type RowRecordDeclaration = { type: string; prefix: string };
export type RowAddressDefinition = { row_type?: string; row_records?: RowRecordDeclaration };
export type RowRecordAddress = Readonly<{
  type: string;
  prefix: string;
  query: Readonly<{ type: string; prefix?: string }>;
  /** The input is always local, even when it starts with the physical prefix. */
  recordId(localId: string): string;
  localId(recordId: string): string;
}>;
/** Validates the declaration at this boundary; malformed values throw. */
export function rowRecordAddress(list: unknown, typeTemplate?: string): RowRecordAddress;
