// tools/send-messages/test/render-a-message.test.mjs
//
// Proves the message renderer is generic and DATA-driven: templates are selected by template_name (N templates
// coexist), placeholders are arbitrary {{key}} from a variables map, and the earlier login-link behaviour is
// byte-for-byte preserved. Carried from the email sender's render tests and its onboarding-wiring tests (the half
// about templates); the half about the old runtime's resolver action was not carried. The cases are the originals;
// only the assertion calls changed from vitest's to node:test's.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildEmailMessage, renderTemplateLines, selectDescriptor } from '../read-data/render-a-message.ts';

const contract = JSON.parse(readFileSync(new URL('../read-data/message-templates.json', import.meta.url), 'utf8'));
const things = Array.isArray(contract.things) ? contract.things : [];

describe('selectDescriptor: DATA-driven by template_name', () => {
  it('selects the login-link template', () => {
    const d = selectDescriptor(things, 'account-login-link');
    assert.equal(d.kind, 'message-template');
    assert.equal(d.template_name, 'account-login-link');
  });

  it('selects the onboarding template (the new one, zero code change)', () => {
    assert.equal(selectDescriptor(things, 'account-onboarding').template_name, 'account-onboarding');
  });

  it('throws on an unknown template (no silent first-template fallback)', () => {
    assert.throws(() => selectDescriptor(things, 'nope'), /Unsupported email template: nope/);
  });
});

describe('renderTemplateLines: generic {{key}} substitution', () => {
  it('substitutes multiple distinct placeholders', () => {
    const out = renderTemplateLines(['Hi {{firstName}}', 'Go {{loginUrl}}'], { firstName: 'Ada', loginUrl: 'https://x/y' }, 'l');
    assert.equal(out, 'Hi Ada\nGo https://x/y');
  });

  it('HTML-escapes substituted values in html mode only', () => {
    const raw = 'https://x/y?a=1&b=2';
    assert.equal(renderTemplateLines(['<a href="{{u}}">go</a>'], { u: raw }, 'l', true), '<a href="https://x/y?a=1&amp;b=2">go</a>');
    assert.equal(renderTemplateLines(['{{u}}'], { u: raw }, 'l', false), raw);
  });

  it('rejects a non-array template and a non-string line', () => {
    assert.throws(() => renderTemplateLines('x', {}, 'l'), /TEMPLATE_LINES_MISSING/);
    assert.throws(() => renderTemplateLines([1], {}, 'l'), /TEMPLATE_LINE_INVALID/);
  });
});

describe('buildEmailMessage: login-link behaviour preserved', () => {
  it('renders the login-link email exactly as before (escaped link in html, raw in text)', () => {
    const d = selectDescriptor(things, 'account-login-link');
    const link = 'https://app.example.com/signin?token=ab&x=1';
    // The installer supplies its OWN sending identity and merges it over the shipped template.
    const msg = buildEmailMessage(d, { link }, { from: 'An Installer <mail@installer.test>' });
    assert.equal(msg.subject, 'Sign in');
    assert.ok(msg.html.includes('href="https://app.example.com/signin?token=ab&amp;x=1"'));
    assert.ok(msg.text.includes('https://app.example.com/signin?token=ab&x=1')); // text not escaped
    assert.equal(msg.from, 'An Installer <mail@installer.test>');
  });

  it('ships NO sending identity, so a template used as-is refuses instead of sending as someone else', () => {
    const d = selectDescriptor(things, 'account-login-link');
    assert.throws(() => buildEmailMessage(d, { link: 'https://app.example.com/x' }), /from is required/);
  });

  it('an override merges over the shipped template rather than replacing it', () => {
    // The property that makes shipping no identity usable at all. Under replace semantics an installer supplying
    // only its address would lose the templates it was trying to use.
    const d = selectDescriptor(things, 'account-login-link');
    const msg = buildEmailMessage(d, { link: 'https://app.example.com/x' }, { from: 'A <a@b.test>' });
    assert.equal(msg.from, 'A <a@b.test>');
    assert.equal(msg.subject, 'Sign in');
    assert.ok(msg.html.includes('Use this link to sign in'));
  });

  it('every shipped template is free of a sending identity, not just the one above', () => {
    // A name sweep rather than a per-template assertion: the next template somebody adds is the one nobody writes a
    // test for. (The package's own copy of this sweep read `.things` of an array and so matched nothing; this reads
    // the list.)
    assert.equal((JSON.stringify(things).match(/"from"\s*:/g) ?? []).length, 0);
  });
});

describe('buildEmailMessage: onboarding email (new template, zero code change)', () => {
  it('renders onboarding with only loginUrl (firstName not available when access starts)', () => {
    const d = selectDescriptor(things, 'account-onboarding');
    const msg = buildEmailMessage(d, { loginUrl: 'https://app.example.com/home?u=1&v=2' }, { from: 'An Installer <mail@installer.test>' });
    assert.equal(msg.subject, 'Welcome — your access is now active');
    assert.ok(msg.html.includes('Welcome aboard!'));
    assert.ok(msg.html.includes('href="https://app.example.com/home?u=1&amp;v=2"'));
    assert.ok(msg.text.includes('Open your account: https://app.example.com/home?u=1&v=2'));
    // no unresolved placeholders remain (the template needs no firstName)
    assert.ok(!msg.html.includes('{{'));
    assert.ok(!msg.text.includes('{{'));
  });

  it('needs only {{loginUrl}} and no {{firstName}}', () => {
    const blob = JSON.stringify(selectDescriptor(things, 'account-onboarding').message);
    assert.ok(blob.includes('{{loginUrl}}'));
    assert.ok(!blob.includes('{{firstName}}'));
  });

  it('requires from + subject', () => {
    assert.throws(() => buildEmailMessage({ message: { html_template: [], text_template: [] } }, {}), /from is required/);
  });
});

describe('the package ships templates, never an installation', () => {
  const descriptors = things.map(thing => thing.payload);

  it('ships at least one template, so the checks around it are not vacuous', () => {
    assert.ok(descriptors.length > 0);
  });

  it('so a template used as shipped refuses rather than sending as somebody else', () => {
    // Absence has to be a THROW, not an empty sender.
    assert.throws(() => buildEmailMessage(descriptors[0], {}), /from is required/);
  });
});

describe('genericity proof: a brand-new template renders with ZERO code change', () => {
  it('renders an invented receipt template from DATA alone', () => {
    const invented = {
      payload: {
        kind: 'message-template',
        template_name: 'purchase-receipt',
        message: {
          from: 'Shop <hi@example.com>',
          subject: 'Receipt {{orderId}}',
          html_template: ['<p>Paid {{amount}} for {{orderId}}</p>'],
          text_template: ['Paid {{amount}} for {{orderId}}'],
        },
      },
    };
    const d = selectDescriptor([invented], 'purchase-receipt');
    const msg = buildEmailMessage(d, { orderId: 'A-100', amount: '$49' });
    assert.equal(msg.subject, 'Receipt A-100');
    assert.equal(msg.html, '<p>Paid $49 for A-100</p>');
    assert.equal(msg.text, 'Paid $49 for A-100');
  });
});
