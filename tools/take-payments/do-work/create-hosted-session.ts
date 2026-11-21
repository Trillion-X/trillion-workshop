import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { encodeStripeForm } from '@/packages/stripe-payment-provider/process/stripe-form-encode.mjs';
import { STRIPE_DOCS_CURRENT_API_VERSION } from '../read-data/capability-records';
import { paymentScheduleFromTheWire } from '@/packages/payment-adapter/read-data/when-money-is-taken';
import webhookEventMap from '../read-data/webhook-event-map.json' with { type: 'json' };
import { checkoutPaymentIntentMetadata } from './map-webhook-event.mjs';
import {
  howStripeTakesASchedule,
  whatTheCheckoutDoes,
  subscriptionScheduleRequest,
} from '@/packages/stripe-payment-provider/do-work/stripe-phases-for-a-payment-schedule';

// ============================================================================
// PURPOSE
// ----------------------------------------------------------------------------
// Provider-owned DIRECT-HTTP Stripe hosted Checkout Session creation for the
// account-portal carrier, which runs ONLY `slot::http-client` (no `slot::workflow`,
// no `slot::process`, no `slot::credentials-vault`). The prior workflow-action
// `action:stripe-payment-provider.start-checkout` needed all three, so it 502'd
// there. This collapses the vault-read + compute.process request-build + http
// steps into ONE in-process handler: it reads the restricted key from an env
// secret (STRIPE_SECRET_KEY), assembles the `POST /v1/checkout/sessions` body
// with the SAME pure Stripe form encoder the process worker uses, and calls
// `slot::http-client` directly (mirrors commit 94203eda for the signed-event
// authority client). Stripe wire knowledge stays in THIS package (L098); the
// http-client transport stays blind; the caller (payment-adapter) speaks a
// provider-agnostic session intent and never sees a Stripe string.
//
// NON-NEGOTIABLE INVARIANTS
//   - The secret NEVER leaves this handler: read from env, placed only on the
//     Authorization header of the outbound request. Never logged, never returned.
//   - success_url / cancel_url are UI-only. They NEVER grant access. Access flips
//     from the signature-verified `invoice.paid` webhook -> Build B trigger ->
//     checkout.complete-hosted. This handler only creates the session + returns url.
//   - Idempotency-Key is REQUIRED on create so a refresh/retry cannot double-create.
//   - Price is SSOT from offer DATA: use a pre-created price ref if the caller
//     supplies one, else inline price_data from the offer amounts (handler blind
//     to which — enum-dissolution).
// ============================================================================

// The whole address the vendor answers on, each written as it publishes it.
// These used to be a shared base plus path fragments, which put an ordinal
// nobody here minted into our own vocabulary and split one fact into two.
const CREATE_SESSION_URL = 'https://api.stripe.com/v1/checkout/sessions';
const SUBSCRIPTION_URL = 'https://api.stripe.com/v1/subscriptions';
const SUBSCRIPTION_SCHEDULE_URL = 'https://api.stripe.com/v1/subscription_schedules';
const HTTP_CLIENT_TARGET = 'slot::http-client';
const SECRET_KEY_ENV = 'STRIPE_SECRET_KEY';
const WEBHOOK_SECRET_ENV = 'STRIPE_WEBHOOK_SECRET';
const SECRET_KEY_CREDENTIAL_REF = 'credential-class:stripe-restricted-key';
const DEFAULT_TIMEOUT_MS = 30_000;

export type HostedSessionLineItem = {
  /** Pre-created Stripe Price id (offer DATA carries one) — preferred when present. */
  price_ref?: string;
  /** Inline price_data unit amount in minor units — used when no price_ref. */
  amount_cents?: number;
  /** Whether this line renews or appears only on the first subscription invoice. */
  billing_mode?: 'recurring' | 'one_time';
  /** Inline price_data product name — used when no price_ref. */
  product_name?: string;
  /** Line quantity. For Builder add-ons this is max(0, unitCount - included_units). */
  quantity: number;
};

export type CreateHostedSessionInput = {
  session: {
    currency: string;
    /**
     * Provider session mode selected by DATA (offer payment_timing threaded through
     * the quote): 'subscription' builds a recurring Stripe subscription session;
     * 'payment' builds a one_time Stripe payment session. The caller (payment-adapter)
     * always sets it.
     */
    payment_mode: string;
    /** Recurring interval for inline price_data (used only in subscription mode). */
    interval?: string;
    /**
     * Fixed number of installments for a bounded pay-in-N offer. When present (>= 2)
     * the recurring subscription is stamped with this bound in its metadata so the
     * grant path cancels it after the Nth paid invoice. Absent for open subscriptions
     * and one_time payments.
     */
    installment_count?: number;
    customer_email?: string;
    /** Grant-key echoed back through the webhook (checkoutAttemptId / accountId). */
    client_reference_id?: string;
    offer_id?: string;
    price_option_id?: string;
    validated_amount_cents?: number;
    /** Authoritative total expected on the first subscription invoice. */
    initial_amount_cents?: number;
    cadence?: string;
    policy_hash?: string;
    quote_reservation_id?: string;
    quote_signature?: string;
    /** Total requested devices — metadata only (not a Stripe quantity). */
    unit_count?: number;
    /** 7 for Personal; 0/undefined = no trial. $0 charged today when > 0. */
    trial_days?: number;
    /**
     * WHAT THIS OFFER TAKES AND WHEN, said once, as the offer says it.
     *
     * When present this decides the whole session and every field above that
     * describes money is ignored, because two descriptions of what to charge
     * is one too many: the older fields can only say "some now, then the same
     * amount forever", and an offer that charges $20 today, $80 next week and
     * $100 a month after that is not expressible in them at all.
     *
     * The first charge is taken by this checkout rather than by the schedule
     * that follows it. The provider's own documentation is the reason: a
     * subscription schedule's first invoice is created as a draft and
     * finalized about an hour later, so a schedule starting now does not
     * charge now, and the one charge that must not be late is the one the
     * person is watching.
     *
     * Wire shape, amounts as text because whole cents are not JSON numbers:
     *   { charges: [{ amount_cents, days_after_signup }], repeat: ... | null }
     */
    payment_schedule?: unknown;
    success_url: string;
    cancel_url: string;
    line_items: HostedSessionLineItem[];
  };
  idempotency_key: string;
};

export type HostedSessionResult = {
  created?: number;
  provider_session_id: string;
  url: string;
  status: string;
  mode: string;
  amount_total: number | null;
  currency: string | null;
  subscription: string | null;
  /** 'paid' | 'no_payment_required' | 'unpaid' — set on read, absent on create. */
  payment_status?: string;
  /** Buyer email captured by Stripe (customer_details.email / customer_email). */
  customer_email?: string;
  /** Grant keys we set in session metadata at create time. */
  offer_id?: string;
  client_reference_id?: string;
  price_option_id?: string;
  validated_amount_cents?: number | null;
  initial_amount_cents?: number | null;
  cadence?: string;
  policy_hash?: string;
  quote_reservation_id?: string;
  quote_signature?: string;
  /**
   * The subscription's RECURRING amount in minor units (base + metered add-ons),
   * read authoritatively from the Stripe subscription. This is the "verified money"
   * the offer money-gate matches — a trial charges 0 today but commits to this.
   */
  recurring_amount_cents?: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function positiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

class HostedSessionError extends Error {
  public readonly publicStatus: number;

  constructor(message: string, publicStatus = 502) {
    super(message);
    this.publicStatus = publicStatus;
  }
}

/** Build one Stripe line_items[] entry: pre-created price ref OR inline price_data. */
function lineItemBody(
  item: HostedSessionLineItem,
  currency: string,
  interval: string,
  isSubscription: boolean,
) {
  const quantity = positiveInt(item.quantity);
  if (quantity <= 0) return null;
  const priceRef = text(item.price_ref);
  if (priceRef) {
    return { price: priceRef, quantity };
  }
  const amount = positiveInt(item.amount_cents);
  if (amount <= 0) {
    throw new HostedSessionError('Line item needs price_ref or a positive amount_cents.', 400);
  }
  const priceData: Record<string, unknown> = {
    currency,
    product_data: { name: text(item.product_name) || 'Bitfield' },
    unit_amount: amount,
  };
  // A subscription Checkout Session may contain both recurring items and
  // one-time items. One-time items appear only on the first invoice.
  const lineRecurs = isSubscription && text(item.billing_mode) !== 'one_time';
  if (lineRecurs) priceData.recurring = { interval: text(interval) || 'month' };
  return { price_data: priceData, quantity };
}

/**
 * The line items and session mode a payment schedule asks for.
 *
 * Only the door charge appears here. Everything after it is phases, attached
 * once the card is collected, and putting any of it in the session would mean
 * the same money described twice in two places that can disagree.
 */
function doorChargeFromASchedule(
  session: CreateHostedSessionInput['session'],
  currency: string,
) {
  const schedule = paymentScheduleFromTheWire(session.payment_schedule);
  const arrangement = howStripeTakesASchedule(schedule);
  const checkout = whatTheCheckoutDoes(arrangement);

  if (checkout.amountCents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HostedSessionError('The amount due at the door is too large to send without losing cents.', 400);
  }

  const productName = text(session.line_items?.[0]?.product_name) || text(session.offer_id);
  if (checkout.mode === 'payment' && !productName) {
    // A charge with nothing naming it appears on a statement as money taken by
    // nobody for nothing. This package holds no product's name of its own, so
    // the caller supplies it or there is no session.
    throw new HostedSessionError('A charge needs a name for what is being bought.', 400);
  }

  return { arrangement, checkout, productName, currency };
}

/** Assemble the create-session form body from the provider-agnostic session intent. */
function sessionRequestBody(session: CreateHostedSessionInput['session']) {
  const currency = text(session.currency) || 'usd';
  const interval = text(session.interval) || 'month';
  // A schedule says what this offer takes and when, so when one is present it
  // decides the session and the older money fields are not consulted at all.
  const scheduled = session.payment_schedule === undefined || session.payment_schedule === null
    ? null
    : doorChargeFromASchedule(session, currency);

  // The Stripe checkout-session mode is DATA-selected. 'payment' is Stripe's one_time
  // mode; anything else maps to the recurring 'subscription' mode.
  const stripeMode = scheduled
    ? scheduled.checkout.mode
    : (text(session.payment_mode) === 'payment' ? 'payment' : 'subscription');
  const isSubscription = stripeMode === 'subscription';
  const lineItems = scheduled
    ? (scheduled.checkout.mode === 'payment'
      ? [lineItemBody(
        {
          amount_cents: Number(scheduled.checkout.amountCents),
          billing_mode: 'one_time' as const,
          product_name: scheduled.productName,
          quantity: 1,
        },
        currency,
        interval,
        false,
      )].filter((item): item is NonNullable<typeof item> => item !== null)
      : [])
    : (Array.isArray(session.line_items) ? session.line_items : [])
      .map((item) => lineItemBody(item, currency, interval, isSubscription))
      .filter((item): item is NonNullable<typeof item> => item !== null);
  // A setup session takes no money, so it carries no line items and must not
  // be refused for having none.
  if (lineItems.length === 0 && stripeMode !== 'setup') {
    throw new HostedSessionError('At least one line item is required for a checkout session.', 400);
  }

  const offerId = text(session.offer_id);
  const clientRef = text(session.client_reference_id);
  const unitCount = positiveInt(session.unit_count);
  const trialDays = positiveInt(session.trial_days);
  const metadata: Record<string, string> = {};
  if (offerId) metadata.offer_id = offerId;
  if (clientRef) metadata.checkout_attempt_id = clientRef;
  if (unitCount > 0) metadata.unit_count = String(unitCount);
  const priceOptionId = text(session.price_option_id);
  const validatedAmountCents = positiveInt(session.validated_amount_cents);
  const cadence = text(session.cadence);
  const initialAmountCents = positiveInt(session.initial_amount_cents);
  const policyHash = text(session.policy_hash);
  const quoteReservationId = text(session.quote_reservation_id);
  const quoteSignature = text(session.quote_signature);
  if (priceOptionId) metadata.price_option_id = priceOptionId;
  if (validatedAmountCents > 0) metadata.validated_amount_cents = String(validatedAmountCents);
  if (cadence) metadata.cadence = cadence;
  if (initialAmountCents > 0) metadata.initial_amount_cents = String(initialAmountCents);
  if (policyHash) metadata.policy_hash = policyHash;
  if (quoteReservationId) metadata.quote_reservation_id = quoteReservationId;
  if (quoteSignature) metadata.quote_signature = quoteSignature;

  const body: Record<string, unknown> = {
    mode: stripeMode,
    success_url: text(session.success_url),
    cancel_url: text(session.cancel_url),
  };
  if (lineItems.length > 0) body.line_items = lineItems;

  if (scheduled?.checkout.keepTheCardForLater) {
    // EVERYTHING SCHEDULED DEPENDS ON THIS ONE FIELD.
    //
    // Without it the card is authorized for this charge and then forgotten, so
    // the schedule has nothing to bill. It fails on its first phase, days
    // later, to somebody who was told they were signed up and has no reason to
    // come back and look. Nothing about the checkout itself looks wrong, which
    // is why it belongs beside the reason rather than in a list of options.
    //
    // A customer must also exist for a schedule to attach to, and a session
    // that only collects a card makes one by itself; one that takes money does
    // not unless it is asked to.
    body.customer_creation = 'always';
  }
  if (stripeMode === 'payment') {
    // A one-time Checkout's PaymentIntent carries the Checkout marker, so the webhook mapper counts this purchase once,
    // on the session's completed event (map-webhook-event.mjs, skip_when). Keeping the card for later adds its flag.
    body.payment_intent_data = {
      metadata: checkoutPaymentIntentMetadata(webhookEventMap),
      ...(scheduled?.checkout.keepTheCardForLater ? { setup_future_usage: 'off_session' } : {}),
    };
  }
  if (session.customer_email) body.customer_email = text(session.customer_email);
  if (clientRef) body.client_reference_id = clientRef;
  if (Object.keys(metadata).length > 0) body.metadata = metadata;

  // trial + per-subscription metadata only exist on a subscription session. A one_time
  // payment session carries the grant metadata at the top level (set above).
  if (isSubscription && !scheduled) {
    const subscriptionData: Record<string, unknown> = {};
    if (trialDays > 0) subscriptionData.trial_period_days = trialDays;
    const subscriptionMetadata: Record<string, string> = { ...metadata };
    // Stripe's subscription-ended webhook carries the Subscription object, not
    // the Checkout Session. Preserve the same already-provider-visible buyer
    // email on the Subscription so the generic entitlement-reversal route can
    // deterministically derive the account without trusting browser input or
    // performing a second network lookup after the subscription has ended.
    const customerEmail = text(session.customer_email);
    if (customerEmail) subscriptionMetadata.customer_email = customerEmail;
    // A bounded installment stamps its bound into the subscription so the grant path
    // (advance-installment) knows the target count and can stop after the Nth paid
    // invoice. installments_paid starts at 0 and the grant path increments it.
    const installmentCount = positiveInt(session.installment_count);
    if (installmentCount >= 2) {
      subscriptionMetadata.installment_count = String(installmentCount);
      subscriptionMetadata.installments_paid = '0';
    }
    if (Object.keys(subscriptionMetadata).length > 0) subscriptionData.metadata = subscriptionMetadata;
    if (Object.keys(subscriptionData).length > 0) body.subscription_data = subscriptionData;
  }
  return body;
}

function readSecretKey(): string {
  const key = text(process.env[SECRET_KEY_ENV]);
  if (!key) {
    throw new HostedSessionError(
      `Stripe secret key is not configured (${SECRET_KEY_ENV} is unset on this carrier).`,
    );
  }
  return key;
}

export type HostedStripeConfigurationStatus = {
  secret_key_configured: boolean;
  webhook_secret_configured: boolean;
  mode: 'live' | 'test' | 'unknown';
  provider_health_checked: false;
};

/**
 * Read-only configuration metadata for the hosted carrier. Secret bytes never
 * cross this function's return or error boundary: only presence and the
 * provider-defined live/test class are observable. This deliberately does not
 * contact Stripe, so it cannot be mistaken for provider health proof.
 */
export function inspectHostedStripeConfigurationTarget(input: unknown): HostedStripeConfigurationStatus {
  if (input !== undefined && input !== null) {
    if (typeof input !== 'object' || Array.isArray(input) || Object.keys(input as object).length !== 0) {
      throw new HostedSessionError('This check does not accept input values.', 400);
    }
  }
  const key = text(process.env[SECRET_KEY_ENV]);
  const mode = key.startsWith('sk_live_')
    ? 'live'
    : key.startsWith('sk_test_')
      ? 'test'
      : 'unknown';
  return {
    secret_key_configured: key.length > 0,
    webhook_secret_configured: text(process.env[WEBHOOK_SECRET_ENV]).length > 0,
    mode,
    provider_health_checked: false,
  };
}

function decodeHttpBody(output: Record<string, unknown>): unknown {
  const body = output.body ?? output.body_json ?? output.response_body;
  if (typeof body === 'string' && body.trim()) return JSON.parse(body) as unknown;
  if (Array.isArray(body)) {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(body as number[]))) as unknown;
  }
  return body ?? {};
}

async function callStripe(request: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<Record<string, unknown>> {
  // slot::http-client expects the request body as a byte sequence (Vec<u8>), NOT
  // a JSON string — it rejects a raw string with "invalid type: string". Encode
  // the form-urlencoded body to UTF-8 bytes (same shape signed-event-authority-client
  // sends). Omit body entirely for GET.
  const { body, ...rest } = request;
  const payload: Record<string, unknown> = { ...rest, timeout_ms: DEFAULT_TIMEOUT_MS };
  if (typeof body === 'string' && body.length > 0) {
    payload.body = Array.from(new TextEncoder().encode(body));
  }
  const reply = await sendRequestToBitfieldTarget({
    target: HTTP_CLIENT_TARGET,
    payload,
  });
  const replyText = new TextDecoder().decode(reply.payload);
  const output = replyText.trim() ? (JSON.parse(replyText) as Record<string, unknown>) : {};
  const statusCode = typeof output.status_code === 'number' ? output.status_code : 0;
  const parsed = decodeHttpBody(output);
  if (statusCode < 200 || statusCode >= 300) {
    const message = isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string'
      ? parsed.error.message
      : 'Stripe rejected the request.';
    throw new HostedSessionError(message, statusCode || 502);
  }
  return isRecord(parsed) ? parsed : {};
}

function toResult(session: Record<string, unknown>): HostedSessionResult {
  return {
    provider_session_id: text(session.id),
    url: text(session.url),
    status: text(session.status) || 'open',
    mode: text(session.mode) || 'subscription',
    amount_total: typeof session.amount_total === 'number' ? session.amount_total : null,
    currency: text(session.currency) || null,
    subscription: text(session.subscription) || null,
  };
}

export type HostedSessionCarrierEffect = {
  kind: 'carrier-http-effect';
  operationId: string;
  request: {
    auth: { scheme: 'bearer'; credentialRef: string };
    body: string;
    headers: Record<string, string>;
    method: 'POST';
    timeoutMs: number;
    url: string;
  };
  finalizeInput: { carrier_transport: 'finalize' };
  finalizeTarget: 'stripe-payment-provider.create-hosted-session';
};

/**
 * Provider-owned request materialization. The carrier receives finished Stripe
 * wire bytes plus an opaque credential reference, never the credential value.
 */
export function materializeHostedSessionCarrierEffect(input: unknown): HostedSessionCarrierEffect {
  const row = isRecord(input) ? input : {};
  const session = isRecord(row.session) ? (row.session as CreateHostedSessionInput['session']) : null;
  if (!session) throw new HostedSessionError('session intent is required.', 400);
  const idempotencyKey = text(row.idempotency_key);
  if (!idempotencyKey) {
    throw new HostedSessionError('idempotency_key is required to create a checkout session.', 400);
  }

  return {
    kind: 'carrier-http-effect',
    operationId: 'stripe-payment-provider.create-hosted-session',
    request: {
      auth: { scheme: 'bearer', credentialRef: SECRET_KEY_CREDENTIAL_REF },
      body: encodeStripeForm(sessionRequestBody(session)),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_DOCS_CURRENT_API_VERSION,
        'Idempotency-Key': idempotencyKey,
      },
      method: 'POST',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      url: CREATE_SESSION_URL,
    },
    finalizeInput: { carrier_transport: 'finalize' },
    finalizeTarget: 'stripe-payment-provider.create-hosted-session',
  };
}

/** Provider-owned raw response finalization. The generic carrier does no Stripe decoding. */
export function finalizeHostedSessionCarrierEffect(input: unknown): HostedSessionResult {
  const row = isRecord(input) ? input : {};
  const response = isRecord(row.transport_response) ? row.transport_response : {};
  const statusCode = typeof response.statusCode === 'number'
    ? response.statusCode
    : (typeof response.status_code === 'number' ? response.status_code : 0);
  const bodyText = typeof response.bodyText === 'string'
    ? response.bodyText
    : (typeof response.body_text === 'string' ? response.body_text : '');
  let parsed: unknown = {};
  try {
    parsed = bodyText.trim() ? JSON.parse(bodyText) : {};
  } catch {
    throw new HostedSessionError('Stripe returned an invalid response.', statusCode || 502);
  }
  if (statusCode < 200 || statusCode >= 300) {
    const message = isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string'
      ? parsed.error.message
      : 'Stripe rejected the request.';
    throw new HostedSessionError(message, statusCode || 502);
  }
  const result = toResult(isRecord(parsed) ? parsed : {});
  if (!result.provider_session_id || !result.url) {
    throw new HostedSessionError('Stripe did not return a hosted checkout session url.');
  }
  return result;
}

/**
 * Create a Stripe hosted Checkout Session (mode=subscription) via a direct
 * slot::http-client POST. Returns the hosted `url` for the browser to redirect to.
 * Fail-closed: any missing key / bad input / non-2xx Stripe response throws with a
 * publicStatus so the caller surfaces a clean error (never a silent success).
 */
export function createHostedSessionTarget(
  input: { carrier_transport: 'materialize' } & Record<string, unknown>,
): Promise<HostedSessionCarrierEffect>;
export function createHostedSessionTarget(input: unknown): Promise<HostedSessionResult>;
export async function createHostedSessionTarget(
  input: unknown,
): Promise<HostedSessionResult | HostedSessionCarrierEffect> {
  const row = isRecord(input) ? input : {};
  if (row.carrier_transport === 'materialize') {
    return materializeHostedSessionCarrierEffect(row);
  }
  if (row.carrier_transport === 'finalize') {
    return finalizeHostedSessionCarrierEffect(row);
  }

  const effect = materializeHostedSessionCarrierEffect(row);
  const key = readSecretKey();
  const stripeSession = await callStripe({
    method: effect.request.method,
    url: effect.request.url,
    headers: {
      Authorization: `Bearer ${key}`,
      ...effect.request.headers,
    },
    body: effect.request.body,
  });
  return finalizeHostedSessionCarrierEffect({
    transport_response: {
      statusCode: 200,
      bodyText: JSON.stringify(stripeSession),
    },
  });
}

function customerEmailOf(session: Record<string, unknown>): string {
  const direct = text(session.customer_email);
  if (direct) return direct;
  const details = isRecord(session.customer_details) ? session.customer_details : {};
  return text(details.email);
}

/** Sum a subscription's recurring line items: sum(price.unit_amount * quantity). */
function subscriptionRecurringCents(subscription: Record<string, unknown>): number | null {
  const items = isRecord(subscription.items) ? subscription.items : {};
  const data = Array.isArray(items.data) ? items.data : [];
  if (data.length === 0) return null;
  let total = 0;
  for (const raw of data) {
    const item = isRecord(raw) ? raw : {};
    const price = isRecord(item.price) ? item.price : {};
    const unit = typeof price.unit_amount === 'number' ? price.unit_amount : 0;
    const qty = typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1;
    total += unit * qty;
  }
  return total;
}

/**
 * Read a hosted Checkout Session by id (GET), enriched for the grant path: the
 * session's completion status + payment_status + buyer email + our grant metadata,
 * AND the subscription's authoritative recurring amount (read via a follow-up GET
 * on the subscription). This is the server-side source of truth the checkout
 * success redirect verifies before granting — it cannot be forged by a client
 * because the amounts/status come from Stripe, not the browser.
 */
export async function readHostedSessionTarget(input: unknown): Promise<HostedSessionResult> {
  const row = isRecord(input) ? input : {};
  const sessionId = text(row.provider_session_id ?? row.session_id ?? row.id);
  if (!sessionId) throw new HostedSessionError('provider_session_id is required.', 400);
  const key = readSecretKey();
  const authHeaders = { Authorization: `Bearer ${key}`, 'Stripe-Version': STRIPE_DOCS_CURRENT_API_VERSION };

  const session = await callStripe({
    method: 'GET',
    url: `${CREATE_SESSION_URL}/${encodeURIComponent(sessionId)}`,
    headers: authHeaders,
  });

  const result = toResult(session);
  result.created = typeof session.created === 'number' && Number.isSafeInteger(session.created)
    && session.created > 0 ? session.created : undefined;
  result.payment_status = text(session.payment_status) || undefined;
  result.customer_email = customerEmailOf(session) || undefined;
  const metadata = isRecord(session.metadata) ? session.metadata : {};
  result.offer_id = text(metadata.offer_id) || undefined;
  result.client_reference_id = text(session.client_reference_id) || undefined;
  result.price_option_id = text(metadata.price_option_id) || undefined;
  result.validated_amount_cents = positiveInt(Number(metadata.validated_amount_cents)) || null;
  result.initial_amount_cents = positiveInt(Number(metadata.initial_amount_cents)) || null;
  result.cadence = text(metadata.cadence) || undefined;
  result.policy_hash = text(metadata.policy_hash) || undefined;
  result.quote_reservation_id = text(metadata.quote_reservation_id) || undefined;
  result.quote_signature = text(metadata.quote_signature) || undefined;
  result.recurring_amount_cents = null;

  const subscriptionId = text(session.subscription);
  if (subscriptionId) {
    const subscription = await callStripe({
      method: 'GET',
      url: `${SUBSCRIPTION_URL}/${encodeURIComponent(subscriptionId)}`,
      headers: authHeaders,
    });
    result.recurring_amount_cents = subscriptionRecurringCents(subscription);
    if (!result.currency) result.currency = text(subscription.currency) || null;
  }
  return result;
}

/**
 * Find the newest completed hosted session for one exact buyer and offer.
 *
 * This is the recovery half of hosted checkout: the normal path carries the
 * session id on the provider return URL, while this bounded read lets an
 * idempotent grant be resumed when that browser return was interrupted. The
 * provider remains the source of truth and only matching completed sessions
 * are returned; no customer, card, invoice, or credential material crosses
 * the package boundary.
 */
export async function findCompletedHostedSessionTarget(input: unknown) {
  const row = isRecord(input) ? input : {};
  const customerEmail = text(row.customer_email ?? row.email).toLowerCase();
  const offerId = text(row.offer_id ?? row.offerId);
  const hasCustomerEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail);
  const createdAfterUnix = Number(row.created_after_unix ?? row.createdAfterUnix);
  const hasCreatedBoundary = Number.isSafeInteger(createdAfterUnix) && createdAfterUnix > 0;
  if (!hasCustomerEmail && !hasCreatedBoundary) {
    throw new HostedSessionError(
      'customer_email or created_after_unix is required to recover a hosted checkout.',
      400,
    );
  }
  if (!offerId) {
    throw new HostedSessionError('offer_id is required to recover a hosted checkout.', 400);
  }

  const key = readSecretKey();
  const headers = {
    Authorization: `Bearer ${key}`,
    'Stripe-Version': STRIPE_DOCS_CURRENT_API_VERSION,
  };
  let startingAfter = '';
  let pagesRead = 0;
  let sessionsExamined = 0;
  let matchingEmailCount = 0;
  let matchingOfferCount = 0;
  const offerMatchesWithinBoundary: string[] = [];

  while (pagesRead < 10) {
    const query = new URLSearchParams({ limit: '100', status: 'complete' });
    if (hasCreatedBoundary) query.set('created[gte]', String(createdAfterUnix));
    if (startingAfter) query.set('starting_after', startingAfter);
    const page = await callStripe({
      method: 'GET',
      url: `${CREATE_SESSION_URL}?${query.toString()}`,
      headers,
    });
    pagesRead += 1;
    const sessions = Array.isArray(page.data) ? page.data : [];
    for (const candidate of sessions) {
      if (!isRecord(candidate)) continue;
      sessionsExamined += 1;
      const metadata = isRecord(candidate.metadata) ? candidate.metadata : {};
      const emailMatches = hasCustomerEmail
        && customerEmailOf(candidate).toLowerCase() === customerEmail;
      const offerMatches = text(metadata.offer_id) === offerId;
      if (emailMatches) matchingEmailCount += 1;
      if (offerMatches) matchingOfferCount += 1;
      if (!offerMatches || (hasCustomerEmail && !emailMatches)) continue;
      const providerSessionId = text(candidate.id);
      if (!providerSessionId) continue;
      if (!hasCustomerEmail) {
        offerMatchesWithinBoundary.push(providerSessionId);
        continue;
      }
      return {
        found: true,
        provider_session_id: providerSessionId,
        pages_read: pagesRead,
        sessions_examined: sessionsExamined,
        matching_email_count: matchingEmailCount,
        matching_offer_count: matchingOfferCount,
      };
    }
    if (page.has_more !== true || sessions.length === 0) break;
    const last = sessions.at(-1);
    startingAfter = isRecord(last) ? text(last.id) : '';
    if (!startingAfter) break;
  }

  if (!hasCustomerEmail && offerMatchesWithinBoundary.length === 1) {
    return {
      found: true,
      provider_session_id: offerMatchesWithinBoundary[0],
      pages_read: pagesRead,
      sessions_examined: sessionsExamined,
      matching_email_count: 0,
      matching_offer_count: matchingOfferCount,
    };
  }

  return {
    found: false,
    pages_read: pagesRead,
    sessions_examined: sessionsExamined,
    matching_email_count: matchingEmailCount,
    matching_offer_count: matchingOfferCount,
    ambiguous: !hasCustomerEmail && offerMatchesWithinBoundary.length > 1,
  };
}

export type CreateSubscriptionScheduleResult = {
  schedule_id: string;
  status: string;
  starts_at: number;
};

/**
 * Create the schedule that takes everything after the door charge.
 *
 * This runs once the checkout has settled, because until then there is no
 * customer to bill and no card to bill it to. The door charge is NOT here and
 * must not be: the provider creates a schedule's first invoice as a draft and
 * finalizes it about an hour later, so money that has to land while the person
 * is watching cannot be one of these phases.
 *
 * Fail-closed on every missing piece. A schedule that silently does not get
 * made is an offer whose later charges never happen, discovered weeks later by
 * nobody, because everything about the checkout looked right.
 */
export async function createSubscriptionScheduleTarget(input: unknown): Promise<CreateSubscriptionScheduleResult> {
  const row = isRecord(input) ? input : {};
  const schedule = paymentScheduleFromTheWire(row.payment_schedule);
  const arrangement = howStripeTakesASchedule(schedule);
  const request = subscriptionScheduleRequest(arrangement, {
    customerRef: text(row.customer_ref ?? row.customer),
    currency: text(row.currency) || 'usd',
    productName: text(row.product_name),
    // The caller says when signup happened rather than this reading a clock,
    // so asking twice for one signup asks for the same schedule twice instead
    // of two schedules a few seconds apart.
    signedUpAtUnixSeconds: Number(row.signed_up_at_unix_seconds),
  });

  const key = readSecretKey();
  const created = await callStripe({
    method: 'POST',
    url: SUBSCRIPTION_SCHEDULE_URL,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': STRIPE_DOCS_CURRENT_API_VERSION,
      ...(text(row.idempotency_key) ? { 'Idempotency-Key': text(row.idempotency_key) } : {}),
    },
    body: encodeStripeForm(request),
  });

  const scheduleId = text(created.id);
  if (!scheduleId) {
    throw new HostedSessionError('Stripe did not return a subscription schedule.', 502);
  }
  return {
    schedule_id: scheduleId,
    status: text(created.status) || 'not_started',
    starts_at: Number(request.start_date),
  };
}

export type CancelSubscriptionResult = {
  subscription_id: string;
  status: string;
  cancel_at_period_end: boolean;
};

export type UpdateSubscriptionMetadataResult = {
  subscription_id: string;
  metadata: Record<string, string>;
  updated: boolean;
};

/**
 * Cancel a Stripe subscription. This is the provider primitive a bounded
 * installment plan needs: after the Nth paid invoice, the caller cancels so no
 * further invoice is generated. Immediate cancel (DELETE) stops it now; passing
 * at_period_end keeps the already-paid period active and stops the next renewal.
 * Fail-closed: missing key or id throws with a publicStatus so the caller never
 * silently leaves a subscription running.
 */
export async function cancelSubscriptionTarget(input: unknown): Promise<CancelSubscriptionResult> {
  const row = isRecord(input) ? input : {};
  const subscriptionId = text(row.subscription_id ?? row.subscription ?? row.id);
  if (!subscriptionId) throw new HostedSessionError('subscription_id is required to cancel.', 400);
  const atPeriodEnd = row.at_period_end === true;
  const key = readSecretKey();
  const url = `${SUBSCRIPTION_URL}/${encodeURIComponent(subscriptionId)}`;
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': STRIPE_DOCS_CURRENT_API_VERSION,
  };
  // at_period_end updates the subscription (POST cancel_at_period_end=true); an
  // immediate cancel deletes it. Both use the Stripe subscriptions resource.
  const subscription = atPeriodEnd
    ? await callStripe({ method: 'POST', url, headers, body: encodeStripeForm({ cancel_at_period_end: true }) })
    : await callStripe({ method: 'DELETE', url, headers });
  return {
    subscription_id: text(subscription.id) || subscriptionId,
    status: text(subscription.status) || (atPeriodEnd ? 'active' : 'canceled'),
    cancel_at_period_end: subscription.cancel_at_period_end === true,
  };
}

function stringMetadata(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalized = text(raw);
    if (normalized) out[key] = normalized;
  }
  return out;
}

/**
 * Additive subscription metadata patch for revoke-path enrichment. Reads the
 * current subscription first, merges only non-empty provided keys, and skips the
 * POST when the effective metadata is unchanged.
 */
export async function updateSubscriptionMetadataTarget(input: unknown): Promise<UpdateSubscriptionMetadataResult> {
  const row = isRecord(input) ? input : {};
  const subscriptionId = text(row.subscription_id ?? row.subscription ?? row.id);
  if (!subscriptionId) {
    throw new HostedSessionError('subscription_id is required to update subscription metadata.', 400);
  }
  const patch = stringMetadata(row.metadata);
  if (Object.keys(patch).length === 0) {
    return { subscription_id: subscriptionId, metadata: {}, updated: false };
  }
  const key = readSecretKey();
  const url = `${SUBSCRIPTION_URL}/${encodeURIComponent(subscriptionId)}`;
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': STRIPE_DOCS_CURRENT_API_VERSION,
  };
  const current = await callStripe({ method: 'GET', url, headers });
  const currentMetadata = stringMetadata(current.metadata);
  const nextMetadata = { ...currentMetadata, ...patch };
  const changed = Object.keys(nextMetadata).some((keyName) => currentMetadata[keyName] !== nextMetadata[keyName])
    || Object.keys(currentMetadata).length !== Object.keys(nextMetadata).length;
  if (!changed) {
    return { subscription_id: subscriptionId, metadata: nextMetadata, updated: false };
  }
  const subscription = await callStripe({
    method: 'POST',
    url,
    headers,
    body: encodeStripeForm({ metadata: nextMetadata }),
  });
  return {
    subscription_id: text(subscription.id) || subscriptionId,
    metadata: stringMetadata(subscription.metadata),
    updated: true,
  };
}

function intOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Math.floor(Number(value));
  return 0;
}

export type AdvanceInstallmentResult = {
  subscription_id: string;
  /** True when this subscription is a bounded installment we act on; false = ignored. */
  handled: boolean;
  /** How many installments have been paid after this event (counter after increment). */
  installments_paid: number;
  /** The plan's fixed count (0 when not an installment subscription). */
  installment_count: number;
  /** True when this event completed the plan and the subscription was canceled. */
  canceled: boolean;
  /** True when this invoice was already counted (idempotent replay of a webhook). */
  duplicate: boolean;
};

/**
 * Grant-path primitive for a bounded pay-in-N offer. Called on each paid-invoice
 * event carrying the subscription. It reads the subscription's installment bound
 * from metadata, counts this paid invoice, and once the Nth installment is paid it
 * cancels the subscription so no further invoice is ever generated (the exact bound
 * an open Stripe subscription lacks). Open subscriptions (no installment_count
 * metadata) are ignored. Idempotent: a replayed webhook for the same invoice id is
 * counted once. Fail-closed on a missing key/id via the shared Stripe error.
 */
export async function advanceInstallmentTarget(input: unknown): Promise<AdvanceInstallmentResult> {
  const row = isRecord(input) ? input : {};
  const subscriptionId = text(row.subscription_id ?? row.subscription ?? row.id);
  if (!subscriptionId) throw new HostedSessionError('subscription_id is required to advance an installment.', 400);
  const invoiceId = text(row.invoice_id ?? row.invoice);
  const key = readSecretKey();
  const url = `${SUBSCRIPTION_URL}/${encodeURIComponent(subscriptionId)}`;
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': STRIPE_DOCS_CURRENT_API_VERSION,
  };

  const subscription = await callStripe({ method: 'GET', url, headers });
  const metadata = isRecord(subscription.metadata) ? subscription.metadata : {};
  const installmentCount = intOf(metadata.installment_count);
  // Not a bounded installment: leave open subscriptions untouched.
  if (installmentCount < 2) {
    return {
      subscription_id: subscriptionId,
      handled: false,
      installments_paid: 0,
      installment_count: 0,
      canceled: false,
      duplicate: false,
    };
  }

  const alreadyPaid = intOf(metadata.installments_paid);
  const lastInvoiceId = text(metadata.last_installment_invoice_id);
  // Idempotent: a webhook retry for the same invoice must not double-count.
  if (invoiceId && lastInvoiceId && invoiceId === lastInvoiceId) {
    return {
      subscription_id: subscriptionId,
      handled: true,
      installments_paid: alreadyPaid,
      installment_count: installmentCount,
      canceled: false,
      duplicate: true,
    };
  }

  const paid = alreadyPaid + 1;
  if (paid >= installmentCount) {
    // Final installment paid: mark the *entitlement* as retained before ending
    // the billing schedule. customer.subscription.deleted is also emitted for
    // ordinary subscription cancellations; this marker lets the generic
    // cancellation route distinguish "paid in full" from "access ended" and
    // prevents the final installment from revoking the purchased product.
    const completionMetadata: Record<string, string> = {
      installments_paid: String(paid),
      entitlement_retained: 'true',
    };
    if (invoiceId) completionMetadata.last_installment_invoice_id = invoiceId;
    await callStripe({
      method: 'POST',
      url,
      headers,
      body: encodeStripeForm({ metadata: completionMetadata }),
    });
    // Then cancel immediately so no further invoice is generated.
    await callStripe({ method: 'DELETE', url, headers });
    return {
      subscription_id: subscriptionId,
      handled: true,
      installments_paid: paid,
      installment_count: installmentCount,
      canceled: true,
      duplicate: false,
    };
  }

  // Not final: persist the incremented counter (and the invoice id for idempotency).
  const updateMetadata: Record<string, string> = { installments_paid: String(paid) };
  if (invoiceId) updateMetadata.last_installment_invoice_id = invoiceId;
  await callStripe({ method: 'POST', url, headers, body: encodeStripeForm({ metadata: updateMetadata }) });
  return {
    subscription_id: subscriptionId,
    handled: true,
    installments_paid: paid,
    installment_count: installmentCount,
    canceled: false,
    duplicate: false,
  };
}
