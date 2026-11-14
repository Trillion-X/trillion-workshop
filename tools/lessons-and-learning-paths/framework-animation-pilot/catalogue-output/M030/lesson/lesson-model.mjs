export const INITIAL_ARRANGEMENT = Object.freeze({ setting: 'quiet', preparation: 'question', challenge: 'same', feedback: 'reader-restates' });

export function selectedChoice(content, kind, id) {
  const choice = content.choices[kind].find(row => row.id === id);
  if (!choice) throw new RangeError(`Unknown ${kind} choice: ${id}`);
  return choice;
}

export function sessionPlan(content, arrangement) {
  const setting = selectedChoice(content, 'setting', arrangement.setting);
  const preparation = selectedChoice(content, 'preparation', arrangement.preparation);
  const challenge = selectedChoice(content, 'challenge', arrangement.challenge);
  const feedback = selectedChoice(content, 'feedback', arrangement.feedback);
  return {
    setting,
    preparation,
    challenge,
    feedback,
    goal: arrangement.setting === 'conversation' ? content.labels.conversationGoal : content.labels.quietGoal,
    task: arrangement.challenge === 'new' ? content.labels.newChallenge : content.labels.sameChallenge,
    preparedQuestion: arrangement.preparation === 'question',
    spokenAttempt: arrangement.setting === 'conversation',
    feedbackPrompt: arrangement.feedback === 'reader-restates'
      ? content.labels.clarityCheckEvidence
      : arrangement.feedback === 'reader-unclear'
        ? content.labels.personCheckEvidence
        : content.labels.noCheckEvidence,
  };
}
