// One private review desk for any venture. Source, offer and audience are data;
// its actions call the same account operations available to an AI.
import { mountRecordEditor, mountRecordTable } from '../../parts/ui/show/coss/workspace-controls';
import { loadScreen } from '../../parts/ui/show/screen-state';
import { notify } from '../../parts/ui/show/coss/notifications';
import { postJson, readJson } from './api';
import { refusal } from './failure';
import { goTo } from './open-screen';
import { onStoreChange } from './store-changes';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
type Source = { id: string; role: string; venture_ref: string; offer_ref?: string; source_url: string; quote: string; observed_at: string };
type Question = { candidate: { id: string; question: string; venture_ref: string; offer_ref: string; source_ref: string }; reviews: Array<{ verdict: string; reason?: string }>; work: Array<{ state: string }>; drafts: Array<{ revision: string; answer: string; destination_url: string; state: string }> };
type Screen = { questions: Question[]; sources: Source[]; upgrade_needed?: boolean };
const said = (error: unknown) => errorWords(error);

export function mountAudienceQuestionsScreen(element: HTMLElement): () => void {
  const host = document.createElement('div');
  element.replaceChildren(host);
  const sourceForm = document.createElement('div');
  const sourceList = document.createElement('div');
  const reviewForm = document.createElement('div');
  const draftForm = document.createElement('div');
  const questionList = document.createElement('div');
  const load = () => screen.reload();

  const screen = loadScreen(host, {
    loading: { label: 'Loading audience questions', layout: 'rows' },
    read: () => readJson<Screen>('/work/api/audience-questions'),
    empty: view => (view.upgrade_needed ? { status: 'empty', icon: 'Sparkles', title: 'Private question work is not kept on this plan', description: 'Your AI can still help with a question in the conversation.', action: goTo('See plans', 'trillion.plan') } : null),
    failed: refusal('Audience questions could not load'),
    clear: () => host.replaceChildren(),
    draw: view => draw(view),
  });
  const stopListening = onStoreChange(() => screen.reload());

  function draw(view: Screen) {
    if (!sourceForm.isConnected) host.replaceChildren(sourceForm, sourceList, reviewForm, draftForm, questionList);
    mountRecordEditor(sourceForm, {
      label: 'Check a public source', items: [{ role: 'question', venture_ref: '', offer_ref: '', source_url: '', quote: '' }],
      allowAdd: false, allowRemove: false,
      fields: [
        { id: 'role', label: 'This source shows', options: [{ value: 'question', label: 'An audience question' }, { value: 'answer', label: 'Answer evidence' }, { value: 'rights', label: 'Reuse rights' }] },
        { id: 'venture_ref', label: 'Venture', required: true },
        { id: 'offer_ref', label: 'Offer for this question' },
        { id: 'source_url', label: 'Public page', type: 'url', required: true },
        { id: 'quote', label: 'Exact words on that page', multiline: true, required: true, maxLength: 500 },
      ],
      actions: [{ id: 'observe', label: 'Check source' }],
      onAction: async (_action: string, values: Record<string, string>) => {
        const answer = await postJson<{ observed: boolean; reason?: string }>('/work/api/audience-questions/observe', values);
        if (!answer.observed) throw new Error(answer.reason ?? 'The source could not be checked.');
        notify('Source checked and kept privately', { kind: 'done' });
        void load();
      },
      onError: (error: unknown) => notify(said(error), { kind: 'error' }),
    });

    mountRecordTable(sourceList, {
      label: 'Checked sources',
      columns: [{ id: 'quote', label: 'Words', primary: true }, { id: 'venture', label: 'Venture' }, { id: 'source', label: 'Source' }],
      items: view.sources.map(source => ({ id: source.id, title: source.quote, cells: {
        quote: { text: source.quote, detail: source.role }, venture: { text: source.venture_ref, detail: source.offer_ref },
        source: { text: source.source_url, detail: new Date(source.observed_at).toLocaleString() },
      }, actions: source.role === 'question' ? [{ id: 'keep', label: 'Keep question' }] : [] })),
      empty: { title: 'No sources checked yet', description: 'Check a public page with an exact audience question or supporting answer first.' },
      onAction: (id: string) => { void postJson<{ kept: boolean; reason?: string }>('/work/api/audience-questions/keep', { source_id: id })
        .then(answer => { if (!answer.kept) throw new Error(answer.reason); notify('Question kept for review', { kind: 'done' }); void load(); })
        .catch(error => notify(said(error), { kind: 'error' })); },
    });

    mountRecordEditor(reviewForm, {
      label: 'Review a question', items: [{ candidate_id: '', verdict: 'accepted', reason: '', answer_source_id: '', answer_note: '', rights_source_id: '', rights_note: '' }],
      allowAdd: false, allowRemove: false,
      fields: [
        { id: 'candidate_id', label: 'Question', required: true, options: view.questions.map(item => ({ value: item.candidate.id, label: item.candidate.question })) },
        { id: 'verdict', label: 'Review', options: [{ value: 'accepted', label: 'Accept for a private draft' }, { value: 'rejected', label: 'Reject or withdraw' }] },
        { id: 'reason', label: 'Why reject or withdraw', multiline: true },
        { id: 'answer_source_id', label: 'Checked answer source', options: view.sources.filter(row => row.role === 'answer').map(row => ({ value: row.id, label: `${row.venture_ref}: ${row.quote}` })) },
        { id: 'answer_note', label: 'How those words answer this question', multiline: true },
        { id: 'rights_source_id', label: 'Checked rights source', options: view.sources.filter(row => row.role === 'rights').map(row => ({ value: row.id, label: `${row.venture_ref}: ${row.quote}` })) },
        { id: 'rights_note', label: 'Why those rights cover this answer', multiline: true },
      ],
      actions: [{ id: 'review', label: 'Save review' }],
      onAction: async (_action: string, values: Record<string, string>) => {
        const answer = await postJson<{ reviewed: boolean; reason?: string }>('/work/api/audience-questions/review', values);
        if (!answer.reviewed) throw new Error(answer.reason ?? 'The review was not saved.');
        notify('Review saved', { kind: 'done' });
        void load();
      },
      onError: (error: unknown) => notify(said(error), { kind: 'error' }),
    });

    mountRecordEditor(draftForm, {
      label: 'Write a private answer',
      items: [{ candidate_id: '', answer: '', destination_url: '' }], allowAdd: false, allowRemove: false,
      fields: [
        { id: 'candidate_id', label: 'Question', required: true,
          options: view.questions.filter(item => item.work.some(work => work.state === 'pending_draft'))
            .map(item => ({ value: item.candidate.id, label: item.candidate.question })) },
        { id: 'answer', label: 'Answer draft', multiline: true, required: true },
        { id: 'destination_url', label: 'Proposed public page', type: 'url', required: true },
      ],
      actions: [{ id: 'save', label: 'Save privately' }],
      onAction: async (_action: string, values: Record<string, string>) => {
        const existing = view.questions.find(item => item.candidate.id === values.candidate_id)?.drafts.at(-1);
        const result = await postJson<{ saved: boolean; reason?: string }>('/work/api/audience-questions/draft',
          { ...values, expected_revision: existing?.revision ?? null });
        if (!result.saved) throw new Error(result.reason ?? 'The draft was not saved.');
        notify('Private answer saved. Nothing was published.', { kind: 'done' });
        void load();
      },
      onError: (error: unknown) => notify(said(error), { kind: 'error' }),
    });

    mountRecordTable(questionList, {
      label: 'Audience questions',
      columns: [{ id: 'question', label: 'Question', primary: true }, { id: 'venture', label: 'Venture and offer' }, { id: 'draft', label: 'Private answer' }, { id: 'state', label: 'State' }],
      items: view.questions.map(item => ({ id: item.candidate.id, title: item.candidate.question, cells: {
        question: { text: item.candidate.question, detail: item.candidate.source_ref },
        venture: { text: item.candidate.venture_ref, detail: item.candidate.offer_ref },
        draft: { text: item.drafts.at(-1)?.answer ?? '', detail: item.drafts.at(-1)?.destination_url },
        state: { text: item.drafts.at(-1)?.state ?? item.work.at(-1)?.state ?? item.reviews.at(-1)?.verdict ?? 'Needs review',
          detail: item.drafts.at(-1)?.destination_url ?? item.reviews.at(-1)?.reason },
      }, actions: [{ id: 'admit', label: 'Add to private drafts' }] })),
      empty: { title: 'No questions kept yet', description: 'Keep a checked question above, then review it against answer evidence.' },
      onAction: (id: string) => { void postJson<{ admitted: boolean; reason?: string }>('/work/api/audience-questions/admit', { candidate_id: id })
        .then(answer => { if (!answer.admitted) throw new Error(answer.reason); notify('Question added to private drafts', { kind: 'done' }); void load(); })
        .catch(error => notify(said(error), { kind: 'error' })); },
    });
  }
  return () => { stopListening(); screen.dispose(); element.replaceChildren(); };
}
