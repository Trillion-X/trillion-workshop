import { useState } from 'react';
import { Badge, Button, Container, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Text, mountReactSurface } from '@trillion/ui';
import { Failed, Screen, Section, Working, h, minutes, rowOf, useToolRun, wordsFor } from './shared.mjs';

const TOOL = 'tool:transcribe-file';
const words = wordsFor('transcribe-file');
const DATA = rowOf(TOOL).screen.inputs;

function Passages({ result }) {
  const passages = Array.isArray(result?.segments) ? result.segments : [];
  return h(Section, { label: words.passages },
    h(Badge, { variant: 'success' }, words.saved),
    h(Container, { layout: 'vertical', gap: 'sm' },
      ...passages.map((passage, index) => h(Container, { key: index, layout: 'horizontal', gap: 'md', alignItems: 'start' },
        h(Text, { variant: 'caption', color: 'muted' }, `${minutes(passage.start)}–${minutes(passage.end)}`),
        h(Text, { variant: 'body' }, String(passage.text ?? '')),
      )),
    ),
    h(Text, { variant: 'caption', color: 'muted' }, words.again),
  );
}

function TranscribeScreen({ surfaceInput, host }) {
  const identity = String(surfaceInput?.identity ?? '');
  const name = surfaceInput?.name ? String(surfaceInput.name) : words.untitled;
  const { state, run, reset } = useToolRun(host, TOOL);
  const [heardIn, setHeardIn] = useState('');
  const OWN = '__own';
  const language = DATA.language;
  const start = () => run({ identity, ...(heardIn ? { language: heardIn } : {}) });
  return h(Screen, { title: words.title, about: words.about },
    h(Section, { label: DATA.identity.label },
      h(Text, { variant: 'body' }, name),
      identity ? h(Text, { variant: 'caption', color: 'muted' }, `${identity.slice(0, 11)}…`) : null,
    ),
    h(Section, { label: language.label },
      h(Select, { value: heardIn || OWN, onValueChange: value => { if (typeof value === 'string') setHeardIn(value === OWN ? '' : value); } },
        h(SelectTrigger, { 'aria-label': language.label },
          h(SelectValue, null, language.choices.find(choice => choice.value === heardIn)?.label ?? language.choices[0].label)),
        h(SelectPopup, null, ...language.choices.map(choice => h(SelectItem, { key: choice.value || OWN, value: choice.value || OWN }, choice.label))),
      ),
      h(Text, { variant: 'caption', color: 'muted' }, words.hearInHint),
    ),
    state.status === 'running' ? h(Working, { words }) : null,
    state.status === 'failed' ? h(Failed, { words, onRetry: start }) : null,
    state.status === 'done' ? h(Passages, { result: state.result }) : null,
    h(Container, { layout: 'horizontal', gap: 'sm' },
      h(Button, { variant: 'primary', disabled: !identity || state.status === 'running', onClick: start }, words.start),
      state.status === 'done' ? h(Button, { variant: 'ghost', onClick: reset }, words.run) : null,
    ),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(TranscribeScreen, { surfaceInput, host }));
}
