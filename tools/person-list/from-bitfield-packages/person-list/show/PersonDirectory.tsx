// package://packages/person-list/show/PersonDirectory.tsx
//
// People directory screen. Reads the declared `people`, `person-search`,
// and `person-profiles` inputs, lets the viewer narrow the list as they
// type, and sends a search-people request when they press Enter or the
// Search button so the wider system can look further than what is already
// on screen.
//
// Clicking a person row opens their profile surface via
// emitPlaceableSurfaceIntent with surfaceInput.actor_ref (BRTK5016: no
// source import from person-profile; package/entry names are string data).

import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { Search, Users } from 'lucide-react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { SelectablePillBar } from '../../../../ui/show/selectable-pill-bar';
import type { SelectablePillBarItem } from '../../../../ui/show/selectable-pill-bar';
import {
  Badge,
  Button,
  Card,
  Container,
  DisplayMark,
  EmptyPlaceholder,
  Icon,
  Input,
  Spinner,
  StatementHeader,
  Text,
  emitPlaceableSurfaceIntent,
} from '../../../../ui';
import {
  decodeAddressedRecords,
  decodeFieldValueRows,
  decodeRecordFieldDescriptors,
  filterAddressedRecords,
  joinFieldValuesToRecords,
  mergeAddressedRecords,
  type JoinedAddressedRecord,
} from '../../../read-data/read-people';
import {
  decodeEffectRows,
  decodeLeaderboardConfig,
  levelFor,
  metricValue,
  rankActors,
} from '../../../read-data/read-leaderboard';
import { decodeOwnerActionDescriptors } from '../do-work/owner-action-descriptors';
import { readActivityEffects } from '../do-work/read-activity-effects';
import { searchPeople } from '../do-work/search-people';
import { refreshPeople } from '../do-work/refresh-people';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openPersonProfile(actorRef: string): void {
  // Open person-profile surface with actor_ref so ProfileView can show
  // that person's details. Package + entry names are string data, not imports.
  emitPlaceableSurfaceIntent({
    id: 'person-profile.panel',
    title: 'Profile',
    materialTarget: 'person-profile',
    packageEntry: {
      packageName: 'person-profile',
      entryName: 'person-profile',
    },
    surfaceInput: {
      actor_ref: actorRef,
      active_actor_ref: actorRef,
    },
  });
}

// ----------------------------------------------------------------------------
// PERSON CARD
// ----------------------------------------------------------------------------

function detailLabel(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

const PersonCard = React.memo(function PersonCard({
  person,
  levelName,
  onClick,
}: {
  person: JoinedAddressedRecord;
  /** Standing label derived from leaderboard config (data) — optional. */
  levelName?: string;
  onClick: (actorRef: string) => void;
}) {
  const handleClick = useCallback(() => onClick(person.id), [onClick, person.id]);
  const detail = detailLabel(person.detail);
  return (
    <Card
      padding="md"
      layout="row"
      interactive
      onClick={handleClick}
      role="button"
      aria-label={`Open ${person.title}'s profile`}
    >
      <DisplayMark name={person.title} size="lg" />
      <Container layout="vertical" gap="none" padding="none" flex={1} minWidth="0">
        <Text variant="body" color="strong" weight="semibold" truncate>
          {person.title}
        </Text>
        {person.subtitle ? (
          <Text variant="body-xs" color="muted" clamp={1}>
            {person.subtitle}
          </Text>
        ) : null}
        {detail ? (
          <Text variant="caption" color="dim" truncate>
            {detail}
          </Text>
        ) : null}
      </Container>
      <Container layout="vertical" gap="xs" padding="none" alignItems="end">
        {levelName ? (
          <Badge variant="accent-solid" size="sm" weight="semibold">{levelName}</Badge>
        ) : null}
      </Container>
    </Card>
  );
});

// ----------------------------------------------------------------------------
// COMPONENT
// ----------------------------------------------------------------------------

function humanizeRoleRef(roleRef: string): string {
  const tail = roleRef.includes(':') ? roleRef.slice(roleRef.lastIndexOf(':') + 1) : roleRef;
  return tail
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

export function PersonDirectory() {
  const peopleFeed = useBitfieldData('people');
  const searchFeed = useBitfieldData('person-search');
  const profilesFeed = useBitfieldData('person-profiles');
  const configFeed = useBitfieldData('leaderboard-config');
  const participantsFeed = useBitfieldData('subject-participants');
  const fieldDescriptorFeed = useBitfieldData('record-field-descriptors');
  const actionDescriptorFeed = useBitfieldData('owner-action-descriptors');
  const fieldDescriptors = useMemo(
    () => decodeRecordFieldDescriptors(fieldDescriptorFeed),
    [fieldDescriptorFeed],
  );
  const actionDescriptors = useMemo(
    () => decodeOwnerActionDescriptors(actionDescriptorFeed),
    [actionDescriptorFeed],
  );

  // Standing per person — all-time points run through the same data-owned
  // weights/levels the leaderboard uses (one scoring truth, two screens).
  const [levelByActor, setLevelByActor] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    const config = decodeLeaderboardConfig(configFeed);
    if (!config) return;
    let cancelled = false;
    void readActivityEffects()
      .then((raw) => {
        if (cancelled || raw === null) return;
        const ranked = rankActors(
          decodeEffectRows(raw),
          config.weights,
          config.metrics,
          Date.now(),
          config.sortMetricKey,
        );
        const next = new Map<string, string>();
        for (const row of ranked) {
          next.set(row.actorRef, levelFor(metricValue(row, config.sortMetricKey), config.levels).name);
        }
        setLevelByActor(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [configFeed]);
  // Role filter pills — vocabulary comes from membership rows (role_ref is data;
  // this component never enumerates role names). Pills appear only when
  // membership data exists, and only for roles that exist.
  const membershipRows = useMemo(() => {
    const rows = Array.isArray(participantsFeed)
      ? participantsFeed
      : participantsFeed && typeof participantsFeed === 'object' && Array.isArray((participantsFeed as { rows?: unknown[] }).rows)
        ? (participantsFeed as { rows: unknown[] }).rows
        : [];
    const out: Array<{ actorRef: string; roleRef: string }> = [];
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const actorRef = typeof row.actor_ref === 'string' ? row.actor_ref : '';
      const roleRef = typeof row.role_ref === 'string' ? row.role_ref : '';
      if (actorRef && roleRef) out.push({ actorRef, roleRef });
    }
    console.log(`[person-list] membership rows=${out.length} feed=${participantsFeed === null ? 'null' : typeof participantsFeed}`);
    return out;
  }, [participantsFeed]);

  const roleFilters = useMemo<SelectablePillBarItem[]>(() => {
    const counts = new Map<string, number>();
    for (const row of membershipRows) counts.set(row.roleRef, (counts.get(row.roleRef) ?? 0) + 1);
    return Array.from(counts.keys())
      .sort()
      .map((roleRef) => ({ id: roleRef, label: humanizeRoleRef(roleRef) }));
  }, [membershipRows]);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);

  const [search, setSearch] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Loading is an ACTIVE-FETCH state, not "the feed is still null". A null people
  // feed with no producer (e.g. a community with zero members yet) is a valid
  // terminal EMPTY state, not a permanent spinner. We start optimistic (we mount →
  // we will try to load) and settle the moment we know there is nothing to fetch or
  // the fetch has finished — so the surface can never hang on "Loading people...".
  const [refreshing, setRefreshing] = useState(true);

  useEffect(() => {
    // Nothing to dispatch (no refresh owner-action available, e.g. a community with
    // no people substrate yet) → we are NOT loading; render the current (empty) data.
    // Never wait on a feed that may never produce, or the surface hangs forever.
    if (actionDescriptors.length === 0) {
      setRefreshing(false);
      return;
    }
    setRefreshing(true);
    void refreshPeople(actionDescriptors)
      .catch(() => {})
      .finally(() => setRefreshing(false));
  }, [actionDescriptors]);

  const fieldValues = useMemo(() => decodeFieldValueRows(profilesFeed), [profilesFeed]);

  const rawPeople = useMemo(
    () => mergeAddressedRecords(
      decodeAddressedRecords(peopleFeed, fieldDescriptors),
      decodeAddressedRecords(searchFeed, fieldDescriptors),
    ),
    [peopleFeed, searchFeed, fieldDescriptors],
  );

  const people = useMemo(() => {
    const { records: joined, withFieldValues } = joinFieldValuesToRecords(
      rawPeople,
      fieldValues,
      fieldDescriptors,
    );
    console.log(`[person-list] people=${joined.length} withFieldValues=${withFieldValues}`);
    return joined;
  }, [rawPeople, fieldValues, fieldDescriptors]);

  // Only show the spinner while an actual refresh is in flight and we have nothing to show yet.
  const isLoading = refreshing && people.length === 0;

  const searchedPeople = useMemo(
    () => filterAddressedRecords(people, search, fieldDescriptors),
    [people, search, fieldDescriptors],
  );
  const visiblePeople = useMemo(() => {
    if (selectedRoles.length === 0) return searchedPeople;
    const allowed = new Set(
      membershipRows.filter((r) => selectedRoles.includes(r.roleRef)).map((r) => r.actorRef),
    );
    return searchedPeople.filter((person) => allowed.has(person.id));
  }, [searchedPeople, selectedRoles, membershipRows]);

  const submitSearch = useCallback(() => {
    const query = search.trim();
    if (query.length === 0 || isSearching) return;

    setIsSearching(true);
    setError(null);
    void searchPeople({
      eventRef: crypto.randomUUID(),
      query,
      requestedAt: new Date().toISOString(),
    }, actionDescriptors)
      .catch((err) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setIsSearching(false);
      });
  }, [actionDescriptors, isSearching, search]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') submitSearch();
    },
    [submitSearch],
  );

  let body: React.ReactNode;
  if (isLoading && people.length === 0) {
    body = (
      <Container layout="vertical" gap="sm" padding="xl" alignItems="center" flex={1}>
        <Spinner />
        <Text variant="body-xs" color="muted">
          Loading people...
        </Text>
      </Container>
    );
  } else if (people.length === 0) {
    body = <EmptyPlaceholder icon={Users} message="No people yet. New faces show up here." />;
  } else if (visiblePeople.length === 0) {
    body = <EmptyPlaceholder icon={Search} message={`No one matches "${search.trim()}" yet.`} />;
  } else {
    body = (
      <Container
        layout="vertical"
        gap="sm"
        padding="none"
        flex={1}
        minHeight="0"
        overflow="y-auto"
      >
        <Container layout="vertical" gap="sm" padding="none" width="full">
          {visiblePeople.map((person) => (
            <PersonCard
              key={person.id}
              person={person}
              levelName={levelByActor.get(person.id)}
              onClick={openPersonProfile}
            />
          ))}
        </Container>
      </Container>
    );
  }

  return (
    <Container height="full" overflow="y-auto" width="full" padding="none">
    <Container as="section" layout="vertical" gap="md" padding="xl" maxWidth="5xl" width="full" centered minHeight="0">
      <StatementHeader
        kicker="People"
        statement="The people who make this place."
        subtitle={isLoading ? undefined : people.length === 1 ? '1 member' : `${people.length} members across your communities.`}
      />

      {roleFilters.length > 0 ? (
        <SelectablePillBar
          items={roleFilters}
          selectedIds={selectedRoles}
          allLabel="All"
          ariaLabel="Filter people by role"
          onSelectAll={() => setSelectedRoles([])}
          onToggle={(id) =>
            setSelectedRoles((prev) =>
              prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id],
            )
          }
        />
      ) : null}

      <Container layout="horizontal" gap="sm" padding="none" alignItems="center" width="full">
        <Container layout="vertical" gap="none" padding="none" flex={1}>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search people by name..."
            aria-label="Search people"
          />
        </Container>
        <Button
          variant="secondary"
          size="md"
          onClick={submitSearch}
          disabled={search.trim().length === 0 || isSearching}
        >
          {isSearching ? <Spinner size="sm" /> : <Icon icon={Search} size="sm" />}
          Search
        </Button>
      </Container>

      {error && (
        <Text variant="body-xs" color="error">
          Search did not go through: {error}
        </Text>
      )}

      {body}
    </Container>
    </Container>
  );
}
