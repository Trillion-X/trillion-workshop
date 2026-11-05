import * as React from 'react';
import { createDockablePlacementStore, useDockablePlacement } from '../../ui/show/dockable-placement';
import { readInstancePlacement, writeInstancePlacement } from '../do-work/instance-placement.ts';
import { SidebarFrame, type DesktopSidebarProps } from './DesktopSidebar.tsx';

/** The same sidebar frame bound to one container and one durable identity. */
export function ContainedSidebar({ instanceId, containerRef, persistPlacement = true, ...props }: DesktopSidebarProps & {
  instanceId: string;
  containerRef: React.RefObject<HTMLElement | null>;
  persistPlacement?: boolean;
}) {
  const store = React.useMemo(() => createDockablePlacementStore(), [instanceId]);
  const [ownerState, setOwnerState] = React.useState(store.get);
  const [error, setError] = React.useState('');
  const queue = React.useRef<Promise<unknown>>(Promise.resolve());
  const editRevision = React.useRef(0);
  React.useEffect(() => {
    if (!persistPlacement) return;
    let active = true;
    const revision = editRevision.current;
    void readInstancePlacement(instanceId).then((value) => { if (active && editRevision.current === revision) setOwnerState(value); }).catch(() => {
      if (active && editRevision.current === revision) setError('Sidebar position could not be loaded.');
    });
    return () => { active = false; };
  }, [instanceId, persistPlacement]);
  const persist = React.useCallback((value: ReturnType<typeof store.get>) => {
    if (!persistPlacement) { setOwnerState(value); return; }
    const revision = ++editRevision.current;
    queue.current = queue.current.catch(() => {}).then(async () => {
      await writeInstancePlacement(instanceId, value);
      if (editRevision.current === revision) {
        setOwnerState(value);
        setError('');
      }
    }).catch(() => { if (editRevision.current === revision) setError('Sidebar position could not be saved.'); });
  }, [instanceId, persistPlacement]);
  const controller = useDockablePlacement(store, ownerState, persist);
  return <SidebarFrame {...props} containerRef={containerRef}
    headerContent={<>{error && <div role="status">{error}</div>}{props.headerContent}</>}
    placement={{ ...controller, width: controller.size, setWidth: controller.setSize }} />;
}
