import React from 'react';
import { Tilt } from '../tilt';

export type EventInvitationFact = {
  label: string;
  value: string;
};

export type EventInvitationProps = {
  title: string;
  summary: string;
  facts: readonly EventInvitationFact[];
  assurance: string;
  actionLabel: string;
  onAction: () => void;
  media: React.ReactNode;
  className?: string;
};

/**
 * Domain-blind invitation entry surface. The caller supplies every fact, visual,
 * promise, and action; this component owns only the event-first hierarchy.
 */
export function EventInvitation({
  title,
  summary,
  facts,
  assurance,
  actionLabel,
  onAction,
  media,
  className,
}: EventInvitationProps) {
  return (
    <section className={['event-invitation', className].filter(Boolean).join(' ')}>
      <div className="event-invitation__copy">
        <h1 className="event-invitation__title">{title}</h1>
        <p className="event-invitation__summary">{summary}</p>
        <dl className="event-invitation__facts">
          {facts.map((fact) => (
            <div className="event-invitation__fact" key={`${fact.label}:${fact.value}`}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
        <p className="event-invitation__assurance">{assurance}</p>
        <button type="button" className="event-invitation__action" onClick={onAction}>
          {actionLabel}
        </button>
      </div>
      <Tilt className="event-invitation__tilt" rotationFactor={5} reverse>
        <div className="event-invitation__media">{media}</div>
      </Tilt>
    </section>
  );
}
