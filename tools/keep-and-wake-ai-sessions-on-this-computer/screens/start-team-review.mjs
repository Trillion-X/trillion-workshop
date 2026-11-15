import { useRef, useState } from 'react';
import { Badge, Button, Container, Input, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { Failed, Screen, Section, Working, h, rowOf, useToolRun, wordsFor } from './shared.mjs';

const TOOL = 'tool:start-team-review';
const words = wordsFor('start-team-review');
const DATA = rowOf(TOOL).screen.inputs;
const STATE_TONE = { working: 'info', approved: 'success', invalidated: 'warning', round_limit: 'warning' };
const STATE_WORDS = { working: words.stateWorking, approved: words.stateApproved, invalidated: words.stateInvalidated, round_limit: words.stateRoundLimit };

function Review({ result }) {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  return h(Section, { label: words.steps },
    h(Container, { layout: 'horizontal', gap: 'sm', alignItems: 'center' },
      h(Badge, { variant: STATE_TONE[result.state] ?? 'neutral' }, STATE_WORDS[result.state] ?? String(result.state ?? '')),
    ),
    h(Text, { variant: 'body' }, String(result.said ?? '')),
    h(Container, { layout: 'vertical', gap: 'sm' },
      ...steps.map((step, index) => h(Container, { key: index, layout: 'vertical', gap: 'xs' },
        h(Text, { variant: 'label', color: 'muted' }, [step.role, step.agent ?? step.agent_id].filter(Boolean).join(' · ')),
        h(Text, { variant: 'body' }, String(step.notes ?? step.said ?? '')),
      )),
    ),
    h(Text, { variant: 'caption', color: 'muted' }, words.again),
  );
}

function TeamReviewScreen({ surfaceInput, host }) {
  const [work, setWork] = useState(String(surfaceInput?.work ?? ''));
  const [rounds, setRounds] = useState(String(surfaceInput?.rounds ?? ''));
  // One request key per opened screen: the same review comes back for the same key.
  const reviewKey = useRef(`team-review:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`);
  const { state, run } = useToolRun(host, TOOL);
  const start = () => {
    const roundCount = Number.parseInt(rounds, 10);
    run({
      work: work.trim(),
      request_key: reviewKey.current,
      ...(Number.isInteger(roundCount) && roundCount >= 1 ? { rounds: roundCount } : {}),
      ...(surfaceInput?.assign ? { assign: surfaceInput.assign } : {}),
      ...(surfaceInput?.needs ? { needs: surfaceInput.needs } : {}),
    });
  };
  return h(Screen, { title: words.title, about: words.about },
    h(Section, { label: DATA.work.label },
      h(Textarea, { value: work, placeholder: DATA.work.placeholder, rows: 4, onChange: event => setWork(event.target.value) }),
    ),
    h(Section, { label: DATA.rounds.label },
      h(Input, { type: 'number', min: '1', value: rounds, placeholder: DATA.rounds.placeholder, onChange: event => setRounds(event.target.value) }),
      h(Text, { variant: 'caption', color: 'muted' }, words.roundsHint),
    ),
    state.status === 'running' ? h(Working, { words }) : null,
    state.status === 'failed' ? h(Failed, { words, onRetry: start }) : null,
    state.status === 'done' ? h(Review, { result: state.result }) : null,
    h(Button, { variant: 'primary', disabled: !work.trim() || state.status === 'running', onClick: start }, words.start),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(TeamReviewScreen, { surfaceInput, host }));
}
