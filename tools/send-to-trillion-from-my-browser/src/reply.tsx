// extension/src/reply.tsx
//
// PURPOSE
//   The reply window: a browser notification has no text field, so pressing a notice's action that asks for words
//   (its `input`) opens this small window with the notice and a box for the answer. Send hands the words to the
//   background worker (src/notice-worker.mjs), which posts them with the action's id to the account, and the window
//   shows what the account said and closes.
//
//   Laid out as a quick reply is (21st.dev Prompt Input 28187 and 31882, Mobbin Google Gemini 057d8ba8 and AirOps
//   790fb029, the notification pair of the visual-hierarchy sheets): what is being answered on top (the Trillion mark,
//   the notice's title, its line muted under it), then one box whose words fill it and grow, with a quiet Cancel and
//   Send at the end of the row under the words. The window opens at settings.json notices.reply_window and then
//   follows its content's height, so a longer reply grows the window instead of scrolling inside it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The box's placeholder and button come from the action itself (input.placeholder, input.button); every other
//      word comes from extension/words.json.
//   2. Nothing is said to be sent until the account answered: Send shows sending, done or try again in itself.
//   3. Enter sends, Shift+Enter is a new line, Escape and Cancel close the window.
//   4. The same shared Textarea, Button and Container the popup and the message box are drawn with; the look is the
//      Trillion apps' theme row.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from 'trillion-workshop/tools/ui/show/button/index.ts';
import { Container } from 'trillion-workshop/tools/ui/show/container/index.ts';
import { ImageBlock } from 'trillion-workshop/tools/ui/show/image-block/ImageBlock.tsx';
import { NamedIcon } from 'trillion-workshop/tools/ui/show/icon/index.ts';
import { Text } from 'trillion-workshop/tools/ui/show/text/index.ts';
import { Textarea } from 'trillion-workshop/tools/ui/show/input/index.ts';
import { paintWithWornLook } from './worn-look-page';
import words from '../words.json' with { type: 'json' };
import settings from '../settings.json' with { type: 'json' };
import mountFeel from 'trillion-workshop/tools/feel/show/mount-feel.ts';
import {currentExtensionFeel} from './current-feel.mjs';

type Action = { id: string; label: string; input?: { placeholder?: string; button?: string } };
type Notice = { id: string; title: string; body?: string; actions?: Action[] };
const said = words.notices;
const asked = new URL(location.href).searchParams;

// The window follows what it shows: its height is the content's plus the window's own frame, never past the
// screen's free height. Nothing is fitted before the notice is drawn.
function fitWindowTo(content: HTMLElement) {
  const fit = () => chrome.windows.getCurrent().then(current => {
    const shown = Math.ceil(content.getBoundingClientRect().height);
    if (current.id === undefined || current.height === undefined || !shown) return;
    const frame = Math.max(0, current.height - window.innerHeight);
    const height = Math.min(shown + frame, screen.availHeight);
    if (height !== current.height) return chrome.windows.update(current.id, { height });
  });
  new ResizeObserver(() => { fit().catch(() => {}); }).observe(content);
}

function Reply() {
  const [notice, setNotice] = React.useState<Notice | null | undefined>(undefined);
  const [text, setText] = React.useState('');
  const [state, setState] = React.useState<{ said: string | null; problem: string | null }>({ said: null, problem: null });
  const sendButton = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    const key = `notice:${asked.get('id')}`;
    chrome.storage.session.get(key).then(stored => setNotice(stored[key] ?? null));
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') window.close(); };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, []);
  const action = notice?.actions?.find(candidate => candidate.id === asked.get('action')) ?? null;

  // The press's promise is the button's own pending, done or try-again state (parts/ui Button press work): a refusal
  // rejects it, so the button never says Done for words the account did not take.
  async function send() {
    if (!notice || !action || !text.trim()) return;
    setState({ said: null, problem: null });
    const answer = await chrome.runtime.sendMessage({ notice_act: { id: notice.id, action: action.id, text: text.trim() } });
    if (answer?.error) { setState({ said: null, problem: answer.error }); throw new Error(answer.error); }
    setState({ said: answer?.said || said.done, problem: null });
    setTimeout(() => window.close(), 1800);
  }

  if (notice === undefined) return null;
  if (!notice || !action) {
    return (
      <Container layout="vertical" gap="md" padding="lg" width="full">
        <Text variant="body">{said.gone}</Text>
        <Button variant="outline" onClick={() => chrome.tabs.create({ url: settings.origin })}>{said.open_trillion}</Button>
      </Container>
    );
  }
  if (state.said) {
    return (
      <Container layout="vertical" gap="sm" padding="xl" width="full" alignItems="center">
        <NamedIcon name="CircleCheck" size="lg" color="success" aria-hidden="true" />
        <Text variant="body" align="center">{state.said}</Text>
      </Container>
    );
  }
  return (
    <Container layout="vertical" gap="md" padding="lg" width="full">
      <Container layout="horizontal" gap="sm" alignItems="start" width="full">
        <ImageBlock src={settings.notices.icon} alt="" rounded="md" className="h-8 w-8 shrink-0" />
        <Container layout="vertical" gap="xs" flex={1}>
          <Text variant="body" weight="medium">{notice.title}</Text>
          {notice.body ? <Text variant="body-xs" color="muted">{notice.body}</Text> : null}
        </Container>
      </Container>
      <Container layout="vertical" gap="xs" width="full" rounded="lg" border="all" background="primary" padding="xs">
        <Textarea aria-label={said.reply_label} placeholder={action.input?.placeholder ?? action.label} value={text} rows={3}
          autoGrow maxHeight={320} autoFocus borderless
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            sendButton.current?.click();
          }} />
        <Container layout="horizontal" gap="xs" alignItems="center" justifyContent="end" width="full">
          <Button variant="ghost" size="sm" onClick={() => window.close()}>{said.cancel}</Button>
          <Button ref={sendButton} variant="primary" size="sm" onClick={send} disabled={!text.trim()} pendingLabel={said.sending} errorLabel={said.try_again}>
            {action.input?.button ?? said.send}
          </Button>
        </Container>
      </Container>
      {state.problem ? <Text variant="caption" color="error" role="alert">{state.problem}</Text> : null}
    </Container>
  );
}

// The look the person wears in Trillion (extension/src/worn-look-page.ts).
paintWithWornLook();
const host = document.body.appendChild(document.createElement('main'));
fitWindowTo(host);
// What happens here feels the way it does in Trillion: the same rows and players (parts/feel), sound and motion in
// this window (a Chrome window has no touch to play).
const stopFeel=mountFeel({props:currentExtensionFeel()});
window.addEventListener('pagehide',stopFeel,{once:true});
createRoot(host).render(<Reply />);
