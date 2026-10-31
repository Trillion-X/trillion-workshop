import {
  type DescribedRecordProjectionInput,
  type DescribedRecordSurface,
  projectDescribedRecordSurface,
} from './described-record-surface.ts';

export interface ReaderMaterializationRequest extends DescribedRecordProjectionInput {
  readerId: string;
  transport?: string;
}

export interface ReaderKeyedMaterialization {
  key: {
    surfaceId: string;
    readerId: string;
    transport: string;
  };
  value: DescribedRecordSurface;
}

export function materializeDescribedRecordSurface(
  request: ReaderMaterializationRequest,
): ReaderKeyedMaterialization {
  const value = projectDescribedRecordSurface(request);
  return {
    key: {
      surfaceId: value.surfaceId,
      readerId: request.readerId,
      transport: request.transport ?? 'json',
    },
    value,
  };
}
