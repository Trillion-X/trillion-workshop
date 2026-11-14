// parts/ui/show/region-map/RegionMap.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// One tappable diagram for any set of named regions drawn as vector paths: a body, a court, a floor plan, a seating chart,
// a rack. The caller gives the regions as DATA ({ id, label, d }), a number per region (or records and a placement row,
// see region-heat.ts) and what to do when one is picked. Each region is coloured by its value in a few heat steps and can
// be picked by pointer or keyboard. The browser tests which path was hit, so there is no coordinate maths here.
//
// Appearance: parts/screen-look/show/region-map.css (`.region-map*`, roles --region-heat-0..4). Heat is set with the
// data-heat attribute, never an inline colour. Search before building: 21st.dev "interactive svg region map heatmap"
// returned 21st component 2346 (a grid heatmap) and 3898 (a GPS map); neither draws caller-supplied shapes, so this is
// original code.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. NO NAMES: nothing here knows a body, a muscle or a room. The regions, their shapes and the view box are props.
// 2. EMPTY IS NOT ZERO: a region with no value carries data-heat="empty", never the lowest heat step.
// 3. KEYBOARD: every region is reachable with Tab, picked with Enter or Space, and named by its label and value.
// 4. NO INLINE STYLE: colour comes from screen-look roles through data-heat and data-picked; geometry only from path data.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cn } from '../cn';
import { regionHeatSteps, type RegionHeatDomain } from './region-heat';

export const REGION_HEAT_STEPS = 5;

export interface MapRegion { id: string; label: string; d: string }

export interface RegionMapProps extends Omit<React.SVGAttributes<SVGSVGElement>, 'onSelect'> {
  regions: readonly MapRegion[];
  /** A number per region id; a region left out or null has no reading and is drawn empty, not as zero. */
  values?: Readonly<Record<string, number | null | undefined>>;
  domain?: RegionHeatDomain;
  viewBox: string;
  pickedId?: string | null;
  onPick?: (id: string) => void;
  /** Words for a region's value in its accessible name, like "3 sessions". */
  valueLabel?: (value: number) => string;
  /** The map's name for assistive technology. */
  title: string;
}

export const RegionMap = React.forwardRef<SVGSVGElement, RegionMapProps>(
  ({ regions, values = {}, domain, viewBox, pickedId = null, onPick, valueLabel = String, title, className, ...props }, ref) => {
    const steps = regionHeatSteps(values, REGION_HEAT_STEPS, domain);
    return (
      <svg ref={ref} viewBox={viewBox} role="group" aria-label={title} className={cn('region-map', className)} {...props}>
        {regions.map(region => {
          const step = steps[region.id] ?? null;
          const value = values[region.id];
          const name = typeof value === 'number' && Number.isFinite(value) ? `${region.label}: ${valueLabel(value)}` : `${region.label}: no reading`;
          return (
            <path
              key={region.id}
              d={region.d}
              role="button"
              tabIndex={0}
              aria-label={name}
              aria-pressed={pickedId === region.id}
              className="region-map-region"
              data-heat={step === null ? 'empty' : step}
              data-picked={pickedId === region.id ? 'true' : undefined}
              onClick={() => onPick?.(region.id)}
              onKeyDown={event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onPick?.(region.id);
              }}
            >
              <title>{name}</title>
            </path>
          );
        })}
      </svg>
    );
  },
);

RegionMap.displayName = 'RegionMap';
