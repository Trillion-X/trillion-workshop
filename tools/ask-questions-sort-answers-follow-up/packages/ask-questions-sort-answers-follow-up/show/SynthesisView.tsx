// packages/ask-questions-sort-answers-follow-up/show/SynthesisView.tsx
//
// A GENERIC, blind AI-synthesis readout over a question sequence's answers.
// Everything specific — which sequence, the framing prompt, the labels — arrives
// as DATA on surfaceInput (L090). The view: reads the answer-facts for the
// sequence, and on demand dispatches the OWNED ai-records-producer
// (action:run-ai-records-production) with the answers + the DATA framing, then
// polls the label-hash result and renders the reply as prose. It NEVER resolves a
// provider/model/prompt itself — that stays in ai-records-producer (No-God-Package);
// this view only dispatches by address and reads the result address.
//
// Reference-Grounded Screen Contract (Mobbin: ABY Journal "ABY Noticed…", Tolan
// "Personality Reading", Alma): eyebrow → statement title → prose synthesis card
// reflecting the person's own words → subtle source grounding → one Synthesize
// action. States: empty / ready / thinking / done / error. Composed only from
// packages/ui primitives (zero inline styling, L065/L066).

import React from 'react';
import { useBitfieldData } from '@/packages/ask-questions-sort-answers-follow-up/.bitfield-entry-scope/ask-questions-sort-answers-follow-up/runtime-kit-react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { Container } from '@/packages/ui/show/container/container';
import { Text } from '@/packages/ui/show/text/Text';
import { Card } from '@/packages/ui/show/card/Card';
import { Button } from '@/packages/ui/show/button/Button';
import { StatementHeader } from '@/packages/ui/show/statement-header';
import { WorkStartState } from '@/packages/ui/show/work-start-state/WorkStartState';
import { answerLinesForSequence } from '@/packages/ask-questions-sort-answers-follow-up/read-data/synthesis-answer-lines';
import { readProducerMessage } from '@/packages/ask-questions-sort-answers-follow-up/read-data/read-producer-message';
import {
  SYNTHESIS_RESULT_KIND,
  latestSynthesisResult,
  resultKeyFor,
  synthesisResultAddress,
} from '@/packages/ask-questions-sort-answers-follow-up/read-data/synthesis-result';

export interface SynthesisConfig {
  sequenceId?: string;
  /** The framing prompt prepended to the person's answers. DATA-supplied. */
  wrapPrefix?: string;
  /** Which producer definition to dispatch (default: the generic producer). */
  definitionId?: string;
  outputKind?: string;
  eyebrow?: string;
  title?: string;
  actionLabel?: string;
  /** Stable per-surface key so surfaces sharing one sequence (e.g. Convictions /
   *  Prime Directive / Codex) persist to distinct records. DATA; falls back to a
   *  slug of `title`. */
  resultKey?: string;
  /** Which agent group the producer runs under. DATA — no Society literal in
   *  this generic view. */
  targetGroupRef?: string;
  /** What to say before any answers exist. DATA — the generic default names no
   *  specific exercise. */
  emptyHint?: string;
}

type Phase = 'ready' | 'thinking' | 'done' | 'error';

const DEFAULT_DEFINITION = 'action:run-ai-records-production';

export function SynthesisView(config: SynthesisConfig = {}) {
  const {
    sequenceId,
    wrapPrefix = 'You are a warm, insightful coach. Below are a person’s own answers. In 2–3 short paragraphs, reflect the through-line back to them in second person, grounded in their own words. Be specific and human, not generic. Their answers:',
    definitionId = DEFAULT_DEFINITION,
    outputKind = 'message',
    eyebrow = 'What we heard',
    title = 'Your synthesis',
    actionLabel = 'Synthesize',
    resultKey,
    targetGroupRef = '',
    emptyHint = 'Answer the questions first — once you’ve filled them in, come back here to see it drawn together.',
  } = config;

  const published = useBitfieldData('published-records');
  const answerLines = React.useMemo(() => answerLinesForSequence(published, sequenceId), [published, sequenceId]);

  // The stable per-surface key + the durable result already saved for it.
  const key = React.useMemo(() => resultKeyFor(resultKey, title), [resultKey, title]);
  const persisted = React.useMemo(
    () => latestSynthesisResult(published, sequenceId, key),
    [published, sequenceId, key],
  );

  const [phase, setPhase] = React.useState<Phase>('ready');
  const [synthesis, setSynthesis] = React.useState<string>('');
  const [errorText, setErrorText] = React.useState<string>('');
  const runToken = React.useRef(0);

  // Living readout: if a saved synthesis exists and the user hasn't started a run,
  // show it immediately — the Codex is here when you come back, no AI re-run.
  React.useEffect(() => {
    if (persisted && phase === 'ready') {
      setSynthesis(persisted);
      setPhase('done');
    }
  }, [persisted, phase]);

  const persistResult = React.useCallback(
    async (text: string) => {
      try {
        await sendRequestToBitfieldTarget({
          target: 'engine.operation.label-addressed',
          payload: {
            operation_label: 'engine.operation.write-batch',
            writes: [
              {
                address_label: synthesisResultAddress(sequenceId, key),
                address_mode: 'identity_text',
                // 2-segment path so it lands in the published-records feed this view reads.
                path_labels: ['current-item', 'published-record'],
                payload: {
                  kind: SYNTHESIS_RESULT_KIND,
                  sequence_id: sequenceId,
                  result_key: key,
                  output_kind: outputKind,
                  text,
                  produced_at: new Date().toISOString(),
                },
              },
            ],
          },
        });
      } catch {
        // Non-fatal: the reply is already shown; persistence just failed this run.
      }
    },
    [sequenceId, key, outputKind],
  );

  const onSynthesize = React.useCallback(() => {
    if (answerLines.length === 0) return;
    const token = ++runToken.current;
    setPhase('thinking');
    setErrorText('');
    const requestId = `synth-${sequenceId ?? 'seq'}-${Date.now()}-${Math.floor(runToken.current)}`;
    const instructionText = `${wrapPrefix}\n\n${answerLines.map((l) => `- ${l}`).join('\n')}`;
    const resultAddress = `package::ai-records-producer::result::${requestId}`;
    const errorAddress = `package::ai-records-producer::error::${requestId}`;

    void (async () => {
      try {
        await sendRequestToBitfieldTarget({
          target: 'slot::workflow',
          payload: {
            operation: 'execute_definition',
            include_output: false,
            definition_id: definitionId,
            input: {
              request_id: requestId,
              instruction_text: instructionText,
              output_kind: outputKind,
              model: '',
              wrap_instruction_ref: '',
              target_group_ref: targetGroupRef,
              agent_ref: '',
            },
          },
        });
      } catch {
        if (runToken.current === token) {
          setErrorText('Couldn’t start the synthesis — try again.');
          setPhase('error');
        }
        return;
      }

      const deadline = Date.now() + 120_000;
      const poll = async () => {
        if (runToken.current !== token) return;
        const status = await readProducerMessage(resultAddress, errorAddress).catch(() => ({ state: 'pending' as const }));
        if (runToken.current !== token) return;
        if (status.state === 'done') {
          const text = status.text.trim();
          setSynthesis(text);
          setPhase('done');
          void persistResult(text); // make it a living, revisitable Codex
          return;
        }
        if (status.state === 'error') {
          setErrorText(status.message);
          setPhase('error');
          return;
        }
        if (Date.now() > deadline) {
          setErrorText('This is taking longer than expected — try again.');
          setPhase('error');
          return;
        }
        setTimeout(() => void poll(), 1500);
      };
      setTimeout(() => void poll(), 1500);
    })();
  }, [answerLines, sequenceId, wrapPrefix, definitionId, outputKind, targetGroupRef, persistResult]);

  // Empty: no answers to synthesize yet AND nothing saved to revisit.
  if (answerLines.length === 0 && !persisted) {
    return (
      <Container padding="lg" maxWidth="md" alignItems="center">
        <WorkStartState
          title="Nothing to synthesize yet"
          description={emptyHint}
        />
      </Container>
    );
  }

  const grounding = `From your ${answerLines.length} answer${answerLines.length === 1 ? '' : 's'}`;

  return (
    // Reading column: a comfortable, WIDE measure (3xl) centered in the pane, so the
    // synthesis fills the space instead of a narrow left-aligned card with dead space
    // on the right. marginX=auto balances the margins on wide screens (readable line
    // length preserved — full-bleed prose is a typography regression, not the goal).
    <Container padding="lg" maxWidth="3xl" marginX="auto" gap="lg">
      <StatementHeader kicker={eyebrow} statement={title} subtitle={grounding} />

      {phase === 'done' ? (
        // Inner content card = `nested` (glass-nested), not `surface`: it sits on the
        // pane's own surface, so a second glass-surface stacks opacity into the muddy
        // "card inside a card" look. glass-nested is the layer-inside-a-surface token
        // (the service-connections reference model). One surface layer, clean nesting.
        <Card variant="nested" padding="lg">
          <Container gap="md">
            {synthesis.split(/\n{2,}/).map((para, i) => (
              <Text key={i} variant="body-lg" leading="relaxed">
                {para.trim()}
              </Text>
            ))}
          </Container>
        </Card>
      ) : null}

      {phase === 'error' ? (
        <Card variant="nested" padding="md">
          <Text variant="body" color="muted">
            {errorText}
          </Text>
        </Card>
      ) : null}

      <Container>
        <Button
          variant="primary"
          size="lg"
          disabled={phase === 'thinking'}
          onClick={onSynthesize}
        >
          {phase === 'thinking'
            ? 'Thinking…'
            : phase === 'done'
              ? 'Synthesize again'
              : actionLabel}
        </Button>
      </Container>
    </Container>
  );
}
