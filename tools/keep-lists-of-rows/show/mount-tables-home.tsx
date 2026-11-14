//
// Live mount for the Tables home. Same package data scope as the board mount —
// the catalog is a structural read over the SAME records feed the board reads;
// creating a table goes through the SAME record writer (one write door, L069).

import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, ToastProvider, mountReactSurface } from '@/packages/ui';
import { bitfieldGeneratedPackageEntryScopeBinding, useBitfieldData,
  bitfieldGeneratedLiveReadScopeDescriptor,
} from '@/packages/visual-database/.bitfield-entry-scope/tables-home/runtime-kit-react';
import { createRecordWriter } from '@/packages/visual-database/do-work/record-writes';
import { TablesHomeSurface } from '@/packages/visual-database/show/TablesHomeSurface';

const recordWriter = createRecordWriter(bitfieldGeneratedLiveReadScopeDescriptor.partitionLabel);

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function TablesHomeDataSurface() {
  const records = useBitfieldData<unknown>('records');
  return (
    <TablesHomeSurface
      records={records}
      packageName={bitfieldGeneratedPackageEntryScopeBinding.package}
      entryName="visual-database"
      writeTable={(write) => recordWriter(write)}
    />
  );
}

export default function mount({ el }: MountArgs) {
  return mountReactSurface(
    el,
    <FloatingMaterialFrame>
      <ErrorBoundary zoneName="tables home">
        <ToastProvider>
          <TablesHomeDataSurface />
        </ToastProvider>
      </ErrorBoundary>
    </FloatingMaterialFrame>,
  );
}
