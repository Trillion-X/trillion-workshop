// packages/ask-questions-sort-answers-follow-up/show/ResultsSurface.tsx
//
// The operator's RESULTS surface: who answered, their score, their segment. A
// generic projection of the segment-assignment facts (ResultsModel) — reuses ui
// StatStrip + Table + Badge, zero inline styling. Honest-empty until real
// submissions (no fabricated rows). Segment chips are DATA-driven (the segmentId
// string straight from the fact) — no closed segment enum.

import React from 'react';
import { Users } from 'lucide-react';
import { Card } from '@/packages/ui/show/card/Card';
import { Container } from '@/packages/ui/show/container/container';
import { Text } from '@/packages/ui/show/text/Text';
import { Badge } from '@/packages/ui/show/badge/Badge';
import { StatStrip } from '@/packages/ui/show/stat-strip/StatStrip';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/packages/ui/show/table/Table';
import { WorkStartState } from '@/packages/ui/show/work-start-state/WorkStartState';
import type { ResultsModel } from '@/packages/ask-questions-sort-answers-follow-up/read-data/results-model';

export interface ResultsSurfaceProps {
  model: ResultsModel;
}

function summaryStats(model: ResultsModel): { label: string; value: string }[] {
  return [
    { label: 'Responses', value: String(model.summary.total) },
    ...Object.entries(model.summary.bySegment).map(([segmentId, count]) => ({
      label: segmentId,
      value: String(count),
    })),
  ];
}

export function ResultsSurface({ model }: ResultsSurfaceProps) {
  if (model.summary.total === 0) {
    return (
      <Card padding="lg">
        <WorkStartState
          icon={Users}
          title="No responses yet"
          description="As people answer this form, their score and segment appear here."
        />
      </Card>
    );
  }

  return (
    <Card padding="lg">
      <Container layout="vertical" gap="md" alignItems="stretch">
        <StatStrip stats={summaryStats(model)} />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Respondent</TableHead>
              <TableHead>Score</TableHead>
              <TableHead>Segment</TableHead>
              <TableHead>Answered</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {model.rows.map((r) => (
              <TableRow key={`${r.formId}:${r.respondentId}`}>
                <TableCell>
                  <Text variant="body-xs">{r.respondentId}</Text>
                </TableCell>
                <TableCell>
                  <Text variant="body-xs">{String(r.score)}</Text>
                </TableCell>
                <TableCell>
                  {r.segmentId ? (
                    <Badge>{r.segmentId}</Badge>
                  ) : (
                    <Text variant="body-xs" color="muted">
                      —
                    </Text>
                  )}
                </TableCell>
                <TableCell>
                  <Text variant="body-xs" color="muted">
                    {r.decidedAt ? r.decidedAt.slice(0, 10) : '—'}
                  </Text>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Container>
    </Card>
  );
}
