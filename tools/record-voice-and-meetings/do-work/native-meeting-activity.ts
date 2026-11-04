import { createMeetingApplicationRecordingInvocation, type MeetingApplicationRecordingInvocation } from './meeting-application-recording';

export type MeetingActivityApp = { id: string; label: string; active: boolean };
export type MeetingActivityState = {
  status: 'unavailable' | 'inactive' | 'observing' | 'inspected';
  apps: MeetingActivityApp[];
};
type NativeProcess = { process_id: number; bundle_id: string; name: string; is_running_input: boolean; episode_id: string };
type Command = { command: 'subscribe' | 'unsubscribe' | 'inspect'; document_id: string; session_id: string };
const validText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.trim() === value && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const processKey = (row: NativeProcess) => JSON.stringify([row.process_id, row.bundle_id, row.episode_id]);

/** The native protocol owns observations; callers supply their actual recording policy and screen adapter. */
export function createNativeMeetingActivityOwner({ post, onChange, onInputStarted }: {
  post: (command: Command) => void;
  onChange: (state: MeetingActivityState) => void;
  onInputStarted: (invocation: MeetingApplicationRecordingInvocation) => void;
}) {
  let documentId: string | null = null, sessionId = crypto.randomUUID();
  let observing = false, enabled = false, configured = false;
  let state: MeetingActivityState = { status: 'unavailable', apps: [] };
  let active = new Set<string>();
  const catalog = new Map<string, MeetingActivityApp>();
  const publish = (status: MeetingActivityState['status']) => {
    state = { status, apps: [...catalog.values()].sort((a, b) => a.label.localeCompare(b.label)) };
    onChange(state);
  };
  const clearActivity = (status: MeetingActivityState['status']) => {
    active.clear();
    for (const [id, app] of catalog) catalog.set(id, { ...app, active: false });
    publish(status);
  };
  const send = (command: Command['command']) => {
    if (documentId) post({ command, document_id: documentId, session_id: sessionId });
  };
  const begin = () => {
    if (!configured || !documentId) return;
    observing = enabled;
    send(enabled ? 'subscribe' : 'inspect');
  };
  return {
    getState: () => state,
    configure(nextEnabled: boolean) {
      if (configured && enabled === nextEnabled) return;
      if (observing) send('unsubscribe');
      configured = true; enabled = nextEnabled; observing = false;
      sessionId = crypto.randomUUID(); active.clear(); begin();
    },
    inspect: () => send('inspect'),
    receive(value: unknown) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const message = value as Record<string, unknown>;
      if (message.event === 'ready' && validText(message.document_id)) {
        if (documentId !== message.document_id) {
          documentId = message.document_id; sessionId = crypto.randomUUID();
          active.clear(); catalog.clear(); observing = false; publish('inactive'); begin();
        }
        return;
      }
      if (message.document_id !== documentId || message.session_id !== sessionId) return;
      if (message.event === 'error') { observing = false; clearActivity('unavailable'); return; }
      if (message.event === 'unsubscribed') return;
      if (message.event !== 'snapshot') return;
      if (!['observing', 'inspected'].includes(String(message.status)) || !Array.isArray(message.processes)
        || message.processes.length > 512 || !message.processes.every(row => row && typeof row === 'object'
          && Number.isSafeInteger(row.process_id) && row.process_id > 0
          && validText(row.bundle_id) && validText(row.name) && validText(row.episode_id) && row.is_running_input === true)) {
        clearActivity('unavailable'); return;
      }
      const rows = message.processes as NativeProcess[];
      const keys = rows.map(processKey);
      if (new Set(keys).size !== keys.length) { clearActivity('unavailable'); return; }
      const previous = active;
      active = new Set(rows.filter(row => row.is_running_input).map(processKey));
      for (const [id, app] of catalog) catalog.set(id, { ...app, active: false });
      for (const row of rows) catalog.set(row.bundle_id, { id: row.bundle_id, label: row.name,
        active: row.is_running_input || catalog.get(row.bundle_id)?.active === true });
      for (const [id, app] of catalog) if (catalog.size > 512 && !app.active) catalog.delete(id);
      publish(message.status as MeetingActivityState['status']);
      // Inspect/start snapshots establish a baseline. Neither a cold restored page nor
      // a changed setting replays an already-running input as a fresh meeting action.
      if (!enabled || !observing || !['input-transition', 'process-list'].includes(String(message.reason))) return;
      for (const row of rows) {
        const key = processKey(row);
        if (!row.is_running_input || previous.has(key)) continue;
        const capturedDocument = documentId, capturedSession = sessionId;
        onInputStarted(createMeetingApplicationRecordingInvocation({
          appId: row.bundle_id, appName: row.name, processId: row.process_id,
          nativeDocumentId: capturedDocument!, nativeSessionId: capturedSession, nativeEpisodeId: row.episode_id,
        }, () => enabled && observing && documentId === capturedDocument && sessionId === capturedSession && active.has(key)));
      }
    },
    pause() {
      if (observing) send('unsubscribe');
      observing = false; enabled = false; configured = false; sessionId = crypto.randomUUID(); clearActivity('inactive');
    },
  };
}

let state: MeetingActivityState = { status: 'unavailable', apps: [] };
const subscribers = new Set<() => void>();
let inputStarted: ((value: MeetingApplicationRecordingInvocation) => void) | null = null;
const host = () => (window as Window & { webkit?: { messageHandlers?: { trillionMeetingActivity?: { postMessage(value: Command): void } } } })
  .webkit?.messageHandlers?.trillionMeetingActivity;
const nativeOwner = createNativeMeetingActivityOwner({
  post: command => host()?.postMessage(command),
  onChange: value => { state = value; for (const subscriber of subscribers) subscriber(); },
  onInputStarted: value => inputStarted?.(value),
});
// Listen before workspace reads finish; WKWebView's ready event may precede them.
if (typeof window !== 'undefined') window.addEventListener('trillion-native-meeting-activity', event => {
  if (host()) nativeOwner.receive((event as CustomEvent).detail);
});
export const readMeetingActivity = () => state;
export function subscribeMeetingActivity(listener: () => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; }
export function configureMeetingActivity(enabled: boolean, onInputStarted: (value: MeetingApplicationRecordingInvocation) => void) {
  // A late-loaded workspace can miss the document-start ready event. Read the
  // native-issued property, never an app-authored session/document identifier.
  if (host()) nativeOwner.receive({ event: 'ready', document_id:
    (window as Window & { __trillionMeetingActivityDocumentID?: string }).__trillionMeetingActivityDocumentID });
  inputStarted = onInputStarted; nativeOwner.configure(enabled);
}
export const pauseMeetingActivity = () => { inputStarted = null; nativeOwner.pause(); };
