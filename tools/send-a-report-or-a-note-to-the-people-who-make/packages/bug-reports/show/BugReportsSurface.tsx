// packages/bug-reports/show/BugReportsSurface.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Unified bug reports hub combining investigation status, canonical bug-report
// rows, and quick-report submission in one view. Summary stats at top, two
// vertical sections (investigations + bug reports), floating report button at
// bottom-right.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Reads only canonical addressed feeds — no store selectors
// 2. Summary bar: total investigations, total issues, unresolved count
// 3. Glassmorphism styling throughout
// 4. Floating quick-report button opens BugReportModal
// 5. Compact representations — not full duplicates of the full investigations/report surfaces
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState, useMemo, useCallback } from 'react';
import { AlertTriangle, FileSearch, Plus, ChevronRight } from 'lucide-react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { BugReportModal } from '@/packages/bug-reports/show/BugReportModal';
import { Card, Badge, Button, Text, Icon } from '@/packages/ui';
import {
  decodeBugReportInvestigationsFeed,
  type BugReportInvestigationEntry,
} from '@/packages/bug-reports/read-data/read-investigations';
import {
  decodeBugReportsFeed,
  type BugReportEntry,
} from '@/packages/bug-reports/read-data/read-bug-reports';

// ============================================================================
// PURE FUNCTIONS
// ============================================================================

/** Count reports that still need initial triage. */
export function countUntriaged(reports: BugReportEntry[]): number {
  return reports.filter((report) => report.severity === 'untriaged').length;
}

/** Sort investigations by ID descending */
export function sortInvestigationsDesc(
  investigations: BugReportInvestigationEntry[],
): BugReportInvestigationEntry[] {
  return [...investigations].sort((a, b) => b.id.localeCompare(a.id));
}

/** Humanize a slug: dashes to spaces, capitalize each word */
export function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}


// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function BugReportsSurface() {
  const reportsEntry = useBitfieldData();
  const investigationsEntry = useBitfieldData('investigations');
  const reports = useMemo(
    () => decodeBugReportsFeed(reportsEntry),
    [reportsEntry],
  );
  const investigations = useMemo(
    () => decodeBugReportInvestigationsFeed(investigationsEntry),
    [investigationsEntry],
  );
  const [modalOpen, setModalOpen] = useState(false);

  const sortedInvestigations = useMemo(() => sortInvestigationsDesc(investigations), [investigations]);
  const untriagedCount = useMemo(() => countUntriaged(reports), [reports]);

  const handleOpenModal = useCallback(() => setModalOpen(true), []);
  const handleCloseModal = useCallback(() => setModalOpen(false), []);

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <Card>
        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <Icon icon={AlertTriangle} size="md" color="warning" />
          <Text variant="heading">Bug Reports</Text>
        </div>

        {/* Summary stats */}
        <Card variant="nested" padding="sm" className="flex items-center gap-4 mb-4">
          <div className="flex items-center gap-1.5">
            <Text variant="label" color="muted">Investigations</Text>
            <Text variant="label" weight="semibold">{investigations.length}</Text>
          </div>
          <div className="w-px h-4 bg-[var(--glass-bg-hover)]" />
          <div className="flex items-center gap-1.5">
            <Text variant="label" color="muted">Reports</Text>
            <Text variant="label" weight="semibold">{reports.length}</Text>
          </div>
          <div className="w-px h-4 bg-[var(--glass-bg-hover)]" />
          <div className="flex items-center gap-1.5">
            <Text variant="label" color="muted">Untriaged</Text>
            <Text variant="label" color={untriagedCount > 0 ? 'warning' : 'success'} weight="semibold">
              {untriagedCount}
            </Text>
          </div>
        </Card>

        {/* Active Investigations */}
        <div className="mb-4">
          <Text variant="overline" className="mb-2 px-1">
            Active Investigations
          </Text>
          {sortedInvestigations.length === 0 ? (
            <div className="flex items-center justify-center py-6">
              <Icon icon={FileSearch} size="lg" color="ghost" className="mr-2" />
              <Text variant="label">No investigations</Text>
            </div>
          ) : (
            <div className="space-y-1">
              {sortedInvestigations.slice(0, 10).map(inv => (
                <Button
                  key={inv.dirName}
                  variant="ghost"
                  className="w-full justify-start px-3 py-2"
                >
                  <Badge variant="accent" size="sm" className="shrink-0 tabular-nums">
                    {inv.id}
                  </Badge>
                  <Text variant="label" color="faint" className="w-12 shrink-0">{inv.date.slice(5)}</Text>
                  <Text variant="label" className="flex-1 truncate">{humanizeSlug(inv.slug)}</Text>
                  <Text variant="caption">{inv.roundCount}r</Text>
                  <Icon icon={ChevronRight} size="xs" color="ghost" />
                </Button>
              ))}
              {sortedInvestigations.length > 10 && (
                <Text variant="caption" className="px-3 py-1">
                  +{sortedInvestigations.length - 10} more
                </Text>
              )}
            </div>
          )}
        </div>

        {/* Canonical Bug Reports */}
        <div>
          <Text variant="overline" className="mb-2 px-1">
            Canonical Bug Reports
          </Text>
          {reports.length === 0 ? (
            <div className="flex items-center justify-center py-6">
              <Icon icon={AlertTriangle} size="lg" color="ghost" className="mr-2" />
              <Text variant="label">No bug reports</Text>
            </div>
          ) : (
            <div className="space-y-1">
              {reports.slice(0, 15).map((report) => (
                <Card
                  key={report.id}
                  variant="nested"
                  padding="sm"
                  className="flex items-start gap-2"
                  interactive
                >
                  <Badge
                    variant={
                      report.severity === 'critical'
                        ? 'error'
                        : report.severity === 'warning'
                          ? 'warning'
                          : report.severity === 'info'
                            ? 'info'
                            : 'neutral'
                    }
                    size="sm"
                    className="shrink-0 mt-0.5"
                  >
                    {report.severity}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <Text variant="label">
                      {report.title || 'Untitled bug report'}
                    </Text>
                    <Text variant="caption" color="muted" as="p" className="mt-1">
                      {report.description.length > 140 ? `${report.description.slice(0, 140)}...` : report.description}
                    </Text>
                  </div>
                </Card>
              ))}
              {reports.length > 15 && (
                <Text variant="caption" className="px-3 py-1">
                  +{reports.length - 15} more
                </Text>
              )}
            </div>
          )}
        </div>

        {/* Floating quick report button */}
        <div className="flex justify-end mt-4">
          <Button
            variant="danger"
            size="sm"
            onClick={handleOpenModal}
            aria-label="Submit quick bug report"
          >
            <Icon icon={Plus} size="sm" />
            Quick Report
          </Button>
        </div>
      </Card>

      {/* Quick report panel */}
      <BugReportModal open={modalOpen} onClose={handleCloseModal} />
    </div>
  );
}
