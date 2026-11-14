// packages/guided-overlay/show/NavButtons.tsx
//
// Renders a step's `nav.buttons[]` — each `{ role, label }` is DATA. The role is
// an OPEN string: the surface dispatches `onAction(role)` blindly (no switch). How
// each role's button looks (its variant, its words, whether the card's first focus
// lands on it) is DATA too: guided-overlay-defaults.json `buttons`, overridden by a
// tour's `look.buttons` and then a step's `look.buttons` (`buttonLooksOf`), so a
// look changed on the canvas for one step, one tour or every tour is one field of
// those rows. An unknown role still renders (`button_fallback`) and still fires its
// action (L083/L090).

import type { ReactElement } from 'react';
import { Button } from '../../ui/show/button/Button';
import { Container } from '../../ui/show/container/container';
import type { StepPerform } from '../do-work/dispatch-step-perform';
import defaults from 'trillion-workshop/tools/tours-screen/guided-overlay-defaults.json';

/** One nav button as it appears in step DATA. */
export interface NavButtonSpec {
  readonly role: string;
  readonly label: string;
  /**
   * Stage-skip grammar. A skip button with a valid target jumps there and persists
   * as an advance; without it, skip retains the legacy whole-tour exit semantic.
   */
  readonly skip_to?: string;
  /**
   * Opaque effect DATA for a non-internal button. When the surface dispatches this
   * button's role, it blindly runs `perform` as one Envelope request (no role/target
   * enumerated in source). Absent = a pure-dismiss button (skip/close) that just exits.
   */
  readonly perform?: StepPerform;
}

/** How one role's button looks: its Button variant, words that replace its label, and whether it takes first focus. */
export interface ButtonLook {
  readonly variant?: string;
  readonly label?: string;
  readonly autofocus?: boolean;
}
export type ButtonLooks = Readonly<Record<string, ButtonLook>>;

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'plain' | 'outline' | 'danger' | 'accent' | 'success' | 'confirm';
const DEFAULT_LOOKS = (defaults as { buttons?: Record<string, ButtonLook> }).buttons ?? {};
const FALLBACK = (defaults as { button_fallback?: ButtonLook }).button_fallback ?? { variant: 'secondary' };

const looksIn = (holder: unknown): Record<string, ButtonLook> => {
  const buttons = (holder as { buttons?: unknown } | undefined)?.buttons;
  return buttons && typeof buttons === 'object' && !Array.isArray(buttons) ? buttons as Record<string, ButtonLook> : {};
};

/** Each role's look for one step: the defaults, then the tour's `look.buttons`, then the step's, field by field. */
export function buttonLooksOf(definition: { look?: unknown } | null, step: { look?: unknown } | null): ButtonLooks {
  const layers = [DEFAULT_LOOKS, looksIn(definition?.look), looksIn(step?.look)];
  const roles = new Set(layers.flatMap(layer => Object.keys(layer)));
  return Object.fromEntries([...roles].map(role => [role, Object.assign({}, ...layers.map(layer => layer[role] ?? {})) as ButtonLook]));
}

/** One role's look, the fallback filling what no layer says. */
export const lookOfRole = (looks: ButtonLooks | undefined, role: string): ButtonLook => ({ ...FALLBACK, ...(looks?.[role] ?? DEFAULT_LOOKS[role] ?? {}) });

export interface NavButtonsProps {
  readonly buttons: readonly NavButtonSpec[];
  /** Fired with the raw role string — the surface decides what each role does. */
  readonly onAction: (role: string) => void;
  /** A per-role disabled predicate (e.g. advance gated by advance_condition). */
  readonly isDisabled?: (role: string) => boolean;
  /** Each role's look (`buttonLooksOf`); the defaults when left out. */
  readonly looks?: ButtonLooks;
}

/** A row of data-driven nav buttons. */
export function NavButtons({ buttons, onAction, isDisabled, looks }: NavButtonsProps): ReactElement | null {
  if (buttons.length === 0) return null;
  return (
    <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
      {buttons.map((b) => {
        const look = lookOfRole(looks, b.role);
        return (
          <Button
            key={b.role}
            variant={look.variant as ButtonVariant}
            size="sm"
            disabled={isDisabled?.(b.role) ?? false}
            onClick={() => onAction(b.role)}
            data-nav-role={b.role}
            // The card's first focus lands on the button that does the step, never on its way out.
            data-autofocus={look.autofocus ? '' : undefined}
          >
            {look.label || b.label}
          </Button>
        );
      })}
    </Container>
  );
}
