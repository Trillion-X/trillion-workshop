// package-set://bitfield-studio/packages/customer-support/show/issue-banner.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The recoverable-issue region: a calm banner above the workbench. The
// workspace reports issues as raw machine strings shaped `category:detail…`
// (e.g. `missing-owner-evidence:t-1:owner-7`). This layer is the translation
// boundary (L098): it keeps ONLY the category, looks up calm human copy for it
// in the workspace copy DATA, and shows one row per category. The raw record id
// / ref AFTER the category is never displayed — no internal token leaks
// (L114/L118).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. DATA-driven copy (L090): the message and severity for a category come from
//    `copy['issue.<category>']` / `copy['issue.<category>.severity']`. A new
//    issue category gets human copy by adding a DATA row — zero edits here.
// 2. No token leak (L114/L118): only the category drives the lookup; the rest of
//    the raw string is discarded. SafeErrorCard sanitizes the final message too.
// 3. Calm fallback (L117): an unmapped category shows a generic "still being
//    gathered" line — honest, never a fabricated specific.
// 4. Composes shared `ui` atoms only — no raw HTML, no className (L065).
//
// =============================================================================

import React from 'react';
import { Container, SafeErrorCard, SeverityRow } from '@/packages/ui';

/** Generic, calm fallback when a category has no authored copy yet. */
const DEFAULT_ISSUE_MESSAGE = 'Some details are still being gathered.';

/** A category of recoverable issue, translated to human copy. */
export interface TranslatedIssue {
  /** The issue category (the segment before the first `:`). */
  id: string;
  message: string;
  severity: string;
  /** How many raw issues fell into this category. */
  count: number;
}

/** Collapse raw `category:detail` issue strings into per-category human copy. */
export function translateIssues(issues: string[], copy: Record<string, string>): TranslatedIssue[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const raw of issues) {
    const category = raw.split(':', 1)[0] || 'issue';
    if (!counts.has(category)) {
      counts.set(category, 0);
      order.push(category);
    }
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return order.map((category) => ({
    id: category,
    message: copy[`issue.${category}`] ?? DEFAULT_ISSUE_MESSAGE,
    severity: copy[`issue.${category}.severity`] ?? 'warning',
    count: counts.get(category) ?? 1,
  }));
}

/** Map a raw authored severity onto the SeverityRow's fixed visual levels. */
function severityLevel(raw: string): 'critical' | 'warning' | 'info' {
  const value = raw.toLowerCase();
  if (value === 'critical' || value === 'error' || value === 'blocked') return 'critical';
  if (value === 'info' || value === 'notice') return 'info';
  return 'warning';
}

export interface IssueBannerProps {
  issues: string[];
  copy: Record<string, string>;
}

/** Stacked recoverable-issue cards, one per translated category. */
export function IssueBanner({ issues, copy }: IssueBannerProps): React.ReactElement | null {
  const translated = React.useMemo(() => translateIssues(issues, copy), [issues, copy]);
  if (translated.length === 0) return null;
  return (
    <Container layout="vertical" gap="sm" aria-label="Needs attention">
      {translated.map((issue) => (
        <SeverityRow key={issue.id} severity={severityLevel(issue.severity)}>
          <SafeErrorCard message={issue.message} />
        </SeverityRow>
      ))}
    </Container>
  );
}

export default IssueBanner;
