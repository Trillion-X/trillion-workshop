export type ConfigurationAspect = {id: string; label: string; fields: string[]};
export type ConfigurationSelection = {format?: 'record-view' | 'settings'; aspects?: string[]; settings: Record<string, unknown>};
export const configurationAspects: ConfigurationAspect[];
export function checkedConfigurationValue<T>(value: T): T;
export function selectedConfigurationAspects(given?: string[], format?: 'record-view' | 'settings', settings?: Record<string, unknown>): string[];
export function captureConfigurationSettings(settings: Record<string, unknown>, chosen: string[] | undefined, fieldIds: string[], format?: 'record-view' | 'settings'): Record<string, unknown>;
export function applyConfigurationSettings<T extends Record<string, unknown>>(current: T, configuration: ConfigurationSelection, fieldIds: string[]): T;
