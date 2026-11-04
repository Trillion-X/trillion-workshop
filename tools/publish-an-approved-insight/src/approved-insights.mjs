import { failureOf } from '../../shared-code/src/failure.mjs';

// One checkable public insight: exact approved words, the way they were reached,
// and the public source passages a reader can inspect for themselves.
const words = (value, maximum) => {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length > maximum) throw new Error(`Keep this field within ${maximum} characters.`);
  return result;
};

export function checkableInsight(input) {
  const title = words(input?.title, 140);
  const insight = words(input?.insight, 4000);
  const method = words(input?.method, 2000);
  const data = words(input?.data, 2000);
  const trace = words(input?.trace, 2000);
  if (!title || !insight || !method || !data || !trace) throw new Error('Give the title, insight, method, data and traceable chain.');
  if (!Array.isArray(input?.sources) || !input.sources.length || input.sources.length > 20) throw new Error('Give 1 to 20 public sources with an exact quote from each.');
  const sources = input.sources.map((item, index) => {
    const url = words(item?.url, 2000);
    const quote = words(item?.quote, 2000);
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error(`Source ${index + 1} needs a public HTTPS address.`); }
    if (parsed.protocol !== 'https:' || !parsed.hostname || !quote || parsed.username || parsed.password
      || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i.test(parsed.hostname)) throw new Error(`Source ${index + 1} needs a public HTTPS address and exact quote.`);
    return { url: parsed.href, quote };
  });
  return { kind: 'insight', title, insight, method, data, trace, sources,
    summary: insight.slice(0, 220) };
}

// This exact text must be present in a message from the person in their own account.
// A caller's assertion that they approved it does not publish anything.
export function insightApprovalText(insight) {
  return ['I approve publishing this insight publicly:', insight.title, insight.insight,
    `How it was reached: ${insight.method}`, `Data checked: ${insight.data}`,
    `Traceable chain: ${insight.trace}`, 'Sources:',
    ...insight.sources.map(source => `${source.url}\n“${source.quote}”`)].join('\n\n');
}

export function personApprovedInsight(message, insight) {
  return message?.speaker === 'person' && typeof message.text === 'string'
    && message.text.includes(insightApprovalText(insight));
}

// The account's published insights (public-insights:request in src/native-owner-routes.json): list them, publish one
// the person approved in their own words, take one down. The public copy is the Pool's story shelf (pool()), reached
// through the effect owner the caller supplies. A publication is noted under its approval before the Pool is asked, so
// a retry after an uncertain reply publishes the same id and words rather than a second copy.
//   settings(prefix)  the account's settings under a prefix, [{ name, value }]
//   fact(key) / setFact(key, value)  one account setting
//   read(id)          one kept record (the approval message)
//   pool()            publishStory(id, story), unpublishStory(id)
//   mintId()          a new public story address
//   command()         the command that publishes or takes down, kept with what it finished (publishOutcome)
//   story(id)         the Pool's public story at that address, read only, or null
export function insightOwner({ settings, fact, setFact, read, pool, mintId, command = () => null, story: publicStory = async () => null, now = () => new Date() }) {
  const asking = insight => ({ published: false, approval_text: insightApprovalText(insight),
    said: 'Show these exact words to the person. Publish only after they approve them in a message.' });
  return {
    list: () => ({ insights: settings('public-insight:').filter(({ value }) => value?.published)
      .map(({ value }) => ({ id: value.id, title: value.title, url: `/stories/${value.id}`, published_at: value.published_at })) }),
    async publish(input) {
      const insight = checkableInsight(input);
      if (!input?.approval_message_id) return asking(insight);
      const approval = read(input.approval_message_id);
      if (!personApprovedInsight(approval, insight)) throw new Error('The named person message does not approve these exact words and sources. Nothing was published.');
      const key = `insight-approval:${input.approval_message_id}`;
      const earlier = fact(key);
      if (earlier && JSON.stringify(earlier.insight) !== JSON.stringify(insight)) throw new Error('This approval already names different words. Nothing was published.');
      if (earlier && fact(`public-insight:${earlier.id}`)?.withdrawn) throw new Error('This insight was withdrawn. Nothing was published.');
      if (earlier && !earlier.story) return { published: true, id: earlier.id, url: `/stories/${earlier.id}`, already_published: true };
      const id = earlier?.id ?? mintId();
      const story = earlier?.story ?? { ...insight, approved_at: approval.at, published_on: now().toISOString() };
      if (!earlier) await setFact(key, { id, insight, story });
      await pool().publishStory(id, story);
      await setFact(`public-insight:${id}`, { id, title: insight.title, published: true, published_at: story.published_on });
      await setFact(key, { id, insight, by: command() });
      return { published: true, id, url: `/stories/${id}` };
    },
    async unpublish(id) {
      const owned = fact(`public-insight:${id}`);
      if (!owned) throw new Error('This account has no insight at that address.');
      if (owned.withdrawn) return { unpublished: true, id, already_unpublished: true };
      await pool().unpublishStory(id);
      await setFact(`public-insight:${id}`, { ...owned, published: false, withdrawn: true, withdrawn_at: now().toISOString(), withdrawn_by: command() });
      return { unpublished: true, id };
    },

    // A lost publish or take-down, read from what it kept and the Pool's public copy, never sent again: finished by
    // this command answers as it did; finished by another as a repeat answers; begun but not finished is unknown;
    // nothing kept (or a refusal) is aborted.
    async publishOutcome(input) {
      let insight;
      try { insight = checkableInsight(input); } catch { return { state: 'aborted' }; }
      if (!input?.approval_message_id) return { state: 'committed', result: asking(insight) };
      const earlier = fact(`insight-approval:${input.approval_message_id}`);
      if (!earlier || JSON.stringify(earlier.insight) !== JSON.stringify(insight)) return { state: 'aborted' };
      if (earlier.story) return { state: 'unknown' };
      const reply = { published: true, id: earlier.id, url: `/stories/${earlier.id}` };
      if (earlier.by === command()) return { state: 'committed', result: reply };
      return fact(`public-insight:${earlier.id}`)?.withdrawn ? { state: 'aborted' } : { state: 'committed', result: { ...reply, already_published: true } };
    },
    async unpublishOutcome(id) {
      const owned = fact(`public-insight:${id}`);
      if (!owned) return { state: 'aborted' };
      if (owned.withdrawn) return { state: 'committed', result: owned.withdrawn_by === command() ? { unpublished: true, id } : { unpublished: true, id, already_unpublished: true } };
      return (await publicStory(id)) ? { state: 'aborted' } : { state: 'unknown' };
    },
  };
}

// The route's own readback: a lost POST or DELETE decided by its owner's outcome (route kind `own`).
export async function insightRequestOutcome(owner, { method, path, body } = {}) {
  const address = String(path ?? '').match(/^\/public-insights(?:\/([0-9a-f]{20}))?$/);
  if (address && method === 'POST' && !address[1]) return owner.publishOutcome(body ?? {});
  if (address && method === 'DELETE' && address[1]) return owner.unpublishOutcome(address[1]);
  return { state: 'aborted' };
}

export async function handleInsightRequest(owner, request) {
  const address = new URL(request.url).pathname.match(/^\/public-insights(?:\/([0-9a-f]{20}))?$/);
  try {
    if (address && request.method === 'GET' && !address[1]) return Response.json(owner.list());
    if (address && request.method === 'POST' && !address[1]) return Response.json(await owner.publish(await request.json()));
    if (address && request.method === 'DELETE' && address[1]) return Response.json(await owner.unpublish(address[1]));
    return Response.json({ error: 'This insight action is not available.' }, { status: 405 });
  } catch (error) {
    // Busy, interrupted or out-of-budget is the shared HTTP failure owner's to answer, never a refusal here.
    if (failureOf(error).tries_again_later) throw error;
    return Response.json({ error: error.message }, { status: 400 });
  }
}
