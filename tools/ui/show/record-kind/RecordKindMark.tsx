// packages/ui/show/record-kind/RecordKindMark.tsx
//
// PURPOSE
//   One mark that says what kind of thing a media record is (an original
//   camera recording, an edit project, an exported video, a draft) so a person
//   never has to guess whether an item is the source or something made from it.
//   Icon, short label and a subtle tone; an optional detail joins the label
//   ("Project · Premiere Pro").
//
// NON-NEGOTIABLE INVARIANTS
//   1. The kind is the record's own `record_kind`, written by its producer.
//      Nothing here lists kinds: labels, icons and tones are screen-look DATA
//      (`record-kind-appearance.json`), and an unknown kind still draws with
//      its key made readable and the fallback appearance.
//   2. `recordKindLabel` is the one text form, used for filtering, sorting and
//      grouping so the mark and its column never disagree.
//   3. Appearance belongs to screen-look through `record-kind-mark*` classes.
import React from 'react';
import appearance from 'trillion-workshop/tools/screen-look/show/record-kind-appearance.json';
import {resolveNamedIcon} from '../icon/NamedIcon';
import {Badge} from '../coss/ui/badge';

export type RecordKindAppearance={label?:string;icon?:string;tone?:string};
export type RecordKindOptions={kind?:string|null;detail?:string|null;compact?:boolean};

const kinds=appearance.kinds as Record<string,RecordKindAppearance>;
const readable=(key:string)=>key.replace(/[_-]+/g,' ').replace(/^./,first=>first.toUpperCase());

/** The resolved look of a kind: DATA row, or the fallback with a readable key. */
export function recordKindAppearance(kind?:string|null):Required<RecordKindAppearance>{
  const key=(kind??'').trim();
  const row=key?kinds[key]:undefined;
  return {
    label:row?.label??(key?readable(key):''),
    icon:row?.icon??appearance.fallback.icon,
    tone:row?.tone??appearance.fallback.tone,
  };
}

/** The mark's text: label, then the detail when the record carries one. */
export function recordKindLabel(kind?:string|null,detail?:string|null):string{
  const {label}=recordKindAppearance(kind);
  return [label,detail?.trim()].filter(Boolean).join(' · ');
}

export function RecordKindMark({kind,detail,compact=false}:RecordKindOptions){
  const look=recordKindAppearance(kind);
  if(!look.label)return null;
  const Icon=resolveNamedIcon(look.icon)??resolveNamedIcon(appearance.fallback.icon);
  const text=recordKindLabel(kind,detail);
  return <Badge variant="outline" size="sm" className="record-kind-mark" data-tone={look.tone} data-kind={kind??''} data-compact={compact||undefined}
    title={compact?text:undefined} aria-label={compact?text:undefined}>
    {Icon?<Icon className="record-kind-mark-icon" aria-hidden="true"/>:null}
    {compact?null:text}
  </Badge>;
}

type StateLook={label?:string;tone?:string};
const states=(appearance as {states?:Record<string,StateLook>}).states??{};
const kindStates=(appearance as {kind_states?:Record<string,Record<string,StateLook>>}).kind_states??{};

/** How a record's state reads: the kind's own wording first, then the shared
 *  row, then the key made readable. The state is the record's `record_state`. */
export function recordStateLook(kind?:string|null,state?:string|null):{label:string;tone:string}{
  const key=(state??'').trim();
  const row={...(key?states[key]:undefined),...(key&&kind?kindStates[kind]?.[key]:undefined)};
  return {label:row.label??(key?readable(key):''),tone:row.tone??appearance.fallback.tone};
}

/** Every shared state as filter values ({key: {label, tone}}). */
export function recordStateValues():Record<string,{label:string;tone:string}>{
  return Object.fromEntries(Object.keys(states).map(key=>[key,recordStateLook(null,key)]));
}

/** Every kind as filter values ({key: {label, tone}}). */
export function recordKindValues():Record<string,{label:string;tone:string}>{
  return Object.fromEntries(Object.keys(kinds).map(key=>{const look=recordKindAppearance(key);return [key,{label:look.label,tone:look.tone}];}));
}

export type RecordStateOptions={kind?:string|null;state?:string|null;problem?:string|null};
/** A record's state with a coloured dot; a problem shows as the hover text. */
export function RecordStateMark({kind,state,problem}:RecordStateOptions){
  const look=recordStateLook(kind,state);
  if(!look.label)return null;
  return <Badge variant="outline" size="sm" className="record-state-mark" data-tone={look.tone} data-state={state??''} title={problem||undefined}>{look.label}</Badge>;
}
