// Renders ai-execution-run records from the kind-scoped exec-history feed as a run history.
// The feed is a bounded `record_from_matching_records` sink (only ai-execution-run +
// ai-execution-step rows), maintained reactively by the engine — NOT the whole
// multi-megabyte published-records aggregate. Rows arrive as bare payload objects.

import React from 'react';
import { Badge, Card, Container, Divider, Icon, ScrollableSurface, Spinner, StatusDot, Text } from '@/packages/ui';
import { Activity, CheckCircle2, CircleSlash, Clock } from 'lucide-react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { readExecutionHistory, type ExecutionReviewDecision, type ExecutionRun, type PublishedRecord } from '@/packages/ai-execution-history/read-data/read-ai-execution-history';
import {
  deriveRunFacts,
  deriveRunHealth,
  EMPTY_HEALTH_RULES,
  type HealthRule,
  type HealthTone,
  type RunHealth,
} from '@/packages/ai-execution-history/read-data/derive-run-health';

type Row = { address?: string; payload?: Record<string, unknown> };

function rowsOf(raw: unknown): Row[] {
  if (Array.isArray(raw)) return raw as Row[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { rows?: unknown }).rows)) return (raw as { rows: Row[] }).rows;
  return [];
}

// The card's status affordance is DERIVED health (the records carry no status
// field), so icon and badge tone come from the classification, not a self-reported
// string. Absent health → a plain in-flight look.
function toneIcon(tone?: HealthTone) {
  if (tone === 'success') return CheckCircle2;
  if (tone === 'error') return CircleSlash;
  return Activity;
}

// HealthTone shares the Badge variant vocabulary 1:1 (success/warning/error/info/
// neutral all exist as Badge variants), so the tone passes straight through.
function badgeVariant(tone?: HealthTone): 'success' | 'warning' | 'error' | 'info' | 'neutral' {
  return tone ?? 'neutral';
}

function iconColor(tone?: HealthTone): 'success' | 'error' | 'muted' {
  if (tone === 'success') return 'success';
  if (tone === 'error') return 'error';
  return 'muted';
}

function shortTime(iso?: string): string | undefined {
  if (!iso) return undefined;
  const t = iso.slice(0, 19).replace('T', ' ');
  return t.length >= 16 ? t : iso;
}

// A run id like "ai-execution-run:claude-jsonl:agent-a0024e6164767e08b" is an
// internal address, not something a person named. Show who ran (Claude Code)
// and a short handle they can recognize, never the raw prefix chain.
function friendlyAgent(run: ExecutionRun): string | undefined {
  const ref = run.agent_ref;
  if (ref) {
    if (/claude/i.test(ref)) return 'Claude Code';
    if (/codex/i.test(ref)) return 'Codex';
    const tail = ref.split(/[/:]/).pop() ?? ref;
    return tail ? tail.charAt(0).toUpperCase() + tail.slice(1) : ref;
  }
  if (/claude/i.test(run.id)) return 'Claude Code';
  if (/codex/i.test(run.id)) return 'Codex';
  return undefined;
}

// The card LEADS with WHAT the run did (its objective) so the history reads as
// work done, not an opaque id. WHO ran it drops to a caption. When a run carries
// no objective, lead with who ran it rather than the internal id chain.
function runLabel(run: ExecutionRun): { title: string; handle?: string } {
  const who = friendlyAgent(run);
  if (run.objective) return { title: run.objective, handle: who };
  return { title: who ?? 'AI run' };
}

// Wall-clock duration of a run from its start/end stamps (e.g. "42s", "3m 10s").
function durationLabel(run: ExecutionRun): string | undefined {
  if (!run.started_at || !run.ended_at) return undefined;
  const ms = Date.parse(run.ended_at) - Date.parse(run.started_at);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function humanDecision(value: string): string {
  const words = value.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Reviewed';
}

function RunCard({ run, stepCount, health, review }: { run: ExecutionRun; stepCount: number; health?: RunHealth; review?: ExecutionReviewDecision }) {
  const tone = health?.tone;
  const label = runLabel(run);
  return (
    <Card variant="surface" padding="md">
      <Container layout="horizontal" alignItems="center" justifyContent="space-between" gap="md" padding="none">
        <Container layout="horizontal" alignItems="center" gap="sm" padding="none">
          <Icon icon={toneIcon(tone)} size="sm" color={iconColor(tone)} />
          <Text variant="label" leading="tight">{label.title}</Text>
          {label.handle ? <Text variant="caption" color="faint">{label.handle}</Text> : null}
        </Container>
        {health ? (
          <Badge variant={badgeVariant(health.tone)}>{health.label}</Badge>
        ) : null}
      </Container>
      <Container layout="horizontal" alignItems="center" gap="md" padding="none">
        {shortTime(run.started_at) ? (
          <Container layout="horizontal" alignItems="center" gap="xs" padding="none">
            <Icon icon={Clock} size="xs" color="faint" />
            <Text variant="caption" color="faint">{shortTime(run.started_at)}</Text>
          </Container>
        ) : null}
        {durationLabel(run) ? <Text variant="caption" color="faint">{durationLabel(run)}</Text> : null}
        {stepCount > 0 ? <Text variant="caption" color="faint">{`${stepCount} step${stepCount === 1 ? '' : 's'}`}</Text> : null}
        {run.total_cost != null ? <Text variant="caption" color="faint">{`$${run.total_cost.toFixed(4)}`}</Text> : null}
        {review ? <Badge variant="info">{humanDecision(review.decision)}</Badge> : null}
      </Container>
      {review ? <Text variant="caption" color="secondary">{review.review_note}</Text> : null}
    </Card>
  );
}

/** Strip a leading `<namespace>:` so `ai-agent-profile:x` and a bare `x` compare equal. */
function stripNamespace(ref: string): string {
  return ref.replace(/^[a-z0-9]+(?:-[a-z0-9]+)*:/i, '');
}

export function ExecutionHistoryPanel({ healthRules = EMPTY_HEALTH_RULES, subjectRef }: { healthRules?: readonly HealthRule[]; subjectRef?: string } = {}) {
  const published = useBitfieldData('exec-history-feed');
  const fullHistory = React.useMemo(() => {
    const rows = rowsOf(published);
    const records: PublishedRecord[] = rows.map((r) => ({ payload: (r && typeof r === 'object' ? (r.payload ?? r) : r) as unknown }));
    return readExecutionHistory(records);
  }, [published]);

  // When a subject is supplied (a worker console tab), show ONLY that agent's runs
  // — matched on `run.agent_ref`, namespace-tolerant so a namespaced subject ref
  // (`ai-agent-profile:x`) joins a bare `agent_ref` and vice-versa. No subject =>
  // the full global history (unchanged standalone behaviour).
  const history = React.useMemo(() => {
    const subject = subjectRef?.trim();
    if (!subject) return fullHistory;
    const wanted = stripNamespace(subject);
    const runs = fullHistory.runs.filter((run) => {
      const ref = run.agent_ref;
      return !!ref && (ref === subject || stripNamespace(ref) === wanted);
    });
    return { ...fullHistory, runs };
  }, [fullHistory, subjectRef]);

  const stepCountByRun = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const s of history.steps) m.set(s.run_ref, (m.get(s.run_ref) ?? 0) + 1);
    return m;
  }, [history.steps]);

  const latestReviewByRun = React.useMemo(() => {
    const reviews = new Map<string, ExecutionReviewDecision>();
    for (const review of history.reviews) if (!reviews.has(review.execution_ref)) reviews.set(review.execution_ref, review);
    return reviews;
  }, [history.reviews]);

  // Derive each run's health from its own facts against the owner-injected rules.
  // Fail-closed: no rules → empty map → cards render with no health badge, exactly
  // as before this feature (behaviour-neutral until DATA rules are supplied).
  const healthByRun = React.useMemo(() => {
    const m = new Map<string, RunHealth>();
    if (healthRules.length === 0) return m;
    const nowMs = Date.now();
    for (const run of history.runs) {
      const facts = deriveRunFacts(run, stepCountByRun.get(run.id) ?? 0, nowMs);
      const health = deriveRunHealth(facts, healthRules);
      if (health) m.set(run.id, health);
    }
    return m;
  }, [history.runs, stepCountByRun, healthRules]);

  // Triage signal shown on the existing header dot — how many runs need a look
  // (a warning/error tone), so the human sees "3852 runs · 40 need attention" at a
  // glance instead of scrolling ~3900 cards. Reuses existing components (no new UI).
  const attentionCount = React.useMemo(() => {
    let n = 0;
    for (const h of healthByRun.values()) if (h.tone === 'error' || h.tone === 'warning') n += 1;
    return n;
  }, [healthByRun]);

  if (published == null) {
    return (
      <ScrollableSurface>
        <Container layout="vertical" gap="sm" alignItems="center" justifyContent="center" padding="xl"><Spinner /></Container>
      </ScrollableSurface>
    );
  }

  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="md" padding="lg">
        <Container layout="horizontal" alignItems="center" justifyContent="space-between" gap="md" padding="none">
          <Container layout="horizontal" alignItems="center" gap="sm" padding="none">
            <Icon icon={Activity} size="sm" />
            <Text variant="heading-sm" leading="tight">AI execution history</Text>
          </Container>
          <StatusDot
            status={attentionCount > 0 ? 'warning' : 'info'}
            size="sm"
            label={attentionCount > 0
              ? `${history.runs.length} runs · ${attentionCount} need attention`
              : `${history.runs.length} run${history.runs.length === 1 ? '' : 's'}`}
          />
        </Container>
        <Divider />
        {history.runs.length === 0 ? (
          <Container layout="vertical" gap="sm" alignItems="center" justifyContent="center" padding="xl">
            <Icon icon={CheckCircle2} size="lg" color="muted" />
            <Text variant="body" color="muted" align="center">No AI runs yet. Commissioned work will appear here as it runs.</Text>
          </Container>
        ) : (
          <Container layout="vertical" gap="sm" padding="none">
            {history.runs.slice(0, 50).map((run) => <RunCard key={run.id} run={run} stepCount={stepCountByRun.get(run.id) ?? 0} health={healthByRun.get(run.id)} review={latestReviewByRun.get(run.id)} />)}
            {history.runs.length > 50 ? (
              <Text variant="caption" color="faint" align="center">{`Showing the 50 most recent of ${history.runs.length} runs.`}</Text>
            ) : null}
          </Container>
        )}
      </Container>
    </ScrollableSurface>
  );
}
