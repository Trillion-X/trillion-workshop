// packages/group/show/BoardHabitLayer.tsx
//
// The at-a-glance + one-tap surface for the habit primitive: a streak badge on every item that is a
// tracked habit (🔥 N), which is ALSO the "log today" toggle — filled/primary when today is already
// logged, click to log or un-log. Generic + DATA-driven: it renders whatever pills it is handed and
// never names an item; the mount resolves each item to a screen rect + computes the streak. L065: ui
// only; the badge is a positioned Container because its coordinate is dynamic.

import { Button, Container, Text } from '../../ui/index.ts';

export interface HabitPillRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One pill: an item's screen rect + its (cadence-aware) streak + whether today is already logged. For a
 *  cadence habit, `cadence` carries this period's progress so the badge reads "🔥 2 · 2/3" instead of a
 *  false "🔥 0" (a 3x/week habit rarely has consecutive days). */
export interface HabitPill {
  readonly memberId: string;
  readonly rect: HabitPillRect;
  readonly streak: number;
  readonly loggedToday: boolean;
  readonly cadence?: { readonly done: number; readonly target: number };
}

export interface BoardHabitLayerProps {
  readonly pills: readonly HabitPill[];
  readonly onToggleToday: (memberId: string) => void;
}

/** The badge text — cadence habits show this period's progress (with the streak when it exists) so the
 *  card never reads a misleading "🔥 0" while on cadence; daily habits show the plain fire streak. */
function badgeOf(pill: HabitPill): string {
  if (pill.cadence) {
    const prog = `${pill.cadence.done}/${pill.cadence.target}`;
    return pill.streak > 0 ? `\u{1F525} ${pill.streak} · ${prog}` : prog;
  }
  return `\u{1F525} ${pill.streak}`;
}

export function BoardHabitLayer({ pills, onToggleToday }: BoardHabitLayerProps): JSX.Element {
  return (
    <>
      {pills.map((pill) => {
        const badge = badgeOf(pill);
        return (
          <Container
            key={pill.memberId}
            position="absolute"
            style={{ left: pill.rect.x - 6, top: pill.rect.y + pill.rect.h - 8, zIndex: 56 }}
          >
            <Button
              variant={pill.loggedToday ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => onToggleToday(pill.memberId)}
              aria-label={pill.loggedToday ? `Un-log today for ${pill.memberId} (${badge})` : `Log today for ${pill.memberId} (${badge})`}
            >
              <Text variant="caption">{badge}</Text>
            </Button>
          </Container>
        );
      })}
    </>
  );
}
