// packages/ui/show/use-mark/UseMark.tsx
//
// PURPOSE
//   One small mark that says how far a piece of work has gone and where: a
//   glyph for a stage (in an edit, exported, scheduled), or the destinations'
//   own logos once it reached one. It sits on a picture's corner, the way a
//   photo library marks the few photos that carry a state and leaves the rest
//   bare. Hover or focus shows the shared Tooltip with the stage and one line
//   per relationship ("In 2 edits", "Published to Instagram · example_handle
//   on Sep 3").
//
// NON-NEGOTIABLE INVARIANTS
//   1. It knows no stage, platform or product. The stage's words, tone and
//      glyph arrive as DATA; logos come from the provider-icon registry rows.
//   2. A caller that has nothing to say draws nothing: this component is only
//      mounted for work that has a state worth marking.
//   3. At most two logos are drawn; more destinations become a count, so the
//      mark never grows into a strip over the picture.
//   4. Appearance belongs to screen-look through the `use-mark*` classes.
//
// References: Apple Photos library grid (one glyph on marked photos only,
// https://mobbin.com/screens/d55c8518-c10c-4dc4-a83b-5da9531f741b); Hero UI
// Badge anatomy on 21st.dev (id 13824), inspiration only, no code copied.
import React from 'react';
import {Tooltip} from '../tooltip';
import {NamedIcon} from '../icon/NamedIcon';
import {ProviderMark} from '../provider-mark/ProviderMark';
import type {ProviderIconRegistryRow} from '../provider-mark/provider-icon-registry';

export type UseMarkDestination = {label: string; providerSlug?: string};

export interface UseMarkProps {
  /** The stage in people's words ("In an edit", "Published"). */
  label: string;
  /** A tone name the screen-look styles colour ("blue", "green", ...). */
  tone?: string;
  /** A Lucide icon name for the stage glyph. */
  icon?: string;
  /** Where it went; drawn as logos in place of the glyph. */
  destinations?: readonly UseMarkDestination[];
  /** One line per relationship, shown under the label on hover. */
  lines?: readonly string[];
  registry: readonly ProviderIconRegistryRow[];
}

const MAX_LOGOS = 2;

export function UseMark({label, tone, icon, destinations = [], lines = [], registry}: UseMarkProps) {
  const shown = destinations.slice(0, MAX_LOGOS), more = destinations.length - shown.length;
  const detail = lines.length ? <span className="use-mark-lines">{lines.map((line, index) => <span key={index}>{line}</span>)}</span> : null;
  return (
    <Tooltip label={label} trailing={detail} side="top" delayDuration={250}>
      <span className="use-mark" data-tone={tone || undefined} data-has-logos={shown.length ? '' : undefined} tabIndex={0} role="img" aria-label={[label, ...lines].join('. ')}>
        {shown.length
          ? shown.map(destination => <ProviderMark key={destination.label} providerSlug={destination.providerSlug || destination.label} providerName={destination.label} registry={registry} size="xs" decorative/>)
          : <NamedIcon name={icon} fallback="Circle" size="xs" aria-hidden="true"/>}
        {more > 0 && <span className="use-mark-more">+{more}</span>}
      </span>
    </Tooltip>
  );
}
