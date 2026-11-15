import { Badge, Button, Container, Text, mountReactSurface } from '@trillion/ui';
import { Failed, Screen, Section, Working, h, rowOf, useToolRun, wordsFor } from './shared.mjs';

const TOOL = 'tool:read-file-words';
const words = wordsFor('read-file-words');
const DATA = rowOf(TOOL).screen.inputs;

function Words({ result }) {
  const badges = [];
  if (result.way) badges.push(words.way[result.way] ?? result.way);
  if (result.skipped) badges.push(words.skipped);
  return h(Section, { label: words.file },
    h(Container, { layout: 'horizontal', gap: 'xs', wrap: true },
      ...badges.map(label => h(Badge, { key: label, variant: 'neutral' }, label)),
      result.cut ? h(Badge, { variant: 'warning' }, words.cut) : null,
    ),
    h(Text, { variant: 'caption', color: 'muted' }, `${Number(result.characters ?? 0).toLocaleString()} ${words.characters}`),
    h(Text, { variant: 'body' }, String(result.said ?? '')),
    h(Text, { variant: 'caption', color: 'muted' }, words.again),
  );
}

function ReadFileWordsScreen({ surfaceInput, host }) {
  const identity = String(surfaceInput?.identity ?? '');
  const name = surfaceInput?.name ? String(surfaceInput.name) : words.untitled;
  const { state, run, reset } = useToolRun(host, TOOL);
  const start = () => run({ identity });
  return h(Screen, { title: words.title, about: words.about },
    h(Section, { label: DATA.identity.label },
      h(Text, { variant: 'body' }, name),
      identity ? h(Text, { variant: 'caption', color: 'muted' }, `${identity.slice(0, 11)}…`) : null,
    ),
    state.status === 'running' ? h(Working, { words }) : null,
    state.status === 'failed' ? h(Failed, { words, onRetry: start }) : null,
    state.status === 'done' ? h(Words, { result: state.result }) : null,
    h(Container, { layout: 'horizontal', gap: 'sm' },
      h(Button, { variant: 'primary', disabled: !identity || state.status === 'running', onClick: start }, words.start),
      state.status === 'done' ? h(Button, { variant: 'ghost', onClick: reset }, words.run) : null,
    ),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(ReadFileWordsScreen, { surfaceInput, host }));
}
