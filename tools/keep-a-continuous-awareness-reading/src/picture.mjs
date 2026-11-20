// The picture a reading keeps: the instructions and JSON shape asked of the model (awarenessPrompt), a model's reply kept
// only in that shape (shapePicture), an incremental merge of a reply into the picture so far (mergePicture), and the
// review of older traits that have no verified source (reviewTraitHistory). Every stage, trait, judgement, choice, limit
// and word is a row of the settings the caller hands in (src/awareness.json content); nothing here names one.

export const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
export const list = value => (Array.isArray(value) ? value : []);
export const fill = (line, values) => line.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');

// What a question can be about: each trait, then the question rows' own (pursuits, something else).
export const aboutIds = settings => [...settings.traits.map(trait => trait.id), ...(settings.questions?.about ?? []).map(item => item.id)];

/**
 * The system words the model reads: the instructions, then the JSON shape asked for, built from the settings rows.
 * map: the reading is also handed the person's map areas, so each pursuit names the areas it serves or lives;
 * mapSettings (required then) is the map's content: reading.ask and reading.look.
 */
export function awarenessPrompt(settings, { map = false, mapSettings = null } = {}) {
  if (map && !mapSettings) throw new TypeError('awarenessPrompt with map needs the map settings.');
  const choices = judgement => judgement.choices.map(choice => `"${choice.id}"`).join(' | ');
  const traitExample = settings.trait_evidence ? [{ quote: 'exact quote from the person', source_id: 'new_inputs source_id' }] : ['short quote or fact from the inputs'];
  const shape = {
    trajectory: 'one or two sentences: where the person is heading, by what they actually do',
    traits: Object.fromEntries(settings.traits.map(trait => [trait.id, [{ name: `${trait.ask} A few words.`, evidence: traitExample }]])),
    pursuits: [{
      title: 'what they are pursuing, a few words',
      ...(settings.recording ? settings.recording.ask : {}),
      trajectory: 'where this pursuit stands now and where it is heading',
      evidence: ['short quote or fact from the inputs'],
      judgements: Object.fromEntries(settings.pursuit_judgements.map(judgement => [judgement.id, { choice: choices(judgement), why: judgement.ask }])),
      ...(map ? { areas: [mapSettings.reading.ask] } : {}),
    }],
    observations: [{ about: 'one thing found in the person', stages: Object.fromEntries(settings.stages.map(stage => [stage.id, stage.ask])) }],
    right_now: { doing: settings.right_now.ask, judgement: { choice: choices(settings.right_now.judgement), why: 'why, by the newest inputs' }, nudge: 'what to stop or do instead, or empty when on the path' },
  };
  if (settings.questions) shape.questions = [{ question: settings.questions.ask, about: aboutIds(settings).map(id => `"${id}"`).join(' | '), guess: 'your best guess from the inputs, or empty', why: 'why you ask, in one short sentence' }];
  const { kept } = settings;
  const asking = settings.questions
    ? ` answers_they_gave are the person's own answers to questions asked earlier (an empty answer is still waiting): their own words outweigh what the inputs suggest, and never ask any of them again. Ask at most ${settings.questions.per_reading} new questions.`
    : '';
  const looking = map ? ` ${mapSettings.reading.look}` : '';
  const incremental = settings.incremental ? ` Return only changes supported by new_inputs. Existing traits, pursuits and observations are kept when omitted; include a pursuit again only when new inputs change it. Always give trajectory and right_now. Empty arrays do not erase earlier findings. In this reading return at most ${settings.incremental_limits?.pursuits ?? settings.kept.pursuits} changed pursuits, ${settings.incremental_limits?.observations ?? settings.kept.observations} observations and ${settings.incremental_limits?.questions ?? settings.questions?.per_reading ?? 0} new questions.` : '';
  const compact = settings.incremental ? {
    trajectory: 'one sentence about direction',
    traits: Object.fromEntries(settings.traits.map(row => [row.id, [{ name: 'few words', evidence: traitExample }]])),
    pursuits: [{ title: 'aim over weeks or years', ...(settings.recording ? settings.recording.ask : {}),
      trajectory: 'direction', evidence: ['quote or fact'],
      judgements: Object.fromEntries(settings.pursuit_judgements.map(row => [row.id, { choice: choices(row), why: 'short reason' }])),
      ...(map ? { areas: ['map area id'] } : {}) }],
    observations: [{ about: 'finding', stages: Object.fromEntries(settings.stages.map(row => [row.id, 'short finding'])) }],
    right_now: { doing: 'current activity', judgement: { choice: choices(settings.right_now.judgement), why: 'reason' }, nudge: 'next action or empty' },
    ...(settings.questions ? { questions: [{ question: 'only what person can answer', about: aboutIds(settings).join(' | '), guess: 'guess or empty', why: 'short reason' }] } : {}),
  } : shape;
  const grounding = settings.trait_evidence ? ' Every trait evidence item must be {quote, source_id}: copy a short exact quote from a new_inputs message whose speaker is person and cite its source_id. AI, peer, generated and unknown-origin messages cannot establish a personal trait. Without that source, omit the trait.' : '';
  return `${settings.instructions}${looking}${asking}${incremental}${grounding} Keep at most ${kept.pursuits} pursuits, ${kept.per_trait} items per trait, ${kept.observations} observations and ${kept.evidence} evidence items each. The JSON shape:\n${JSON.stringify(compact)}`;
}

// An incremental reading adds or refreshes findings while retaining earlier supported findings. The newest
// evidence wins for an existing pursuit or named trait; the recorded id, when present, is the stable key.
export function mergePicture(before, update, settings) {
  if (!before || !settings.incremental) return update;
  const keep = (old, fresh, key, most) => {
    const rows = [...fresh, ...old.filter(item => !fresh.some(next => key(next) === key(item)))];
    return rows.slice(0, most);
  };
  const traits = Object.fromEntries(settings.traits.map(({ id }) => [id,
    keep(list(before.traits?.[id]), list(update.traits?.[id]).map(fresh => {
      const old = list(before.traits?.[id]).find(item => item.name.toLowerCase() === fresh.name.toLowerCase());
      return old && !fresh.evidence.length ? { ...fresh, evidence: old.evidence, ...(old.evidence_sources ? { evidence_sources: old.evidence_sources } : {}) } : fresh;
    }), item => item.name.toLowerCase(), settings.kept.per_trait)]));
  const pursuits = [...list(update.pursuits).map(fresh => {
    const old = list(before.pursuits).find(item => (item.recorded && fresh.recorded && item.recorded === fresh.recorded)
      || item.title.toLowerCase() === fresh.title.toLowerCase());
    return old ? { ...old, ...fresh, recorded: fresh.recorded || old.recorded,
      now: fresh.now || old.now, after: fresh.after || old.after,
      evidence: fresh.evidence.length ? fresh.evidence : old.evidence,
      judgements: { ...old.judgements, ...fresh.judgements },
      areas: fresh.areas?.length ? fresh.areas : old.areas } : fresh;
  }), ...list(before.pursuits).filter(old => !list(update.pursuits).some(fresh =>
    (old.recorded && fresh.recorded && old.recorded === fresh.recorded) || old.title.toLowerCase() === fresh.title.toLowerCase()))]
    .slice(0, settings.kept.pursuits);
  return {
    trajectory: update.trajectory || before.trajectory,
    traits,
    pursuits,
    observations: keep(list(before.observations), list(update.observations).map(fresh => {
      const old = list(before.observations).find(item => item.about.toLowerCase() === fresh.about.toLowerCase());
      return old ? { ...fresh, stages: { ...old.stages, ...fresh.stages } } : fresh;
    }), item => item.about.toLowerCase(), settings.kept.observations),
    right_now: update.right_now ?? before.right_now ?? null,
    questions: update.questions,
  };
}

/** Keep unverified older traits available for review without presenting them as supported personal facts. */
export function reviewTraitHistory(before, settings) {
  if (!before) return { picture: null, unverified_traits: {} };
  const unverified_traits = {};
  const traits = Object.fromEntries(settings.traits.map(({ id }) => {
    const verified = item => list(item.evidence).length > 0 && list(item.evidence).every(quote =>
      list(item.evidence_sources).some(source => source.source_id && settings.trait_evidence.speakers.includes(source.speaker) && source.quote === quote));
    const rows = list(before.traits?.[id]);
    const unverified = [...rows.filter(item => !verified(item)), ...list(before.unverified_traits?.[id])];
    if (unverified.length) unverified_traits[id] = unverified.slice(0, settings.kept.per_trait);
    return [id, rows.filter(verified)];
  }));
  return { picture: { ...before, traits }, unverified_traits };
}

/**
 * A model's reply as the picture is kept, or null when it has no trajectory. Only listed ids and choices survive.
 *   sources     when given (trait_evidence), a trait keeps only quotes that are in a new input from an allowed speaker
 *   areas       when given (the map), each pursuit keeps the ids of those areas it names, through keepAreas(ids, areas)
 *   recorded    the ids of the pursuits already recorded: a pursuit id the reply names is kept only when it is one of them
 */
export function shapePicture(reply, settings, { areas = null, keepAreas = null, recorded = null, sources = null } = {}) {
  if (!reply || typeof reply !== 'object') return null;
  if (areas && !keepAreas) throw new TypeError('shapePicture with areas needs keepAreas.');
  const { kept } = settings;
  const trajectory = text(reply.trajectory, kept.chars);
  if (!trajectory) return null;
  const evidence = value => list(value).map(item => text(typeof item === 'string' ? item : item?.quote ?? item?.fact ?? '', kept.chars)).filter(Boolean).slice(0, kept.evidence);
  const traitEvidence = value => {
    if (sources === null) return { evidence: evidence(value) };
    const policy = settings.trait_evidence;
    const checked = list(value).flatMap(item => {
      const quote = text(item?.quote, kept.chars);
      const source_id = text(item?.source_id, 300);
      if (!quote || (policy.require_source_id && !source_id)) return [];
      const source = list(sources).find(row => row.source_id === source_id && row.kind === policy.input_kind
        && policy.speakers.includes(row.speaker) && typeof row.text === 'string' && row.text.includes(quote));
      return source ? [{ source_id: source.source_id, speaker: source.speaker, at: source.at ?? null, quote }] : [];
    }).slice(0, kept.evidence);
    return { evidence: checked.map(source => source.quote), evidence_sources: checked };
  };
  const judged = (judgement, value) => {
    const choice = typeof value?.choice === 'string' ? value.choice.trim().toLowerCase() : '';
    return judgement.choices.some(item => item.id === choice) ? { choice, why: text(value.why, kept.chars) } : null;
  };
  const traits = Object.fromEntries(settings.traits.map(trait => [trait.id, list(reply.traits?.[trait.id])
    .map(item => ({ name: text(typeof item === 'string' ? item : item?.name, 120), ...traitEvidence(item?.evidence) }))
    .filter(item => item.name && (sources === null || item.evidence.length)).slice(0, kept.per_trait)]));
  const pursuits = list(reply.pursuits).map(item => ({
    title: text(item?.title, 160),
    ...(settings.recording ? {
      recorded: recorded?.has(text(item?.recorded, 200)) ? text(item.recorded, 200) : '',
      now: text(item?.now, kept.chars), after: text(item?.after, kept.chars),
    } : {}),
    trajectory: text(item?.trajectory, kept.chars),
    evidence: evidence(item?.evidence),
    judgements: Object.fromEntries(settings.pursuit_judgements.map(judgement => [judgement.id, judged(judgement, item?.judgements?.[judgement.id])]).filter(([, value]) => value)),
    ...(areas ? { areas: keepAreas(item?.areas, areas) } : {}),
  })).filter(item => item.title).slice(0, kept.pursuits);
  const observations = list(reply.observations).map(item => ({
    about: text(item?.about, 200),
    stages: Object.fromEntries(settings.stages.map(stage => [stage.id, text(item?.stages?.[stage.id], kept.chars)]).filter(([, value]) => value)),
  })).filter(item => item.about && Object.keys(item.stages).length).slice(0, kept.observations);
  const now = reply.right_now;
  const right_now = text(now?.doing, kept.chars)
    ? { doing: text(now.doing, kept.chars), judgement: judged(settings.right_now.judgement, now.judgement), nudge: text(now.nudge, kept.chars) }
    : null;
  const about = new Set(aboutIds(settings));
  const questions = settings.questions ? list(reply.questions).map(item => ({
    question: text(typeof item === 'string' ? item : item?.question, 200),
    about: about.has(item?.about) ? item.about : 'other',
    guess: text(item?.guess, kept.chars),
    why: text(item?.why, kept.chars),
  })).filter((item, index, all) => item.question && all.findIndex(other => other.question.toLowerCase() === item.question.toLowerCase()) === index)
    .slice(0, settings.questions.per_reading) : [];
  return { trajectory, traits, pursuits, observations, right_now, questions };
}
