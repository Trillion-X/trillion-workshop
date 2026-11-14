// packages/group/show/RewriteLoopView.tsx
//
// R14 product surface: the write-a-lot → CUT-to-nugget → rewrite-around-it loop, on a note.
// The note's text is the starting draft. "Cut to nugget" (pure judge, no engine) picks the
// highest-value sentence to rewrite around. The author types a rewrite in the inline box and
// adds it as a version; every version is scored best-first-visible and "Use this version"
// writes the chosen text back to the note. AI generation (auto-drafting / auto-rewriting) is
// the model-selection owner boundary and would only PREFILL the same inline box — not required
// for the loop to work. Generic: the rubric is DATA (writing-judge); nothing is named here.
// Chrome is ui components (L065); the score bar is data-driven.

import { useState } from 'react';
import { Badge, Button, Container, Text, Textarea } from '../../ui';
import {
  appendRewrite,
  bestVersion,
  cutToNugget,
  startLoop,
  type LoopStage,
  type RewriteLoop,
} from 'trillion-workshop/tools/organize-the-sidebar/read-data/rewrite-loop.ts';
import { DEFAULT_WRITING_RUBRIC, type Rubric } from 'trillion-workshop/tools/organize-the-sidebar/read-data/writing-judge.ts';

export interface RewriteLoopViewProps {
  readonly draft: string;
  readonly rubric?: Rubric;
  /** "keep the best" — write the chosen version's text back onto the note. */
  readonly onUseVersion?: (text: string) => void;
}

const BAR_W = 200;

function scoreColor(score: number): string {
  if (score >= 0.75) return '#12a150';
  if (score >= 0.5) return '#d97706';
  return '#e5484d';
}

const STAGE_LABEL: Record<LoopStage, string> = { draft: 'Draft', nugget: 'Nugget', rewrite: 'Rewrite' };

export function RewriteLoopView({ draft, rubric = DEFAULT_WRITING_RUBRIC, onUseVersion }: RewriteLoopViewProps): JSX.Element | null {
  const [loop, setLoop] = useState<RewriteLoop>(() => startLoop(draft, rubric));
  const [rewrite, setRewrite] = useState('');
  if (draft.trim().length === 0) return null; // nothing to refine (L118)

  const best = bestVersion(loop);
  const latest = loop.versions[loop.versions.length - 1];
  const canCut = latest?.stage !== 'nugget'; // don't cut a nugget again

  return (
    <Container layout="vertical" gap="sm">
      <Text variant="body-md" weight="semibold">
        Refine — {loop.versions.length} version{loop.versions.length === 1 ? '' : 's'}
      </Text>
      {loop.versions.map((v) => {
        const isBest = best?.id === v.id;
        const pct = Math.round(v.score * 100);
        return (
          <Container key={v.id} layout="vertical" gap="none">
            <Container layout="horizontal" gap="xs" alignItems="center">
              <Badge variant={isBest ? 'success' : 'neutral'}>{STAGE_LABEL[v.stage]}</Badge>
              {isBest ? <Text variant="body-sm" weight="semibold">Best</Text> : null}
              <Text variant="body-sm" tone="muted">{pct}/100</Text>
            </Container>
            <Container position="relative" style={{ height: 6, width: BAR_W, background: '#e6e8ec', borderRadius: 3 }}>
              <Container position="absolute" style={{ left: 0, top: 0, height: 6, width: BAR_W * v.score, background: scoreColor(v.score), borderRadius: 3 }} />
            </Container>
            <Text variant="body-sm" tone="muted">{v.text.length > 120 ? `${v.text.slice(0, 120)}…` : v.text}</Text>
            {onUseVersion ? (
              <Button variant="ghost" size="sm" aria-label={`Use the ${STAGE_LABEL[v.stage]} version`} onClick={() => onUseVersion(v.text)}>
                Use this version
              </Button>
            ) : null}
          </Container>
        );
      })}
      <Container layout="horizontal" gap="xs" alignItems="center">
        {canCut ? (
          <Button variant="secondary" size="sm" aria-label="Cut the latest version to its strongest sentence" onClick={() => setLoop((l) => cutToNugget(l, rubric))}>
            Cut to nugget
          </Button>
        ) : null}
      </Container>
      <Textarea
        value={rewrite}
        onChange={(e) => setRewrite(e.target.value)}
        placeholder="Rewrite around the nugget…"
        aria-label="Rewrite text"
        rows={3}
      />
      <Button
        variant="primary"
        size="sm"
        disabled={rewrite.trim().length === 0}
        aria-label="Add this rewrite as a new version"
        onClick={() => {
          if (rewrite.trim().length === 0) return;
          setLoop((l) => appendRewrite(l, rewrite.trim(), rubric));
          setRewrite('');
        }}
      >
        Add rewrite
      </Button>
    </Container>
  );
}
