// packages/agent-work-gate-compliance/show/AgentWorkGateCompliancePanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Dashboard panel displaying gate analytics: compliance rates, category
// breakdowns, agent reliability, and weekly trends. Reads the package-provided
// `gate-analytics` payload and renders with glassmorphic cards,
// color-coded compliance indicators, sortable agent table, and CSS-only
// sparklines for trend visualization.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. PURE UI COMPONENTS: All rendering uses ui/ barrel components (Card, Text,
//    Badge, Table, Container, Bar, Sparkline) — zero raw HTML elements
// 2. COLOR CODING: Compliance rate green >90%, yellow 70-90%, red <70%
// 3. ASYNC DATA LOADING: Reads live analytics from package data
// 4. ACCESSIBLE SPARKLINES: CSS-only trend visualization (no chart library)
// 5. SORTABLE TABLES: Agent reliability table sortable by completion/deferral
//
// =============================================================================
// KEY CONCEPTS
// =============================================================================
//
// - GateAnalytics interface: totalTasks, totalGates, completedGates,
//   deferredGates, notNeededGates, pendingGates, complianceRate,
//   gateCategoryBreakdown, agentReliability, trends
// - Color mapping: complianceRate >= 90 = success, >= 70 = warning, else error
// - Category breakdown: horizontal stacked bars with labels
// - Agent reliability: sortable table (default sort: completion desc)
// - Trends: sparkline visualization using Sparkline component
//
// =============================================================================
// SECURITY CONSIDERATIONS
// =============================================================================
//
// - Reads from the package-provided `gate-analytics` payload
// - Agent names from deferredBy field (already validated at write time)
// - No user input, no eval, no dangerous HTML rendering
// - Error states handled gracefully (show placeholder, not error message)
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this code is a critical design feature.
// You are forbidden from simplifying or removing it.
//
// =============================================================================

import React from 'react';
import {
  Card,
  Text,
  Badge,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Container,
  Bar,
  Sparkline,
} from '@/packages/ui';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  decodeGateAnalyticsFeed,
  type GateAnalytics,
} from '@/packages/agent-work-gate-compliance/read-data/read-agent-work-gate-summary';

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Get color variant for compliance rate.
 * Green >= 90%, Yellow >= 70%, Red < 70%.
 */
function getComplianceColor(rate: number): 'success' | 'warning' | 'error' {
  if (rate >= 90) return 'success';
  if (rate >= 70) return 'warning';
  return 'error';
}

/**
 * Get text color for compliance rate display.
 * Green >= 90%, Yellow >= 70%, Red < 70%.
 */
function getComplianceTextColor(rate: number): 'success' | 'warning' | 'error' {
  if (rate >= 90) return 'success';
  if (rate >= 70) return 'warning';
  return 'error';
}

/**
 * Sort agent reliability by completion rate descending, then deferral rate.
 */
function sortAgentReliability(
  agents: Array<{ agentId: string; completionRate: number; deferralRate: number }>
): Array<{ agentId: string; completionRate: number; deferralRate: number }> {
  return [...agents].sort((a, b) => {
    if (b.completionRate !== a.completionRate) {
      return b.completionRate - a.completionRate;
    }
    return a.deferralRate - b.deferralRate;
  });
}

/**
 * Get variant for trend value based on compliance rate thresholds.
 */
function getTrendVariant(value: number): 'success' | 'warning' | 'error' {
  if (value >= 90) return 'success';
  if (value >= 70) return 'warning';
  return 'error';
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Agent work gate compliance dashboard panel.
 *
 * Displays:
 * - Compliance rate (large, color-coded)
 * - Category breakdown (horizontal stacked bars)
 * - Agent reliability (sortable table)
 * - Weekly trends (sparkline visualization)
 *
 * Reads live analytics from the package-provided `gate-analytics` payload.
 */
export function AgentWorkGateCompliancePanel() {
  const analyticsEntry = useBitfieldData();
  const analyticsArray = React.useMemo(
    () => decodeGateAnalyticsFeed(analyticsEntry),
    [analyticsEntry],
  );
  const analytics = analyticsArray.length > 0 ? analyticsArray[0] : null;
  const loading = analyticsEntry === undefined;
  const error = false !== null;

  if (loading) {
    return (
      <Card variant="surface" padding="lg">
        <Text variant="body-xs" color="muted">
          Loading analytics...
        </Text>
      </Card>
    );
  }

  if (error || !analytics) {
    return (
      <Card variant="surface" padding="lg">
        <Text variant="body-xs" color="error">
          Failed to load analytics
        </Text>
      </Card>
    );
  }

  const complianceColor = getComplianceColor(analytics.complianceRate);
  const complianceTextColor = getComplianceTextColor(analytics.complianceRate);
  const sortedAgents = sortAgentReliability(analytics.agentReliability);

  return (
    <Container layout="vertical" gap="lg" width="full">
      {/* === COMPLIANCE RATE === */}
      <Card variant="surface" padding="lg">
        <Container layout="vertical" gap="sm">
          <Text variant="label" color="muted">
            Overall Compliance Rate
          </Text>
          <Container layout="horizontal" gap="md" alignItems="end">
            <Text variant="heading-xl" color={complianceTextColor} mono tabular>
              {analytics.complianceRate.toFixed(1)}%
            </Text>
            <Badge variant={complianceColor} size="md">
              {analytics.completedGates} / {analytics.totalGates} gates
            </Badge>
          </Container>
        </Container>
      </Card>

      {/* === CATEGORY BREAKDOWN === */}
      <Card variant="surface" padding="lg">
        <Container layout="vertical" gap="md">
          <Text variant="label" color="muted">
            Category Breakdown
          </Text>
          {Object.entries(analytics.gateCategoryBreakdown).map(
            ([category, { total, completed, deferred }]) => {
              const completionPercent = total > 0 ? (completed / total) * 100 : 0;
              const deferralPercent = total > 0 ? (deferred / total) * 100 : 0;
              const pendingPercent = total > 0 ? ((total - completed - deferred) / total) * 100 : 0;

              return (
                <Container key={category} layout="vertical" gap="xs" width="full">
                  <Container layout="horizontal" justifyContent="between" width="full">
                    <Text variant="body-xs" color="white">
                      {category}
                    </Text>
                    <Text variant="body-xs" color="muted" mono>
                      {completed}/{total}
                    </Text>
                  </Container>
                  <Bar
                    segments={[
                      ...(completionPercent > 0
                        ? [
                            {
                              percent: completionPercent,
                              variant: 'success' as const,
                              title: `Completed: ${completed}`,
                            },
                          ]
                        : []),
                      ...(deferralPercent > 0
                        ? [
                            {
                              percent: deferralPercent,
                              variant: 'warning' as const,
                              title: `Deferred: ${deferred}`,
                            },
                          ]
                        : []),
                      ...(pendingPercent > 0
                        ? [
                            {
                              percent: pendingPercent,
                              variant: 'error' as const,
                              title: `Pending: ${total - completed - deferred}`,
                            },
                          ]
                        : []),
                    ]}
                    height="md"
                  />
                </Container>
              );
            }
          )}
        </Container>
      </Card>

      {/* === AGENT RELIABILITY === */}
      <Card variant="surface" padding="lg">
        <Container layout="vertical" gap="md">
          <Text variant="label" color="muted">
            Agent Reliability
          </Text>
          {sortedAgents.length === 0 ? (
            <Text variant="body-xs" color="muted">
              No agent data available
            </Text>
          ) : (
            <Container overflow="x-auto" width="full">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Completion</TableHead>
                    <TableHead>Deferral</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedAgents.map(({ agentId, completionRate, deferralRate }) => (
                    <TableRow key={agentId}>
                      <TableCell>
                        <Text variant="body-xs" color="white">
                          {agentId}
                        </Text>
                      </TableCell>
                      <TableCell>
                        <Text variant="body-xs" color="white" mono tabular>
                          {completionRate.toFixed(0)}%
                        </Text>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={deferralRate > 50 ? 'warning' : 'neutral'}
                          size="sm"
                        >
                          {deferralRate.toFixed(0)}%
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Container>
          )}
        </Container>
      </Card>

      {/* === TRENDS === */}
      <Card variant="surface" padding="lg">
        <Container layout="vertical" gap="md">
          <Text variant="label" color="muted">
            Weekly Trend
          </Text>
          {analytics.trends.length === 0 ? (
            <Text variant="body-xs" color="muted">
              No trend data available
            </Text>
          ) : (
            <Sparkline
              points={analytics.trends.map((t) => ({
                value: t.complianceRate,
                label: `${t.date}: ${t.complianceRate.toFixed(1)}%`,
              }))}
              height="md"
              getVariant={(value) => getTrendVariant(value)}
            />
          )}
        </Container>
      </Card>

      {/* === SUMMARY STATS === */}
      <Card variant="surface" padding="lg">
        <Container layout="grid" gap="md" gridCols="2">
          <Container layout="vertical" gap="xs">
            <Text variant="label" color="muted">
              Tasks
            </Text>
            <Text variant="heading" color="white" mono>
              {analytics.totalTasks}
            </Text>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text variant="label" color="muted">
              Completed
            </Text>
            <Text variant="heading" color="success" mono>
              {analytics.completedGates}
            </Text>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text variant="label" color="muted">
              Deferred
            </Text>
            <Text variant="heading" color="warning" mono>
              {analytics.deferredGates}
            </Text>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text variant="label" color="muted">
              Not Needed
            </Text>
            <Text variant="heading" color="muted" mono>
              {analytics.notNeededGates}
            </Text>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text variant="label" color="muted">
              Pending
            </Text>
            <Text variant="heading" color="error" mono>
              {analytics.pendingGates}
            </Text>
          </Container>
        </Container>
      </Card>
    </Container>
  );
}
