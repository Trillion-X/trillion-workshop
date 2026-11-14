// parts/ui/show/next-step-card/NextStepCard.tsx
//
// PURPOSE
//   One concrete next action, shown where a person already looks: a sentence
//   saying what to make, the few items it would use (as small pictures), one
//   line saying why, a switch for where it is going, and the actions to take
//   it, try another, or put it away. It is the opposite of a list of
//   suggestions: exactly one, so the choice is already made.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Domain-blind: the caller supplies every word, picture, destination and
//      action as DATA and receives action ids back. Nothing here knows what a
//      recording, a format or a channel is.
//   2. One primary action at most; the rest are quiet. A caller wanting a
//      second primary is asking for a second card, which this does not draw.
//   3. While the caller is still choosing (`pending`), the card keeps its size
//      and says so in the caller's words; it never shows a spinner in place of
//      the whole card.
//   4. Appearance belongs to screen-look through the `next-step-card*` classes.
import React from 'react';
import {Card} from '../coss/ui/card';
import {Button} from '../coss/ui/button';
import {ActionMenu} from '../action-menu/ActionMenu';
import {ProviderMark} from '../provider-mark/ProviderMark';
import {HoverPreview, type PreviewItem} from '../hover-preview/HoverPreview';
import type {ProviderIconRegistryRow} from '../provider-mark/provider-icon-registry';

/** One small picture; with `preview`, resting the pointer on it shows the item
 *  itself (a video playing, a sound's waveform) in the shared hover preview. */
export type NextStepMedia = {id: string; src: string; alt: string; preview?: PreviewItem};
export type NextStepDestination = {id: string; label: string; providerSlug?: string};
export type NextStepAction = {id: string; label: string; primary?: boolean; disabled?: boolean};

export interface NextStepCardProps {
  title: string;
  reason?: string;
  media?: readonly NextStepMedia[];
  destination?: NextStepDestination | null;
  destinations?: readonly NextStepDestination[];
  actions: readonly NextStepAction[];
  pending?: boolean;
  onAction: (id: string) => void;
  onDestination?: (id: string) => void;
  onMedia?: (id: string) => void;
  registry: readonly ProviderIconRegistryRow[];
  label?: string;
}

function DestinationMark({destination, registry}: {destination: NextStepDestination; registry: readonly ProviderIconRegistryRow[]}) {
  return <ProviderMark providerSlug={destination.providerSlug || destination.label} providerName={destination.label} registry={registry} size="xs" decorative/>;
}

export function NextStepCard({title, reason, media = [], destination, destinations = [], actions, pending = false, onAction, onDestination, onMedia, registry, label = 'What to make next'}: NextStepCardProps) {
  const others = destinations.filter(row => row.id !== destination?.id);
  const previewed = media.filter(item => item.preview);
  return (
    <Card className="next-step-card" aria-label={label} aria-busy={pending || undefined} data-pending={pending ? '' : undefined}>
      <div className="next-step-card-media">
        {media.map(item => {
          const thumb = (
            <Button key={item.id} variant="ghost" className="next-step-card-thumb" aria-label={'Open ' + item.alt} disabled={!onMedia} onClick={() => onMedia?.(item.id)}>
              {item.src ? <img src={item.src} alt="" loading="lazy"/> : null}
            </Button>
          );
          // Every picture with a preview belongs to one carousel, opened at
          // the one the pointer rests on, so the whole set can be looked at.
          const at = previewed.indexOf(item);
          return at < 0
            ? thumb
            : <HoverPreview key={item.id} trigger={thumb} side="bottom" items={previewed} start={at} preview={one => one.preview ?? null} label={previewed.length > 1 ? title : item.alt}/>;
        })}
      </div>
      <div className="next-step-card-body">
        <p className="next-step-card-title">{title}</p>
        {reason && <p className="next-step-card-reason">{reason}</p>}
      </div>
      <div className="next-step-card-actions" role="group" aria-label={'Actions for ' + title}>
        {destination && (others.length && onDestination
          ? <ActionMenu
              label="Where it goes"
              iconTrigger={false}
              triggerContent={<span className="next-step-card-destination"><DestinationMark destination={destination} registry={registry}/>{destination.label}</span>}
              triggerProps={{size: 'sm', variant: 'ghost'}}
              items={others.map(row => ({id: row.id, label: row.label, icon: {glyph: <DestinationMark destination={row} registry={registry}/>}}))}
              onAction={id => onDestination(id)}
            />
          : <span className="next-step-card-destination"><DestinationMark destination={destination} registry={registry}/>{destination.label}</span>)}
        {actions.map(action => (
          <Button key={action.id} size="sm" variant={action.primary ? 'default' : 'ghost'} disabled={pending || action.disabled} onClick={() => onAction(action.id)}>{action.label}</Button>
        ))}
      </div>
    </Card>
  );
}
