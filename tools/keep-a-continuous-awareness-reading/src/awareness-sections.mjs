// The computed sections of a kept picture for a guided screen: the state-to-sections shape a guide description draws
// (its heading, banner, catalogs of rows, questions waiting, the right-now row, pursuits and observations). Every heading,
// label, tone and column comes from the settings the caller hands in. The screen owner supplies the presentation it
// owns: the read-now action (`readNow`) and the life-map sections (`mapSections`, already built, placed after pursuits).
import { fill } from './picture.mjs';

const when = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// One judgement choice as the status pill of a row: its label and tone, or null when the value names no choice.
const status = (judgement, value) => {
  const choice = judgement.choices.find(item => item.id === value?.choice);
  return choice ? { label: choice.label, tone: choice.tone } : null;
};

// A choice field's tones as record-views `values` DATA: each choice's label drawn in its tone.
const toned = choices => Object.fromEntries(choices.map(choice => [choice.label, { tone: choice.tone }]));

const textField = (id, label, icon, width) => ({ id, label, icon, ruleKind: 'text', filterable: true, sortable: true, width });
const choiceField = (id, label, icon, values) => ({ id, label, icon, kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 160, ...(values ? { values } : {}) });

/**
 * settings: the awareness content (words, columns, traits, stages, pursuit_judgements, right_now, questions).
 * state:    { picture, reading, questions, map } as the reader's read() gives them; the map is optional.
 * readNow:  the read-now action the screen draws (presentation); mapSections: the map's sections, after pursuits.
 * mapWords: the map's words (pursuit_areas, the areas column's label), needed when state.map is set.
 */
export function awarenessSections(state, { settings, readNow, mapSections = [], mapWords = null }) {
  const { words } = settings;
  const { columns } = words;
  const value = state?.picture;
  if (!value) {
    return [{ id: 'awareness', heading: words.heading, body: words.body, empty: { icon: 'Sparkles', title: words.empty_title, body: words.empty_body }, actions: [readNow] }, ...mapSections];
  }
  const fromLine = evidence => (evidence?.length ? fill(words.evidence, { evidence: evidence.join(' · ') }) : null);
  const traits = settings.traits.flatMap(trait => (value.traits?.[trait.id] ?? []).map((item, index) => ({
    id: `trait-${trait.id}-${index}`, title: item.name, detail: fromLine(item.evidence) ?? undefined,
    status: { label: trait.label, tone: 'quiet' },
    facts: { name: item.name, kind: trait.label, evidence: (item.evidence ?? []).join(' · ') },
  })));
  const sections = [{
    id: 'awareness',
    heading: words.heading,
    body: words.body,
    banner: {
      icon: 'Compass', title: value.trajectory,
      detail: [fill(words.read_line, { count: String(value.read_count ?? 0), when: when(value.read_at) }), state.reading?.history_done ? null : words.reading_history].filter(Boolean).join(' '),
    },
    ...(traits.length ? {
      catalog: { label: words.traits_label, view: 'table', fields: [
        textField('name', columns.name, 'Sparkles', 240),
        choiceField('kind', columns.kind, 'Shapes'),
        textField('evidence', columns.evidence, 'Quote', 360),
      ] },
      rows: traits,
    } : {}),
    actions: [readNow],
  }];
  // What it could not tell: how many questions wait, the first few, and the list's Form view to answer them in.
  const waiting = state?.questions;
  if (settings.questions && waiting?.count) {
    const asking = settings.questions.words;
    sections.push({ id: 'awareness-questions', heading: asking.heading, body: asking.body, rows: [{
      id: 'questions-waiting', title: fill(asking.waiting, { count: String(waiting.count) }),
      detail: waiting.questions.slice(0, 3).join('\n'),
      actions: [{ label: asking.answer, icon: 'ClipboardList', tone: 'primary', open: `/lists/${encodeURIComponent(waiting.list_id)}?view=form` }],
    }] });
  }
  if (value.right_now) {
    const pill = status(settings.right_now.judgement, value.right_now.judgement);
    sections.push({ id: 'awareness-right-now', heading: words.right_now_heading, rows: [{
      id: 'right-now', title: value.right_now.doing,
      detail: [value.right_now.judgement?.why, value.right_now.nudge].filter(Boolean).join('\n') || undefined,
      ...(pill ? { status: pill } : {}),
    }] });
  }
  const areaLabels = new Map((state?.map?.areas ?? []).map(area => [area.id, area.label]));
  const areasOf = pursuit => (pursuit.areas ?? []).map(id => areaLabels.get(id)).filter(Boolean).join(' · ');
  if (value.pursuits?.length) {
    sections.push({
      id: 'awareness-pursuits', heading: words.pursuits_heading,
      catalog: { label: words.pursuits_label, view: 'table', fields: [
        textField('title', columns.pursuit, 'Compass', 220),
        textField('trajectory', columns.heading_to, 'TrendingUp', 320),
        ...settings.pursuit_judgements.map(judgement => choiceField(judgement.id, judgement.label, 'CircleDot', toned(judgement.choices))),
        ...settings.pursuit_judgements.map(judgement => textField(`${judgement.id}_why`, fill(columns.why, { label: judgement.label }), 'MessageSquare', 280)),
        ...(state?.map ? [textField('areas', mapWords.pursuit_areas, 'Map', 280)] : []),
        textField('evidence', columns.evidence, 'Quote', 320),
      ] },
      rows: value.pursuits.map((pursuit, index) => {
        const pills = settings.pursuit_judgements.map(judgement => ({ judgement, pill: status(judgement, pursuit.judgements?.[judgement.id]) })).filter(item => item.pill);
        return {
          id: `pursuit-${index}`, title: pursuit.title,
          detail: [pursuit.trajectory, fromLine(pursuit.evidence)].filter(Boolean).join('\n'),
          ...(pills.length ? { status: pills[0].pill } : {}),
          facts: {
            title: pursuit.title, trajectory: pursuit.trajectory ?? '', evidence: (pursuit.evidence ?? []).join(' · '),
            ...(state?.map ? { areas: areasOf(pursuit) } : {}),
            ...Object.fromEntries(settings.pursuit_judgements.map(judgement => [judgement.id, status(judgement, pursuit.judgements?.[judgement.id])?.label ?? ''])),
            ...Object.fromEntries(settings.pursuit_judgements.map(judgement => [`${judgement.id}_why`, pursuit.judgements?.[judgement.id]?.why ?? ''])),
          },
        };
      }),
    });
  }
  sections.push(...mapSections);
  if (value.observations?.length) {
    sections.push({
      id: 'awareness-observations', heading: words.observations_heading,
      catalog: { label: words.observations_label, view: 'table', fields: [
        textField('about', columns.about, 'Eye', 220),
        ...settings.stages.map(stage => textField(stage.id, stage.label, 'ArrowRight', 280)),
      ] },
      rows: value.observations.map((observation, index) => ({
        id: `observation-${index}`, title: observation.about, open_label: words.observations_open,
        steps: settings.stages.filter(stage => observation.stages[stage.id]).map(stage => ({ title: stage.label, body: observation.stages[stage.id] })),
        facts: { about: observation.about, ...Object.fromEntries(settings.stages.map(stage => [stage.id, observation.stages?.[stage.id] ?? ''])) },
      })),
    });
  }
  return sections;
}
