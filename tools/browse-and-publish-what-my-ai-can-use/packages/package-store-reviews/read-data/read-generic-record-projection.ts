import { type GenericRecordContracts } from './descriptor-contracts';
import { foldGenericRecordEvents, type GenericProjectionFold } from './fold-generic-record-events';

export interface GenericRecordProjectionInput {
  contracts: GenericRecordContracts;
  reader_id: string;
  events?: unknown;
  records?: unknown;
}

export interface ReaderContractValue {
  reader_id: string;
  projection_id: string;
  state: GenericProjectionFold['state'];
  summary?: GenericProjectionFold['summary'];
  items?: GenericProjectionFold['items'];
  filters?: GenericProjectionFold['filters'];
  actions?: GenericProjectionFold['actions'];
  issues: GenericProjectionFold['issues'];
  trace: GenericProjectionFold['trace'];
}

export function readGenericRecordProjection(input: GenericRecordProjectionInput): ReaderContractValue {
  const fold = foldGenericRecordEvents(input.contracts, input.reader_id, {
    events: input.events,
    records: input.records,
  });
  const reader = input.contracts.readers.find((entry) => entry.id === input.reader_id);
  const sections = new Set(reader?.sections ?? []);
  return {
    reader_id: fold.reader_id,
    projection_id: fold.projection_id,
    state: fold.state,
    ...(sections.has('summary') ? { summary: fold.summary } : {}),
    ...(sections.has('items') ? { items: fold.items } : {}),
    ...(sections.has('filters') ? { filters: fold.filters } : {}),
    ...(sections.has('actions') ? { actions: fold.actions } : {}),
    issues: fold.issues,
    trace: fold.trace,
  };
}
