import { DEFAULT_EDITING_RULES } from './document-value.ts';
import type { AutoformatRule } from './documents.ts';

const levelOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6 ? value : null;

/** Authored heading semantics, with compatibility for saved shortcut blocks predating semantic metadata. */
export function headingLevel(props: Record<string, unknown> | undefined, rules: readonly AutoformatRule[] = DEFAULT_EDITING_RULES.autoformat): number | null {
  const custom = props?.custom as { heading_level?: unknown } | undefined;
  const rule = rules.find(candidate => candidate.id === props?.made_by_shortcut);
  if (rule) {
    const change = rule.effect.find(effect => effect.type === 'UPDATE_PROPS' && effect.changes?.props?.custom);
    const semantics = change?.type === 'UPDATE_PROPS' ? change.changes.props?.custom as { heading_level?: unknown } : undefined;
    // A known non-heading shortcut supersedes any stale heading metadata on an older block.
    if (!levelOf(semantics?.heading_level)) return null;
    return custom && Object.hasOwn(custom, 'heading_level')
      ? levelOf(custom.heading_level) : levelOf(semantics?.heading_level);
  }
  return levelOf(custom?.heading_level);
}
