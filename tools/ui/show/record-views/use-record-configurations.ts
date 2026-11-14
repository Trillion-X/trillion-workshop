import * as React from 'react';
import {makeConfigurationController, type ConfigurationSource} from 'trillion-workshop/tools/keep-lists-of-rows/read-data/configuration-controller.mjs';

export type RecordConfigurationBinding = {source: ConfigurationSource; initialId?: string; sharedCode?: string; sharedOffer?: string};
export function useRecordConfigurations(binding: RecordConfigurationBinding | undefined, target: string | undefined, openPath: string | undefined, fields: {id: string}[]) {
  const [, changed] = React.useReducer((value: number) => value + 1, 0);
  const currentFields = React.useRef(fields); currentFields.current = fields;
  const controller = React.useMemo(() => binding && target && openPath ? makeConfigurationController({
    source: binding.source, target, openPath, fieldIds: () => currentFields.current.map(field => field.id),
    initialId: binding.initialId, sharedCode: binding.sharedCode, sharedOffer: binding.sharedOffer, changed,
  }) : null, [binding?.source, target, openPath, binding?.initialId, binding?.sharedCode, binding?.sharedOffer]);
  React.useEffect(() => {
    void controller?.load();
    return () => controller?.dispose();
  }, [controller]);
  return controller?.options() ?? {};
}
