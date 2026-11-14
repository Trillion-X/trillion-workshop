import * as React from 'react';
import type { SemanticSceneSection } from '../read-data/scene-descriptor';

export function SemanticSceneStory({ sections }: { sections: readonly SemanticSceneSection[] }) {
  return (
    <article data-semantic-story>
      {sections.map((section) => (
        <section key={section.id} id={section.id} data-claim-state={section.claimState} data-station-id={section.stationId}>
          {section.eyebrow ? <p>{section.eyebrow}</p> : null}
          <h2>{section.heading}</h2>
          <p>{section.body}</p>
          {section.action ? <a href={section.action.href}>{section.action.label}</a> : null}
        </section>
      ))}
    </article>
  );
}
