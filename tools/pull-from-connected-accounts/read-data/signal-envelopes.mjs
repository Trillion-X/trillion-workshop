// tools/pull-from-connected-accounts/read-data/signal-envelopes.mjs
//
// What signal-cli prints, turned into what the `signal` pull takes. `signal-cli -o json receive` prints one JSON line per
// envelope ({ envelope: { sourceUuid, sourceName, timestamp, dataMessage?, editMessage?, syncMessage?, callMessage?, ... },
// account }); the pull takes `conversations` in the shape README.md "What the Signal client must hand in" lists, and
// nothing else. The old connector asked signal-cli for a listConversations command that does not exist; envelopes are
// what the client gives, so this folds them.
//
// - A conversation is a group (`group:<groupId>`, titled by the group's name when an envelope carries it) or the other
//   person (their account's service id, titled by the name their messages came with).
// - A message's identity is its author and its sent time (`<author>:<timestamp>`), as Signal identifies a message, so
//   an edit (`editMessage.targetSentTimestamp`) lands on the message it edits, with `editedTimestamp` the edit's time.
// - The account's own messages sent from another of its devices arrive as `syncMessage.sentMessage`: their author is
//   `self_id`, their conversation the group or the person they were sent to.
// - A call is kept as a message of type `call_started` with no body. Receipts, typing, stories, reactions and
//   anything else are not messages and are counted in `left_out`, never kept; so is a data message that says nothing
//   (a group change, a disappearing-timer change, a profile key).
// - Only service ids (UUIDs) name people: a phone number signal-cli prints beside one is never copied.

const GROUP = 'group:';

/** The JSON lines `signal-cli -o json receive` printed, as envelopes; a line that is not one is counted in `unreadable`. */
export function readEnvelopeLines(text) {
  const envelopes = [];
  let unreadable = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && parsed.envelope && typeof parsed.envelope === 'object') envelopes.push(parsed.envelope);
      else unreadable += 1;
    } catch {
      unreadable += 1;
    }
  }
  return { envelopes, unreadable };
}

const text = value => (typeof value === 'string' && value.length ? value : null);
const time = value => (Number.isSafeInteger(value) && value > 0 ? value : null);

/**
 * Envelopes to `{ conversations, left_out }`: `conversations` exactly in the pull's contract (id, name?, type,
 * messages: [{ id, timestamp, from, body?, editedTimestamp?, type }]), in the order first seen; `left_out` how many
 * envelopes held no message (receipts, typing, stories, reactions, an envelope with no author).
 */
export function envelopesToConversations(envelopes, selfId) {
  const conversations = new Map();
  let leftOut = 0;
  const conversation = (id, type, name) => {
    let held = conversations.get(id);
    if (!held) conversations.set(id, (held = { id, type, messages: new Map() }));
    if (name && !held.name) held.name = name;
    return held;
  };
  const keep = (held, message) => {
    const before = held.messages.get(message.id);
    // Within one receive, a later edit replaces an earlier copy and never the other way round; across pulls the pull's
    // own fold decides (signal.json `conflict`).
    if (!before || (message.editedTimestamp ?? 0) >= (before.editedTimestamp ?? 0)) held.messages.set(message.id, message);
  };
  for (const envelope of envelopes ?? []) {
    const author = text(envelope?.sourceUuid);
    const sent = envelope?.syncMessage?.sentMessage;
    let kept = false;
    if (author && envelope.dataMessage && !envelope.dataMessage.reaction && !envelope.dataMessage.remoteDelete) {
      kept = keepData(author, author, text(envelope.sourceName), envelope.dataMessage, null);
    } else if (author && envelope.editMessage?.dataMessage) {
      kept = keepData(author, author, text(envelope.sourceName), envelope.editMessage.dataMessage,
        { of: time(envelope.editMessage.targetSentTimestamp), at: time(envelope.timestamp) });
    } else if (author && sent && (sent.dataMessage || sent.message !== undefined || sent.editMessage)) {
      // The account's own message, sent from another of its devices: to the group it names, else to the person.
      const data = sent.editMessage?.dataMessage ?? sent.dataMessage ?? sent;
      const edit = sent.editMessage ? { of: time(sent.editMessage.targetSentTimestamp), at: time(sent.timestamp ?? envelope.timestamp) } : null;
      kept = keepData(selfId, text(sent.destinationUuid), null, data, edit);
    } else if (author && envelope.callMessage?.offerMessage) {
      const at = time(envelope.timestamp);
      if (at) {
        keep(conversation(author, 'individual', text(envelope.sourceName)), { id: `${author}:${at}`, timestamp: at, from: author, type: 'call_started' });
        kept = true;
      }
    }
    if (!kept) leftOut += 1;
  }
  return {
    conversations: [...conversations.values()].map(({ messages, ...held }) => ({ ...held, messages: [...messages.values()] })),
    left_out: leftOut,
  };

  // One data message (or an edit of one) by `from`, in its group or else with `other`.
  function keepData(from, other, otherName, data, edit) {
    const group = data.groupInfo ?? data.groupV2 ?? null;
    const groupId = text(group?.groupId);
    const at = edit ? edit.of : time(data.timestamp);
    if (!from || !at || (!groupId && !other)) return false;
    // A group change, a timer change, a profile key or an ended session is not something anyone said.
    const said = text(data.message) || data.attachments?.length || data.sticker || data.sharedContacts?.length || data.contacts?.length || data.pollCreate;
    if (!said) return false;
    const held = groupId ? conversation(`${GROUP}${groupId}`, 'group', text(group.groupName)) : conversation(other, 'individual', otherName);
    const message = { id: `${from}:${at}`, timestamp: at, from, type: 'normal' };
    const body = text(data.message);
    if (body) message.body = body;
    if (edit?.at) message.editedTimestamp = edit.at;
    keep(held, message);
    return true;
  }
}
