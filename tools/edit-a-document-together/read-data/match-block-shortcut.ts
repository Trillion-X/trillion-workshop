import { matchAutoformat, type AutoformatMatch, type AutoformatRule, type InputShortcut } from './documents.ts';
import { embeddedTextMarker } from './what-enter-does-in-this-block.ts';

/** Match authored input after an earlier shortcut has already painted its marker.
 * Only that producing DATA row can identify a marker; punctuation is never guessed.
 * A longer authored prefix can extend the earlier gesture through the same registry.
 */
export function matchBlockShortcut(
  text: string,
  trigger: 'space' | 'enter',
  rules: AutoformatRule[],
  shortcuts: InputShortcut[],
  madeByShortcut?: string | null,
): AutoformatMatch | null {
  const producer = shortcuts.find(row => row.id === madeByShortcut);
  const marker = embeddedTextMarker(text, producer);
  if (!producer || !marker || !text.startsWith(marker)) return matchAutoformat(text, trigger, rules);
  const authored = text.slice(marker.length);
  const gesture = rules.find(row => row.id === producer.id);
  if (gesture?.prefix && trigger === 'space') {
    const extended = matchAutoformat(`${gesture.prefix} ${authored}`, trigger, rules);
    if (extended && extended.rule.id !== producer.id && extended.rule.prefix.startsWith(`${gesture.prefix} `)) return extended;
  }
  return matchAutoformat(authored, trigger, rules);
}
