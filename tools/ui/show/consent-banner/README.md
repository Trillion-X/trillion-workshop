# Consent banner (shared, static pages)

The cookie consent bar for a page built as static HTML, shared by every client site. Import it from the build; a site passes its
own consent block (its rows) and gets the same bar, the same first-party cookie and the same gtag consent update.

- `consent-banner.mjs`: `consentDefaultScript(consent)` (runs first in `<head>`: everything denied, granted again only from a kept
  "granted" cookie), `consentBannerScript(consent)` (the bar; Accept and Decline are the same element and class), and
  `consentBannerStyle()` (the bar's stylesheet).
- `consent-banner.css`: Screen Look tokens with fallbacks, a visible focus ring on the buttons, one fade and rise that
  `prefers-reduced-motion: reduce` removes.
- `consent-banner.test.mjs`: `node --test tools/ui/show/consent-banner/consent-banner.test.mjs`.

Words and names are the site's data: `consent.banner.label` is the bar's accessible name (its `aria-label`), not visible text; `consent.banner` (label, message, accept, decline), `consent.cookie` (name, max_age_seconds up
to 395 days) and `consent.storage_types`. The cookie is first-party, `SameSite=Lax`, `Secure`, `Path=/`. Nothing is granted before
Accept. A kept answer ("granted" or "denied") is never asked for again.

A static build loads the part from the Workshop folder it is given and places the default, the style and the bar in each page's head, the default first.
