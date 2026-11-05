import { titleOf } from '../shared-code/src/work-title.mjs';

// A view of the existing message, arrival and activity records. IDs stay exactly
// as their owners recorded them. A successful tool call is never task completion.
const short = (value, length = 72) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};
const chatId = message => `chat:${JSON.stringify([message.app, message.conversation_id])}`;

export function messageSourceSpan(message, input) {
  if (!message || message.speaker !== 'person') throw new Error('Choose one of your own messages.');
  const { start, end } = input;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > message.text.length) throw new Error('Choose words from this message.');
  const text = message.text.slice(start, end);
  if (!text.trim() || text.length > 2000) throw new Error('Choose between 1 and 2,000 characters from this message.');
  return { message_id: message.id, start, end, text };
}

export function messageTaskGraph(answer) {
  const nodes = [];
  const edges = [];
  const known = new Set();
  const add = node => {
    if (!known.has(node.id)) { known.add(node.id); nodes.push(node); return; }
    const current = nodes.find(one => one.id === node.id);
    if (node.opens) current.opens = node.opens;
    if (current.label === current.id && node.label) current.label = node.label;
    if (!current.body && node.body) current.body = node.body;
    if (current.kind === 'Linked item' && node.kind) current.kind = node.kind;
  };
  const sourceMessages = answer.messages.filter(message => message.speaker !== 'ai');
  for (const message of sourceMessages) {
    add({ id: message.id, label: short(message.text || 'Message with files'), subtitle: message.app, kind: 'Source message', may_branch: message.speaker === 'person', body: message.text, at: message.at, app: message.app });
  }
  const chats = new Map();
  for (const message of answer.messages) {
    if (message.speaker !== 'ai' || !message.conversation_id) continue;
    const id = chatId(message);
    const current = chats.get(id);
    if (!current || message.at > current.at) chats.set(id, message);
  }
  for (const [id, message] of chats) {
    add({ id, label: `${message.app} chat`, kind: 'AI chat', body: message.text, at: message.at, app: message.app });
    for (const person of sourceMessages.filter(one => chatId(one) === id)) {
      edges.push({ id: `${person.id}->${id}`, from: person.id, to: id, activity: 'active' });
    }
  }
  const messagesById = new Map(answer.messages.map(message => [message.id, message]));
  for (const arrival of answer.arrivals) {
    add({ id: arrival.id, label: short(arrival.title || arrival.job), subtitle: `Work from ${arrival.route ?? 'your message'}`, status: 'queued', kind: 'Work sent', body: arrival.job, at: arrival.at ?? '', app: arrival.route ?? '' });
    if (known.has(arrival.message_id)) edges.push({ id: `${arrival.message_id}->${arrival.id}`, from: arrival.message_id, to: arrival.id, activity: 'active' });
    const message = messagesById.get(arrival.message_id);
    if (message?.conversation_id && known.has(chatId(message))) edges.push({ id: `${arrival.id}->${chatId(message)}`, from: arrival.id, to: chatId(message), activity: 'active' });
    for (const file of arrival.files ?? []) {
      if (!file?.id) continue;
      add({ id: file.id, label: file.name || file.id, kind: 'Source file', body: '', at: arrival.at ?? '', app: arrival.route ?? '', opens: { surface: 'trillion.file', input: 'id' } });
      if (known.has(arrival.message_id)) edges.push({ id: `${arrival.message_id}->${file.id}`, from: arrival.message_id, to: file.id, activity: 'idle' });
    }
  }
  for (const request of answer.asked ?? []) {
    add({ id: request.id, label: short(request.context?.words || request.job), kind: 'Follow-up', body: request.context?.words || request.job, at: request.at ?? '', app: 'You', status: 'queued' });
    const source = request.context?.source_id;
    if (known.has(source)) edges.push({ id: `${source}->${request.id}`, from: source, to: request.id, activity: 'active' });
  }
  for (const block of answer.blocks ?? []) {
    const links = [{ source_id: block.source_id, start: block.start, end: block.end }, ...(block.sources ?? [])];
    const spans = links.flatMap(link => {
      const source = messagesById.get(link.source_id);
      if (!source || !Number.isInteger(link.start) || !Number.isInteger(link.end)
        || link.start < 0 || link.end <= link.start || link.end > source.text.length) return [];
      return [{ message_id: source.id, start: link.start, end: link.end, text: source.text.slice(link.start, link.end), task_id: block.id }];
    });
    const firstSource = messagesById.get(spans[0]?.message_id);
    add({ id: block.id, label: short(block.title), kind: 'Block', body: block.title, at: block.updated_at ?? block.at ?? '', app: 'You', status: block.state ?? 'open', ...(Number.isInteger(block.progress) ? { progress: block.progress } : {}), ...(spans.length ? { source_span: spans[0], source_spans: spans, source_message: firstSource?.text } : {}) });
    for (const span of spans) {
      const sourceNode = nodes.find(one => one.id === span.message_id);
      if (sourceNode && !(sourceNode.source_spans ?? []).some(one => one.task_id === block.id && one.start === span.start && one.end === span.end)) (sourceNode.source_spans ??= []).push(span);
    }
    for (const id of new Set(links.map(link => link.source_id))) if (known.has(id)) edges.push({ id: `${id}->${block.id}`, from: id, to: block.id, activity: 'active' });
    if (known.has(block.parent_id)) edges.push({ id: `${block.parent_id}->${block.id}`, from: block.parent_id, to: block.id, activity: 'active' });
  }
  for (const task of answer.handoffs ?? []) {
    const result = typeof task.result === 'string' ? task.result : task.result ? JSON.stringify(task.result, null, 2) : '';
    const span = task.input?.source_span;
    const source = span && messagesById.get(span.message_id);
    add({ id: task.handoff_id, label: titleOf(task), kind: task.parent_handoff_id ? 'Subtask' : 'Task', body: [task.job, task.summary, result].filter(Boolean).join('\n\n'), at: task.finished_at || task.taken_at || task.handed_at, app: task.taken_by || task.to_agent || '', status: task.state, ...(span ? { source_span: span, source_message: source?.text, may_branch: source?.speaker === 'person' } : {}) });
    if (source && source.text.slice(span.start, span.end) === span.text) {
      const node = nodes.find(one => one.id === source.id);
      if (node) (node.source_spans ??= []).push({ ...span, task_id: task.handoff_id });
    }
  }
  for (const block of answer.blocks ?? []) for (const proof of block.proof ?? []) {
    if (known.has(proof.id)) edges.push({ id: `${block.id}->${proof.id}`, from: block.id, to: proof.id, activity: 'active' });
  }
  for (const task of answer.handoffs ?? []) {
    const message = task.input?.arrived?.message_id;
    const parent = task.parent_handoff_id;
    for (const source of [parent, message, task.input?.arrived?.asked_id].filter(id => known.has(id))) edges.push({ id: `${source}->${task.handoff_id}`, from: source, to: task.handoff_id, activity: task.state === 'finished' ? 'active' : 'idle' });
  }
  const related = new Map((answer.related ?? []).map(record => [record.id, record]));
  const connectRelated = (from, reference) => {
    if (!reference?.id) return;
    const record = related.get(reference.id);
    add(record ?? { id: reference.id, label: reference.id, kind: reference.kind || 'Linked item', body: '', at: '', app: '', ...(reference.kind === 'file' ? { opens: { surface: 'trillion.file', input: 'id' } } : {}) });
    edges.push({ id: `${from}->${reference.id}`, from, to: reference.id, activity: 'idle' });
    if (record) for (const next of record.about ?? []) {
      const target = related.get(next.id);
      if (target) { add(target); edges.push({ id: `${record.id}->${next.id}`, from: record.id, to: next.id, activity: 'idle' }); }
    }
  };
  // A message written on an item of the map (a comment, a question or work for someone, its `about` naming that item
  // as kind record) hangs off that item; anything else a message is about hangs off the message.
  for (const message of sourceMessages) for (const reference of message.about ?? []) {
    if (reference?.kind === 'record' && reference.id !== message.id && known.has(reference.id)) edges.push({ id: `${reference.id}->${message.id}`, from: reference.id, to: message.id, activity: 'active' });
    else connectRelated(message.id, reference);
  }
  for (const task of answer.handoffs ?? []) if (task.case_id) connectRelated(task.handoff_id, { id: task.case_id, kind: 'Decision' });
  for (const row of answer.activity) {
    const linked = [...new Set([...(row.for ?? []), ...(row.uses ?? [])])];
    for (const id of linked) add(related.get(id) ?? { id, label: id, kind: 'Linked item', body: '', at: '', app: '' });
    const app = row.app?.trim() || 'AI';
    const id = `activity:${row.seq}`;
    // The AI that did it is the contribution's own `app` (shown as From), never a shared node: one node for every job an
    // AI did would join unrelated work on the map.
    add({ id, label: short(row.title || row.label || 'AI activity'), kind: 'AI contribution', body: [row.label, row.title, row.agent_name, row.model, row.reason].filter(Boolean).join('\n'), at: row.at, app: row.agent_name || app, ...(row.ok === false ? { status: 'failed' } : {}) });
    for (const source of linked) edges.push({ id: `${source}->${id}`, from: source, to: id, activity: row.ok === false ? 'failed' : 'active' });
    if (row.item) {
      add(related.get(row.item) ?? { id: row.item, label: row.title || row.item, kind: 'Output', body: row.title || row.item, at: row.at, app, opens: row.opens });
      edges.push({ id: `${id}->${row.item}`, from: id, to: row.item, activity: row.ok === false ? 'failed' : 'active' });
    }
  }
  return { nodes, edges };
}

// The person's messages as tasks. Each work block an AI recorded (record_blocks) is one task in its own words; its
// feature is the block it sits under, a top-level block holding blocks (or naming no pursuit) heads its own feature,
// and a top-level block holding none is filed under its pursuit. Its pursuit is the first one named by its own `about`, its parent's, or the
// message it came from (directly, or through a decision that message is about). Progress is the block's own recorded
// percentage (done counts as all of it); a block holding blocks shows the share of them done. A person message no
// block came from is one row saying so, never a guessed task. Nothing here asks a model to split anything.
// The values a task row holds when it names no pursuit, and the feature of a message no AI broke into tasks yet.
export const NO_PURSUIT = 'no-pursuit';
export const NOT_BROKEN = 'not-broken-yet';
const isPursuitRef = reference => typeof reference?.id === 'string' && String(reference.kind ?? '').toLowerCase() === 'pursuit';

export function messageTasks(answer) {
  const blocks = answer.blocks ?? [];
  const messagesById = new Map(answer.messages.map(message => [message.id, message]));
  const related = new Map((answer.related ?? []).map(record => [record.id, record]));
  const pursuitLabels = new Map((answer.related ?? []).filter(record => record.kind === 'Pursuit').map(record => [record.id, record.label ?? record.id]));
  const blocksById = new Map(blocks.map(block => [block.id, block]));
  const childrenOf = new Map();
  for (const block of blocks) {
    if (!blocksById.has(block.parent_id) || block.parent_id === block.id) continue;
    const list = childrenOf.get(block.parent_id);
    if (list) list.push(block); else childrenOf.set(block.parent_id, [block]);
  }
  const pursuitIn = about => (about ?? []).find(isPursuitRef)?.id
    ?? (about ?? []).map(reference => related.get(reference?.id)).find(record => record?.kind === 'Decision' && (record.about ?? []).length)?.about?.[0]?.id;
  const sourceIds = block => [block.source_id, ...(block.sources ?? []).map(link => link.source_id)];
  const pursuitOf = (block, seen = new Set()) => {
    if (seen.has(block.id)) return '';
    seen.add(block.id);
    const parent = blocksById.get(block.parent_id);
    return (block.about ?? []).find(isPursuitRef)?.id
      ?? (parent ? pursuitOf(parent, seen) || undefined : undefined)
      ?? sourceIds(block).map(id => pursuitIn(messagesById.get(id)?.about)).find(Boolean)
      ?? '';
  };
  // The words a block came from: its own span, else the span of the block it sits under in the same message (a task
  // split from a feature came from the feature's words), else the whole message.
  const exactIn = (block, text) => Number.isInteger(block.start) && Number.isInteger(block.end) && block.start >= 0 && block.end > block.start && block.end <= text.length;
  const spanOf = block => {
    const source = messagesById.get(block.source_id);
    if (!source || typeof source.text !== 'string') return null;
    const seen = new Set();
    for (let at = block; at && at.source_id === block.source_id && !seen.has(at.id); at = blocksById.get(at.parent_id)) {
      seen.add(at.id);
      if (exactIn(at, source.text)) return { message_id: source.id, start: at.start, end: at.end, text: source.text.slice(at.start, at.end), task_id: block.id };
    }
    return { message_id: source.id, start: 0, end: source.text.length, text: source.text, task_id: block.id };
  };
  const tasks = [];
  const featureLabels = new Map();
  for (const block of blocks) {
    const children = childrenOf.get(block.id) ?? [];
    const parent = blocksById.get(block.parent_id);
    const pursuit = pursuitOf(block);
    const feature = parent ? parent.id : children.length || !pursuit ? block.id : pursuit;
    if (parent) featureLabels.set(parent.id, { label: parent.title });
    else if (feature === block.id) featureLabels.set(block.id, { label: block.title });
    else featureLabels.set(pursuit, { label: pursuitLabels.get(pursuit) ?? pursuit, pursuit });
    const done = children.filter(child => child.state === 'done').length;
    const progress = children.length ? Math.round((done / children.length) * 100)
      : Number.isInteger(block.progress) ? block.progress : block.state === 'done' ? 100 : null;
    const span = spanOf(block);
    tasks.push({
      id: block.id, kind: 'task', title: block.title, status: block.state ?? 'open', at: block.updated_at ?? block.at ?? '',
      pursuit: pursuit || NO_PURSUIT, feature, progress, parent_id: parent ? parent.id : null, leaf: children.length === 0,
      ...(children.length ? { done_count: done, asked_count: children.length } : {}),
      detail: span?.text ?? '', source_message: messagesById.get(block.source_id)?.text ?? '', ...(span ? { source_span: span } : {}),
    });
  }
  const broken = new Set(blocks.flatMap(sourceIds));
  for (const message of answer.messages) {
    if (message.speaker !== 'person' || broken.has(message.id)) continue;
    tasks.push({
      id: message.id, kind: 'message', title: short(message.text, 120), status: 'unbroken', at: message.at ?? '',
      pursuit: pursuitIn(message.about) ?? NO_PURSUIT, feature: NOT_BROKEN, progress: null, parent_id: null, leaf: true,
      detail: message.text ?? '', source_message: message.text ?? '',
    });
  }
  const pursuits = new Map([...pursuitLabels]);
  for (const task of tasks) if (task.pursuit !== NO_PURSUIT && !pursuits.has(task.pursuit)) pursuits.set(task.pursuit, task.pursuit);
  return {
    tasks,
    pursuits: [...pursuits].map(([id, label]) => ({ id, label })),
    // A feature that is a pursuit's own loose tasks names that pursuit (`pursuit`), so its heading can say so.
    features: [...featureLabels].map(([id, named]) => ({ id, ...named })),
  };
}

/** How much of what was asked is done among these task rows: tasks holding none of their own, done or not. A message
 *  no AI broke into tasks yet is asked but not counted done. */
export function doneOfAsked(tasks) {
  const asked = tasks.filter(task => task.leaf);
  return { done: asked.filter(task => task.status === 'done').length, asked: asked.length };
}

// A repeated page or a record revised between reads keeps one current item.
export function mergeMessagePage(previous, page) {
  const merge = (older, newer, key) => [...new Map([...older, ...newer].map(row => [row[key], row])).values()];
  return {
    ...page,
    messages: merge(previous.messages, page.messages, 'id'),
    arrivals: merge(previous.arrivals, page.arrivals, 'id'),
    asked: merge(previous.asked ?? [], page.asked ?? [], 'id'),
    blocks: merge(previous.blocks ?? [], page.blocks ?? [], 'id'),
    activity: merge(previous.activity, page.activity, 'seq'),
    handoffs: merge(previous.handoffs ?? [], page.handoffs ?? [], 'handoff_id'),
    related: merge(previous.related ?? [], page.related ?? [], 'id'),
  };
}
