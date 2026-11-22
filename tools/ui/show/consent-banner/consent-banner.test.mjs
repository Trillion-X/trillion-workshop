// tools/ui/show/consent-banner/consent-banner.test.mjs: the consent default, the bar and its cookie, and the stylesheet's focus and motion rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consentBannerScript, consentBannerStyle, consentDefaultScript } from './consent-banner.mjs';

const consent = {
  default: 'denied',
  storage_types: ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage'],
  cookie: { name: 'ethos_consent', max_age_seconds: 15552000 },
  banner: { label: 'Cookie choice', message: 'We measure visits only if you accept.', accept: 'Accept', decline: 'Decline' },
};

test('the consent default denies every storage type before any tag, and grants again only from a kept granted cookie', () => {
  const out = consentDefaultScript(consent);
  assert.ok(out.startsWith('<script>') && out.endsWith('</script>'));
  assert.ok(out.includes('"ad_storage":"denied"') && out.includes('"analytics_storage":"denied"'));
  assert.ok(out.includes("(?:^|; )ethos_consent=([^;]*)"));
  assert.ok(out.includes("m[1]==='granted'"));
  const defaultCall = out.slice(out.indexOf("gtag('consent','default',"), out.indexOf('});', out.indexOf("gtag('consent','default',")) + 1);
  assert.ok(!defaultCall.includes('granted'), 'the default call itself grants nothing');
});

test('the bar writes the cookie first-party, Lax and Secure, with the site max age, and grants only on Accept', () => {
  const out = consentBannerScript(consent);
  assert.ok(out.includes("'; Max-Age='+MAX+'; Path=/; SameSite=Lax; Secure'"));
  assert.ok(out.includes('MAX=15552000'));
  assert.ok(out.includes("[['accept','granted'],['decline','denied']]"));
  assert.ok(out.includes("if(value==='granted')gtag('consent','update',GRANTED)"));
});

test('Accept and Decline are one class with the same button element, so neither is easier', () => {
  const out = consentBannerScript(consent);
  assert.ok(out.includes("b.className='consent-banner-button'"));
  assert.equal(out.match(/createElement\('button'\)/g).length, 1);
});

test('a kept answer is never asked for again', () => {
  const out = consentBannerScript(consent);
  assert.ok(out.includes("if(saved()==='granted'||saved()==='denied')return;"));
});

test('the bar draws with classes only, never inline styles', () => {
  const out = consentBannerScript(consent);
  assert.ok(!out.includes('.style.'), 'no element.style writes');
  assert.ok(!out.includes('cssText'));
  assert.ok(out.includes("bar.className='consent-banner'"));
});

test('words and names that could close the script are escaped', () => {
  const hostile = { ...consent, banner: { ...consent.banner, message: '</script><img src=x onerror=alert(1)>' } };
  const out = consentBannerScript(hostile);
  assert.ok(!out.includes('</script><img'));
  assert.ok(out.includes('\\u003c/script\\u003e'));
});

test('a bad consent block is refused with the field named', () => {
  assert.throws(() => consentBannerScript({ ...consent, cookie: { name: 'bad name', max_age_seconds: 1 } }), /cookie\.name/);
  assert.throws(() => consentBannerScript({ ...consent, cookie: { name: 'ok', max_age_seconds: 34128001 } }), /395 days/);
  assert.throws(() => consentDefaultScript({ ...consent, banner: { ...consent.banner, accept: '' } }), /storage_types|accept/);
});

test('the stylesheet shows a visible focus ring and drops motion under reduced motion', () => {
  const css = consentBannerStyle();
  assert.ok(css.includes('.consent-banner-button:focus-visible'));
  assert.ok(css.includes('var(--focus-ring-color'));
  assert.ok(css.includes('@media (prefers-reduced-motion: no-preference)'));
  assert.ok(!css.includes('transition: all'));
});
