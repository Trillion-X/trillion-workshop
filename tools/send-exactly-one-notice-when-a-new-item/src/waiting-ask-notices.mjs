import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/waiting-on-you.json' with { type: 'json' };

const ownPath = value => /^\/(?![/\\])/.test(value);
const webAddress = value => /^https:\/\//i.test(value);

// A new Waiting row gets one notice. Editing it, filing it again, or marking it Done does not resend it.
export function noticesForNewWaitingRows({ before = new Map(), kept = [] } = {}) {
  return kept.flatMap(row => {
    const values = row?.values ?? {};
    if (!row?.id || !values.what || values.status === 'Done' || before.has(row.id)) return [];
    const where = typeof values.where === 'string' ? values.where.trim() : '';
    const open = ownPath(where) || webAddress(where) ? where
      : `/lists/${encodeURIComponent(settings.list.id)}/${encodeURIComponent(row.id)}`;
    return [{ key: `${settings.new_ask_notice.key_prefix}:${row.id}`, kind: settings.new_ask_notice.kind,
      title: values.what, body: typeof values.why === 'string' ? values.why : '', open,
      refs: { card: `asks:${row.id}`, open } }];
  });
}
