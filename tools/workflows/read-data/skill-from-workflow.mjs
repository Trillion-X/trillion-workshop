// tools/workflows/read-data/skill-from-workflow.mjs
//
// The text of an agent skill (a SKILL.md) made from one workflow's rows and from nothing else, so a skill that teaches a
// workflow cannot drift from it: the steps, their agents and lanes, what each hands back and the checks that judge it are
// read from the recipe, never copied by hand. `skillFromWorkflow(recipe)` takes the payload recipeFromRows makes.
//
//   skillFromWorkflow(recipe) -> the SKILL.md text, the same bytes for the same rows
//
// A recipe row may carry `skill`, the words a skill holds that no step says: `{ description, sections: [{ title, text, at }] }`.
// `description` replaces the generated one (the trigger: when to use the skill); each section is written under its title,
// `at: 'start'` (after the purpose, before the run) or `at: 'end'` (after the steps). They are rows' data, so a hand edit of
// the skill that adds words is still refused, and nothing a skill said is lost to the generator.
//
// do-work/skill-from-workflow.mjs reads the rows (a file of the records door's answers, or the door itself) and writes the
// skill or checks the file on disk against it.

const slugOf = recipe => recipe.id.replace(/^workflow:/, '');
const oneLine = text => String(text).replace(/\s+/g, ' ').trim();
const quote = text => JSON.stringify(oneLine(text));

function agentsLine(step) {
  if (step.lanes_from) return `Agents: one per lane, the lanes being read from the answer of step \`${step.lanes_from[1]}\` (\`${step.lanes_from.slice(2).join('.')}\`); start them with \`tool:start-a-recipe-step\`, each lane's job is \`<run>:${step.id}:<lane id>\`, and each lane has a different AI.`;
  if (Array.isArray(step.lanes)) return `Agents: ${step.lanes.length}, one per lane (${step.lanes.join(', ')}); start them with \`tool:start-a-recipe-step\`, each lane's job is \`<run>:${step.id}:<lane id>\`, and each lane has a different AI.`;
  if (step.agents > 1) return `Agents: ${step.agents}, one per lane; start them with \`tool:start-a-recipe-step\`, and each lane has a different AI.`;
  return null;
}

const handsBack = step => {
  const required = step.submit?.required ?? [];
  return required.length ? required.map(name => `\`${name}\``).join(', ') : 'an object';
};

const sections = (recipe, at) => (recipe.skill?.sections ?? []).filter(section => (section.at ?? 'end') === at)
  .flatMap(section => [`## ${section.title}`, '', section.text.trim(), '']);

export function skillFromWorkflow(recipe) {
  const slug = slugOf(recipe);
  const inputs = Object.keys(recipe.input_schema?.properties ?? {});
  const needed = new Set(recipe.input_schema?.required ?? []);
  const lines = [
    '---',
    `name: ${slug}`,
    `description: ${quote(recipe.skill?.description ?? `Use when asked to: ${oneLine(recipe.job)} Runs ${recipe.id}; this skill is generated from that workflow's rows.`)}`,
    `source: record:workflow-recipe:${slug}`,
    '---',
    `# ${recipe.label}`,
    '',
    `<!-- Generated from ${recipe.id} by tools/workflows/do-work/skill-from-workflow.mjs. Change the workflow's rows, never this file: a hand edit is refused by the generator's --check. -->`,
    '',
    `**Purpose:** ${oneLine(recipe.job)}`,
    '',
    ...sections(recipe, 'start'),
    '## Run the workflow',
    '',
    `The steps, their schemas and their checks are the rows of \`${recipe.id}\` in the person's list of workflows. Start it, then do each step in order:`,
    '',
    `1. \`trillion tools\` finds \`tool:start-a-recipe-run\`; run it with \`{"row":"${recipe.id}"}\`${inputs.length ? ` and the input (${inputs.map(name => `\`${name}\`${needed.has(name) ? ' (required)' : ''}`).join(', ')})` : ''}. It writes one waiting AI job holding the steps.`,
    '2. For each step, begin it with `tool:start-a-recipe-step` (run = that job\'s id, step = the step id), do the work, and hand the answer in with `tool:submit-a-recipe-step`. A step is done only when its checks pass.',
    `3. The steps, in order: ${recipe.steps.map(step => `\`${step.id}\``).join(', ')}.`,
    '',
    '## Steps',
  ];
  recipe.steps.forEach((step, at) => {
    lines.push('', `### ${at + 1}. ${step.title ?? step.id} (\`${step.id}\`)`, '', oneLine(step.do));
    const agents = agentsLine(step);
    if (agents) lines.push('', agents);
    lines.push('', `Hands back: ${handsBack(step)}.`);
    const checks = (step.checks ?? []).map(check => check.says).filter(Boolean);
    if (checks.length) lines.push('', 'Checks that must pass:', ...checks.map(says => `- ${says}`));
  });
  lines.push(...sections(recipe, 'end'));
  if (recipe.source) lines.push('', '## Where this workflow came from', '', oneLine(typeof recipe.source === 'string' ? recipe.source : JSON.stringify(recipe.source)));
  return `${lines.join('\n')}\n`;
}
