// packages/service-connections/show/ServiceConnectionDialog.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Connect dialog rendered entirely from package-declared service data.
// Reference anatomy (Bolt.new Stripe-key modal): mark + "Connect <Name>" +
// one-line purpose, ONE input per field with a "Where do I find this?"
// disclosure holding the exact numbered steps and the provider deep link.
// Steps stay behind the disclosure so the default view is calm — the wall of
// instructions never stacks above the inputs. When the service requires
// nothing, the dialog is one click: "Ready to connect."
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Service auth config is DATA (not code) — adding a service = one data entry
// 2. Credential fields, guide steps, and deep links render from data, never
//    from provider-name branching
// 3. Guide steps live behind a per-field disclosure — closed by default
// 4. onAuthenticate(credential) receives structured field values
// 5. Uses ONLY @/packages/ui barrel imports — zero raw HTML
// 6. The primary verb is "Connect" — storage mechanics never appear as copy
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Container,
  Icon,
  Input,
  LAYER_ORDER,
  ProviderMark,
  Reveal,
  Text,
  Textarea,
  type ProviderIconRegistryRow,
} from '@/packages/ui';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import type {
  ServiceAuthConfig,
  ServiceAuthorizationMethod,
  ServiceCredentialField,
  ServiceCredentialSubmission,
} from '@/packages/service-connections/read-data/read-service-connection-options';
import {
  ConnectedAccountsSection,
  type ConnectedAccountView,
  type ConnectedAccountsSectionProps,
} from '@/packages/service-connections/show/ConnectedAccountsSection';
import { FloatingPanel } from '@/packages/screen-arrangement/show/FloatingPanel';

/**
 * Result of an interactive acquisition (the `acquire` facet). The dialog only
 * ever sees the NON-SECRET outcome: the account label to show ("Connected as
 * …") and, for device-code flows, the user code to present. No token, no
 * client secret — those are sealed in credentials-vault by the process.
 */
export interface ServiceAcquireOutcome {
  accountLabel?: string;
  device?: { userCode: string; verificationUri: string };
}

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface ServiceConnectionDialogProps {
  /** Panel open state */
  open: boolean;

  /** Service display name ("GitHub", "Notion", etc.) */
  serviceName: string;

  /** Open provider identity used to resolve the shared brand registry */
  serviceVendor?: string;

  /** Raw provider-icon DATA rows; unknown vendors keep the monogram fallback */
  providerIconRegistry?: readonly ProviderIconRegistryRow[];

  /** True for custom services: the name itself becomes an editable field */
  allowNameEntry?: boolean;

  /** Authentication config from package data */
  authConfig: ServiceAuthConfig;

  /** Callback when modal closes */
  onClose: () => void;

  /** Callback when user connects — receives structured field values (paste/`collect` path) */
  onAuthenticate: (credential: ServiceCredentialSubmission) => Promise<void>;

  /**
   * Callback for the interactive `acquire` path: dispatches the acquisition
   * process (browser/device-code) via the backend and resolves with the
   * NON-SECRET outcome (account label / device code). Required only when the
   * service declares an `acquire` facet; for paste-only services it is unused.
   * Receives the dialog's collected NON-secret field values (an acquire config
   * MAY declare credentialFields for pre-launch inputs — a pairing phone, an
   * account handle; the process argv references them via `{field}` rows).
   */
  onAcquire?: (
    fields: Record<string, string>,
    authorizationMethod?: ServiceAuthorizationMethod,
  ) => Promise<ServiceAcquireOutcome>;

  /**
   * LIVE mid-process challenge for session-backed acquires (a WhatsApp pairing
   * code, a QR, a device code emitted WHILE the acquire process blocks waiting
   * for the user to act elsewhere). Supplied reactively by the surface from the
   * acquire process-session event feed (`read-acquire-challenge-events` lens).
   * Takes precedence over the resolve-then-show `device` outcome, which
   * structurally cannot carry a mid-run code (a bounded compute.process returns
   * stdout only at completion — the deadlock the Codex convergence proved).
   * The dialog stays blind: it renders whatever code/uri/hint fields the
   * challenge carries — no vendor names, no challenge-kind enum (L090).
   */
  liveChallenge?: { type: string; fields: Record<string, unknown> } | null;

  /**
   * A TERMINAL FAILURE from a session-backed acquire — the running connect
   * process errored, or exited before pairing. Supplied by the surface, which
   * drops the live feed the instant it fails, so `liveChallenge` is already
   * null by the time this arrives. The dialog uses it to LEAVE its waiting
   * state and fall back to the field-entry (retry) view with the cause shown,
   * so a failed pairing is always escapable and retryable (Q3). Null on the
   * happy path.
   */
  acquireError?: string | null;

  /**
   * This service's REAL connected account instances (the dynamic list —
   * Airtable "Connected accounts" / Notion "CONNECTED ACCOUNTS (N)" anatomy).
   * Rendered above the connect form so adding another account happens with
   * the existing ones in view; empty/omitted renders nothing (L117 — no
   * placeholder rows). The surface computes this from the SAME live readiness
   * view the grid renders — no extra subscription (L126).
   */
  existingAccounts?: ConnectedAccountView[];

  /** Rename one instance's account label (writes the accountLabel fact). */
  onRenameAccount?: ConnectedAccountsSectionProps['onRename'];

  /** Disconnect ONE instance — never the whole vendor. */
  onDisconnectAccount?: ConnectedAccountsSectionProps['onDisconnect'];

  /**
   * Owner-gated reveal of an instance's stored credential fields. Explicit
   * click-only; the values render masked-by-default inside the section. A
   * deliberate READ path separate from connect-flow sealing — see
   * do-work/reveal-service-connection-credential.ts.
   */
  onRevealAccountCredentials?: ConnectedAccountsSectionProps['onReveal'];
}

// ---------------------------------------------------------------------------
// FIELD GUIDE — numbered steps + provider deep link behind a disclosure,
// closed by default so the dialog reads calm (Bolt.new "Where can I find my
// API key?" anatomy)
// ---------------------------------------------------------------------------

function FieldGuide({ field }: { field: ServiceCredentialField }) {
  const [openGuide, setOpenGuide] = useState(false);
  if (!field.guideSteps.length) return null;

  return (
    <Container layout="vertical" gap="xs" padding="none">
      <Container layout="horizontal" justifyContent="flex-start" padding="none">
        <Button variant="ghost" size="sm" onClick={() => setOpenGuide((current) => !current)}>
          <Icon icon={openGuide ? ChevronDown : ChevronRight} size="xs" />
          Where do I find this?
        </Button>
      </Container>
      <Reveal open={openGuide}>
        <Card variant="nested" padding="sm">
          <Container layout="vertical" gap="sm" padding="none">
            {field.guideSteps.map((step, stepIndex) => (
              <Container key={step} layout="horizontal" gap="sm" alignItems="start" padding="none">
                <Badge variant="secondary" size="sm">{stepIndex + 1}</Badge>
                <Text variant="body-xs" color="secondary">{step}</Text>
              </Container>
            ))}
            {field.guideUrl && field.guideUrl.includes('://') ? (
              <Container layout="horizontal" justifyContent="flex-start" padding="none">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => window.open(field.guideUrl, '_blank', 'noopener,noreferrer')}
                >
                  <Icon icon={ExternalLink} size="xs" />
                  Open {new URL(field.guideUrl).hostname.replace(/^www\./, '')}
                </Button>
              </Container>
            ) : null}
          </Container>
        </Card>
      </Reveal>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function ServiceConnectionDialog({
  open,
  serviceName,
  serviceVendor,
  providerIconRegistry = [],
  allowNameEntry = false,
  authConfig,
  onClose,
  onAuthenticate,
  onAcquire,
  liveChallenge = null,
  acquireError = null,
  existingAccounts = [],
  onRenameAccount,
  onDisconnectAccount,
  onRevealAccountCredentials,
}: ServiceConnectionDialogProps) {
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [enteredName, setEnteredName] = useState(serviceName);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Interactive-acquire state: a device code to present (for browserless flows)
  // and the resolved account label. Never holds a token or secret.
  const [deviceCode, setDeviceCode] = useState<ServiceAcquireOutcome['device'] | null>(null);
  // Session-backed acquire in flight: the launch resolved with NO terminal
  // outcome (a live process is now running and will stream its pairing code /
  // QR into `liveChallenge`). True keeps the dialog OPEN and the primary action
  // disabled so a second tap cannot spawn a duplicate connect session while we
  // wait for the code to arrive. Cleared when the dialog re-opens.
  const [sessionPending, setSessionPending] = useState(false);

  const authorizationMethods = authConfig.authorizationMethods ?? [];
  const defaultAuthorizationMethod = authorizationMethods.find((method) => method.recommended)
    ?? authorizationMethods[0]
    ?? null;
  const [authorizationMethodId, setAuthorizationMethodId] = useState<string | null>(
    defaultAuthorizationMethod?.id ?? null,
  );
  const authorizationMethod = authorizationMethods.find((method) => method.id === authorizationMethodId)
    ?? defaultAuthorizationMethod;
  const activeCredentialFields = authorizationMethod?.credentialFields
    ?? authConfig.credentialFields;

  // Presence of an `acquire` facet selects the one-click render shape — NOT a
  // vendor name, NOT a mode enum (L090: the data describes itself).
  const acquire = authorizationMethod?.acquire ?? authConfig.acquire ?? null;

  // Reset the form ONLY on an open transition (or a service switch) — NOT on
  // every render. `authConfig` is recomputed fresh by the surface each render,
  // so `authConfig.credentialFields` is a NEW array identity every time; listing
  // it here made this effect re-fire on the very next render after the user
  // pressed Continue, wiping their input and snapping the dialog back to the
  // phone-entry fields ("I pressed Continue and it went back to the phone number
  // in half a millisecond"). Keyed on `open`/`serviceName` plus a STABLE string
  // of the field ids, so a genuine field-set change still re-inits without the
  // per-render array-identity churn. The ids are read at run time, not triggers.
  const fieldIdsKey = activeCredentialFields.map((field) => field.id).join(' ');
  useEffect(() => {
    if (!open) return;
    setFieldValues(
      Object.fromEntries(
        activeCredentialFields.map((field) => [field.id, '']),
      ),
    );
    setEnteredName(serviceName);
    setError(null);
    setDeviceCode(null);
    setSessionPending(false);
    setAuthorizationMethodId(defaultAuthorizationMethod?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, serviceName, fieldIdsKey]);

  // FAILURE → RETRY (Q3): a session-backed acquire failed. The surface already
  // dropped the live feed (so liveChallenge is null); clear the local waiting
  // flags too, so the render falls back to the field-entry view. The cause is
  // shown in the error slot and the primary action re-enables — the user reads
  // it and retries, instead of staring at a frozen "Starting the connection…".
  useEffect(() => {
    if (!acquireError) return;
    setSessionPending(false);
    setDeviceCode(null);
    setIsLoading(false);
  }, [acquireError]);

  // One-click contract: when nothing is required, Connect works immediately
  // and skippable fields read as skippable — never as homework.
  const allFieldsSkippable = activeCredentialFields.every((field) => !field.required);
  const effectiveName = allowNameEntry ? enteredName.trim() : serviceName;

  const handleFieldChange = (fieldId: string, value: string) => {
    setFieldValues((current) => ({ ...current, [fieldId]: value }));
  };

  const buildSubmission = (): ServiceCredentialSubmission | null => {
    if (allowNameEntry && !effectiveName) {
      setError('Name the service first');
      return null;
    }

    const missingField = activeCredentialFields.find(
      (field) => field.required && !fieldValues[field.id]?.trim(),
    );

    if (missingField) {
      setError(`${missingField.label} is required`);
      return null;
    }

    return {
      serviceVendor: authConfig.vendor,
      serviceName: effectiveName,
      authorizationMethodId: authorizationMethod?.id,
      fields: activeCredentialFields
        .map((field) => ({
          id: field.id,
          label: field.label,
          value: fieldValues[field.id]?.trim() ?? '',
          secret: field.secret === true,
        }))
        .filter((field) => field.value.length > 0),
    };
  };

  // Interactive acquire: dispatch the acquisition process. On success the dialog
  // closes and the reactive feed flips the tile to Connected. For a browserless
  // device-code flow the process returns a code to present; the dialog shows it
  // and stays open while the process finishes in the background.
  const handleAcquire = async () => {
    if (!onAcquire) {
      setError('Connecting is not available right now. Try again.');
      return;
    }
    // Acquire-mode pre-launch inputs (NON-secret — a pairing phone, a handle):
    // required ones gate the launch, same contract as the paste path.
    const missingAcquireField = activeCredentialFields.find(
      (field) => field.required && !fieldValues[field.id]?.trim(),
    );
    if (missingAcquireField) {
      setError(`${missingAcquireField.label} is required`);
      return;
    }
    setIsLoading(true);
    setError(null);
    setDeviceCode(null);
    setSessionPending(false);
    try {
      const outcome = await onAcquire(
        Object.fromEntries(
          Object.entries(fieldValues).map(([id, value]) => [id, value.trim()]),
        ),
        authorizationMethod ?? undefined,
      );
      // Browserless device-code flow: present the code, stay open.
      if (outcome.device) {
        setDeviceCode(outcome.device);
        return;
      }
      // Self-completing acquire: it resolved with a terminal account label, so
      // the connection is already established — close and let the reactive feed
      // flip the tile to Connected.
      if (outcome.accountLabel) {
        onClose();
        return;
      }
      // Session-backed acquire (WhatsApp pairing / QR / 2FA): the launch resolved
      // with NO terminal outcome because a live process is now running and will
      // stream its pairing code / QR into `liveChallenge`. Closing here would tear
      // the dialog down before the code can render — the "modal vanished in an
      // instant" bug. STAY OPEN and let the live challenge / completion drive.
      setSessionPending(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not connect. Try again.';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async () => {
    const submission = buildSubmission();
    if (!submission) return;

    if (!allFieldsSkippable && submission.fields.length === 0) {
      setError('Enter the value this service requires');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await onAuthenticate(submission);
      setFieldValues({});
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not connect. Try again.';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <FloatingPanel
      open={open}
      onClose={onClose}
      label="Connect a service"
      width={448}
      layer={LAYER_ORDER.walkthrough + 1}
    >
      <Container layout="vertical" gap="lg" padding="lg">
        {/* Header: service mark + name + plain-English purpose */}
        <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
          <ProviderMark
            providerSlug={serviceVendor || authConfig.vendor}
            providerName={effectiveName || 'Service'}
            registry={providerIconRegistry}
            size="md"
            decorative
          />
          <Container layout="vertical" gap="none" padding="none">
            <Text variant="heading-xs">
              {effectiveName ? `Connect ${effectiveName}` : 'Connect a service'}
            </Text>
            {authConfig.instructions ? (
              <Text variant="body-xs" color="muted">{authConfig.instructions}</Text>
            ) : null}
          </Container>
        </Container>

        {/* Dynamic connected-accounts list (Airtable/Notion anatomy): every
            REAL connected instance of this service, with per-instance manage
            (rename / reveal stored credential / disconnect one) behind a
            closed-by-default disclosure. Renders NOTHING when no instances
            exist or the surface didn't wire the management callbacks — the
            connect form below is then the whole dialog, exactly as before. */}
        {onRenameAccount && onDisconnectAccount && onRevealAccountCredentials ? (
          <ConnectedAccountsSection
            accounts={existingAccounts}
            onRename={onRenameAccount}
            onDisconnect={onDisconnectAccount}
            onReveal={onRevealAccountCredentials}
          />
        ) : null}

        {authorizationMethods.length > 1 ? (
          <Container layout="vertical" gap="xs" padding="none">
            <Text variant="label" color="muted">How do you want to connect?</Text>
            {authorizationMethods.map((method) => (
              <Button
                key={method.id}
                variant={authorizationMethod?.id === method.id ? 'primary' : 'secondary'}
                onClick={() => {
                  setAuthorizationMethodId(method.id);
                  setFieldValues(Object.fromEntries(method.credentialFields.map((field) => [field.id, ''])));
                  setError(null);
                  setDeviceCode(null);
                  setSessionPending(false);
                }}
                disabled={isLoading || sessionPending}
              >
                <Container layout="vertical" gap="none" alignItems="start" padding="none">
                  <Text variant="body-sm" weight="semibold">{method.label}</Text>
                  {method.description ? (
                    <Text variant="body-xs" color="muted">{method.description}</Text>
                  ) : null}
                </Container>
              </Button>
            ))}
          </Container>
        ) : null}

        {/* Interactive acquire (`acquire` facet present): one tap, no fields.
            Reference anatomy (Zapier/Buffer/Base44 Mobbin): a single primary
            action sends the user to the provider to pick an account; success
            flips the tile to Connected. No token ever appears here. */}
        {acquire ? (
          <Container layout="vertical" gap="md" padding="none">
            {liveChallenge ? (
              // LIVE mid-process challenge (session-backed acquire): the code
              // arrived on the running process's event feed while it waits for
              // the user. Rendered blindly from the challenge's own fields —
              // `code`/`user_code` is the thing to type, `verification_uri` /
              // `instructions`/`hint` tell the user where (L090: the process
              // line describes itself; no vendor or kind branching here).
              <Card variant="nested" padding="md">
                <Container layout="vertical" gap="xs" padding="none">
                  <Text variant="body-sm">
                    {String(
                      liveChallenge.fields.instructions
                        ?? liveChallenge.fields.hint
                        ?? (liveChallenge.fields.verification_uri
                          ? `Open ${String(liveChallenge.fields.verification_uri)} and enter this code:`
                          : 'Enter this code where the app asks for it:'),
                    )}
                  </Text>
                  <Text variant="heading-sm">
                    {String(
                      liveChallenge.fields.code
                        ?? liveChallenge.fields.user_code
                        ?? liveChallenge.fields.qr
                        ?? '',
                    )}
                  </Text>
                  <Text variant="body-xs" color="muted">
                    Leave this open — it connects automatically once you approve.
                  </Text>
                </Container>
              </Card>
            ) : deviceCode ? (
              <Card variant="nested" padding="md">
                <Container layout="vertical" gap="xs" padding="none">
                  <Text variant="body-sm">
                    Open {deviceCode.verificationUri} and enter this code:
                  </Text>
                  <Text variant="heading-sm">{deviceCode.userCode}</Text>
                  <Text variant="body-xs" color="muted">
                    Leave this open — it connects automatically once you approve.
                  </Text>
                </Container>
              </Card>
            ) : sessionPending ? (
              // Session launched, code not streamed in yet: hold the dialog open
              // with a calm waiting state so it never looks idle (and never
              // reverts to the pre-launch fields). `liveChallenge` replaces this
              // the instant the running process emits its pairing code / QR.
              <Card variant="nested" padding="md">
                <Container layout="vertical" gap="xs" padding="none">
                  <Text variant="body-sm">Starting the connection…</Text>
                  <Text variant="body-xs" color="muted">
                    Leave this open — your pairing code appears here in a moment.
                  </Text>
                </Container>
              </Card>
            ) : (
              <>
                <Text variant="body-sm" color="secondary">
                  You’ll sign in with {effectiveName} and pick the account to connect.
                  Nothing to copy or paste.
                </Text>
                {/* Pre-launch NON-secret inputs an acquire config declares (a
                    pairing phone, an account handle) — same field DATA shape
                    as the paste path, rendered before the process launches. */}
                {activeCredentialFields.map((field) => (
                  <Container key={field.id} layout="vertical" gap="xs" padding="none">
                    <Input
                      label={field.required ? field.label : `${field.label} — you can skip this`}
                      type={field.secret ? 'password' : 'text'}
                      placeholder={field.placeholder}
                      value={fieldValues[field.id] ?? ''}
                      onChange={(event) => handleFieldChange(field.id, event.currentTarget.value)}
                      disabled={isLoading}
                      autoComplete={field.autocomplete}
                      hint={field.help || undefined}
                    />
                    <FieldGuide field={field} />
                  </Container>
                ))}
              </>
            )}
          </Container>
        ) : (
          <>
            {/* One-click: nothing required */}
            {allFieldsSkippable ? (
              <Text variant="body-xs" color="success">
                Ready to connect — nothing required.
              </Text>
            ) : null}

            {/* Custom services name themselves */}
            {allowNameEntry ? (
              <Input
                label="Service name"
                placeholder="What is this tool called?"
                value={enteredName}
                onChange={(event) => setEnteredName(event.currentTarget.value)}
                disabled={isLoading}
                autoComplete="off"
              />
            ) : null}

            {/* Fields — calm by default; exact steps open on demand */}
            <Container layout="vertical" gap="md" padding="none">
              {activeCredentialFields.map((field) => (
                <Container key={field.id} layout="vertical" gap="xs" padding="none">
                  {field.multiline ? (
                    <Textarea
                      label={field.required ? field.label : `${field.label} — you can skip this`}
                      placeholder={field.placeholder}
                      value={fieldValues[field.id] ?? ''}
                      onChange={(event) => handleFieldChange(field.id, event.currentTarget.value)}
                      rows={4}
                      disabled={isLoading}
                      autoComplete={field.autocomplete}
                    />
                  ) : (
                    <Input
                      label={field.required ? field.label : `${field.label} — you can skip this`}
                      type={field.secret ? 'password' : 'text'}
                      placeholder={field.placeholder}
                      value={fieldValues[field.id] ?? ''}
                      onChange={(event) => handleFieldChange(field.id, event.currentTarget.value)}
                      disabled={isLoading}
                      autoComplete={field.autocomplete}
                      hint={field.help || undefined}
                    />
                  )}
                  <FieldGuide field={field} />
                </Container>
              ))}
            </Container>
          </>
        )}

        {/* Error: plain cause, retry stays on the primary button. `error` is a
            local validation/paste failure; `acquireError` is a failed live
            connect session surfaced from the process feed (Q3). Either shows
            here, and the field view is back so the user can immediately retry. */}
        {(error || acquireError) && (
          <Text variant="body-xs" color="error">{error || acquireError}</Text>
        )}

        {/* Actions — acquire shows a single provider sign-in verb; paste shows Connect */}
        <Container layout="horizontal" gap="sm" justifyContent="flex-end" padding="none">
          {/* Cancel is ALWAYS enabled (Q3): closing is the guaranteed escape.
              A hung launch (beginSessionAcquisition never resolves) would leave
              isLoading true forever — gating Cancel on it would trap the user
              exactly as reported ("I couldn't close, I couldn't restart"). The
              surface's closeDialog aborts the live session on close, so an
              in-flight connect can never survive a Cancel. */}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {acquire ? (
            <Button variant="primary" onClick={handleAcquire} loading={isLoading} disabled={!!deviceCode || !!liveChallenge || sessionPending}>
              Continue with {effectiveName}
            </Button>
          ) : (
            <Button variant="primary" onClick={handleSubmit} loading={isLoading}>
              {authorizationMethod?.label ?? 'Connect'}
            </Button>
          )}
        </Container>
      </Container>
    </FloatingPanel>
  );
}
