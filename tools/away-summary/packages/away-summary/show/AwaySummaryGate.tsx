// package-set://bitfield-studio/packages/away-summary/show/AwaySummaryGate.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Feature-owned away-summary gate. Reads canonical away-summary and
// away-summary-owned last-seen feeds, decides whether the banner should be
// shown, persists last-seen on the canonical owner, and renders the dumb
// AwaySummary banner view.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Away-summary lifecycle lives inside this package, not a root shell
// 2. Canonical reads come only from addressed away-summary-owned readers
// 3. `lastSeen` writes go only through the canonical owner action
// 4. View-local banner visibility is represented by the effective last-seen
//    timestamp, not by a second fake reusable hook surface
//
// =============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { AwaySummary } from '@/packages/away-summary/show/AwaySummary';
import { updateAwaySummaryLastSeen } from '@/packages/away-summary/do-work/update-away-summary-last-seen';
import { decodeAwaySummaryLastSeen } from '@/packages/away-summary/read-data/read-away-summary-last-seen';
import { decodeAwaySummaryFeed } from '@/packages/away-summary/read-data/read-away-summary';
import { selectAwaySummarySince } from '@/packages/away-summary/read-data/select-away-summary';

function AwaySummaryGateContents() {
  const lastSeenEntry = useBitfieldData('last-seen');
  const awaySummaryEntry = useBitfieldData();
  const [lastSeenOverride, setLastSeenOverride] = useState<string | null>(null);
  const lastSeen = useMemo(
    () => decodeAwaySummaryLastSeen(lastSeenEntry),
    [lastSeenEntry],
  );
  const summaries = useMemo(
    () => decodeAwaySummaryFeed(awaySummaryEntry),
    [awaySummaryEntry],
  );
  const effectiveLastSeen = lastSeenOverride ?? lastSeen;

  const saveLastSeen = useCallback(async (value: string) => {
    await updateAwaySummaryLastSeen(value);
  }, []);

  useEffect(() => {
    if (lastSeenEntry === null || effectiveLastSeen) {
      return;
    }
    const now = new Date().toISOString();
    setLastSeenOverride(now);
    void saveLastSeen(now);
  }, [effectiveLastSeen, lastSeenEntry === null, saveLastSeen]);

  useEffect(() => {
    if (!lastSeenOverride) {
      return;
    }
    if (lastSeen !== lastSeenOverride) {
      return;
    }
    setLastSeenOverride(null);
  }, [lastSeen, lastSeenOverride]);

  const visibleSummary = useMemo(
    () =>
      selectAwaySummarySince(
        effectiveLastSeen,
        summaries,
      ),
    [effectiveLastSeen, summaries],
  );

  const dismiss = useCallback(() => {
    const now = new Date().toISOString();
    setLastSeenOverride(now);
    void saveLastSeen(now);
  }, [saveLastSeen]);

  if (!visibleSummary) {
    return null;
  }

  return (
    <AwaySummary
      taskCount={visibleSummary.tasksCompleted.length}
      totalCost={visibleSummary.totalCost}
      totalTimeMinutes={visibleSummary.totalTimeMinutes}
      errorCount={visibleSummary.errors}
      tasks={visibleSummary.tasksCompleted}
      onDismiss={dismiss}
    />
  );
}

export function AwaySummaryGate() {
  return <AwaySummaryGateContents />;
}
