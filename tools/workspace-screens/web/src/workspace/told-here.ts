// src/workspace/told-here.ts
//
// PURPOSE
//   Puts what Trillion told the person "In Trillion" (tool:tell-the-person, GET /work/api/tell/notices) into the page's
//   one notification center, so the bell, its panel and the Notifications screen show it beside every other
//   notification. The person's store is the truth: each notice goes in with its own id, its time and its read mark,
//   kept (the panel cannot remove it), and marking it read or unread writes the store (POST /work/api/tell/notices/read).
//   Work still going on (tool:report-progress, src/tell-the-person.mjs report) goes in as a running card whose progress
//   moves each time its store changes, and settles when the work ends.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every row is one the store answered; nothing here names a kind of news or a kind of work.
//   2. The list read when the page opens goes in quietly; a notice that arrives later, unread, shows a card.
//   3. Open goes to the notice's own address (src/workspace/open-screen.ts openAddress), as a window over the work, or
//      the page there when no screen does.
//   4. The list is read again whenever the person's store changes (store-changes.ts), and on the narrow change of its own
//      read (/work/api/tell/notices), which an AI reply's notice is written under with no revision.
//   5. Progress words come from the counts the store kept: counts in bytes read as sizes (formatBytes), any other unit
//      as "done of total unit", and a report's own label wins.
//   6. A notice's own buttons are the ones the store answers with it (src/tell-the-person.mjs: what running work offers,
//      such as Pause or Stop, then its kind's own, such as Reply with its field): pressing one only asks the store
//      (POST /work/api/tell/notices/act, with the person's words for a reply), which does it or sends it to whatever
//      reported the work; what it says back is told, and where it says to go opens. Open is the whole row's press.
import { ensureNotificationHost, notify } from '../../parts/ui/show/coss/notifications';
import { formatBytes, type NotificationProgress } from '../../parts/ui/show/notifications/notification-center';
import { postJson, readJson } from './api';
import { sendQuietly } from './quiet-writes';
import { openAddress } from './open-screen';
import { onStoreChange } from './store-changes';
import storeChangeReads from './store-change-reads.json' with { type: 'json' };

type Progress = { done?: number; total?: number; unit?: string; label?: string };
type ToldAction = { id: string; label: string; input?: { placeholder?: string; button?: string }; opens?: boolean };
type Told = { id: string; kind: string; title: string; body: string; open: string; at: string; read: boolean; state?: string; source?: string; progress?: Progress; chips?: { text: string; tone?: string }[]; preview_identity?: string; actions?: ToldAction[] };

const API = storeChangeReads.notices;
// Open shows the screen as a window over the person's work, so the work it came from stays where it was.
const OVER_THE_WORK = { layer: 'overlay', size: { width: 720, height: 560 } } as const;
let shown = new Set<string>();
const pendingReplies = new Map<string, { text: string; submission_id: string }>();
let first = true;
const posters = new Map<string, Promise<string | null>>();

function open(address: string) {
  if (!openAddress(address, OVER_THE_WORK)) location.assign(new URL(address, location.origin).href);
}

const counted = (value: number, unit?: string) => (unit === 'bytes' ? formatBytes(value) : value.toLocaleString());
function posterFor(identity: string): Promise<string | null> {
  let pending = posters.get(identity);
  if (!pending) {
    // The file owner returns a kept still or makes one on demand. A notice can
    // arrive before any screen has asked for its video's preview. The preview
    // makers load with the first notice that shows a file, not with the page.
    pending = import('./made-previews').then(({ previewStore }) => previewStore.requestMissingPreviews?.([identity])
      .then(results => results[identity]) ?? previewStore.read(identity))
      .then(made => typeof made?.poster === 'string' ? made.poster : null)
      .then(picture => { if (!picture) posters.delete(identity); return picture; })
      .catch(() => { posters.delete(identity); return null; });
    posters.set(identity, pending);
  }
  return pending;
}
/** How far a report's work has got, in the center's shape: a fraction (or null when only words are known) and a line. */
export function progressOf(progress: Progress | undefined): NotificationProgress | null {
  if (!progress) return null;
  const { done, total, unit, label } = progress;
  const known = typeof done === 'number' && typeof total === 'number' && total > 0;
  const words = label ?? (known ? `${counted(done, unit)} of ${counted(total, unit)}${unit && unit !== 'bytes' ? ` ${unit}` : ''}` : undefined);
  return { value: known ? Math.min(1, done / total) : null, ...(words ? { label: words } : {}) };
}

const read = () => { void readAgain().catch(() => {}); };

/** One of a notice's own buttons pressed (with the person's words for a reply): the store does it; what it says back
 *  is told, and where it says to go opens. A refusal is thrown on, so the button shows it failed. */
async function act(item: Told, action: ToldAction, text?: string): Promise<void> {
  const pendingKey = `${item.id}:${item.at}:${action.id}`;
  const storageKey = `trillion.notice.reply.${pendingKey}`;
  const prior = text ? pendingReplies.get(pendingKey) : undefined;
  let savedID: string | null = null;
  try { savedID = sessionStorage.getItem(storageKey); } catch { /* Storage may be unavailable; this page still remembers retries. */ }
  const submission_id = text ? (prior ? (prior.text === text ? prior.submission_id : crypto.randomUUID().toLowerCase()) : savedID ?? crypto.randomUUID().toLowerCase()) : undefined;
  if (text && submission_id) {
    pendingReplies.set(pendingKey, { text, submission_id });
    try { sessionStorage.setItem(storageKey, submission_id); } catch { /* Keep the in-page retry ID. */ }
  }
  try {
    const answer = await postJson<{ said?: string; open?: string }>(`${API}/act`, { id: item.id, action: action.id, ...(text ? { text } : {}), ...(submission_id ? { submission_id } : {}) });
    if (text && pendingReplies.get(pendingKey)?.submission_id === submission_id) {
      pendingReplies.delete(pendingKey);
      try { sessionStorage.removeItem(storageKey); } catch { /* The page state is already cleared. */ }
    }
    if (answer?.said) notify(answer.said, { kind: 'done' });
    if (answer?.open) open(answer.open);
  } catch (error) {
    if ((error as { status?: number })?.status === 400 && pendingReplies.get(pendingKey)?.submission_id === submission_id) {
      pendingReplies.delete(pendingKey);
      try { sessionStorage.removeItem(storageKey); } catch { /* A new press can still create a new ID. */ }
    }
    throw error;
  } finally { read(); }
}

async function readAgain(): Promise<void> {
  const { notices } = await readJson<{ notices: Told[] }>(API);
  const center = ensureNotificationHost();
  for (const item of [...notices].reverse()) {
    const running = item.state === 'running';
    center.emit(item.title, {
      id: item.id, kind: item.kind, at: Date.parse(item.at), read: item.read, kept: true,
      toast: !first && !item.read && !shown.has(item.id),
      running, progress: running ? progressOf(item.progress) ?? { value: null } : null,
      // A notice that sends chips is drawn with them (12 of 40 files, 3 heard) instead of a longer sentence.
      ...(item.chips?.length ? { chips: item.chips } : {}),
      ...(item.body || item.source ? { detail: [item.body, item.source].filter(Boolean).join(' · ') } : {}),
      // The notice's own buttons (invariant 6), Open as the whole row's press.
      actions: [
        ...(item.actions ?? []).filter(action => !action.opens).map(action => ({
          id: action.id, label: action.label, dismisses: false, ...(action.input ? { input: action.input } : {}),
          onAction: (text?: string) => act(item, action, text),
        })),
        { id: 'open', label: 'Open', press: true, dismisses: true, onAction: () => open(item.open) },
      ],
      onRead: read => { sendQuietly({ key: `told-read:${item.id}`, path: `${API}/read`, body: { read, ids: [item.id] }, together: 'ids' }); },
    });
    // Keep the notice immediate; its already-saved poster arrives when the
    // namespace result owner answers, without decoding the source video here.
    if (item.preview_identity) void posterFor(item.preview_identity).then(picture => {
      if (picture && center.get(item.id)) center.emit(item.title, { id: item.id, preview: picture });
    });
  }
  shown = new Set(notices.map(item => item.id));
  first = false;
}

/** Starts keeping the center in line with what Trillion told the person here; answers the function that stops it. */
export function keepToldHere(): () => void {
  read();
  // A notice that an AI replied is told on its own narrow change, with no revision (store-change-reads.json `notices`).
  return onStoreChange(read, [API]);
}
