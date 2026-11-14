// NO PRIOR: searched Bitfield package show sources for public card, card appearance,
// public title, and site card; searched 21st.dev for configurable site content cards.
import React, { useState } from 'react';
import { Button } from '../button';
import { Input, Textarea } from '../input';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../coss/ui/select';
import '../../../screen-look/show/public-app-editor.css';

export type PublicCardPresentation = { title: string; description: string; style: 'card' | 'plain' };
export type PublicVisitorView = {
  source_label: string;
  sections?: { heading?: string; text?: string; items?: { label?: string; text?: string }[] }[];
  actions?: { label: string }[];
};

export function PublicCardOptions({ initial, visitorView, operation, canRun, onApply, onClose }: {
  initial: PublicCardPresentation;
  visitorView?: PublicVisitorView;
  operation: 'open' | 'run';
  canRun?: boolean;
  onApply: (value: PublicCardPresentation, operation: 'open' | 'run') => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [style, setStyle] = useState<PublicCardPresentation['style']>(initial.style);
  const [visitorAction, setVisitorAction] = useState<'open' | 'run'>(operation);
  const valid = Boolean(title.trim() && title.length <= 120 && description.trim() && description.length <= 600);
  return <section className="trillion-public-card-options" aria-label="Public card settings">
    <div className="trillion-public-card-options__heading">
      <h2>Card on this page</h2>
      <Button size="sm" variant="secondary" onClick={onClose}>Close</Button>
    </div>
    <p>Anyone who can open this page can read these words. {visitorAction === 'run'
      ? 'Visitors can also run this published tool within its public limits.'
      : 'Visitors can open its Trillion link; this card cannot run it.'}</p>
    {canRun ? <label className="trillion-public-card-options__style">Visitor action
      <Select value={visitorAction} onValueChange={value => { if (value === 'open' || value === 'run') setVisitorAction(value); }}>
        <SelectTrigger aria-label="Visitor action"><SelectValue /></SelectTrigger>
        <SelectPopup><SelectItem value="open">Open only</SelectItem><SelectItem value="run">Run on this page</SelectItem></SelectPopup>
      </Select>
    </label> : null}
    <Input label="Public title" value={title} maxLength={120} onChange={event => setTitle(event.currentTarget.value)} />
    <Textarea label="Public description" value={description} maxLength={600} onChange={event => setDescription(event.currentTarget.value)} />
    <label className="trillion-public-card-options__style">Appearance
      <Select value={style} onValueChange={value => { if (value === 'card' || value === 'plain') setStyle(value); }}>
        <SelectTrigger aria-label="Card appearance"><SelectValue /></SelectTrigger>
        <SelectPopup><SelectItem value="card">Card</SelectItem><SelectItem value="plain">Plain section</SelectItem></SelectPopup>
      </Select>
    </label>
    {visitorView ? <div className={`trillion-public-card-preview trillion-public-card-preview--${style}`} aria-label="Visitor view preview">
      <p className="trillion-public-card-preview__source">{visitorView.source_label}</p>
      <h3>{title || initial.title}</h3>
      <p>{description || initial.description}</p>
      {visitorView.sections?.map((section, sectionIndex) => <section className="trillion-public-card-preview__section" key={sectionIndex}>
        {section.heading ? <h4>{section.heading}</h4> : null}
        {section.text ? <p>{section.text}</p> : null}
        {section.items?.length ? <ul>{section.items.map((item, itemIndex) => <li key={itemIndex}>
          {item.label ? <strong>{item.label}</strong> : null}{item.label && item.text ? ' · ' : null}{item.text}
        </li>)}</ul> : null}
      </section>)}
      {visitorView.actions?.length ? <div className="trillion-public-card-preview__actions" aria-label="Visitor actions">
        {visitorView.actions.map((action, index) => <span key={index}>{action.label}</span>)}
      </div> : null}
    </div> : null}
    <Button size="sm" disabled={!valid} onClick={() => onApply({ title: title.trim(), description: description.trim(), style }, canRun ? visitorAction : 'open')}>Apply to page</Button>
  </section>;
}
