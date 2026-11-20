// Made-up awareness and map content for the tests. The real rows are content the caller hands in, never read here.
export const settings = {
  instructions: 'Read what the person did and wrote.',
  kept: { pursuits: 5, per_trait: 3, observations: 4, evidence: 3, chars: 200 },
  incremental: true,
  incremental_limits: { pursuits: 2, observations: 2 },
  traits: [
    { id: 'values', label: 'Value', ask: 'a value they act on' },
    { id: 'skills', label: 'Skill', ask: 'a skill they use' },
  ],
  trait_evidence: { speakers: ['person'], input_kind: 'message', require_source_id: true },
  recording: { found_by: 'reading', where: 'messages', ask: { now: 'where it stands now', after: 'where it should get to' } },
  pursuit_judgements: [{
    id: 'worth', label: 'Worth it', ask: 'is it worth it for them',
    choices: [{ id: 'yes', label: 'Worth it', tone: 'good' }, { id: 'no', label: 'Not worth it', tone: 'bad' }],
  }],
  stages: [{ id: 'aware', label: 'Awareness', ask: 'what they noticed' }, { id: 'focus', label: 'Focus', ask: 'what they focus on' }],
  right_now: {
    ask: 'what they are doing now',
    judgement: { ask: 'is it on their path', choices: [{ id: 'on', label: 'On the path', tone: 'good' }, { id: 'off', label: 'Off the path', tone: 'warn' }] },
  },
  questions: {
    list: { id: 'questions', label: 'Questions' }, ask: 'what the inputs cannot show', per_reading: 2, open_cap: 4, answered_read: 8,
    about: [{ id: 'pursuits', label: 'Pursuits' }],
    words: { heading: 'Questions', body: 'Answer these.', waiting: '{count} questions wait for you', answer: 'Answer' },
  },
  words: {
    heading: 'Awareness', body: 'What the reading sees.', read_now: 'Read now', read_now_busy: 'Reading',
    read_line: 'Read {count} inputs, last on {when}.', reading_history: 'Older history is still being read.',
    empty_title: 'Nothing read yet', empty_body: 'The reading starts with the first input.', evidence: 'Evidence: {evidence}',
    traits_label: 'Traits', right_now_heading: 'Right now', pursuits_heading: 'Pursuits', pursuits_label: 'Pursuits',
    observations_heading: 'Observations', observations_label: 'Observations', observations_open: 'Open',
    columns: { name: 'Name', kind: 'Kind', evidence: 'Evidence', pursuit: 'Pursuit', heading_to: 'Heading to', why: '{label}: why', about: 'About' },
  },
  repair_instructions: 'Make the reply valid JSON.',
  every_minutes: 10,
  waiting_longest_minutes: 60,
  readings_per_day: 5,
  inputs: {
    chars: 4000, messages: 50, results: 20, activity: 20, result_kinds: ['transcript', 'summary'], result_chars: 300,
    message_chars: 300, speaker_chars: { person: 400 }, stated_pursuits: 10, stated_chars: 200,
  },
};

export const mapSettings = {
  words: { heading: 'Map', offer_body: 'Start a map of your life.', start_map: 'Start map', pursuit_areas: 'Areas' },
  reading: { ask: 'map area id', look: 'Look across every area, first the untouched ones.' },
};
