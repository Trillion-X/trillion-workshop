// tools/calendar/do-work/read-google-calendar-events.mjs
// The command of tool:read-google-calendar-events. Input (stdin, JSON):
//   { range_start, range_end, calendar_id?, max_results?, connection_ref? }
// The person's own Google OAuth client id, client secret and refresh token arrive on private descriptors 3, 4 and 5 under
// the held-value names the row names. They are read here, used for one token request and one events request, and never
// returned, printed or put in an error: anything Google says is shown with those three values taken out.
import { readFileSync } from 'node:fs';
import { refuse, runCommand } from './command.mjs';
import { TOKEN_URL, eventsUrl, readEvents, requestProblems } from '../read-data/google-events.mjs';

const HELD = ['Google client id', 'Google client secret', 'Google refresh token'];
const jsonOf = async response => { try { return await response.json(); } catch { return {}; } };

export function heldCredentials(read = fd => readFileSync(fd, 'utf8')) {
  return [3, 4, 5].map((fd, index) => {
    let value = '';
    try { value = read(fd).trim(); } catch { value = ''; }
    if (!value) throw new Error(`No ${HELD[index]} arrived: put it in your held values under the name this tool asks for.`);
    return value;
  });
}

export async function readGoogleCalendarEvents(input, { credentials = heldCredentials(), fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  refuse(requestProblems(input));
  const [clientId, clientSecret, refreshToken] = credentials;
  const clean = message => credentials.reduce((text, secret) => text.split(secret).join('[held value]'), String(message ?? '')).slice(0, 300);
  const token = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const granted = await jsonOf(token);
  if (!token.ok || typeof granted.access_token !== 'string') {
    throw new Error(`Google did not give access: ${clean(granted.error_description ?? granted.error ?? token.status)}.`);
  }
  const response = await fetchImpl(eventsUrl(input), {
    headers: { accept: 'application/json', authorization: `Bearer ${granted.access_token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const reply = await jsonOf(response);
  const read = readEvents(reply, { status: response.status, calendarId: input.calendar_id ?? 'primary', connectionRef: input.connection_ref });
  return {
    blocks: read.blocks,
    issues: read.issues.map(issue => ({ ...issue, detail: issue.detail === undefined ? undefined : clean(issue.detail) })),
    range_start: new Date(input.range_start).toISOString(),
    range_end: new Date(input.range_end).toISOString(),
    source: { provider: 'google-calendar', http_status: response.status, event_count: read.blocks.length },
  };
}

runCommand(import.meta.url, input => readGoogleCalendarEvents(input));
