// Trillion's account adapter for the sales contract builder surface.
// The Workshop app-entry and the direct screen both mount this one visual component. It reads the person's saved
// deals (the templates) and what their business has (tool:manage-sales-contracts operation `resources`: offers and
// prices, customers, rules, schedules, workflows) at the same time; a business that cannot be read still opens the
// builder, with the reason shown where the offers and customers would be.
import React from 'react';
import { mountReactSurface } from '../../parts/ui';
import { ErrorBoundary } from '../../parts/ui/show/error-boundary';
import { ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { refusal } from './failure';
import { runWorkshopTool } from './workshop-tool-api';
import {
  SalesContractBuilderSurface,
  type ContractPrimitive,
  type ContractTemplate,
  type DealResources,
  type SavedSalesContract,
  type SalesBuilderContent,
  type AudienceContent,
} from './sales-contract-builder-surface';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
/** Saved agreements first, followed by the owner's current Marketplace defaults. */
async function readContractTemplates(): Promise<{templates:ContractTemplate[];builder:SalesBuilderContent;audienceContent:AudienceContent}> {
  // A new run each open (no fixed request key, which would replay the first list and hide every contract saved since).
  const result = await runWorkshopTool<{ contracts: SavedSalesContract[]; templates: ContractTemplate[];builder:SalesBuilderContent;audienceContent:AudienceContent;defaults_error?:string }>('tool:manage-sales-contracts', { operation: 'list' });
  if (!Array.isArray(result.result?.contracts) || !Array.isArray(result.result?.templates)||!result.result.builder||!result.result.audienceContent) throw new Error(result.result?.defaults_error||result.error || 'The current contract templates could not be read.');
  const saved = (result.result?.contracts ?? []).map((row): ContractTemplate => {
    const terms = row.contract;
    const rules = (Array.isArray(terms.rules) ? terms.rules : []).filter((rule): rule is ContractPrimitive => Boolean(rule) && typeof rule === 'object' && typeof (rule as { type?: unknown }).type === 'string');
    const agreed = terms.agreement_terms;
    return { id: row.id, name: row.name, description: 'Saved in your account', rules, ...(agreed && typeof agreed === 'object' ? { sourceTerms: agreed as Record<string, unknown> } : {}) };
  });
  const own = new Set(saved.map(row => row.id));
  return {templates:[...saved, ...result.result.templates.filter(row => !own.has(row.id))],builder:result.result.builder,audienceContent:result.result.audienceContent};
}

/** What the business has, as the builder reads it; when it cannot be read, one source saying why. */
async function readDealResources(): Promise<DealResources> {
  try {
    const result = await runWorkshopTool<DealResources>('tool:manage-sales-contracts', { operation: 'resources' });
    if (Array.isArray(result.result?.sources)) return result.result;
    return { sources: [{ id: 'resources', group: 'offers', label: 'Your offers', state: 'unread', reason: result.error || 'Your offers and customers could not be read.', items: [] }] };
  } catch (error) {
    return { sources: [{ id: 'resources', group: 'offers', label: 'Your offers', state: 'unread', reason: errorWords(error, 'Your offers and customers could not be read.'), items: [] }] };
  }
}

const readBuilder = async () => {
  const [defaults, resources] = await Promise.all([readContractTemplates(), readDealResources()]);
  return { ...defaults, resources };
};

function SalesContractBuilderScreen() {
  const loaded = useScreenLoad('sales-contracts', { loading: { label: 'Opening the contract builder', layout: 'editor' }, read: readBuilder, failed: refusal('The contract builder could not open') });
  return (
    <ErrorBoundary zoneName="sales contract builder">
      {loaded.state ? <ScreenState state={loaded.state} /> : <SalesContractBuilderSurface {...loaded.value} />}
    </ErrorBoundary>
  );
}

export function mountSalesContractBuilderScreen(element: HTMLElement): () => void {
  return mountReactSurface(element, <SalesContractBuilderScreen />);
}
