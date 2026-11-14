// packages/ui/show/lifecycle-rules/LifecycleRules.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Two blind editors for "what happens to a record after some days":
//
//   DurationChoice          [7 days][30 days][90 days][Keep indefinitely][Custom ▢]
//   LifecycleRulesEditor    a default window, the quick choices, and an ordered
//                           list of rules: When <field> <op> <value> … Then
//                           <action> after <n> days counting from <date field>.
//
// The shape is the one storage services use for lifecycle rules (a filter, an
// action and an age) and the anatomy follows 21st.dev "Segmented Control"
// (id 23552: radiogroup, arrow keys) and "Advanced Data Table Filter Builder"
// (id 27325: field · operator · value rows with add/remove), checked against
// Apple Photos "Recently Deleted" (days left on every item) on Mobbin.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Blind: fields, operators, actions and quick choices are DATA passed in.
//    Nothing here names a media kind, a folder or any product concept.
// 2. `after_days: null` is "keep indefinitely" and stays null end to end.
// 3. A number of days is a whole number from 0 to 36500; anything else is not
//    emitted, so the caller never receives a value it has to reject.
// 4. The editor owns only draft state. Saving hands the whole document to the
//    caller, which validates and persists it.
//
// =============================================================================
// AI ASSISTANT DIRECTIVE
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import {Plus, Trash2, X} from 'lucide-react';
import {Button} from '../coss/ui/button';
import {Input} from '../coss/ui/input';
import {Checkbox} from '../coss/ui/checkbox';
import {Select, SelectTrigger, SelectValue, SelectPopup, SelectItem} from '../coss/ui/select';
import {mountSharedContent} from '../coss/workspace-controls';

export type LifecycleDays = number | null;
export type LifecycleField = {id: string; label: string; kind?: string; values?: Array<{id: string; label: string}>};
export type LifecycleOperator = {id: string; label: string; needs_value: boolean; applies_to?: string[]};

/** The operators a field offers: those whose `applies_to` names its kind (all, when either side is undeclared). */
export const operatorsForField = (operators: LifecycleOperator[], field?: LifecycleField) =>
  operators.filter(operator => !operator.applies_to || !field?.kind || operator.applies_to.includes(field.kind));
export type LifecycleAction = {id: string; label: string};
export type LifecycleCondition = {field: string; op: string; value: string};
export type LifecycleRule = {id: string; label: string; enabled?: boolean; when: LifecycleCondition[]; then: {action: string; after_days: LifecycleDays; since?: string}};
export type LifecycleSettings = {default: {after_days: LifecycleDays}; suggestions: Array<{after_days: LifecycleDays}>; rules: LifecycleRule[]};

const validDays = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 36500;
export const durationLabel = (days: LifecycleDays) => days === null ? 'Keep indefinitely' : days === 1 ? '1 day' : `${days} days`;
const keyOf = (days: LifecycleDays) => days === null ? 'forever' : String(days);

// ---------------------------------------------------------------------------
// DurationChoice
// ---------------------------------------------------------------------------

export type DurationChoiceProps = {
  label: string;
  value: LifecycleDays;
  suggestions: LifecycleDays[];
  onChange: (days: LifecycleDays) => void;
  /** Offers "Add to choices" for a custom number that is not a choice yet. */
  onAddSuggestion?: (days: number) => void;
};

export function DurationChoice({label, value, suggestions, onChange, onAddSuggestion}: DurationChoiceProps) {
  const choices = [...new Map(suggestions.map(days => [keyOf(days), days])).values()];
  const custom = !choices.some(days => days === value);
  const [draft, setDraft] = React.useState(custom && value !== null ? String(value) : '');
  const buttons = React.useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = custom ? choices.length : choices.findIndex(days => days === value);
  const move = (from: number, step: number) => {
    const next = (from + step + choices.length + 1) % (choices.length + 1);
    buttons.current[next]?.focus();
    if (next < choices.length) onChange(choices[next]);
  };
  const commit = (text: string) => {
    setDraft(text);
    const days = Number(text);
    if (text.trim() !== '' && validDays(days)) onChange(days);
  };
  return (
    <div className="lifecycle-duration" role="radiogroup" aria-label={label}>
      {choices.map((days, index) => (
        <Button
          key={keyOf(days)}
          ref={node => { buttons.current[index] = node; }}
          type="button"
          size="sm"
          variant="outline"
          role="radio"
          aria-checked={index === selectedIndex}
          tabIndex={index === (selectedIndex < 0 ? 0 : selectedIndex) ? 0 : -1}
          onKeyDown={event => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); move(index, 1); }
            if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); move(index, -1); }
          }}
          onClick={() => onChange(days)}
        >{durationLabel(days)}</Button>
      ))}
      <span className="lifecycle-duration-custom" data-selected={custom ? 'true' : 'false'}>
        <Input
          ref={node => { buttons.current[choices.length] = node as unknown as HTMLButtonElement; }}
          type="number"
          min={0}
          max={36500}
          step={1}
          inputMode="numeric"
          aria-label={`${label}: a number of days`}
          placeholder="Days"
          value={custom && value !== null ? String(value) : draft}
          onFocus={() => { if (!custom && draft !== '') commit(draft); }}
          onChange={event => commit(event.target.value)}
        />
        <span aria-hidden="true">days</span>
      </span>
      {onAddSuggestion && custom && validDays(value) && (
        <Button type="button" size="sm" variant="ghost" onClick={() => onAddSuggestion(value as number)}>Add to choices</Button>
      )}
    </div>
  );
}

export function mountDurationChoice(node: HTMLElement, options: DurationChoiceProps) {
  let current = options.value;
  const draw = () => mountSharedContent(node, <DurationChoice {...options} value={current} onChange={days => { current = days; draw(); options.onChange(days); }}/>);
  draw();
  return {value: () => current};
}

// ---------------------------------------------------------------------------
// LifecycleRulesEditor
// ---------------------------------------------------------------------------

export type LifecycleRulesEditorProps = {
  value: LifecycleSettings;
  fields: LifecycleField[];
  operators: LifecycleOperator[];
  actions: LifecycleAction[];
  /** Copy for the default window, in the caller's words. */
  defaultLabel: string;
  onSave: (settings: LifecycleSettings) => Promise<void> | void;
  onCancel?: () => void;
};

function Choose({label, value, options, onChange}: {label: string; value: string; options: Array<{id: string; label: string}>; onChange: (value: string) => void}) {
  return (
    <Select value={value} items={options.map(option => ({value: option.id, label: option.label}))} onValueChange={next => onChange(String(next))}>
      <SelectTrigger aria-label={label} size="sm"><SelectValue>{options.find(option => option.id === value)?.label || 'Choose…'}</SelectValue></SelectTrigger>
      <SelectPopup portalProps={{className: 'coss-ui'}} alignItemWithTrigger={false}>
        {options.map(option => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}
      </SelectPopup>
    </Select>
  );
}

let nextRuleKey = 0;
const newKey = () => `lifecycle-rule-${++nextRuleKey}`;

export function LifecycleRulesEditor({value, fields, operators, actions, defaultLabel, onSave, onCancel}: LifecycleRulesEditorProps) {
  const [draft, setDraft] = React.useState(() => ({...value, rules: value.rules.map(rule => ({...rule, key: newKey()}))}));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const dateFields = fields.filter(field => field.kind === 'date');
  const suggestionDays = draft.suggestions.map(row => row.after_days);
  const setRule = (key: string, change: (rule: LifecycleRule) => LifecycleRule) => setDraft(current => ({...current, rules: current.rules.map(rule => rule.key === key ? {...change(rule), key} : rule)}));
  const addSuggestion = (days: number) => setDraft(current => current.suggestions.some(row => row.after_days === days) ? current : {...current, suggestions: [...current.suggestions, {after_days: days}].sort((a, b) => (a.after_days ?? Infinity) - (b.after_days ?? Infinity))});
  const operatorOf = (id: string) => operators.find(operator => operator.id === id);
  const save = async () => {
    setSaving(true); setError('');
    try { await onSave({default: draft.default, suggestions: draft.suggestions, rules: draft.rules.map(({key: _key, ...rule}) => rule)}); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  return (
    <div className="lifecycle-rules">
      <section className="lifecycle-rules-section" aria-labelledby="lifecycle-default">
        <h3 id="lifecycle-default">{defaultLabel}</h3>
        <DurationChoice label={defaultLabel} value={draft.default.after_days} suggestions={suggestionDays} onChange={days => setDraft(current => ({...current, default: {after_days: days}}))} onAddSuggestion={addSuggestion}/>
        <div className="lifecycle-suggestions" aria-label="Quick choices">
          {draft.suggestions.map(row => (
            <span key={keyOf(row.after_days)} className="lifecycle-suggestion">
              {durationLabel(row.after_days)}
              <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove ${durationLabel(row.after_days)} from choices`} onClick={() => setDraft(current => ({...current, suggestions: current.suggestions.filter(item => item.after_days !== row.after_days)}))}><X/></Button>
            </span>
          ))}
        </div>
      </section>
      <section className="lifecycle-rules-section" aria-labelledby="lifecycle-rules">
        <h3 id="lifecycle-rules">Rules <small>The first rule that matches decides.</small></h3>
        {draft.rules.map((rule, index) => (
          <article key={rule.key} className="lifecycle-rule" data-enabled={rule.enabled === false ? 'false' : 'true'} aria-label={rule.label || `Rule ${index + 1}`}>
            <header>
              <Input aria-label={`Rule ${index + 1} name`} value={rule.label} placeholder="Name this rule" onChange={event => setRule(rule.key, current => ({...current, label: event.target.value}))}/>
              <label className="lifecycle-rule-toggle"><Checkbox checked={rule.enabled !== false} onCheckedChange={checked => setRule(rule.key, current => ({...current, enabled: !!checked}))}/>On</label>
              <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${rule.label || `rule ${index + 1}`}`} onClick={() => setDraft(current => ({...current, rules: current.rules.filter(item => item.key !== rule.key)}))}><Trash2/></Button>
            </header>
            <div className="lifecycle-rule-clause">
              <span className="lifecycle-rule-word">When</span>
              <div className="lifecycle-rule-conditions">
                {rule.when.map((condition, conditionIndex) => {
                  const field = fields.find(item => item.id === condition.field), operator = operatorOf(condition.op);
                  const update = (patch: Partial<LifecycleCondition>) => setRule(rule.key, current => ({...current, when: current.when.map((item, i) => i === conditionIndex ? {...item, ...patch} : item)}));
                  return (
                    <div key={conditionIndex} className="lifecycle-rule-condition">
                      <Choose label="Field" value={condition.field} options={fields} onChange={id => {const offered = operatorsForField(operators, fields.find(item => item.id === id)); update({field: id, value: '', op: offered.some(item => item.id === condition.op) ? condition.op : offered[0]?.id || ''});}}/>
                      <Choose label="Comparison" value={condition.op} options={operatorsForField(operators, field)} onChange={id => update({op: id})}/>
                      {operator?.needs_value !== false && (field?.values?.length
                        ? <Choose label="Value" value={condition.value} options={field.values} onChange={id => update({value: id})}/>
                        : <Input aria-label="Value" value={condition.value} placeholder="Value" onChange={event => update({value: event.target.value})}/>)}
                      <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove condition" onClick={() => setRule(rule.key, current => ({...current, when: current.when.filter((_, i) => i !== conditionIndex)}))}><X/></Button>
                    </div>
                  );
                })}
                <Button type="button" size="sm" variant="ghost" onClick={() => setRule(rule.key, current => ({...current, when: [...current.when, {field: fields[0]?.id || '', op: operatorsForField(operators, fields[0])[0]?.id || '', value: ''}]}))}><Plus/>Condition</Button>
              </div>
            </div>
            <div className="lifecycle-rule-clause">
              <span className="lifecycle-rule-word">Then</span>
              <div className="lifecycle-rule-outcome">
                <Choose label="Action" value={rule.then.action} options={actions} onChange={id => setRule(rule.key, current => ({...current, then: {...current.then, action: id}}))}/>
                <DurationChoice label="After" value={rule.then.after_days} suggestions={suggestionDays} onChange={days => setRule(rule.key, current => ({...current, then: {...current.then, after_days: days}}))}/>
                {dateFields.length > 0 && (
                  <span className="lifecycle-rule-since">counting from <Choose label="Counting from" value={rule.then.since || dateFields[0].id} options={dateFields} onChange={id => setRule(rule.key, current => ({...current, then: {...current.then, since: id}}))}/></span>
                )}
              </div>
            </div>
          </article>
        ))}
        <Button type="button" size="sm" variant="outline" onClick={() => setDraft(current => ({...current, rules: [...current.rules, {key: newKey(), id: '', label: '', enabled: true, when: [{field: fields[0]?.id || '', op: operatorsForField(operators, fields[0])[0]?.id || '', value: ''}], then: {action: actions[0]?.id || '', after_days: current.default.after_days, since: dateFields[0]?.id}}]}))}><Plus/>Add rule</Button>
      </section>
      {error && <p role="alert" className="lifecycle-rules-error">{error}</p>}
      <footer className="lifecycle-rules-footer">
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button type="button" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</Button>
      </footer>
    </div>
  );
}

export function mountLifecycleRulesEditor(node: HTMLElement, options: LifecycleRulesEditorProps) {
  mountSharedContent(node, <LifecycleRulesEditor {...options}/>);
}
