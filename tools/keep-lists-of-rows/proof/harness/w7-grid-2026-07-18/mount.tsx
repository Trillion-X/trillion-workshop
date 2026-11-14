// W7 grid render-matrix mount: the REAL VisualDatabaseSurface over decoded
// fields/views/records from window.__STATE__. Write path is the harness stub
// (deterministic derive replies, no engine).
import React from 'react';
import { createRoot } from 'react-dom/client';
import { decodeVisualDatabaseModel } from '../../../read-data/visual-database';
import { createRecordWriter } from '../../../do-work/record-writes';
import { VisualDatabaseSurface } from '../../../show/VisualDatabaseSurface';

const STATE = (window as unknown as { __STATE__: { records: unknown; fields: unknown; views: unknown; actions: unknown; readOnly?: boolean } }).__STATE__;

const model = decodeVisualDatabaseModel({
  records: STATE.records,
  fields: STATE.fields,
  views: STATE.views,
  actions: STATE.actions,
});

const root = createRoot(document.getElementById('root')!);
root.render(
  React.createElement(VisualDatabaseSurface, {
    model,
    ...(STATE.readOnly ? {} : {
      writeRecord: createRecordWriter('harness'),
      recordTarget: {
        addressPrefix: 'package::visual-database-harness::record',
        payloadDefaults: { owner_package: 'visual-database-harness' },
      },
      descriptorTargets: {
        fields: { addressLabel: 'visual-database-harness.fields' },
        views: { addressLabel: 'visual-database-harness.views' },
      },
    }),
  }),
);
