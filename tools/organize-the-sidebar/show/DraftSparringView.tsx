// packages/group/show/DraftSparringView.tsx
//
// R13 product surface: writing SPARRING. Given several drafts (e.g. a few note cards holding
// alternative versions), it ranks them best-first with the judge and badges the winner —
// "write three versions, spar them, keep the best". Reads the pure rankDrafts + judgeText
// (writing-judge.ts); no engine. Generic: it ranks whatever drafts + rubric it is given and
// never names a criterion. Chrome is ui components (L065); the score bar is data-driven.

import { Badge, Button, Container, Text } from '../../ui/index.ts';
import {
  DEFAULT_WRITING_RUBRIC,
  rankDrafts,
  type Rubric,
} from '../read-data/writing-judge.ts';

export interface SparringDraft {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

export interface DraftSparringViewProps {
  readonly drafts: readonly SparringDraft[];
  readonly rubric?: Rubric;
  /** "keep the best" — when provided, a button removes every draft except the winner. */
  readonly onKeepWinner?: (winnerId: string, loserIds: readonly string[]) => void;
}

const BAR_W = 200;

function scoreColor(score: number): string {
  if (score >= 0.75) return '#12a150';
  if (score >= 0.5) return '#d97706';
  return '#e5484d';
}

export function DraftSparringView({ drafts, rubric = DEFAULT_WRITING_RUBRIC, onKeepWinner }: DraftSparringViewProps): JSX.Element | null {
  if (drafts.length < 2) return null; // sparring needs at least two contenders (L118)
  const ranked = rankDrafts(drafts, rubric);
  const byId = new Map(drafts.map((d) => [d.id, d]));
  return (
    <Container layout="vertical" gap="sm">
      <Text variant="body-md" weight="semibold">
        Sparring — {drafts.length} drafts
      </Text>
      {ranked.map((r, i) => {
        const draft = byId.get(r.id);
        if (!draft) return null;
        const pct = Math.round(r.overall * 100);
        return (
          <Container key={r.id} layout="vertical" gap="none">
            <Container layout="horizontal" gap="xs" alignItems="center">
              <Text variant="body-sm" weight="semibold">
                {draft.title}
              </Text>
              {i === 0 ? <Badge variant="success">Winner</Badge> : null}
              <Text variant="body-sm" tone="muted">
                {pct}/100
              </Text>
            </Container>
            <Container position="relative" style={{ height: 6, width: BAR_W, background: '#e6e8ec', borderRadius: 3 }}>
              <Container
                position="absolute"
                style={{ left: 0, top: 0, height: 6, width: BAR_W * r.overall, background: scoreColor(r.overall), borderRadius: 3 }}
              />
            </Container>
          </Container>
        );
      })}
      {onKeepWinner ? (
        <Button
          variant="secondary"
          size="sm"
          aria-label="Keep the winner and remove the other drafts"
          onClick={() => onKeepWinner(ranked[0].id, ranked.slice(1).map((r) => r.id))}
        >
          Keep winner, remove others
        </Button>
      ) : null}
    </Container>
  );
}
