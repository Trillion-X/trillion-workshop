// Give Trillion a narrow, authenticated way to inspect and continue the person's existing Claude Cloud sessions.
// The Claude sign-in stays on the computer that owns it. Never accept or return a bearer token here.
import { dispatchCloudSessions } from './read-cloud-sessions.mjs';

const CONFIG = /^[A-Za-z0-9._-]+$/;
const SESSION = /^[A-Za-z0-9_-]{1,200}$/;
const REPOSITORIES = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:,[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)*$/;

export function validateClaudeCloudRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The request must be an object.');
  const action = input.action;
  if (!['accounts', 'list', 'read', 'resume', 'start'].includes(action)) throw new Error('Choose accounts, list, read, resume or start.');
  if (action !== 'accounts' && (typeof input.config_folder !== 'string' || !CONFIG.test(input.config_folder)
    || ['.', '..'].includes(input.config_folder))) throw new Error('Name one Claude config folder directly below the computer account home.');
  if ((action === 'read' || action === 'resume') && (typeof input.session_id !== 'string'
    || !SESSION.test(input.session_id))) throw new Error('Name the exact Claude Cloud session ID.');
  if (action === 'list' && input.limit !== undefined && (!Number.isSafeInteger(input.limit)
    || input.limit < 1 || input.limit > 200)) throw new Error('The session limit must be from 1 to 200.');
  if (action === 'start' && (typeof input.repositories !== 'string'
    || !REPOSITORIES.test(input.repositories) || typeof input.title !== 'string' || !input.title.trim()
    || input.title.length > 200)) throw new Error('Starting needs an exact owner/repo list and a short title.');
  if ((action === 'resume' || action === 'start') && (typeof input.message !== 'string'
    || !input.message.trim() || input.message.length > 20000)) throw new Error('Send a nonempty continuation brief of at most 20,000 characters.');
  return action;
}

/** One operation and one session at a time. Never starts a replacement when resuming is requested. */
export async function manageClaudeCloudSessions(input, { dispatch = dispatchCloudSessions } = {}) {
  const action = validateClaudeCloudRequest(input);
  const folder = input.config_folder;
  const args = action === 'accounts' ? ['accounts']
    : action === 'list' ? ['list-json', folder, String(input.limit ?? 100)]
    : action === 'read' ? ['read-one', folder, input.session_id]
    : action === 'resume' ? ['send', folder, input.session_id, '-']
    : ['start', folder, input.repositories, input.title, '-'];
  if (input.dry_run === true && (action === 'resume' || action === 'start')) {
    return { action, dry_run: true, config_folder: folder,
      session_id: action === 'resume' ? input.session_id : null,
      repositories: action === 'start' ? input.repositories.split(',') : null, message_chars: input.message.trim().length };
  }
  const printed = [];
  const answer = await dispatch(args, {
    print: line => printed.push(line),
    resolveBrief: async () => input.message.trim(),
  });
  if (answer !== undefined) return answer;
  const last = printed.at(-1);
  if (!last) throw new Error('Claude Cloud accepted no verifiable answer. Check the exact session before retrying a write.');
  try { return JSON.parse(last); } catch { throw new Error('Claude Cloud returned a non-JSON answer; do not retry a write without checking its state.'); }
}
