// A public site's favicon address, shared by the account guide and the progress card.
// Keep this browser-safe: the progress card is part of the signed-in workspace bundle.
const TRILLION_ICON = 'https://app.gettrillion.ai/brand/current/mark.svg';
const TRILLION_DOMAIN = 'gettrillion.ai';

export const logoOf = domain => {
  if (typeof domain !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return '';
  const normalized = domain.toLowerCase();
  if (normalized === TRILLION_DOMAIN || normalized.endsWith(`.${TRILLION_DOMAIN}`)) return TRILLION_ICON;
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
};
