import * as React from 'react';
import type { WorkFlowItem } from '../read-data/work-flow-map';
import type { WorkFlowFeedState } from '../read-data/work-flow-feed';

export interface WorkFlowMapProps {
  items: readonly WorkFlowItem[];
  feedState?: WorkFlowFeedState;
}

/** Renders only recorded owner events. An arrival animates once when its ID first appears. */
export function WorkFlowMap({ items, feedState = 'ready' }: WorkFlowMapProps) {
  const seenEvents = React.useRef<Set<string> | null>(null);
  const currentIds = new Set(items.flatMap((item) => item.events.map((event) => event.id)));
  const arrivals = seenEvents.current === null
    ? new Set<string>()
    : new Set([...currentIds].filter((id) => !seenEvents.current?.has(id)));

  React.useEffect(() => {
    seenEvents.current = currentIds;
  }, [items]);

  const attention = items.filter((item) => item.availability !== 'available' || (item.events.length > 0 && !item.taskAddress));
  const eventCount = items.reduce((sum, item) => sum + item.events.length, 0);
  const linkedCount = items.filter((item) => item.taskAddress).length;

  return (
    <section aria-label="Work flow map" className="bf-work-flow-map">
      <header className="bf-work-flow-map__heading">
        <div><p className="bf-work-flow-map__eyebrow">Your work</p><h2>Your work, in motion.</h2><p>Follow each recorded source event to the task it belongs to.</p></div>
        <div className="bf-work-flow-map__summary" aria-label="Recorded totals"><span><strong>{items.length}</strong> sources</span><span><strong>{eventCount}</strong> events</span><span><strong>{linkedCount}</strong> linked tasks</span></div>
      </header>
      {feedState !== 'ready' && <p className="bf-work-flow-map__feed-state" role="status">{feedState === 'unavailable' ? 'The event feed is unavailable.' : feedState === 'invalid' ? 'The event feed could not be read.' : feedState === 'stale' ? 'No recent events have arrived.' : 'No recorded events have arrived yet.'}</p>}
      <div className="bf-work-flow-map__grid">
        <div className="bf-work-flow-map__main">
          <div className="bf-work-flow-map__card-heading"><div><h3>The flow <span aria-hidden="true">•</span></h3><p>Source → recorded changes → task</p></div><span className="bf-work-flow-map__recorded">Recorded events</span></div>
          {items.length === 0 ? <div className="bf-work-flow-map__empty">No connected sources or work events yet.</div> : (
            <div className="bf-work-flow-map__lanes">{items.map((item) => (
              <article className="bf-work-flow-map__lane" key={item.source.address}>
                <div className="bf-work-flow-map__source"><span className="bf-work-flow-map__source-icon" aria-hidden="true">↘</span><div><strong>{item.source.label ?? item.source.address}</strong><span>{item.availability === 'unavailable' ? 'Unavailable' : item.availability === 'stale' ? 'No recent events' : 'Recent event'}</span></div></div>
                <div className="bf-work-flow-map__path">{item.events.length === 0 ? <div className="bf-work-flow-map__empty">No event received from this source.</div> : (
                  <ol aria-label={`${item.source.label ?? item.source.address} recorded transitions`} className="bf-work-flow-map__events">{item.events.map((event) => (
                    <li className={`bf-work-flow-map__event${arrivals.has(event.id) ? ' bf-work-flow-map__event--arrived' : ''}`} data-event-id={event.id} key={event.id}>
                      <span className="bf-work-flow-map__event-label">{event.summary ?? event.state}</span><span className="bf-work-flow-map__producer">{event.producer}</span><time className="bf-work-flow-map__time" dateTime={new Date(event.occurredAtMs).toISOString()}>{new Date(event.occurredAtMs).toLocaleString()}</time>
                    </li>
                  ))}</ol>
                )}</div>
                <div className={`bf-work-flow-map__task${item.taskAddress ? ' bf-work-flow-map__task--linked' : ''}`}><span className="bf-work-flow-map__task-icon" aria-hidden="true">{item.taskAddress ? '✓' : '·'}</span><span>{item.taskAddress ? `Task: ${item.taskAddress}` : item.events.length > 0 ? 'No linked task recorded' : 'Awaiting event'}</span></div>
              </article>
            ))}</div>
          )}
          <footer className="bf-work-flow-map__footer">Only recorded events move through this view.</footer>
        </div>
        <aside className="bf-work-flow-map__attention" aria-label="Work needing attention">
          <div className="bf-work-flow-map__card-heading"><div><h3>Worth knowing</h3><p>Gaps visible in the records.</p></div><span className="bf-work-flow-map__attention-count">{attention.length}</span></div>
          {attention.length === 0 ? <p className="bf-work-flow-map__attention-clear">{feedState === 'ready' && eventCount > 0 ? 'No missing source or task links in these records.' : 'There are no observations to check yet.'}</p> : <ul className="bf-work-flow-map__attention-list">{attention.map((item) => (
            <li key={item.source.address}><span className="bf-work-flow-map__attention-icon" aria-hidden="true">!</span><div><strong>{item.availability === 'unavailable' ? 'Source unavailable' : item.availability === 'stale' ? 'No recent events' : 'Needs a task link'}</strong><span>{item.source.label ?? item.source.address}</span><p>{item.availability === 'unavailable' ? 'No recorded event has arrived.' : item.availability === 'stale' ? 'The last event is older than the freshness window.' : 'An event arrived, but no task address is attached.'}</p></div></li>
          ))}</ul>}
        </aside>
      </div>
    </section>
  );
}
