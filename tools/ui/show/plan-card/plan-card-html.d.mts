export type PlanCardFacts = {
  id?: string;
  name: string;
  price?: string;
  summary?: string;
  recommended?: boolean;
  highlighted?: boolean;
  notes?: readonly string[];
  lines?: readonly (string | { label: string; value?: string; included?: boolean })[];
  linesLabel?: string;
  action?: { label: string; href: string };
};
export function planCardContentsHtml(plan: PlanCardFacts): string;
export function planCardHtml(plan: PlanCardFacts): string;
