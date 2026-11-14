// packages/interaction-program/show/mount-community-console.tsx
//
// =============================================================================
// PURPOSE — the Community console (plan T5–T8): the CM-facing surface over the
// interaction-program DATA seeds. Four sections, all DATA-driven:
//   Roles & Permissions — a role×permission matrix whose COLUMNS are the union
//     of permission strings found in the member-type DATA rows (a new
//     permission string = a new column, zero code — L063/L090)
//   Points & Seasons    — measure-definition rows as human cards
//   Pages & Onboarding  — program-surface + daily-sequence rows
//   Ask AI              — dispatches the EXISTING ai-records-producer action
//     with the seeded `configure-community` instruction; the AI writes DATA
//     rows, the feeds re-render them (no AI logic here — no god package)
//
// NON-NEGOTIABLE INVARIANTS:
// 1. No hardcoded roles/permissions/community names — everything from the five
//    bound scoped feeds (see console-selectors.mjs).
// 2. Product copy is human ("Roles & Permissions", "Points & Seasons") — no
//    internal vocabulary (interaction-program, access-rule, measure-definition,
//    write-batch) in the UI (L114/L118).
// 3. No imports from other feature packages' source — documents,
//    timed-action, ai-records-producer are reached ONLY via dispatch/DATA
//    (L106 independent-inventor test). Shared `ui` primitives only.
// 4. Fail-soft: every section renders an honest empty state; unbound inputs
//    never reach `useBitfieldData('')` (the read-scope crash, Root A).
// 5. Edits are scoped additive DATA writes (identity_text label-addressed
//    write-batch of the ONE affected row) — never re-admission (L121/L128).
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  Badge,
  Button,
  Card,
  Container,
  Divider,
  ErrorBoundary,
  Input,
  Text,
  mountReactSurface,
} from '@/packages/ui';
import {
  buildMeasureModels,
  buildProgramModels,
  buildRoleMatrix,
  buildSequenceModels,
  buildSetupModels,
  buildMatchModels,
  buildSurfaceModels,
  togglePermission,
} from '../read-data/console-selectors.mjs';

const ENGINE_LABEL_TARGET = 'engine.operation.label-addressed';
const WRITE_BATCH_OPERATION = 'engine.operation.write-batch';

// The package's own always-declared input, used ONLY as a safe fallback NAME so
// an unbound optional input never reaches `useBitfieldData('')` — which throws
// "Bitfield read scope has no input named ''" and crashes the whole surface.
// The read value is discarded when the input was not actually bound.
const SAFE_FALLBACK_INPUT = 'interaction-program-list';

function useOptionalInput(name: string | undefined): unknown {
  const raw = useBitfieldData(name || SAFE_FALLBACK_INPUT);
  return name ? raw : undefined;
}

type SurfaceInput = {
  programs_input?: string;
  member_types_input?: string;
  measures_input?: string;
  sequences_input?: string;
  surfaces_input?: string;
  setup_items_input?: string;
  matches_input?: string;
};

// ---------------------------------------------------------------------------
// DATA writes — one scoped additive row write per edit (L121). A row's address
// is DISCOVERED from the log by its own kind+id (L090 self-describing data,
// same pattern as the funnel's discoverRecordAddress) — never derived from a
// hardcoded naming convention, because the member-type feed matches by KIND and
// a role row authored by Ask-AI or any other package lives at its OWN address.
// Writing to a convention-derived address would create a divergent duplicate.
// ---------------------------------------------------------------------------

function decodeItemAddress(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    try {
      const text = new TextDecoder().decode(Uint8Array.from(raw as number[]));
      // Envelope addresses are length-prefixed; strip any leading non-printables.
      const printable = text.replace(/^[^\x20-\x7e]+/, '');
      return printable || null;
    } catch { return null; }
  }
  return null;
}

async function discoverRecordAddress(kind: string, id: string): Promise<string | null> {
  if (!kind || !id) return null;
  const reply = await sendRequestToBitfieldTarget({
    target: 'slot::find-current-items',
    payload: {
      operation: 'find-current-items',
      in: 'published-record',
      where: { all: [{ field: 'kind', in: [kind] }, { field: 'id', in: [id] }] },
      include: ['payload', 'address'],
    },
  } as never) as { payload: Uint8Array };
  const parsed = JSON.parse(new TextDecoder().decode(reply.payload));
  const items: Array<{ address?: unknown }> = parsed?.items ?? parsed?.output?.items ?? [];
  for (const item of items) {
    const address = decodeItemAddress(item.address);
    if (address) return address;
  }
  return null;
}

async function writeRow(addressLabel: string, payload: unknown, addressMode: 'identity_text' | 'label_hash'): Promise<void> {
  await Promise.resolve(sendRequestToBitfieldTarget({
    target: ENGINE_LABEL_TARGET,
    payload: {
      operation_label: WRITE_BATCH_OPERATION,
      writes: [{
        address_label: addressLabel,
        address_mode: addressMode,
        path_labels: ['current-item', 'published-record'],
        payload,
      }],
    },
  } as never));
}

// The package-admitted seed rows live at this label under label_hash mode (the
// admission path's mode — verified live on the tribes app). This is the write
// FALLBACK for rows whose stored address is a hash (not recoverable from the
// item's address bytes); rows written live under identity_text (e.g. by the
// Ask-AI producer) are discovered and re-written at their OWN address instead.
function seedMemberTypeAddress(id: string): string {
  return `package::interaction-program::seed::member-type::${id.replace(/:/g, '::')}`;
}

async function writeMemberTypeRow(row: { id: string; row: Record<string, unknown> }, payload: unknown): Promise<void> {
  const discovered = await discoverRecordAddress('interaction-program.member-type', row.id);
  if (discovered && discovered.startsWith('package::')) {
    await writeRow(discovered, payload, 'identity_text');
    return;
  }
  await writeRow(seedMemberTypeAddress(row.id), payload, 'label_hash');
}

// Ask AI (T8): dispatch the EXISTING producer action with the seeded
// configure-community instruction. The producer owns providers/models/prompts;
// this surface only names the instruction ref + passes the request text as data.
// Input contract matches the same-package `produce_icebreakers` precedent (which
// dispatches `{output_kind, wrap_instruction_ref: <full instruction ADDRESS>}` — the
// workflow assembles the prompt from the instruction record's wrap_prefix, per the
// producer CLI's own comment "instruction_text ... the workflow has already assembled
// from the wrap_instruction_ref"). Unlike the trigger-driven icebreaker, this is a UI
// dispatch, so it also supplies: request_id (the producer's write step keys
// result/error records by it) and instruction_text (the CM's free-text request, which
// the workflow appends to the wrap_prefix). The prior `{instruction_ref, request_text}`
// were unrecognized fields and `request_id` was missing → the dispatch produced nothing.
async function askAiToConfigure(requestText: string): Promise<number> {
  const requestId = `interaction-program:configure-community:${
    (globalThis.crypto?.randomUUID?.() ?? String(requestText.length))
  }`;
  // The producer runs synchronously and returns its output inline (include_output),
  // so we await the reply here — no background poller (L136). Each produced descriptor
  // is then APPLIED: written as a live, addressable, renderable setup-item record the
  // "Community setup" feed reads. A DISTINCT kind keeps AI output out of the programs feed.
  const reply = await Promise.resolve(sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: 'action:run-ai-records-production',
      include_output: true,
      input: {
        request_id: requestId,
        output_kind: 'interaction-program',
        wrap_instruction_ref: 'package::interaction-program::seed::instruction::configure-community',
        instruction_text: requestText,
      },
    },
  } as never)) as { payload?: unknown } & Record<string, unknown>;

  let parsed: Record<string, unknown> = reply;
  const maybeBytes = reply?.payload;
  if (maybeBytes instanceof Uint8Array) {
    try { parsed = JSON.parse(new TextDecoder().decode(maybeBytes)); } catch { parsed = {}; }
  }
  const output = (parsed?.output ?? parsed) as { items?: unknown };
  const items: Array<Record<string, unknown>> = Array.isArray(output?.items) ? (output.items as Array<Record<string, unknown>>) : [];

  let applied = 0;
  for (const item of items) {
    const nested = Array.isArray(item?.records) ? (item.records as Array<Record<string, unknown>>) : [item];
    for (const rec of nested) {
      const id = typeof rec?.id === 'string' && rec.id.length > 0 ? rec.id : null;
      if (!id) continue;
      await writeRow(
        `interaction-program::setup::${id}`,
        { ...rec, kind: 'interaction-program.setup-item', id },
        'identity_text',
      );
      applied += 1;
    }
  }
  return applied;
}

// Run the matchmaker for ONE program: dispatch the EXISTING generic
// `action:tribe.run-match-cycle` (which reads the program's meaning-search
// embeddings, pairs by similarity via the select-pairs leaf, and writes
// relationship-graph connection edges). This surface owns NO matching logic —
// it passes the program id as data and lets the workflow + owned engines run.
// A workflow error (e.g. an unresolvable sub-definition) is surfaced, never
// swallowed as a silent success.
async function runMatchCycle(programId: string): Promise<void> {
  const cycle = `console:${globalThis.crypto?.randomUUID?.() ?? 'c'}`;
  const reply = (await Promise.resolve(sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: 'action:tribe.run-match-cycle',
      include_output: true,
      input: {
        program_id: programId,
        cycle,
        initiating_event: {
          subject_id: `console:${programId}`,
          event_kind: 'manual-match-request',
          occurred_at: new Date().toISOString(),
          query_text: `interaction-program:${programId}:manual-match-request`,
        },
      },
    },
  } as never))) as { payload?: unknown } & Record<string, unknown>;

  let parsed: Record<string, unknown> = reply;
  const maybeBytes = reply?.payload;
  if (maybeBytes instanceof Uint8Array) {
    try { parsed = JSON.parse(new TextDecoder().decode(maybeBytes)); } catch { parsed = {}; }
  }
  const code = typeof parsed?.code === 'string' ? parsed.code : '';
  const message = typeof parsed?.message === 'string' ? parsed.message : '';
  if (/FE_|error|not found|failed/i.test(`${code} ${message}`)) {
    throw new Error(message || code || 'match cycle failed');
  }
}

// ---------------------------------------------------------------------------
// SECTIONS
// ---------------------------------------------------------------------------

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <Container padding="lg">
      <Text tone="muted" size="sm">{children}</Text>
    </Container>
  );
}

export function RolesSection({ memberTypeRows }: { memberTypeRows: unknown }) {
  const matrix = React.useMemo(() => buildRoleMatrix(memberTypeRows), [memberTypeRows]);
  const [pending, setPending] = React.useState<string | null>(null);

  if (matrix.rows.length === 0) {
    return <EmptyHint>No roles yet. Ask the AI below to set up roles for your community.</EmptyHint>;
  }

  const toggle = async (row: { id: string; row: Record<string, unknown> }, column: string) => {
    const key = `${row.id}:${column}`;
    setPending(key);
    try {
      await writeMemberTypeRow(row, togglePermission(row.row, column));
    } finally {
      setPending(null);
    }
  };

  return (
    <Card padding="md">
      <Text weight="semibold">Roles &amp; Permissions</Text>
      <Text tone="muted" size="sm">Tap a cell to grant or remove. Add a new permission by granting it through Ask AI — new permissions become new columns automatically.</Text>
      <Divider />
      <table>
        <thead>
          <tr>
            <th><Text size="sm" tone="muted">Role</Text></th>
            {matrix.columns.map((column) => (
              <th key={column}><Text size="sm" tone="muted">{column.replace(/[-_]+/g, ' ')}</Text></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((row) => (
            <tr key={row.id}>
              <td><Text size="sm" weight="medium">{row.role}</Text></td>
              {row.cells.map((cell) => (
                <td key={cell.column}>
                  <Button
                    size="sm"
                    variant={cell.granted ? 'primary' : 'ghost'}
                    disabled={pending === `${row.id}:${cell.column}`}
                    onClick={() => { void toggle(row, cell.column); }}
                  >
                    {cell.granted ? 'Yes' : '—'}
                  </Button>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function PointsSection({ measureRows }: { measureRows: unknown }) {
  const models = React.useMemo(() => buildMeasureModels(measureRows), [measureRows]);
  if (models.length === 0) {
    return <EmptyHint>No points or games configured yet.</EmptyHint>;
  }
  return (
    <Card padding="md">
      <Text weight="semibold">Points &amp; Seasons</Text>
      <Divider />
      {models.map((m) => (
        <Container key={m.id} padding="sm">
          <Text size="sm" weight="medium">{m.title}</Text>
          {m.failClosed ? <Badge tone="neutral">counts only confirmed activity</Badge> : null}
        </Container>
      ))}
      <Text tone="muted" size="sm">Leaderboards and seasons build on these — ask the AI below to add a game or start a season.</Text>
    </Card>
  );
}

export function PagesSection({ surfaceRows, sequenceRows }: { surfaceRows: unknown; sequenceRows: unknown }) {
  const surfaces = React.useMemo(() => buildSurfaceModels(surfaceRows), [surfaceRows]);
  const sequences = React.useMemo(() => buildSequenceModels(sequenceRows), [sequenceRows]);
  if (surfaces.length === 0 && sequences.length === 0) {
    return <EmptyHint>No pages or onboarding yet.</EmptyHint>;
  }
  return (
    <Card padding="md">
      <Text weight="semibold">Pages &amp; Onboarding</Text>
      <Divider />
      {surfaces.map((s) => (
        <Container key={s.id} padding="sm">
          <Text size="sm" weight="medium">{s.id.replace(/[-_]+/g, ' ')}</Text>
          <Text tone="muted" size="sm">Community page — edit it in the page composer.</Text>
        </Container>
      ))}
      {sequences.map((seq) => (
        <Container key={seq.id} padding="sm">
          <Text size="sm" weight="medium">{seq.id.replace(/[-_]+/g, ' ')}</Text>
          {seq.days.map((d) => (
            <Text key={d.day} tone="muted" size="sm">Day {d.day}: {d.title}</Text>
          ))}
        </Container>
      ))}
    </Card>
  );
}

function AskAiSection() {
  const [request, setRequest] = React.useState('');
  const [status, setStatus] = React.useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  const send = async () => {
    if (!request.trim()) return;
    setStatus('sending');
    try {
      await askAiToConfigure(request.trim());
      setStatus('sent');
      setRequest('');
    } catch {
      setStatus('error');
    }
  };

  return (
    <Card padding="md">
      <Text weight="semibold">Ask AI</Text>
      <Text tone="muted" size="sm">Describe what you want — “add a mentor role that can invite people”, “start a monthly points season” — and it gets set up for you.</Text>
      <Divider />
      <Input
        value={request}
        placeholder="Tell the AI what to set up…"
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRequest(e.target.value)}
      />
      <Button size="sm" variant="primary" disabled={status === 'sending'} onClick={() => { void send(); }}>
        {status === 'sending' ? 'Setting up…' : 'Set it up'}
      </Button>
      {status === 'sent' ? <Text size="sm" tone="muted">On it — new settings appear above as they land.</Text> : null}
      {status === 'error' ? <Text size="sm" tone="muted">That didn’t go through. Try again.</Text> : null}
    </Card>
  );
}

// The AI-configured items, rendered generically by their self-describing
// name/type/purpose (L090/L118). Returns null when nothing is configured yet, so
// it only appears once Ask-AI has applied real settings. This is what makes the
// "new settings appear above as they land" promise TRUE.
export function CommunitySetupSection({ setupRows }: { setupRows: unknown }) {
  const models = React.useMemo(() => buildSetupModels(setupRows), [setupRows]);
  if (models.length === 0) return null;
  return (
    <Card padding="md">
      <Text weight="semibold">Community setup</Text>
      <Divider />
      {models.map((m) => (
        <Container key={m.id} padding="sm">
          <Text size="sm" weight="medium">{m.name}</Text>
          <Badge tone="neutral">{m.type}</Badge>
          {m.purpose ? <Text tone="muted" size="sm">{m.purpose}</Text> : null}
        </Container>
      ))}
    </Card>
  );
}

// Matchmaking: one "Run matching" control per program. Generic (L090) — a row is
// rendered for whatever programs the feed carries, and the button passes only the
// program id to the owned match-cycle workflow. No community/program name is
// hardcoded; a new program appears here as a DATA row with zero code change.
function MatchmakingRow({ programId }: { programId: string }) {
  const [status, setStatus] = React.useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const label = programId.replace(/[_:-]+/g, ' ');
  const run = async () => {
    setStatus('running');
    try { await runMatchCycle(programId); setStatus('done'); }
    catch { setStatus('error'); }
  };
  return (
    <Container padding="sm">
      <Text size="sm" weight="medium">{label}</Text>
      <Button size="sm" variant="primary" disabled={status === 'running'} onClick={() => { void run(); }}>
        {status === 'running' ? 'Matching…' : 'Run matching'}
      </Button>
      {status === 'done' ? <Text size="sm" tone="muted">Matches formed — new connections are live.</Text> : null}
      {status === 'error' ? <Text size="sm" tone="muted">Couldn’t run matching. Try again.</Text> : null}
    </Container>
  );
}

export function MatchmakingSection({ programs }: { programs: Array<{ id: string }> }) {
  if (programs.length === 0) return null;
  return (
    <Card padding="md">
      <Text weight="semibold">Matchmaking</Text>
      <Text tone="muted" size="sm">Form new pairings from member similarity — everyone gets matched with who fits best.</Text>
      <Divider />
      {programs.map((p) => <MatchmakingRow key={p.id} programId={p.id} />)}
    </Card>
  );
}

// The formed pairings, rendered generically from their self-describing connection
// records (members + attributes.match_score / program_id / rationale — L090/L118).
// Returns null until matching has run, so it appears the moment "Run matching" writes
// connections — making the "new connections are live" promise visible.
export function MatchesSection({ matchRows }: { matchRows: unknown }) {
  const models = React.useMemo(() => buildMatchModels(matchRows), [matchRows]);
  if (models.length === 0) return null;
  return (
    <Card padding="md">
      <Text weight="semibold">Matches</Text>
      <Text tone="muted" size="sm">Pairings formed from member similarity.</Text>
      <Divider />
      {models.map((m) => (
        <Container key={m.id} padding="sm">
          <Text size="sm" weight="medium">{m.members.join(' · ')}</Text>
          {m.program ? <Badge tone="neutral">{m.program.replace(/[_:-]+/g, ' ')}</Badge> : null}
          {typeof m.score === 'number' ? <Text tone="muted" size="sm">{`${Math.round(m.score * 100)}% match`}</Text> : null}
          {m.rationale ? <Text tone="muted" size="sm">{m.rationale}</Text> : null}
        </Container>
      ))}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ROOT
// ---------------------------------------------------------------------------

function CommunityConsoleRoot({ surfaceInput }: { surfaceInput: SurfaceInput }) {
  const programsRaw = useBitfieldData(surfaceInput.programs_input || SAFE_FALLBACK_INPUT);
  const memberTypesRaw = useOptionalInput(surfaceInput.member_types_input);
  const measuresRaw = useOptionalInput(surfaceInput.measures_input);
  const sequencesRaw = useOptionalInput(surfaceInput.sequences_input);
  const surfacesRaw = useOptionalInput(surfaceInput.surfaces_input);
  const setupItemsRaw = useOptionalInput(surfaceInput.setup_items_input);
  const matchesRaw = useOptionalInput(surfaceInput.matches_input);
  const programs = React.useMemo(() => buildProgramModels(programsRaw), [programsRaw]);

  return (
    <Container padding="md">
      <Text weight="semibold" size="lg">Community</Text>
      <Text tone="muted" size="sm">
        {programs.length > 0
          ? `${programs.length} program${programs.length === 1 ? '' : 's'} running`
          : 'No programs yet — ask the AI below to set one up.'}
      </Text>
      <Divider />
      <CommunitySetupSection setupRows={setupItemsRaw} />
      <MatchmakingSection programs={programs} />
      <MatchesSection matchRows={matchesRaw} />
      <RolesSection memberTypeRows={memberTypesRaw} />
      <PointsSection measureRows={measuresRaw} />
      <PagesSection surfaceRows={surfacesRaw} sequenceRows={sequencesRaw} />
      <AskAiSection />
    </Container>
  );
}

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

export default function mount({ el, props = {} }: MountArgs) {
  // Read BOTH surface_input and surfaceInput (hosts may camelize) — same
  // robust convention as the funnel mount; an undefined input name must never
  // reach useBitfieldData('').
  const surfaceInput = (props.surfaceInput ?? props.surface_input ?? {}) as SurfaceInput;
  return mountReactSurface(
    el,
    <ErrorBoundary zoneName="community console">
      <CommunityConsoleRoot surfaceInput={surfaceInput} />
    </ErrorBoundary>,
  );
}
