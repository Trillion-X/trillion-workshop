/** A fence must be longer than every matching delimiter in its literal body. */
export function markdownCodeFence(text: string, marker = '`', minimum = 3, language = ''): string {
  if (marker !== '`' && marker !== '~') throw new Error('A Markdown fence uses backticks or tildes.');
  let longest = 0, run = 0;
  for (const character of text) { run = character === marker ? run + 1 : 0; longest = Math.max(longest, run); }
  const fence = marker.repeat(Math.max(3, Math.min(128, Math.floor(minimum) || 3), longest + 1));
  return `${fence}${language.replace(/[^a-zA-Z0-9_+.-]/g, '')}\n${text}\n${fence}`;
}
