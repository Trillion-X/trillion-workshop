// A public site's favicon address, shared by the account guide and the progress card.
// Keep this browser-safe: the progress card is part of the signed-in workspace bundle.
export const logoOf = domain => {
  if (typeof domain !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return '';
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
};
