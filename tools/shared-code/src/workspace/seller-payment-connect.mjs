/** Starts the seller's own Trillion payment setup, then opens Stripe's hosted onboarding. */
export async function startSellerPaymentConnect({ fetcher = fetch, navigate = url => window.location.assign(url) } = {}) {
  const response = await fetcher('/work/api/seller-payments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error || 'Payments could not be opened.');
  if (typeof result?.url !== 'string' || !URL.canParse(result.url)
    || new URL(result.url).protocol !== 'https:') {
    throw new Error('Stripe did not return a secure setup link.');
  }
  navigate(result.url);
}
