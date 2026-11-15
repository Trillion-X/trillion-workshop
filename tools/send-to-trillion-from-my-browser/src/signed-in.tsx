// extension/src/signed-in.tsx
//
// PURPOSE
//   Where Trillion's sign-in sends the person back: exchanges the code for this extension's tokens
//   (trillion.mjs finishSignIn), says so, and closes the tab.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Container } from 'trillion-workshop/tools/ui/show/container/index.ts';
import { NamedIcon } from 'trillion-workshop/tools/ui/show/icon/index.ts';
import { Text } from 'trillion-workshop/tools/ui/show/text/index.ts';
import { finishSignIn } from './trillion.mjs';
import { paintWithWornLook } from './worn-look-page';
import words from '../words.json' with { type: 'json' };

function SignedIn() {
  const [state, setState] = React.useState<{ done: boolean; problem: string | null }>({ done: false, problem: null });
  React.useEffect(() => {
    finishSignIn(location.href)
      .then(() => { setState({ done: true, problem: null }); setTimeout(() => window.close(), 1500); })
      .catch(error => setState({ done: false, problem: String(error.message) }));
  }, []);
  return (
    <Container layout="vertical" gap="md" padding="xl" alignItems="center">
      <NamedIcon name={state.problem ? 'CircleAlert' : 'CircleCheck'} size="lg" aria-hidden="true" />
      <Text variant="title" align="center">{state.problem ? words.signed_in_failed : state.done ? words.signed_in_heading : words.looking}</Text>
      <Text variant="body" color="muted" align="center">{state.problem ?? words.signed_in_body}</Text>
    </Container>
  );
}

// The look the person wears in Trillion (extension/src/worn-look-page.ts).
paintWithWornLook();
const host = document.body.appendChild(document.createElement('main'));
createRoot(host).render(<SignedIn />);
