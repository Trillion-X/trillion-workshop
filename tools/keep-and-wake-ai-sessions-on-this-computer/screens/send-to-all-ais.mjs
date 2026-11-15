import { useState } from 'react';
import { Badge, Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { Failed, Screen, Section, Working, h, rowOf, useToolRun, wordsFor } from './shared.mjs';

const TOOL = 'tool:send-to-all-ais';
const words = wordsFor('send-to-all-ais');
const DATA = rowOf(TOOL).screen.inputs;
const ATTACH_LIMIT = 19;
const DELIVERY_TONE = { waiting: 'info', delivered: 'success', next_connection: 'warning' };

function Delivery({ result }) {
  const delivery = Array.isArray(result?.delivery) ? result.delivery : [];
  return h(Section, { label: words.delivery },
    h(Container, { layout: 'vertical', gap: 'sm' },
      ...delivery.map((ai, index) => h(Container, { key: ai.agent_id ?? index, layout: 'horizontal', gap: 'md', alignItems: 'center', justifyContent: 'between' },
        h(Text, { variant: 'body' }, String(ai.name ?? ai.agent_id ?? '')),
        h(Badge, { variant: DELIVERY_TONE[ai.state] ?? 'neutral' }, words.states[ai.state] ?? String(ai.state ?? '')),
      )),
    ),
    h(Text, { variant: 'caption', color: 'muted' }, words.sent),
  );
}

function SendToAllAisScreen({ surfaceInput, host }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState(() => (Array.isArray(surfaceInput?.files) ? surfaceInput.files.slice(0, ATTACH_LIMIT) : []));
  const { state, run, reset } = useToolRun(host, TOOL);
  const send = () => run({
    text,
    ...(files.length ? { files: files.map(file => ({ identity: file.identity })) } : {}),
  });
  const ready = (text.trim().length > 0 || files.length > 0) && state.status !== 'running';
  return h(Screen, { title: words.title, about: words.about },
    h(Section, { label: DATA.text.label },
      h(Textarea, { value: text, placeholder: DATA.text.placeholder, rows: 5, onChange: event => setText(event.target.value) }),
      h(Text, { variant: 'caption', color: 'muted' }, words.attachLimit),
    ),
    h(Section, { label: words.files },
      files.length
        ? h(Container, { layout: 'vertical', gap: 'xs' },
          ...files.map(file => h(Container, { key: file.identity, layout: 'horizontal', gap: 'sm', alignItems: 'center', justifyContent: 'between' },
            h(Text, { variant: 'body' }, String(file.name ?? file.identity)),
            h(Button, { variant: 'ghost', size: 'sm', onClick: () => setFiles(current => current.filter(item => item.identity !== file.identity)) }, words.remove ?? 'Remove'),
          )),
        )
        : h(Text, { variant: 'caption', color: 'muted' }, words.noFiles),
    ),
    state.status === 'running' ? h(Working, { words }) : null,
    state.status === 'failed' ? h(Failed, { words, onRetry: send }) : null,
    state.status === 'done' ? h(Delivery, { result: state.result }) : null,
    h(Container, { layout: 'horizontal', gap: 'sm' },
      h(Button, { variant: 'primary', disabled: !ready, onClick: () => { send(); } }, words.send),
      state.status === 'done' ? h(Button, { variant: 'ghost', onClick: reset }, words.run) : null,
    ),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(SendToAllAisScreen, { surfaceInput, host }));
}
