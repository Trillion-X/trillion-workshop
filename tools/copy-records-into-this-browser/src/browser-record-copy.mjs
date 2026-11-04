import { keptAnswerStore } from '../../refuse-a-change-made-from-an-open-page/src/kept-answers.mjs';
import { DEVICE_ACCOUNT_HEADER } from '../../keep-my-records-on-this-device/do-work/account-copy.mjs';
import { FrameError, expandFrame, isFrame, maxFrameBytes } from '../../keep-my-records-on-this-device/do-work/frame-compression.mjs';
import recordCopySettings from './record-copies.json' with { type: 'json' };

// Check before reading uploads or asking the person's store. Cookies may have changed since this page opened.
export function browserRecordCopyRefusal(request, session) {
  if (!session) return Response.json({ error: 'Sign in again.' }, { status: 401 });
  if (session.look_only) return Response.json({ error: 'Not allowed.' }, { status: 403 });
  if (request.headers.get(DEVICE_ACCOUNT_HEADER) !== keptAnswerStore(session.userId)) {
    return Response.json({ error: 'This device copy belongs to another sign-in. Open your workspace again.' }, { status: 409 });
  }
  return null;
}

// The text of an upload: a frame compressed against the settle sample is expanded to the size it declared (and no more
// than a request may carry, in UTF-8 bytes), anything else is read as it came. Answers a Response when the frame is refused.
export async function browserRecordCopyBody(request) {
  if (!isFrame(request.headers)) return { text: await request.text() };
  const declared = request.headers.get('content-length');
  if (!/^\d{1,12}$/.test(declared ?? '') || Number(declared) > maxFrameBytes) {
    return { refusal: Response.json({ error: `A compressed frame declares its length and is at most ${maxFrameBytes} bytes.` }, { status: 413 }) };
  }
  try {
    return { text: expandFrame(new Uint8Array(await request.arrayBuffer()), request.headers, { max_expanded_bytes: recordCopySettings.most_chars_sent * 4 }) };
  } catch (error) {
    if (!(error instanceof FrameError)) throw error;
    return { refusal: Response.json({ error: error.message }, { status: error.status }) };
  }
}
