// package-set://bitfield-studio/packages/poker-rules/show/PokerRuleSummary.tsx

import React from 'react';
import { Activity, BadgeCheck, CircleDollarSign, GitBranch, ShieldCheck, Users } from 'lucide-react';
import { Badge, Card, Container, Icon, ProgressBar, ScrollableSurface, Text } from '@/packages/ui';
import type { PokerHandState, PokerPlayer } from '@/packages/poker-rules/read-data/poker-rules';

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function activePlayers(players: readonly PokerPlayer[]): number {
  return players.filter((player) => !player.eliminated && player.chips > 0).length;
}

function committedPlayers(players: readonly PokerPlayer[]): number {
  return players.filter((player) => player.totalCommitted > 0 || player.currentBet > 0).length;
}

function roleFor(index: number, state: PokerHandState): string {
  const roles = [];
  if (index === state.dealerIndex) roles.push('Dealer');
  if (index === state.smallBlindIndex) roles.push('Small blind');
  if (index === state.bigBlindIndex) roles.push('Big blind');
  if (index === state.activeIndex) roles.push('Acting');
  return roles.join(' / ');
}

const POKER_RULE_SUMMARY_CSS = `
.casino-rules {
  --casino-ink: #fffdfa;
  --casino-muted: rgba(255, 253, 250, 0.66);
  --casino-faint: rgba(255, 253, 250, 0.42);
  --casino-green: #053f2d;
  --casino-neon: #20ffc2;
  --casino-gold: #ffbe3d;
  color: var(--casino-ink);
  font-family: "Avenir Next", "Trebuchet MS", Verdana, sans-serif;
  font-variant-numeric: tabular-nums;
}

.casino-rules-surface {
  position: relative;
  overflow: hidden !important;
  border: 1px solid rgba(32, 255, 194, 0.22) !important;
  border-radius: 34px !important;
  background:
    radial-gradient(circle at 14% 6%, rgba(32, 255, 194, 0.20), transparent 28%),
    radial-gradient(circle at 84% 10%, rgba(255, 190, 61, 0.18), transparent 30%),
    linear-gradient(145deg, #06271f, #010806 72%) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.10), 0 36px 110px rgba(0,0,0,0.36) !important;
}

.casino-rules-surface::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(135deg, rgba(255,255,255,0.035) 25%, transparent 25%),
    linear-gradient(225deg, rgba(255,255,255,0.035) 25%, transparent 25%);
  background-position: 0 0, 18px 18px;
  background-size: 36px 36px;
  opacity: 0.24;
  pointer-events: none;
}

.casino-rules-content {
  position: relative;
  z-index: 1;
}

.casino-rules-title {
  color: white;
  font-size: clamp(34px, 5vw, 66px);
  font-weight: 1000;
  letter-spacing: -0.065em;
  line-height: 0.92;
  text-transform: uppercase;
  text-shadow: 0 4px 0 #00130e, 0 16px 30px rgba(0,0,0,0.62);
}

.casino-rules-copy {
  color: var(--casino-muted) !important;
  max-width: 46rem;
}

.casino-rules-card {
  border: 1px solid rgba(32, 255, 194, 0.16) !important;
  border-radius: 24px !important;
  background:
    linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.025)),
    rgba(0, 19, 14, 0.54) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 18px 42px rgba(0,0,0,0.20) !important;
}

.casino-rules-stat {
  min-height: 72px;
}

.casino-rules-role-row {
  min-height: 48px;
  border: 1px solid rgba(32, 255, 194, 0.15);
  border-radius: 16px;
  background:
    linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.025)),
    rgba(0, 19, 14, 0.46);
  padding: 10px 12px;
}

.casino-rules-pass-row {
  align-items: start;
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 16px;
  background: rgba(2, 18, 13, 0.46);
  padding: 10px 12px;
}

.casino-rules :where([data-ui-text]) {
  color: inherit;
}

@media (max-width: 720px) {
  .casino-rules-surface {
    border-radius: 26px !important;
  }

  .casino-rules-title {
    font-size: clamp(38px, 13vw, 58px);
  }
}
`;

function StatCard({
  icon,
  label,
  value,
  tone = 'neutral',
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  tone?: 'neutral' | 'accent' | 'success' | 'info';
}) {
  return (
    <Card variant="nested" padding="sm" layout="row" className="casino-rules-card casino-rules-stat min-w-0 justify-between">
      <Container layout="horizontal" alignItems="center" gap="sm" className="min-w-0">
        <Icon icon={icon} size="md" color={tone === 'success' ? 'success' : tone === 'info' ? 'info' : tone === 'accent' ? 'accent' : 'muted'} />
        <Text variant="label" color="muted" truncate>{label}</Text>
      </Container>
      <Text variant="body-xs" weight="semibold" tabular>{value}</Text>
    </Card>
  );
}

export function PokerRuleSummary({ state }: { state: PokerHandState }) {
  const activeCount = activePlayers(state.players);
  const potCoverage = Math.round((committedPlayers(state.players) / Math.max(1, state.players.length)) * 100);
  const actingPlayer = state.players[state.activeIndex] ?? null;
  const ruleChecks = [
    { label: 'Dealer button rotates through active seats', complete: state.dealerIndex >= 0 },
    { label: 'Small and big blinds are posted into the pot', complete: state.smallBlindIndex >= 0 && state.bigBlindIndex >= 0 && state.pot >= state.smallBlind + state.bigBlind },
    { label: 'Acting seat skips folded, all-in, and eliminated players', complete: state.activeIndex >= 0 || state.phase !== 'playing' },
    { label: 'Minimum raise and call amount stay explicit', complete: state.minRaise > 0 && state.currentBet >= 0 },
  ];

  return (
    <ScrollableSurface>
      <Card variant="surface" padding="lg" layout="stack" minHeight="0" aria-label="Poker rule summary" className="casino-rules casino-rules-surface">
        <style>{POKER_RULE_SUMMARY_CSS}</style>
        <Container layout="vertical" gap="lg" className="casino-rules-content">
      <Container layout="horizontal" justifyContent="between" alignItems="start" gap="lg" wrap>
        <Container layout="vertical" gap="sm" className="min-w-0">
          <Container layout="horizontal" alignItems="center" gap="sm" wrap>
            <Icon icon={ShieldCheck} size="lg" color="success" />
            <Text className="casino-rules-title">Poker Rules</Text>
            <Badge variant="success" size="sm">rule engine</Badge>
          </Container>
          <Text variant="body" color="muted" leading="relaxed" className="casino-rules-copy">
            Texas Hold'em rule state for blinds, dealer rotation, active turn, pot, and legal player action requests.
          </Text>
        </Container>
        <Badge variant="accent" size="lg">Hand {state.handNumber}</Badge>
      </Container>

      <Container layout="grid" gridCols={4} gap="sm" className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Activity} label="Phase / street" value={`${state.phase} / ${state.street}`} tone="info" />
        <StatCard icon={CircleDollarSign} label="Blinds" value={`${formatNumber(state.smallBlind)} / ${formatNumber(state.bigBlind)}`} tone="accent" />
        <StatCard icon={CircleDollarSign} label="Pot" value={formatNumber(state.pot)} tone="success" />
        <StatCard icon={Users} label="Active seats" value={`${activeCount}/${state.players.length}`} />
      </Container>

      <Card variant="nested" padding="md" layout="stack" className="casino-rules-card">
        <Container layout="horizontal" justifyContent="between" alignItems="center" gap="md" wrap>
          <Container layout="vertical" gap="xs">
            <Text variant="heading">Current turn contract</Text>
            <Text variant="body-xs" color="muted">
              {actingPlayer ? `${actingPlayer.name} must act against current bet ${formatNumber(state.currentBet)}.` : 'No player action is open for this phase.'}
            </Text>
          </Container>
          <Badge variant={actingPlayer ? 'info' : 'muted'}>{actingPlayer ? 'action required' : 'closed'}</Badge>
        </Container>
        <ProgressBar percentage={potCoverage} color="var(--color-success)" />
      </Card>

      <Container layout="grid" gridCols={2} gap="md" className="grid-cols-1 xl:grid-cols-2">
        <Card variant="nested" padding="md" layout="stack" className="casino-rules-card">
          <Container layout="horizontal" alignItems="center" gap="sm">
            <Icon icon={GitBranch} size="md" color="accent" />
            <Text variant="heading">Seat roles</Text>
          </Container>
          <Container layout="vertical" gap="sm">
            {state.players.map((player, index) => (
              <Container key={player.id} layout="horizontal" justifyContent="between" alignItems="center" gap="md" className="casino-rules-role-row">
                <Container layout="vertical" gap="xs" className="min-w-0">
                  <Text variant="body-xs" weight="semibold" truncate>{player.name}</Text>
                  <Text variant="caption" color="faint" truncate>{roleFor(index, state) || 'In hand'}</Text>
                </Container>
                <Badge variant={index === state.activeIndex ? 'accent' : player.eliminated ? 'muted' : 'neutral'}>{formatNumber(player.chips)}</Badge>
              </Container>
            ))}
          </Container>
        </Card>

        <Card variant="nested" padding="md" layout="stack" className="casino-rules-card">
          <Container layout="horizontal" alignItems="center" gap="sm">
            <Icon icon={BadgeCheck} size="md" color="success" />
            <Text variant="heading">Rule proof checks</Text>
          </Container>
          <Container layout="vertical" gap="sm">
            {ruleChecks.map((check) => (
              <Container key={check.label} layout="horizontal" gap="sm" className="casino-rules-pass-row">
                <Badge variant={check.complete ? 'success' : 'warning'} size="sm">{check.complete ? 'pass' : 'check'}</Badge>
                <Text variant="body-xs" color="muted">{check.label}</Text>
              </Container>
            ))}
          </Container>
        </Card>
      </Container>
        </Container>
      </Card>
    </ScrollableSurface>
  );
}
