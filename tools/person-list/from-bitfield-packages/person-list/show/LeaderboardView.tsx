// package://packages/person-list/show/LeaderboardView.tsx
//
// Leaderboard screen, laid out like the reference (Skool): a hero card with
// the viewer's avatar, level, and points beside the level ladder; below it
// three side-by-side boards — 7-day, 30-day, all-time — each a ranked list
// of avatar rows with right-aligned points.
//
// Ranks come from real activity: signed_event_effect rows scored by the
// weights in the leaderboard-config published input. All scoring is
// data-driven — retuning points or renaming levels is a record edit, never
// a code change. Aggregation lives in read-data/read-leaderboard.ts as pure
// functions.

import React, { useEffect, useMemo, useState } from 'react';
import { Trophy } from 'lucide-react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  Card,
  Container,
  DisplayMark,
  EmptyPlaceholder,
  Spinner,
  StatementHeader,
  Text,
} from '@/packages/ui';
import { RankRow } from './RankRow';
import {
  decodeEffectRows,
  decodeLeaderboardConfig,
  levelFor,
  metricValue,
  rankActors,
  type LeaderboardConfig,
  type LevelThreshold,
  type MetricDescriptor,
  type RankedActor,
} from '../../../read-data/read-leaderboard';
import {
  decodeAddressedRecords,
  decodeFieldValueRows,
  decodeRecordFieldDescriptors,
  joinFieldValuesToRecords,
} from '../../../read-data/read-people';
import { readActivityEffects } from '../do-work/read-activity-effects';
import { useCurrentActorRef } from '../read-data/use-current-actor';

// ---------------------------------------------------------------------------
// HERO — viewer identity + level ladder (reference: avatar left, levels right)
// ---------------------------------------------------------------------------

interface HeroProps {
  name: string;
  level: LevelThreshold;
  points: number;
  levels: readonly LevelThreshold[];
}

function Hero({ name, level, points, levels }: HeroProps) {
  return (
    <Card padding="lg" layout="row">
      <Container alignItems="center" gap="sm" padding="none" flex={1}>
        <DisplayMark name={name} size="xl" />
        <Container gap="none" padding="none" alignItems="center">
          <Text variant="heading-lg" color="strong">{name}</Text>
          <Text variant="body-xs" color="muted">Level {level.level} · {level.name}</Text>
          <Text variant="caption" color="accent" tabular>{points} points</Text>
        </Container>
      </Container>
      <Container gap="xs" padding="none" flex={1}>
        {levels.map((row) => {
          const reached = points >= row.min_points;
          return (
            <Container key={row.level} layout="horizontal" alignItems="center" gap="sm" padding="none">
              <DisplayMark name={String(row.level)} size="xs" />
              <Text
                variant="body-xs"
                color={row.level === level.level ? 'strong' : reached ? 'muted' : 'dim'}
                weight={row.level === level.level ? 'medium' : undefined}
              >
                Level {row.level} · {row.name}
              </Text>
              <Container flex={1} padding="none" gap="none" />
              <Text variant="caption" color="dim" tabular>{row.min_points}+ pts</Text>
            </Container>
          );
        })}
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// BOARD — one ranked window (reference: card per window, rows w/ rank,
// avatar, name, right-aligned points)
// ---------------------------------------------------------------------------

interface BoardProps {
  metric: MetricDescriptor;
  ranking: readonly RankedActor[];
  nameByActor: ReadonlyMap<string, string>;
  viewerRef: string;
}

function Board({ metric, ranking, nameByActor, viewerRef }: BoardProps) {
  const rows = [...ranking]
    .filter((row) => metricValue(row, metric.key) > 0)
    .sort((a, b) => metricValue(b, metric.key) - metricValue(a, metric.key) || a.actorRef.localeCompare(b.actorRef))
    .slice(0, 10);
  return (
    <Card padding="md" layout="stack" flex={1}>
      <Text variant="heading-xs" color="secondary">{metric.label}</Text>
      {rows.length === 0 ? (
        <Text variant="caption" color="dim">No activity in this window</Text>
      ) : (
        <Container gap="none" padding="none">
          {rows.map((row, index) => {
            const name = nameByActor.get(row.actorRef) ?? row.actorRef;
            const isYou = row.actorRef === viewerRef;
            return (
              <RankRow
                key={row.actorRef}
                rank={index + 1}
                title={isYou ? `${name} (you)` : name}
                avatarName={name}
                value={`+${metricValue(row, metric.key)}`}
                highlighted={isYou}
              />
            );
          })}
        </Container>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

export function LeaderboardView(props: Record<string, unknown> = {}) {
  const configFeed = useBitfieldData('leaderboard-config');
  const peopleFeed = useBitfieldData('people');
  const profilesFeed = useBitfieldData('person-profiles');
  const fieldDescriptorFeed = useBitfieldData('record-field-descriptors');
  const viewerRef = useCurrentActorRef(props);
  const fieldDescriptors = useMemo(
    () => decodeRecordFieldDescriptors(fieldDescriptorFeed),
    [fieldDescriptorFeed],
  );

  const [effectsRaw, setEffectsRaw] = useState<readonly unknown[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void readActivityEffects(controller.signal)
      .then((rows) => setEffectsRaw(rows))
      .catch(() => {
        if (!controller.signal.aborted) setEffectsRaw([]);
      });
    return () => controller.abort();
  }, []);

  const config: LeaderboardConfig | null = useMemo(
    () => decodeLeaderboardConfig(configFeed),
    [configFeed],
  );
  const rows = useMemo(() => decodeEffectRows(effectsRaw ?? []), [effectsRaw]);

  const ranking = useMemo(() => {
    if (!config) return [];
    const ranked = rankActors(rows, config.weights, config.metrics, Date.now(), config.sortMetricKey);
    console.log(`[person-list] leaderboard actors=${ranked.length} effects=${rows.length}`);
    return ranked;
  }, [rows, config]);

  // Resolve display names from the people directory join.
  const nameByActor = useMemo(() => {
    const fieldValues = decodeFieldValueRows(profilesFeed);
    const { records } = joinFieldValuesToRecords(
      decodeAddressedRecords(peopleFeed, fieldDescriptors),
      fieldValues,
      fieldDescriptors,
    );
    const map = new Map<string, string>();
    for (const record of records) map.set(record.id, record.title);
    return map;
  }, [fieldDescriptors, peopleFeed, profilesFeed]);

  const myRow = ranking.find((row) => row.actorRef === viewerRef);
  const myPoints = metricValue(myRow, config?.sortMetricKey ?? '');
  const myLevel = config ? levelFor(myPoints, config.levels) : null;
  const myName = nameByActor.get(viewerRef) ?? viewerRef;

  const isLoading = effectsRaw === null || configFeed === null;

  return (
    <Container height="full" overflow="y-auto" width="full" padding="none">
      <Container as="section" gap="lg" padding="xl" maxWidth="5xl" width="full" centered>
        <StatementHeader
          kicker="Leaderboard"
          statement="Earn your place. Every contribution counts."
          subtitle="Points come from posts, replies, likes, and finished quests across your communities."
        />

        {isLoading ? (
          <Container layout="vertical" gap="sm" padding="xl" alignItems="center" flex={1}>
            <Spinner />
            <Text variant="body-xs" color="muted">Loading activity...</Text>
          </Container>
        ) : !config || ranking.length === 0 ? (
          <EmptyPlaceholder
            icon={Trophy}
            message="Post, comment, and like to earn the first points"
          />
        ) : (
          <>
            {myLevel ? (
              <Hero name={myName} level={myLevel} points={myPoints} levels={config.levels} />
            ) : null}

            <Container layout="horizontal" alignItems="start" gap="md" padding="none" width="full" wrap>
              {config.metrics.map((metric) => (
                <Board
                  key={metric.key}
                  metric={metric}
                  ranking={ranking}
                  nameByActor={nameByActor}
                  viewerRef={viewerRef}
                />
              ))}
            </Container>
          </>
        )}
      </Container>
    </Container>
  );
}
