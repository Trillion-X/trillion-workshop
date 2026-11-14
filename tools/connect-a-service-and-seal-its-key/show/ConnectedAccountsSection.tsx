// packages/service-connections/show/ConnectedAccountsSection.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The dynamic connected-accounts list inside the connect dialog. Reference
// anatomy (Mobbin): Airtable Integrations "Connected accounts" (account
// identity + "Connected N days ago" per row, "+ Connect new account" below),
// Notion connect popover ("CONNECTED ACCOUNTS (1)" header + rows + "Add
// another account"), Ditto "Manage Connection" (per-connection manage +
// remove). Each row is one REAL connected instance; management (rename /
// reveal stored credential / disconnect) lives behind a per-row "Manage"
// disclosure so the default list reads calm — the same closed-by-default
// disclosure pattern the dialog's FieldGuide already uses.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Uses ONLY @/packages/ui barrel imports — zero raw HTML (L065/L066)
// 2. Renders ONLY real connected instances — no sample/demo rows; an empty
//    list renders NOTHING (the section, header included, disappears) (L117)
// 3. Revealed credential values are MASKED BY DEFAULT and flip visible only
//    on an explicit per-field click; plaintext lives in component state for
//    exactly as long as the disclosure stays open and is NEVER logged,
//    persisted, or forwarded (the reveal-path sealing contract —
//    do-work/reveal-service-connection-credential.ts invariant 4)
// 4. Zero branching on service identity — rows render from props alone
// 5. All mutations go through the injected callbacks (rename / disconnect /
//    reveal) — this component owns presentation state only
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState } from 'react';
import {
  Button,
  Card,
  Container,
  Divider,
  Icon,
  Input,
  Reveal,
  Text,
  copyTextToClipboard,
} from '@/packages/ui';
import { ChevronDown, ChevronRight, Copy, Eye, EyeOff } from 'lucide-react';
import type { RevealedServiceCredentialField } from '@/packages/service-connections/do-work/reveal-service-connection-credential';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

/** One REAL connected instance, in the screen's language (ref-free, L098). */
export interface ConnectedAccountView {
  /** Stable instance id — passed back on every callback, never rendered. */
  id: string;
  /** Account identity ("work@example.com", "Personal"); '' = never named. */
  accountLabel: string;
  /** ISO timestamp of the connect ('' / null = unknown). Display only. */
  connectedAt: string | null;
  /** Derived display tag from the readiness view ('connected' | 'error' | …). */
  status: string;
}

export interface ConnectedAccountsSectionProps {
  /** The service's REAL connected instances. Empty = the section renders null. */
  accounts: ConnectedAccountView[];

  /** Rename one instance's account label. Resolves when the fact is written. */
  onRename: (connectionId: string, accountLabel: string) => Promise<void>;

  /** Disconnect ONE instance (never the whole vendor). */
  onDisconnect: (connectionId: string) => Promise<void>;

  /**
   * Owner-gated reveal: resolve this instance's stored credential fields to
   * plaintext. Only called on the explicit "Show stored credential" click —
   * never eagerly. The returned values render masked until per-field unmask.
   */
  onReveal: (connectionId: string) => Promise<RevealedServiceCredentialField[]>;
}

// ---------------------------------------------------------------------------
// DATE — plain-language connect date ("Connected Jul 3, 2026"); the row stays
// silent when the timestamp is unknown (no fake recency, L117)
// ---------------------------------------------------------------------------

function connectedOnText(connectedAt: string | null): string {
  if (!connectedAt) return '';
  const parsed = new Date(connectedAt);
  if (Number.isNaN(parsed.getTime())) return '';
  return `Connected ${parsed.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}`;
}

// ---------------------------------------------------------------------------
// CREDENTIAL FIELD ROW — masked by default; explicit per-field unmask + copy.
// Copy works WITHOUT unmasking (the Airtable/1Password pattern) so a user in a
// shared-screen setting never has to expose the value to move it.
// ---------------------------------------------------------------------------

function RevealedFieldRow({ field }: { field: RevealedServiceCredentialField }) {
  const [visible, setVisible] = useState(false);

  return (
    <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
      <Container layout="vertical" gap="none" padding="none" flex={1} minWidth="0">
        <Text variant="body-xs" color="muted">{field.label}</Text>
        <Text variant="body-sm" truncate>
          {visible ? field.value : '••••••••••••'}
        </Text>
      </Container>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setVisible((current) => !current)}
        title={visible ? 'Hide value' : 'Show value'}
      >
        <Icon icon={visible ? EyeOff : Eye} size="xs" />
        {visible ? 'Hide' : 'Show'}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void copyTextToClipboard(field.value)}
        title="Copy value"
      >
        <Icon icon={Copy} size="xs" />
        Copy
      </Button>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// ACCOUNT ROW — identity line + closed-by-default Manage disclosure holding
// rename / reveal / disconnect (Ditto "Manage Connection" anatomy, scoped to
// ONE instance)
// ---------------------------------------------------------------------------

function ConnectedAccountRow({
  account,
  onRename,
  onDisconnect,
  onReveal,
}: {
  account: ConnectedAccountView;
} & Pick<ConnectedAccountsSectionProps, 'onRename' | 'onDisconnect' | 'onReveal'>) {
  const [openManage, setOpenManage] = useState(false);
  const [labelDraft, setLabelDraft] = useState(account.accountLabel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Plaintext credential fields live here ONLY while the disclosure is open —
  // closing Manage drops them (see the onClick below), so the secret's
  // lifetime is exactly the reveal session (sealing invariant 3).
  const [revealedFields, setRevealedFields] = useState<RevealedServiceCredentialField[] | null>(null);

  const displayLabel = account.accountLabel || 'Unnamed account';
  const connectedText = connectedOnText(account.connectedAt);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card variant="nested" padding="sm">
      <Container layout="vertical" gap="xs" padding="none">
        {/* Identity line: label + connect date left, Manage right */}
        <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
          <Container layout="vertical" gap="none" padding="none" flex={1} minWidth="0">
            <Text variant="body-sm" weight="medium" truncate>{displayLabel}</Text>
            {connectedText ? (
              <Text variant="body-xs" color="muted">{connectedText}</Text>
            ) : null}
          </Container>
          {account.status === 'error' ? (
            <Text variant="body-xs" color="error">Needs attention</Text>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setOpenManage((current) => {
                const next = !current;
                // Closing the disclosure ends the reveal session: plaintext is
                // dropped so it cannot linger invisibly behind a closed row.
                if (!next) setRevealedFields(null);
                return next;
              });
              setLabelDraft(account.accountLabel);
              setError(null);
            }}
          >
            <Icon icon={openManage ? ChevronDown : ChevronRight} size="xs" />
            Manage
          </Button>
        </Container>

        <Reveal open={openManage}>
          <Container layout="vertical" gap="sm" padding="none">
            <Divider />

            {/* Rename — the label is how the owner tells accounts apart */}
            <Container layout="horizontal" gap="sm" alignItems="end" padding="none">
              <Container layout="vertical" gap="none" padding="none" flex={1} minWidth="0">
                <Input
                  label="Account label"
                  placeholder="work@example.com, Personal…"
                  value={labelDraft}
                  onChange={(event) => setLabelDraft(event.currentTarget.value)}
                  disabled={busy}
                  autoComplete="off"
                />
              </Container>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || labelDraft.trim() === account.accountLabel}
                onClick={() => void run(() => onRename(account.id, labelDraft.trim()))}
              >
                Save
              </Button>
            </Container>

            {/* Reveal stored credential — deliberate, owner-triggered read.
                Values arrive masked; each unmasks individually. */}
            {revealedFields === null ? (
              <Container layout="horizontal" justifyContent="flex-start" padding="none">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const fields = await onReveal(account.id);
                      setRevealedFields(fields);
                    })
                  }
                >
                  <Icon icon={Eye} size="xs" />
                  Show stored credential
                </Button>
              </Container>
            ) : revealedFields.length === 0 ? (
              <Text variant="body-xs" color="muted">
                No stored credential — this account connected without one.
              </Text>
            ) : (
              <Container layout="vertical" gap="sm" padding="none">
                {revealedFields.map((field) => (
                  <RevealedFieldRow key={field.secretName} field={field} />
                ))}
              </Container>
            )}

            {/* Disconnect THIS account only — quiet, never the loudest element */}
            <Container layout="horizontal" justifyContent="flex-start" padding="none">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void run(() => onDisconnect(account.id))}
              >
                Disconnect this account
              </Button>
            </Container>

            {error ? (
              <Text variant="body-xs" color="error">{error}</Text>
            ) : null}
          </Container>
        </Reveal>
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SECTION — header + rows; renders NOTHING when there are no real instances
// ---------------------------------------------------------------------------

export function ConnectedAccountsSection({
  accounts,
  onRename,
  onDisconnect,
  onReveal,
}: ConnectedAccountsSectionProps) {
  if (accounts.length === 0) return null;

  return (
    <Container layout="vertical" gap="xs" padding="none">
      <Text variant="label" color="muted">
        Connected accounts ({accounts.length})
      </Text>
      {accounts.map((account) => (
        <ConnectedAccountRow
          key={account.id}
          account={account}
          onRename={onRename}
          onDisconnect={onDisconnect}
          onReveal={onReveal}
        />
      ))}
    </Container>
  );
}
