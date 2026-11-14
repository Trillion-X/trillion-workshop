// packages/roi/show/ROIDashboard.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Primary ROI dashboard view showing all 5 irreducible ROI variables:
// Cost, Time, Quality, Fidelity, Autonomy. Displays an overall score bar
// at the top, then a responsive grid of 5 metric cards below.
//
// The user's requirement: "I should be able to look at ONE view and know if
// the system is delivering ROI. If I have to open 5 different panels to
// figure that out, the system is failing."
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Prominent overall ROI score bar at top (0-100, color gradient)
// 2. 5 metric cards in responsive grid: 3 cols (xl), 2 cols (md), 1 col (sm)
// 3. Each metric card shows label, value, detail, health indicator
// 4. Icons: Cost, Time, Quality, Fidelity, Autonomy from Lucide
// 5. Health thresholds per metric for green/yellow/red status
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  DollarSign,
  Clock,
  CheckCircle2,
  Target,
  Zap,
  TrendingUp,
  Users,
  Package,
} from 'lucide-react';
import {
  decodeProjectRoiFeed,
  selectProjectRoiSnapshot,
} from '@/packages/roi/read-data/read-project-roi';
import {
  decodeRoiTimeseriesDataFeed,
  selectRoiTimeseriesPayload,
} from '@/packages/roi/read-data/read-roi-timeseries-data';
import { MetricCard } from '@/packages/roi/show/MetricCard';
import { TaskReceipt } from '@/packages/roi/show/TaskReceipt';
import { Card, Container, Text } from '@/packages/ui';
import { WorkStartState, WorkSkeletonRows } from '@/packages/ui/show/work-start-state';
import { InteractiveTimeseriesChart } from '@/packages/ui/show/timeseries-chart/InteractiveTimeseriesChart';
import { SelectablePillBar } from '@/packages/ui/show/selectable-pill-bar';
import { ComplianceDashboard } from '@/packages/roi/show/ComplianceDashboard';
import { EfficiencySuggestions } from '@/packages/roi/show/EfficiencySuggestions';
import { RevenueCard } from '@/packages/roi/show/RevenueCard';
import { BusinessOutcomeCard } from '@/packages/roi/show/BusinessOutcomeCard';
import { LeadFunnelChart } from '@/packages/roi/show/LeadFunnelChart';
import { ContentBreakdownChart } from '@/packages/roi/show/ContentBreakdownChart';
import { SocietyMetricsBreakdown } from '@/packages/roi/show/SocietyMetricsBreakdown';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

interface HealthThresholds {
  green: number;
  yellow: number;
}

// ---------------------------------------------------------------------------
// HEALTH THRESHOLDS
// ---------------------------------------------------------------------------

/**
 * Thresholds for determining metric health status (green/yellow/red).
 * These are heuristics — customize based on your system's goals.
 *
 * For rates (0-1): higher is better, so comparison is straightforward.
 * For costs and counts: lower is better, so thresholds are inverted.
 */
const HEALTH_THRESHOLDS = {
  testPassRate: { green: 0.95, yellow: 0.80 }, // >=95% good, 80-95% warning
  firstPassRate: { green: 0.90, yellow: 0.70 },
  specMatchRate: { green: 0.90, yellow: 0.75 },
  autonomyRate: { green: 0.80, yellow: 0.60 },
  efficiency: { green: 0.75, yellow: 0.50 },
  burnRate: { green: 5, yellow: 10 }, // $/hour, lower is better
  correctionCount: { green: 1, yellow: 3 }, // count, lower is better
} as const;

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Determine health status for a metric based on value and thresholds.
 * Higher is better for rates, lower is better for costs/counts.
 */
function getHealth(
  value: number,
  higherIsBetter: boolean,
  thresholds: HealthThresholds
): 'green' | 'yellow' | 'red' {
  if (higherIsBetter) {
    // Rates, efficiency, etc.
    if (value >= thresholds.green) return 'green';
    if (value >= thresholds.yellow) return 'yellow';
    return 'red';
  } else {
    // Costs, counts, etc. — lower is better
    if (value <= thresholds.yellow) return 'green';
    if (value <= thresholds.green) return 'yellow';
    return 'red';
  }
}

/**
 * Format milliseconds into a human-readable duration string.
 * @example formatDuration(60_000) => "1m"
 * @example formatDuration(3_661_000) => "1h 1m"
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

/**
 * Format number as percentage (0-1 range to 0-100 display).
 */
function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Format currency value.
 */
function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * ROI Dashboard — the single view showing all 5 irreducible ROI variables.
 *
 * Layout:
 * 1. Project filter bar with "All Projects" + per-project chips
 * 2. Overall ROI score bar (0-100, color gradient)
 * 3. 5 metric cards in responsive grid
 * 4. Cost Breakdown, Compliance, Efficiency Suggestions sections
 * 5. Cost History chart and Task Receipt list
 *
 * Reads the aggregate `project-roi` package input and derives the selected
 * project snapshot locally from descriptor-projected snapshot rows.
 */
export const ROIDashboard: React.FC = () => {
  const [selectedProjectIds, setSelectedProjectIds] = React.useState<string[]>([]);
  const [costHistoryBucket, setCostHistoryBucket] = React.useState('1d');
  const roiEntry = useBitfieldData('project-roi');
  const timeseriesEntry = useBitfieldData('timeseries-data');
  const roiSource = React.useMemo(() => decodeProjectRoiFeed(roiEntry), [roiEntry]);
  const timeseriesData = React.useMemo(
    () => decodeRoiTimeseriesDataFeed(timeseriesEntry),
    [timeseriesEntry],
  );
  const projectItems = React.useMemo(() => {
    return Array.from(new Set((roiSource?.projectSnapshots ?? []).map((entry) => entry.projectId)))
      .sort((left, right) => left.localeCompare(right))
      .map((id) => ({ id, label: id }));
  }, [roiSource]);
  const activeProjectIds = React.useMemo(
    () => selectedProjectIds.filter((id) => projectItems.some((item) => item.id === id)),
    [projectItems, selectedProjectIds],
  );
  const visibleProjectIds = activeProjectIds.length > 0
    ? activeProjectIds
    : projectItems.map((item) => item.id);
  const selectedProjectId = visibleProjectIds.length === 1 ? visibleProjectIds[0] : 'default';
  const roi = selectProjectRoiSnapshot(roiSource, selectedProjectId);
  const costHistory = selectRoiTimeseriesPayload(timeseriesData, 'cost', costHistoryBucket);
  const isLoading = roiEntry === null;
  const error = null;
  const toggleProject = React.useCallback((projectId: string) => {
    setSelectedProjectIds((current) => {
      const validIds = new Set(projectItems.map((item) => item.id));
      const selected = activeProjectIds.length > 0
        ? new Set(current.filter((id) => validIds.has(id)))
        : new Set(validIds);
      if (selected.has(projectId)) selected.delete(projectId);
      else selected.add(projectId);
      return Array.from(selected);
    });
  }, [activeProjectIds, projectItems]);

  if (isLoading && !roi) {
    return (
      <Container layout="vertical" gap="sm" padding="md">
        <WorkSkeletonRows rows={4} />
      </Container>
    );
  }

  if (error && !roi) {
    return (
      <Container layout="vertical" gap="md" justifyContent="center" alignItems="center">
        <Text variant="body-xs" color="error">{error}</Text>
      </Container>
    );
  }

  if (!roi) {
    return (
      <Container layout="vertical" gap="md" padding="md">
        <WorkStartState
          icon={TrendingUp}
          title="ROI tracking is live"
          description="No results to report yet. As your published content reaches people and the funnel converts, this dashboard fills in on its own — revenue, cost, autonomy, quality, and the machine's recommended next move."
          items={[
            { label: 'Revenue & signups', detail: 'Counts up as checkouts complete', badge: 'auto' },
            { label: 'Leads & reach', detail: 'From attributed content impressions', badge: 'auto' },
            { label: 'Cost & autonomy', detail: 'How efficiently the machine runs', badge: 'auto' },
            { label: 'Next action', detail: 'The highest-ROI move to approve', badge: 'auto' },
          ]}
        />
      </Container>
    );
  }

  // Determine health status for each metric
  const costHealth = getHealth(
    roi.cost.burnRate,
    false,
    HEALTH_THRESHOLDS.burnRate
  );
  const timeHealth = getHealth(
    roi.time.efficiency,
    true,
    HEALTH_THRESHOLDS.efficiency
  );
  const qualityHealth = getHealth(
    roi.quality.testPassRate,
    true,
    HEALTH_THRESHOLDS.testPassRate
  );
  const fidelityHealth = getHealth(
    roi.fidelity.specMatchRate,
    true,
    HEALTH_THRESHOLDS.specMatchRate
  );
  const autonomyHealth = getHealth(
    roi.autonomy.autonomyRate,
    true,
    HEALTH_THRESHOLDS.autonomyRate
  );

  return (
    <Container layout="vertical" gap="lg">
      {/* ====================================================================
          PROJECT FILTER BAR
          ==================================================================== */}

      <SelectablePillBar
        items={projectItems}
        selectedIds={visibleProjectIds}
        allLabel="All Projects"
        ariaLabel="Filter ROI by project"
        onSelectAll={() => setSelectedProjectIds(projectItems.map((item) => item.id))}
        onToggle={toggleProject}
      />

      {/* ====================================================================
          HERO SECTION: REVENUE (BUSINESS OUTCOMES)
          ==================================================================== */}

      <RevenueCard
        totalCents={roi.businessOutcomes.revenueGenerated.totalCents}
        thisMonthCents={roi.businessOutcomes.revenueGenerated.thisMonthCents}
      />

      {/* ====================================================================
          BUSINESS OUTCOMES GRID (3-COLUMN)
          ==================================================================== */}

      <Container layout="vertical" gap="sm">
        <Container layout="horizontal" gap="sm">
          <BusinessOutcomeCard
            label="Tasks Completed"
            value={roi.businessOutcomes.tasksCompleted.total}
            unit="tasks"
            detail={`This week: ${roi.businessOutcomes.tasksCompleted.thisWeek}`}
            trend={roi.businessOutcomes.tasksCompleted.thisWeek > 0 ? 'up' : 'flat'}
          />
          <BusinessOutcomeCard
            label="Items Created"
            value={roi.businessOutcomes.itemsCreated.total}
            unit="items"
            detail={`Across ${Object.keys(roi.businessOutcomes.itemsCreated.breakdownByType).length} platforms`}
            trend="up"
          />
          <BusinessOutcomeCard
            label="Content Reach"
            value={roi.businessOutcomes.contentReach.impressions.toLocaleString()}
            unit="impressions"
            detail={`${Math.round(roi.businessOutcomes.contentReach.engagementRate * 100)}% engagement`}
            trend="up"
          />
        </Container>
      </Container>

      {/* ====================================================================
          LEADS & PROJECTS GRID
          ==================================================================== */}

      <Container layout="vertical" gap="sm">
        <Container layout="horizontal" gap="sm">
          <BusinessOutcomeCard
            label="Leads Captured"
            value={roi.businessOutcomes.leadsCaptured.total}
            unit="leads"
            detail={`${Math.round(roi.businessOutcomes.leadsCaptured.conversionRate * 100)}% convert • ${roi.businessOutcomes.leadsCaptured.qualified} qualified`}
            trend="up"
          />
          <BusinessOutcomeCard
            label="Projects Launched"
            value={roi.businessOutcomes.projectsLaunched.live}
            unit={`of ${roi.businessOutcomes.projectsLaunched.total}`}
            detail="Live and generating value"
            trend="up"
          />
          <BusinessOutcomeCard
            label="Signups"
            value={roi.businessOutcomes.signups.total}
            unit="users"
            detail={`This week: ${roi.businessOutcomes.signups.thisWeek}`}
            trend={roi.businessOutcomes.signups.thisWeek > 0 ? 'up' : 'flat'}
          />
        </Container>
      </Container>

      {/* ====================================================================
          AGGREGATE SUMMARY ROW (SYSTEM HEALTH)
          ==================================================================== */}

      <Card variant="surface" padding="lg">
        <Container layout="vertical" gap="md">
          {/* Score title and value */}
          <Container layout="horizontal" justifyContent="between" alignItems="center">
            <Text variant="body" weight="semibold" color="strong">
              Overall ROI
            </Text>
            <Text variant="heading-xl" weight="bold" color="white">
              {Math.round(roi.overallScore)}/100
            </Text>
          </Container>

          {/* Subtext */}
          <Text variant="caption" color="subtle">
            {roi.overallScore >= 70
              ? 'System delivering strong ROI'
              : roi.overallScore >= 40
                ? 'System meeting baseline expectations'
                : 'System underperforming — intervention needed'}
          </Text>
        </Container>
      </Card>

      {/* ====================================================================
          AGGREGATE METRICS GRID (Cost, Time, Quality, Fidelity, Autonomy)
          ==================================================================== */}

      <Container layout="vertical" gap="sm">
        <Container layout="horizontal" gap="sm">
          {/* Cost Metric */}
          <MetricCard
            icon={DollarSign}
            label="Cost"
            value={formatCurrency(roi.cost.totalSpent)}
            detail={`of ${formatCurrency(roi.cost.budget)} • $${roi.cost.burnRate.toFixed(1)}/hr`}
            health={costHealth}
          />

          {/* Time Metric */}
          <MetricCard
            icon={Clock}
            label="Time"
            value={formatDuration(roi.time.elapsed)}
            detail={`AI: ${formatDuration(roi.time.aiTime)} • You: ${formatDuration(roi.time.humanTime)}`}
            health={timeHealth}
          />

          {/* Quality Metric */}
          <MetricCard
            icon={CheckCircle2}
            label="Quality"
            value={formatPercent(roi.quality.testPassRate)}
            detail={`${roi.quality.correctionCount} corrections • ${formatPercent(roi.quality.firstPassRate)} first-pass`}
            health={qualityHealth}
          />

          {/* Fidelity Metric */}
          <MetricCard
            icon={Target}
            label="Fidelity"
            value={formatPercent(roi.fidelity.specMatchRate)}
            detail={`${roi.fidelity.redirectCount} redirects • Score: ${formatPercent(roi.fidelity.score)}`}
            health={fidelityHealth}
          />

          {/* Autonomy Metric */}
          <MetricCard
            icon={Zap}
            label="Autonomy"
            value={formatPercent(roi.autonomy.autonomyRate)}
            detail={`${roi.autonomy.fullyAutonomousCount} autonomous • ${roi.autonomy.avgInterventionsPerTask.toFixed(1)}/task`}
            health={autonomyHealth}
          />
        </Container>
      </Container>

      {/* ====================================================================
          CHARTS ROW (2x2 GRID)
          ==================================================================== */}

      <Container layout="vertical" gap="sm">
        <Container layout="horizontal" gap="sm">
          {/* Lead Funnel */}
          <LeadFunnelChart
            newLeads={roi.businessOutcomes.leadsCaptured.total}
            qualified={roi.businessOutcomes.leadsCaptured.qualified}
            converted={Math.round(roi.businessOutcomes.leadsCaptured.total * roi.businessOutcomes.leadsCaptured.conversionRate)}
          />

          {/* Content Breakdown */}
          <ContentBreakdownChart
            breakdown={roi.businessOutcomes.itemsCreated.breakdownByType}
          />
        </Container>
      </Container>

      {/* ====================================================================
          PER-SOCIETY BREAKDOWN
          ==================================================================== */}

      <Card variant="surface" padding="lg">
        <Container layout="vertical" gap="md">
          <Text variant="heading-xs" weight="semibold" color="strong">
            Metrics by Society
          </Text>
          <SocietyMetricsBreakdown />
        </Container>
      </Card>

      {/* ====================================================================
          COMPLIANCE DASHBOARD
          ==================================================================== */}

      <Card variant="surface" padding="lg">
        <Container layout="vertical" gap="md">
          <Text variant="heading-xs" weight="semibold" color="strong">
            Compliance Status
          </Text>
          <ComplianceDashboard projectId={selectedProjectId} />
        </Container>
      </Card>

      {/* ====================================================================
          EFFICIENCY SUGGESTIONS
          ==================================================================== */}

      <Card variant="surface" padding="lg">
        <EfficiencySuggestions projectId={selectedProjectId} />
      </Card>

      {/* ====================================================================
          COST HISTORY CHART
          ==================================================================== */}

      <InteractiveTimeseriesChart
        config={{
          title: 'Cost History',
          metric: 'cost',
          bucket: costHistoryBucket,
          showAccumulated: true,
          showAverage: true,
        }}
        buckets={costHistory.buckets}
        summary={costHistory.summary}
        activeBucket={costHistoryBucket}
        onActiveBucketChange={setCostHistoryBucket}
      />

      {/* ====================================================================
          TASK RECEIPT LIST
          ==================================================================== */}

      <Container layout="vertical" gap="md">
        <Text variant="heading-xs" weight="semibold" color="strong">
          Completed Work
        </Text>

        {roi.taskReceipts && roi.taskReceipts.length > 0 ? (
          <Container layout="vertical" gap="sm">
            {roi.taskReceipts.map((receipt, idx) => (
              <TaskReceipt key={`${receipt.taskId}-${idx}`} receipt={receipt} />
            ))}
          </Container>
        ) : (
          <Card variant="nested" padding="md">
            <Text variant="body-xs" color="subtle">
              No completed tasks yet
            </Text>
          </Card>
        )}
      </Container>

      {/* ====================================================================
          DEBUG: Last Updated Timestamp
          ==================================================================== */}

      <Container layout="vertical" gap="md" alignItems="center">
        <Text variant="caption" color="ghost">
          Last updated: {new Date(roi.timestamp).toLocaleTimeString()}
        </Text>
      </Container>
    </Container>
  );
};

ROIDashboard.displayName = 'ROIDashboard';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export type {};
