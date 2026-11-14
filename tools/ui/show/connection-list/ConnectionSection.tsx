// packages/ui/show/connection-list/ConnectionSection.tsx
//
// PURPOSE
//   One settings section listing connections to outside services: each row is
//   the service's mark, its name with one line of detail, the formats it
//   offers, its current state and one action. The header can summarise how
//   many rows are connected. Anatomy follows Vercel's sign-in methods card,
//   Linear's connected workspaces and the 21st.dev "Integrations 02" list.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The caller derives each row's state from real checks; this never infers
//      one. State labels and tones are screen-look DATA
//      (`connection-state-appearance.json`); an unknown state still draws.
//   2. No service is named here; marks come from the provider-icon registry.
//   3. Appearance belongs to screen-look through `connection-section*` classes.
import React from 'react';
import {ArrowUpRight} from 'lucide-react';
import appearance from '../../../screen-look/show/connection-state-appearance.json';
import {ProviderMark} from '../provider-mark/ProviderMark';
import type {ProviderIconRegistryRow} from '../provider-mark/provider-icon-registry';
import {Badge} from '../coss/ui/badge';
import {Button} from '../coss/ui/button';
import {EmptyState,type EmptyStateOptions} from '../empty-state';

export type ConnectionAction={id:string;label:string;opensOutside?:boolean;tone?:'default'|'danger'};
export type ConnectionRow={
  id:string;
  name:string;
  detail?:string;
  providerSlug?:string;
  /** Derived by the caller from real checks, for example "connected". */
  state?:string;
  tags?:string[];
  action?:ConnectionAction;
};
export type ConnectionSectionOptions={
  title:string;
  description?:string;
  rows:ConnectionRow[];
  /** The shared empty state shown in place of rows when there are none. */
  empty?:EmptyStateOptions;
  /** Count rows in this state in the header ("2 of 7 connected"). */
  summarizeState?:string;
  registry?:readonly ProviderIconRegistryRow[];
  onAction?:(rowId:string,actionId:string)=>void;
};

const states=appearance.states as Record<string,{label?:string;tone?:string}>;
export function connectionStateLook(state?:string|null){
  const key=(state??'').trim();
  const row=key?states[key]:undefined;
  return {label:row?.label??key.replace(/[_-]+/g,' ').replace(/^./,first=>first.toUpperCase()),tone:row?.tone??appearance.fallback.tone};
}

export function ConnectionSection({title,description,rows,empty,summarizeState,registry=[],onAction}:ConnectionSectionOptions){
  const counted=summarizeState?rows.filter(row=>row.state===summarizeState).length:0;
  const summaryLabel=summarizeState?`${counted} of ${rows.length} ${connectionStateLook(summarizeState).label.toLocaleLowerCase()}`:'';
  return <section className="connection-section" aria-label={title}>
    <header className="connection-section-header">
      <div className="connection-section-heading"><h2>{title}</h2>{description?<p>{description}</p>:null}</div>
      {summarizeState&&rows.length?<div className="connection-section-summary" role="status">
        <span>{summaryLabel}</span>
        <meter className="connection-section-meter" min={0} max={rows.length} value={counted} aria-label={summaryLabel}/>
      </div>:null}
    </header>
    {rows.length?<ul className="connection-section-rows">
      {rows.map(row=>{const look=connectionStateLook(row.state);return <li key={row.id} className="connection-section-row" data-state={row.state||undefined}>
        <span className="connection-section-mark"><ProviderMark providerSlug={row.providerSlug||row.name} providerName={row.name} registry={registry} size="sm" decorative/></span>
        <span className="connection-section-copy">
          <strong>{row.name}</strong>
          {row.detail?<small>{row.detail}</small>:null}
          {row.tags?.length?<span className="connection-section-tags">{row.tags.map(tag=><Badge key={tag} variant="outline" size="sm">{tag}</Badge>)}</span>:null}
        </span>
        {row.state?<Badge variant="outline" size="sm" className="connection-section-state" data-tone={look.tone}>{look.label}</Badge>:null}
        {row.action?<Button type="button" size="sm" variant={row.action.tone==='danger'?'ghost':'outline'} className="connection-section-action" data-tone={row.action.tone||undefined}
          onClick={()=>onAction?.(row.id,row.action!.id)}>{row.action.label}{row.action.opensOutside?<ArrowUpRight aria-hidden="true"/>:null}</Button>:null}
      </li>;})}
    </ul>:<EmptyState {...(empty||{})}/>}
  </section>;
}
