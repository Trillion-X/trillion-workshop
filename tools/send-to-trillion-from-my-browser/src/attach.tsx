// extension/src/attach.tsx
//
// PURPOSE
//   "Attach files" in Send to Trillion: the person drops files here or picks them from their computer, each is kept in
//   their Trillion files as it is chosen, and each goes into the tray the popup sends, like anything else they add.
//   It is its own small window (extension/attach.html, opened by the popup), because a browser closes the popup the
//   moment its own file chooser opens.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Built from the shared parts (parts/ui): the licensed kibo Dropzone takes the files; no control is hand-made.
//   2. Every word is DATA (extension/words.json `attach`, extension/page-tools.json `files`).
//   3. A file is in the tray only once it is kept (its identity known), so Send never sends a file still on its way.
//   4. Done opens the popup again with the files in Sending and closes this window.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from 'trillion-workshop/tools/ui/show/button/index.ts';
import { Container } from 'trillion-workshop/tools/ui/show/container/index.ts';
import { NamedIcon } from 'trillion-workshop/tools/ui/show/icon/index.ts';
import { Spinner } from 'trillion-workshop/tools/ui/show/spinner/index.ts';
import { Text } from 'trillion-workshop/tools/ui/show/text/index.ts';
import { Dropzone, DropzoneEmptyState } from 'trillion-workshop/tools/ui/show/kibo/dropzone.tsx';
import { paintWithWornLook } from './worn-look-page';
import { keepFile, signedInAccount, SignInNeeded } from './trillion.mjs';
import { addToTray } from './tray.mjs';
import pageTools from '../page-tools.json' with { type: 'json' };
import words from '../words.json' with { type: 'json' };

const said = words.attach;
type Kept = { id: number; name: string; state: 'keeping' | 'kept' | 'failed'; why?: string };

function Attach() {
  const [kept, setKept] = React.useState<Kept[]>([]);
  const nextId = React.useRef(0);
  const change = (id: number, next: Partial<Kept>) => setKept(rows => rows.map(row => (row.id === id ? { ...row, ...next } : row)));

  async function take(files: File[]) {
    const expectedAccount = await signedInAccount();
    const admitted = files.map(file => ({ id: ++nextId.current, file }));
    setKept(rows => [...rows, ...admitted.map(({ id, file }) => ({ id, name: file.name, state: 'keeping' as const }))]);
    for (const { id, file } of admitted) {
      try {
        if (!expectedAccount) throw new SignInNeeded();
        const identity = await keepFile({ blob: file, name: file.name, mediaType: file.type || 'application/octet-stream', expectedAccount });
        await addToTray({ kind: pageTools.files.kind, name: file.name, title: file.name, file: identity, size: file.size, url: null, made_by: pageTools.files.id, account: expectedAccount });
        change(id, { state: 'kept' });
      } catch (error) {
        change(id, { state: 'failed', why: (error as Error).message });
      }
    }
  }

  async function done() {
    await chrome.action.openPopup().catch(() => {});
    window.close();
  }

  const keeping = kept.some(row => row.state === 'keeping');
  return (
    <Container layout="vertical" gap="md" padding="lg" width="full">
      <Text variant="title">{said.title}</Text>
      <Dropzone maxFiles={0} multiple onDrop={files => void take(files)} aria-label={said.drop}>
        <DropzoneEmptyState>
          <Container layout="vertical" gap="xs" alignItems="center">
            <NamedIcon name={pageTools.files.icon} aria-hidden="true" />
            <Text>{said.drop}</Text>
            <Text variant="caption" color="muted">{said.choose}</Text>
          </Container>
        </DropzoneEmptyState>
      </Dropzone>
      {kept.map(row => (
        <Container key={row.id} layout="horizontal" gap="sm" alignItems="center">
          {row.state === 'keeping' ? <Spinner /> : <NamedIcon name={row.state === 'kept' ? 'Check' : 'TriangleAlert'} aria-hidden="true" />}
          <Text>{row.name}</Text>
          <Text variant="caption" color="muted">{row.state === 'keeping' ? said.keeping : row.state === 'kept' ? said.kept : `${said.could_not} ${row.why ?? ''}`}</Text>
        </Container>
      ))}
      <Container layout="horizontal" gap="sm" justifyContent="end" width="full">
        <Button variant="ghost" size="sm" onClick={() => window.close()}>{said.cancel}</Button>
        <Button size="sm" disabled={keeping || !kept.some(row => row.state === 'kept')} onClick={() => done()}>{keeping ? said.keeping : said.done}</Button>
      </Container>
    </Container>
  );
}

// The look the person wears in Trillion (extension/src/worn-look-page.ts).
paintWithWornLook();
createRoot(document.body.appendChild(document.createElement('main'))).render(<Attach />);
