// src/workspace/door-grant-screen.tsx
//
// PURPOSE
//   The owner's grant screen: a grant someone asked for (`/grants?computer=<id>&ask=<base64url>`) is kept on one of the
//   owner's own computers with one press, read back, and the grants kept there are listed with when each was last used
//   and a Stop on each. Each call goes through the account's one door (api.ts), pinned to that computer, so it is the
//   same operation an AI calls, carried out on the computer named in the address.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a product, a tool or a person: every word is door-grant-words.json, and the grant is sent as
//      the request carried it (door-grant.mjs).
//   2. A keep is shown as kept only when the engine's own list of that computer names it again.
//   3. Every control is a shared part (Button, Card, Container, Text) and the states are the shared screen state.
//   4. A refusal is shown by the engine's code in words; nothing is kept on a refusal.

import * as React from 'react';
import { Button, Card, Container, Text } from '../../../../ui';
import { loadScreen } from '../../../../ui/show/screen-state';
import { mountReactSurface } from '../../../../ui/show/react-surface-mount';
import { readJson } from './api';
import { refusal } from './failure';
import words from './door-grant-words.json';
import { KEEP, LIST, WITHDRAW, doorRequest, endsWords, isKept, lastUsedWords, refusalWords, requestOf, whoWords, withdrawInput } from './door-grant.mjs';

type Person = { principal: string; key_blake3?: string; team?: string; issuer?: string };
type Grant = { label: string; people?: Person[]; grant?: { tools?: string[]; identity?: string; journal?: string }; ends?: { until?: string }; last_used?: string | null };
type Grants = { grants: Grant[] };
type Asked = { label: string; sharing: { grant: { tools: string[]; identity: string; journal: string }; people: Person[]; ends?: { until?: string } } };
type Request = { ok: true; input: Asked } | { ok: false; reason: string };

const listOf = (computer: string) => readJson<Grants>(doorRequest(LIST, {}, computer, '').path);

// A refusal the engine gave carries its code (account-door.ts keeps it as `refused.code`).
const codeOf = (error: unknown) => (error as { refused?: { code?: string } } | null)?.refused?.code;

function GrantRow({ grant, busy, stop }: { grant: Grant; busy: boolean; stop: (label: string) => void }) {
  const tools = grant.grant?.tools ?? [];
  return (
    <Card variant="nested" padding="md" data-door-grant={grant.label}>
      <Container layout="vertical" gap="xs">
        <Text variant="heading-xs">{grant.label}</Text>
        <Text variant="body" color="muted">{words.who}: {(grant.people ?? []).map(whoWords).join('; ')}</Text>
        <Text variant="body" color="muted">{words.tools}: {tools.join(', ')}</Text>
        <Text variant="body" color="muted">{words.ends}: {endsWords(grant.ends)}</Text>
        <Text variant="caption" color="muted">{lastUsedWords(grant.last_used)}</Text>
        <Container layout="horizontal" justifyContent="end">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => stop(grant.label)}>{busy ? words.stopping : words.stop}</Button>
        </Container>
      </Container>
    </Card>
  );
}

function RequestCard({ request, busy, onKeep }: { request: Asked; busy: boolean; onKeep: () => void }) {
  const grant = request.sharing.grant;
  return (
    <Card variant="nested" padding="md">
      <Container layout="vertical" gap="xs">
        <Text variant="heading-xs">{words.request_heading}</Text>
        <Text variant="heading">{request.label}</Text>
        <Text variant="body" color="muted">{words.who}: {request.sharing.people.map(whoWords).join('; ')}</Text>
        <Text variant="body" color="muted">{words.tools}: {grant.tools.join(', ')}</Text>
        <Text variant="body" color="muted">{words.identity}: {words.identity_words[grant.identity as 'none' | 'self']}</Text>
        <Text variant="body" color="muted">{words.journal}: {words.journal_words[grant.journal as 'input' | 'none']}</Text>
        <Text variant="body" color="muted">{words.ends}: {endsWords(request.sharing.ends)}</Text>
        <Container layout="horizontal" justifyContent="end">
          <Button disabled={busy} onClick={onKeep}>{busy ? words.keeping : words.keep}</Button>
        </Container>
      </Container>
    </Card>
  );
}

function DoorGrant({ first, computer, request }: { first: Grants; computer: string; request: Request | null }) {
  const [grants, setGrants] = React.useState<Grant[]>(first.grants);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  // The engine's own list of this computer, read again after every change.
  const reread = async () => {
    const list = await listOf(computer);
    setGrants(list.grants);
    return list;
  };

  const call = async (method: string, input: unknown, key: string) => {
    const { path, init } = doorRequest(method, input, computer, key);
    return readJson<unknown>(path, init, true);
  };

  const keep = async (input: Asked) => {
    setBusy('keep'); setMessage(null);
    try {
      await call(KEEP, input, crypto.randomUUID());
      const list = await reread();
      setMessage(isKept(list, input.label) ? words.kept : words.not_listed_yet);
    } catch (error) {
      setMessage(refusalWords(codeOf(error)));
    } finally {
      setBusy(null);
    }
  };

  const stop = async (label: string) => {
    setBusy(label); setMessage(null);
    try {
      await call(WITHDRAW, withdrawInput(label), crypto.randomUUID());
      await reread();
      setMessage(words.stopped);
    } catch {
      setMessage(words.stop_failed);
    } finally {
      setBusy(null);
    }
  };

  const requestNeedsComputer = request?.ok === true && !computer;
  return (
    <Container layout="vertical" gap="md">
      <Text variant="title">{words.title}</Text>
      {request && !request.ok ? <Text variant="body" color="muted">{words.problems[request.reason as keyof typeof words.problems] ?? words.problems.invalid}</Text> : null}
      {requestNeedsComputer ? <Text variant="body" color="muted">{words.problems.computer}</Text> : null}
      {request?.ok && computer ? <RequestCard request={request.input} busy={busy === 'keep'} onKeep={() => void keep(request.input)} /> : null}
      {message ? <Text variant="body">{message}</Text> : null}
      <Text variant="heading-xs">{words.list_heading}</Text>
      {grants.length === 0 ? <Text variant="body" color="muted">{words.none_kept}</Text> : null}
      {grants.map(grant => <GrantRow key={grant.label} grant={grant} busy={busy === grant.label} stop={label => void stop(label)} />)}
    </Container>
  );
}

export function mountDoorGrantScreen(element: HTMLElement): () => void {
  const address = new URLSearchParams(location.search);
  const computer = address.get('computer') ?? '';
  const request = address.has('ask') ? requestOf(address.get('ask') ?? '') : null;
  let unmount: (() => void) | null = null;
  const screen = loadScreen(element, {
    loading: { label: words.loading, layout: 'rows' },
    read: () => listOf(computer),
    failed: refusal(words.load_failed),
    clear: () => { unmount?.(); unmount = null; },
    draw: first => { if (!unmount) unmount = mountReactSurface(element, <DoorGrant first={first} computer={computer} request={request} />); },
  });
  return () => { screen.dispose(); unmount?.(); element.replaceChildren(); };
}
