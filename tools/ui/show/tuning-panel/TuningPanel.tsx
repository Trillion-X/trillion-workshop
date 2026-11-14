// parts/ui/show/tuning-panel/TuningPanel.tsx
//
// NO PRIOR: searched 'tuning|live preview|theme editor' in bitfield-packages/packages/*/show; searched 'theme customizer with live preview color picker sliders' on the 21st.dev MCP; searched 'theme editor with color swatches, sliders and a live preview' on Mobbin
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The one place a person tunes something: every setting is drawn as a control
// you can see and drag (a colour swatch that opens a wheel, a track with the
// value beside it, a row of choices drawn as themselves, a switch), with the
// typed value still there for anyone who wants to type it, and the thing being
// tuned drawn right beside the controls. Every change is sent at once, so the
// thing the person is tuning changes while they move the control; nothing waits
// for a save to be seen.
//
// Anatomy follows Klaviyo's brand review and Shopify's theme settings (controls
// in a column, the real thing beside them), Mintlify's colour rows (swatch and
// colour code in one field) and Telegram's text tools (a track with its number).
// The fine controls (TuningFields.tsx) follow Figma's and Diffusion Studio's
// inspectors: titled sections that fold away, a label column beside compact
// fields with a prefix you drag (X, Y, Blur), a shadow, a timing curve. It is the
// one inspector: a caption style, a shape on a board, a part of a page and a
// record's fields are all setting rows drawn here.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. Settings are DATA (TuningSetting rows). This file never names a setting.
// 2. The control for a setting is looked up by its `widget` id in TUNING_WIDGETS;
//    a new kind of control is one entry there, never a branch here.
// 3. Every move of a control calls onChange at once. Whether and when a change is
//    kept is the caller's; the caller paints the real thing from the same values.
// 4. A setting can show a small picture of itself (`sample`): a tile with one CSS
//    property set to the value, so a size or a corner reads as a picture.
// 5. The layout follows the pane, never the window (container query `tuning`):
//    the preview above the controls in a narrow pane, beside them in a wide one.
// 6. Where a control sits beside its label is the widget's own placement
//    (TUNING_PLACEMENT, DATA keyed by widget id): beside, under, or in the
//    inspector's label column. A row may hold several settings side by side
//    (`settings`), each drawn by its own widget with its own value.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react';

import { cn } from '../cn';
import { SearchField } from '../search-field/SearchField';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '../shadcn/empty';
import { ColorPickerPopover } from '../color-picker-popover';
import { SegmentedControl } from '../segmented-control';
import { Switch } from '../switch';
import { Textarea } from '../input';
import { Button, type ButtonProps } from '../button/Button';
import { NamedIcon } from '../icon/NamedIcon';
import { Dropdown } from '../dropdown';
import { CurveField, ScrubField, ShadowField, curveOf, type TuningCurve, type TuningShadow } from './TuningFields';

/** A setting's value. A shadow is its object, a curve its four numbers; null is a thing taken away (no shadow). */
export type TuningValue = string | number | boolean | readonly string[] | readonly number[] | TuningShadow | null | undefined;

export interface TuningOption {
  readonly value: string;
  readonly label: string;
}

/** A small picture of a setting: a tile with `css_property` set to the value (plus `unit`). */
export interface TuningSample {
  readonly css_property: string;
  readonly unit?: string;
  /** What the tile holds; "Aa" when left out. */
  readonly text?: string;
}

export interface TuningSetting {
  readonly key: string;
  readonly label: string;
  /** Which control draws it, looked up in TUNING_WIDGETS. */
  readonly widget: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** Shown after a number, as typed and as drawn (px, %, s). */
  readonly unit?: string;
  readonly options?: readonly TuningOption[];
  /** Each option drawn with this CSS property set to its value (font-family draws fonts in their own face). */
  readonly options_drawn_with?: string;
  /** Colour presets offered under the wheel. */
  readonly presets?: readonly string[];
  readonly sample?: TuningSample;
  /** A short muted line under the label, only when the label alone cannot say it. */
  readonly note?: string;
  /** The value the setting goes back to; Reset shows while the value differs. */
  readonly default_value?: TuningValue;
  /** The short word at the start of a number field, the part you drag (X, Y, W). */
  readonly prefix?: string;
  /** Several settings drawn side by side in one row under this label (Position: X and Y). Each keeps its own key. */
  readonly settings?: readonly TuningSetting[];
  /** Where the value lives in the caller's record, when that is deeper than one key. Opaque here: the caller reads it. */
  readonly path?: readonly string[];
}

export interface TuningSection {
  readonly id: string;
  readonly title: string;
  readonly settings: readonly TuningSetting[];
}

export interface TuningControlProps {
  readonly setting: TuningSetting;
  readonly value: TuningValue;
  readonly onChange: (key: string, value: TuningValue) => void;
  /** Every setting's value, for a row that holds several settings side by side. */
  readonly values?: Readonly<Record<string, TuningValue>>;
}

export interface TuningPanelProps {
  readonly sections: readonly TuningSection[];
  readonly values: Readonly<Record<string, TuningValue>>;
  readonly onChange: (key: string, value: TuningValue) => void;
  /** The real thing being tuned, drawn from the same values. Left out when the thing is already on screen. */
  readonly preview?: React.ReactNode;
  /** Above the sections: a name field, a title. */
  readonly header?: React.ReactNode;
  /** Below the sections: the actions that keep or drop the change. */
  readonly footer?: React.ReactNode;
  readonly className?: string;
  /** Prevent edits while the caller commits this exact set of values. */
  readonly disabled?: boolean;
  /** Opt in to property search; the caller supplies the words, never the settings themselves. */
  readonly search?: { label: string; placeholder: string; empty: string };
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function numberOf(value: TuningValue, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

/** A colour as a colour code the wheel can start from: codes pass through, rgb()/rgba() become #rrggbb(aa). */
export function colourCode(value: string): string | null {
  if (HEX.test(value)) return value;
  const parts = /^rgba?\(([^)]+)\)$/i.exec(value.trim())?.[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (!parts || parts.length < 3 || parts.some(n => !Number.isFinite(n))) return null;
  const hex = parts.slice(0, 3).map(n => Math.round(n).toString(16).padStart(2, '0')).join('');
  const alpha = parts.length > 3 && parts[3] < 1 ? Math.round(parts[3] * 255).toString(16).padStart(2, '0') : '';
  return `#${hex}${alpha}`;
}

function toCamel(property: string): string {
  return property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** The small picture of a setting at its value. */
export function TuningSampleTile({ sample, value }: { sample: TuningSample; value: TuningValue }) {
  const shown = value === undefined || value === '' ? undefined : `${value}${sample.unit ?? ''}`;
  return (
    <span
      aria-hidden="true"
      data-tuning-sample
      className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-control)] border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] leading-none text-[var(--text-primary)]"
      style={shown ? { [toCamel(sample.css_property)]: shown } as React.CSSProperties : undefined}
    >
      {sample.text ?? 'Aa'}
    </span>
  );
}

/** A colour: the swatch opens the wheel, the colour code sits beside it in the same field; both change it at once. */
export function TuningColorField({ label, value, presets, onChange }: {
  label: string; value: string; presets?: readonly string[]; onChange: (hex: string) => void;
}) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(value);
  useEffect(() => { setTyped(value); }, [value]);
  const code = colourCode(value);
  const drawable = code !== null || (typeof CSS !== 'undefined' && CSS.supports('color', value));
  return (
    <span className="inline-flex h-9 min-w-0 shrink-0 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] pl-1 pr-2 focus-within:ring-1 focus-within:ring-[var(--border-focus)]" data-tuning-color>
      <button
        ref={anchor}
        type="button"
        aria-label={`Pick ${label.toLowerCase()}`}
        aria-expanded={open}
        className="size-7 shrink-0 cursor-pointer rounded-[calc(var(--radius-control)-2px)] border border-[var(--border-primary)] shadow-sm transition-transform hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-color)] motion-reduce:transition-none"
        style={{ background: drawable ? value : 'transparent' }}
        onClick={() => setOpen(current => !current)}
      />
      <input
        aria-label={label}
        spellCheck={false}
        className="w-16 min-w-0 bg-transparent font-mono text-xs tabular-nums text-[var(--text-primary)] outline-none"
        value={typed}
        onChange={event => {
          const next = event.currentTarget.value.trim();
          const withHash = next.startsWith('#') ? next : `#${next}`;
          setTyped(next);
          if (HEX.test(withHash)) onChange(withHash.toLowerCase());
        }}
        onBlur={() => setTyped(value)}
      />
      <ColorPickerPopover
        anchorRef={anchor as React.RefObject<HTMLElement>}
        open={open}
        value={code ?? '#000000'}
        presets={presets}
        title={label}
        placement="below"
        onChange={onChange}
        onDismiss={() => setOpen(false)}
      />
    </span>
  );
}

/** A number: a track to drag and the number beside it to type, with its unit. */
export function TuningSliderField({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (value: number) => void;
}) {
  const [typed, setTyped] = useState(String(value));
  useEffect(() => { setTyped(String(value)); }, [value]);
  const filled = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3" data-tuning-slider>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full accent-[var(--accent-primary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]"
        style={{ background: `linear-gradient(to right, var(--accent-primary) ${filled}%, var(--glass-bg-hover) ${filled}%)` }}
        onChange={event => onChange(event.currentTarget.valueAsNumber)}
      />
      <span className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-[var(--radius-control)] border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] px-2 focus-within:ring-1 focus-within:ring-[var(--border-focus)]">
        <input
          aria-label={`${label} value`}
          inputMode="decimal"
          className="w-10 bg-transparent text-right text-xs tabular-nums text-[var(--text-primary)] outline-none"
          value={typed}
          onChange={event => {
            setTyped(event.currentTarget.value);
            const n = Number.parseFloat(event.currentTarget.value);
            if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
          }}
          onBlur={() => setTyped(String(value))}
        />
        {unit ? <span className="text-xs text-[var(--text-muted)]">{unit}</span> : null}
      </span>
    </span>
  );
}

/** Choices drawn as themselves (a font in its own face), plus your own typed value. */
function ChoicesWidget({ setting, value, onChange }: TuningControlProps) {
  const current = value === undefined || Array.isArray(value) ? '' : String(value);
  const options = setting.options ?? [];
  const property = setting.options_drawn_with ? toCamel(setting.options_drawn_with) : null;
  const known = options.some(option => option.value === current);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5" data-tuning-choices>
      {options.map(option => {
        const chosen = option.value === current;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={chosen}
            className={cn(
              'h-8 max-w-[11rem] truncate rounded-[var(--radius-control)] border px-3 text-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]',
              chosen
                ? 'border-[var(--accent-primary)] bg-[var(--glass-bg-active)] text-[var(--text-primary)]'
                : 'border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)]',
            )}
            style={property ? { [property]: option.value } as React.CSSProperties : undefined}
            onClick={() => onChange(setting.key, option.value)}
          >
            {option.label}
          </button>
        );
      })}
      <input
        aria-label={`${setting.label}, your own`}
        placeholder="Your own"
        className={cn(
          'h-8 w-28 min-w-0 rounded-[var(--radius-control)] border bg-[var(--glass-bg-subtle)] px-2 text-sm text-[var(--text-primary)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]',
          !known && current ? 'border-[var(--accent-primary)]' : 'border-[var(--border-primary)]',
        )}
        style={property && !known && current ? { [property]: current } as React.CSSProperties : undefined}
        value={known ? '' : current}
        onChange={event => onChange(setting.key, event.currentTarget.value)}
      />
    </span>
  );
}

/** Several of the choices at once (snap points, days), each a chip that turns on or off. */
function ManyWidget({ setting, value, onChange }: TuningControlProps) {
  const chosen = new Set(Array.isArray(value) ? value : []);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5" data-tuning-many>
      {(setting.options ?? []).map(option => {
        const on = chosen.has(option.value);
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            className={cn(
              'h-8 min-w-10 rounded-[var(--radius-control)] border px-3 text-sm tabular-nums transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]',
              on
                ? 'border-[var(--accent-primary)] bg-[var(--glass-bg-active)] text-[var(--text-primary)]'
                : 'border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] text-[var(--text-muted)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)]',
            )}
            onClick={() => {
              const next = (setting.options ?? []).map(row => row.value).filter(id => (id === option.value ? !on : chosen.has(id)));
              onChange(setting.key, next);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </span>
  );
}

/** The control for each kind of setting, by the setting's `widget` id. A new kind is one entry. */
export const TUNING_WIDGETS: Record<string, (props: TuningControlProps) => React.ReactNode> = {
  color: ({ setting, value, onChange }) => (
    <TuningColorField label={setting.label} value={String(value ?? '')} presets={setting.presets} onChange={hex => onChange(setting.key, hex)} />
  ),
  slider: ({ setting, value, onChange }) => {
    const min = setting.min ?? 0;
    const max = setting.max ?? 100;
    return (
      <TuningSliderField
        label={setting.label}
        value={numberOf(value, numberOf(setting.default_value, min))}
        min={min}
        max={max}
        step={setting.step ?? 1}
        unit={setting.unit}
        onChange={next => onChange(setting.key, next)}
      />
    );
  },
  segmented: ({ setting, value, onChange }) => (
    <SegmentedControl
      ariaLabel={setting.label}
      items={(setting.options ?? []).map(option => ({ id: option.value, label: option.label }))}
      value={String(value ?? '')}
      onValueChange={next => onChange(setting.key, next)}
    />
  ),
  // On or off. With two options the value is the option's value (off first, then on); without, true or false.
  toggle: ({ setting, value, onChange }) => {
    const [off, on] = setting.options?.length === 2 ? setting.options.map(option => option.value) : [false, true];
    return <Switch label={setting.label} checked={value === on || (on === true && value === 'true')} onCheckedChange={next => onChange(setting.key, next ? on : off)} />;
  },
  choices: (props) => <ChoicesWidget {...props} />,
  // A number drawn the way a design tool draws one: a compact field with its prefix to drag, its unit, arrow keys.
  number: ({ setting, value, onChange }) => (
    <ScrubField
      className="w-full"
      label={setting.label}
      prefix={setting.prefix}
      value={numberOf(value, numberOf(setting.default_value, setting.min ?? 0))}
      min={setting.min}
      max={setting.max}
      step={setting.step ?? 1}
      unit={setting.unit}
      onChange={next => onChange(setting.key, next)}
    />
  ),
  // One of many choices in a list that opens (a font, a blend); the options are DATA. Without a default, None
  // comes first and chooses nothing (an empty value).
  select: ({ setting, value, onChange }) => (
    <Dropdown
      aria-label={setting.label}
      items={[
        ...(setting.default_value === undefined ? [{ value: '', label: 'None' }] : []),
        ...(setting.options ?? []).map(option => ({ value: option.value, label: option.label })),
      ]}
      value={value === undefined || value === null ? '' : String(value)}
      align="end"
      onValueChange={next => onChange(setting.key, next)}
    />
  ),
  // A shadow: position, blur, spread, colour and opacity; null when there is none.
  shadow: ({ setting, value, onChange }) => (
    <ShadowField label={setting.label} unit={setting.unit} value={shadowOf(value)} onChange={next => onChange(setting.key, next)} />
  ),
  // A timing curve: drag its handles or pick a named curve (options whose values are "x1,y1,x2,y2").
  curve: ({ setting, value, onChange }) => (
    <CurveField
      label={setting.label}
      value={curveOf(value) ?? curveOf(setting.default_value) ?? LINEAR}
      presets={setting.options}
      onChange={(next: TuningCurve) => onChange(setting.key, next)}
    />
  ),
  many: (props) => <ManyWidget {...props} />,
  // Words: what a heading, a line or a button says, typed in place; every keystroke is a change.
  words: ({ setting, value, onChange }) => (
    <Textarea aria-label={setting.label} rows={String(value ?? '').length > 60 ? 3 : 1} value={String(value ?? '')} onChange={event => onChange(setting.key, event.currentTarget.value)} />
  ),
  // A button's look: each choice drawn as the shared button in that look, so the person picks what they see.
  button: ({ setting, value, onChange }) => (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5" data-tuning-choices>
      {(setting.options ?? []).map(option => (
        <Button
          key={option.value}
          type="button"
          size="sm"
          variant={option.value as ButtonProps['variant']}
          aria-pressed={option.value === value}
          className={option.value === value ? 'ring-2 ring-[var(--accent-primary)] ring-offset-2 ring-offset-[var(--bg-primary)]' : undefined}
          onClick={() => onChange(setting.key, option.value)}
        >
          {option.label}
        </Button>
      ))}
    </span>
  ),
  // An icon: each choice drawn as the icon itself (its value a shared icon name), named by its label.
  icon: ({ setting, value, onChange }) => (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5" data-tuning-choices>
      {(setting.options ?? []).map(option => (
        <Button
          key={option.value}
          type="button"
          size="icon"
          variant={option.value === value ? 'secondary' : 'ghost'}
          aria-pressed={option.value === value}
          aria-label={option.label}
          title={option.label}
          className={option.value === value ? 'ring-2 ring-[var(--accent-primary)]' : undefined}
          onClick={() => onChange(setting.key, option.value)}
        >
          <NamedIcon name={option.value} size="sm" aria-hidden="true" />
        </Button>
      ))}
    </span>
  ),
  // A colour of the shared palette: each choice drawn as its own swatch (`data-colour`, screen-look --record-kind-<hue>);
  // an empty value is no colour.
  hue: ({ setting, value, onChange }) => (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5" data-tuning-choices>
      {(setting.options ?? []).map(option => (
        <Button
          key={option.value || 'none'}
          type="button"
          size="icon"
          variant="ghost"
          aria-pressed={option.value === (value ?? '')}
          aria-label={option.label}
          title={option.label}
          data-colour={option.value || undefined}
          className={cn('colour-dot rounded-full', option.value === (value ?? '') && 'ring-2 ring-[var(--accent-primary)] ring-offset-2 ring-offset-[var(--bg-primary)]')}
          onClick={() => onChange(setting.key, option.value)}
        >
          {option.value ? null : <NamedIcon name="Ban" size="xs" aria-hidden="true" />}
        </Button>
      ))}
    </span>
  ),
};

const LINEAR: TuningCurve = [0, 0, 1, 1];

function shadowOf(value: TuningValue): TuningShadow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as TuningShadow;
  const n = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return { x: n(row.x, 0), y: n(row.y, 0), blur: n(row.blur, 0), spread: n(row.spread, 0), colour: typeof row.colour === 'string' ? row.colour : '#000000', opacity: n(row.opacity, 1) };
}

/** Where each widget's control sits: `under` its label (a full-width track, a row of choices), in the inspector's
 *  label `column` (compact design-tool fields), or `beside` the label at the row's end (anything not listed). */
export const TUNING_PLACEMENT: Readonly<Record<string, 'under' | 'column'>> = {
  slider: 'under', choices: 'under', many: 'under', words: 'under', button: 'under', icon: 'under', hue: 'under',
  shadow: 'under', curve: 'under',
  number: 'column', select: 'column', color: 'column', toggle: 'column',
};

export function TuningControl({ setting, value, onChange, values }: TuningControlProps) {
  const draw = TUNING_WIDGETS[setting.widget] ?? TUNING_WIDGETS.slider;
  // A setting drawn with a sample tile keeps the tile beside its label, so it sits at the row's end.
  const placed = setting.settings?.length ? 'column' : TUNING_PLACEMENT[setting.widget] ?? 'beside';
  const placement = placed === 'column' && setting.sample ? 'beside' : placed;
  const differs = setting.default_value !== undefined && value !== undefined && JSON.stringify(value) !== JSON.stringify(setting.default_value);
  // One way back to the setting's own value, wherever the control sits.
  const reset = (
    <button
      type="button"
      aria-label={`Reset ${setting.label.toLowerCase()}`}
      title="Reset"
      className="grid size-5 shrink-0 place-items-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]"
      onClick={() => onChange(setting.key, setting.default_value)}
    >
      <NamedIcon name="RotateCcw" size="xs" aria-hidden="true" />
    </button>
  );
  if (placement === 'column') {
    return (
      <div data-tuning-setting={setting.key} className="grid min-w-0 grid-cols-[minmax(4.5rem,7rem)_minmax(0,1fr)] items-start gap-x-2 py-1.5">
        <span className="flex h-7 min-w-0 items-center gap-1">
          <span className="truncate text-xs text-[var(--text-secondary)]" title={setting.note ?? setting.label}>{setting.label}</span>
          {differs ? reset : null}
        </span>
        {setting.settings?.length ? (
          <span className={cn('grid min-w-0 gap-1.5', setting.settings.length > 1 && 'grid-cols-2')}>
            {setting.settings.map(part => (
              <span key={part.key} className="min-w-0" data-tuning-setting={part.key}>
                {(TUNING_WIDGETS[part.widget] ?? TUNING_WIDGETS.number)({ setting: part, value: values?.[part.key], onChange, values })}
              </span>
            ))}
          </span>
        ) : (
          <span className="flex min-w-0 items-center justify-end">{draw({ setting, value, onChange, values })}</span>
        )}
      </div>
    );
  }
  const under = placement === 'under';
  return (
    <div
      data-tuning-setting={setting.key}
      className={cn('min-w-0 py-2.5', under ? 'grid gap-2' : 'flex items-center justify-between gap-3')}
    >
      <span className={cn('flex min-w-0 items-center gap-3', under && 'w-full')}>
        {setting.sample ? <TuningSampleTile sample={setting.sample} value={value} /> : null}
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate text-xs text-[var(--text-secondary)]">{setting.label}</span>
          {setting.note ? <span className="truncate text-xs text-[var(--text-muted)]">{setting.note}</span> : null}
        </span>
        {differs ? reset : null}
      </span>
      {draw({ setting, value, onChange, values })}
    </div>
  );
}

export function TuningPanel({ sections, values, onChange, preview, header, footer, className, disabled = false, search }: TuningPanelProps) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const term = search ? query.trim().toLocaleLowerCase() : '';
  // Frappe Builder's BlockProperties: searching a section reveals its controls;
  // searching a setting retains its real row and current value. Closing a search
  // restores the person's section folds without changing any setting.
  const matches = (setting: TuningSetting): boolean => `${setting.label} ${setting.key} ${setting.note ?? ''}`.toLocaleLowerCase().includes(term)
    || Boolean(setting.settings?.some(matches));
  const shown = term ? sections.flatMap(section => {
    const settings = section.title.toLocaleLowerCase().includes(term) ? section.settings : section.settings.filter(matches);
    return settings.length ? [{ ...section, settings }] : [];
  }) : sections;
  return (
    <div className={cn('@container/tuning w-full min-w-0', className)} data-tuning-panel>
      <div className={cn('grid min-w-0 gap-5', preview ? '@3xl/tuning:grid-cols-[minmax(17rem,24rem)_minmax(0,1fr)]' : '')}>
        {preview ? (
          <div className="min-w-0 @3xl/tuning:order-2" data-tuning-preview>
            <div className="@3xl/tuning:sticky @3xl/tuning:top-0">{preview}</div>
          </div>
        ) : null}
        <div className="grid min-w-0 content-start gap-4 @3xl/tuning:order-1">
          {header}
          {search ? <div data-tuning-search><SearchField label={search.label} placeholder={search.placeholder} value={query}
            onChange={event => setQuery(event.currentTarget.value)} onKeyDown={event => {
              if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); }
            }} /></div> : null}
          <fieldset disabled={disabled} className="m-0 grid min-w-0 gap-4 border-0 p-0 disabled:opacity-60">
          {shown.map(section => (
            <section key={section.id} className="grid min-w-0 border-t border-[var(--border-primary)] pt-2 first:border-t-0 first:pt-0" data-tuning-section={section.id} aria-label={section.title}>
              <h3 className="m-0">
                <button
                  type="button"
                  aria-expanded={Boolean(term) || !folded.has(section.id)}
                  className="flex h-7 w-full items-center justify-between gap-2 rounded-[var(--radius-control)] text-left text-sm font-semibold text-[var(--text-primary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]"
                  onClick={() => setFolded(current => {
                    const next = new Set(current);
                    if (next.has(section.id)) next.delete(section.id); else next.add(section.id);
                    return next;
                  })}
                >
                  {section.title}
                  <NamedIcon name={!term && folded.has(section.id) ? 'ChevronRight' : 'ChevronDown'} size="xs" aria-hidden="true" className="text-[var(--text-muted)]" />
                </button>
              </h3>
              {!term && folded.has(section.id) ? null : (
                <div className="grid min-w-0">
                  {section.settings.map(setting => (
                    <TuningControl key={setting.key} setting={setting} value={values[setting.key]} values={values} onChange={onChange} />
                  ))}
                </div>
              )}
            </section>
          ))}
          {term && !shown.length ? <Empty data-tuning-search-empty role="status" className="p-3 md:p-3">
            <EmptyHeader><EmptyMedia variant="icon"><NamedIcon name="Search" aria-hidden="true" /></EmptyMedia>
              <EmptyDescription>{search?.empty}</EmptyDescription></EmptyHeader>
          </Empty> : null}
          </fieldset>
          {footer}
        </div>
      </div>
    </div>
  );
}
