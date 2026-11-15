// The pricing section of old src/billing-screen.mjs, without its unrelated Worker billing imports.
import settings from '../src/billing-screen.json' with { type: 'json' };
const B = settings.usage_breakdown;
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (whole, name) => (values[name] ?? whole));

/** Seller-authorized current rule records as ordinary Guide fields/actions.
 * The caller owns authorization and supplies only this seller's record door.
 * A client sees their purchased usage basis, never this management section.
 * Full create/read/retire/delete and scope edits use the same published tool's
 * existing /use screen; the inline editor is only its convenient markup edit. */
export function usagePricingControls({ can_edit = false, rules = [], effective_at = new Date().toISOString() } = {}) {
  if (can_edit !== true) return null;
  const percentOf = value => {
    const digits = String(value ?? '');
    if (!/^\d+$/.test(digits)) return null;
    const whole = BigInt(digits) / 100n, remainder = (BigInt(digits) % 100n).toString().padStart(2, '0').replace(/0+$/, '');
    return `${whole}${remainder ? `.${remainder}` : ''}`;
  };
  return { id: 'usage-pricing', heading: B.pricing_heading, body: B.pricing_body,
    rows: rules.map(rule => {
      const scope = rule.scope ?? {};
      const title = rule.label ?? ([
        scope.resource_id ? fill(B.pricing_resource, { name: scope.resource_id }) : null,
        scope.plan_id ? fill(B.pricing_plan, { name: scope.plan_id }) : null,
        scope.client_id ? fill(B.pricing_client, { name: scope.client_id }) : null,
      ].filter(Boolean).join(' · ') || B.pricing_default);
      const value = percentOf(rule.markup_bps);
      const editable = Number.isSafeInteger(rule.version) && rule.version > 0 && value !== null && rule.state !== 'retired' && rule.state !== 'deleted';
      const { markup_bps: _bps, record_id: _record, ...basis } = rule;
      return { id: `usage-pricing:${rule.id}`, title,
        detail: editable ? B.pricing_terms : B.pricing_unversioned,
        status: { label: rule.state === 'retired' ? B.pricing_retired : rule.state === 'deleted' ? B.pricing_deleted : B.pricing_current, tone: 'quiet' },
        ...(editable ? { open_label: B.pricing_manage,
          fields: [{ name: 'markup_percent', label: B.pricing_markup, secret: false, value }],
          actions: [{ label: B.pricing_save, tone: 'quiet', tool: { id: 'tool:manage-usage-pricing',
            input: { action: 'save', rule_id: rule.id, expected_version: rule.version, rule: { ...basis, effective_at } },
            with_fields: true, field_paths: { markup_percent: ['rule', 'markup_percent'] }, request_key_field: 'request_key' } }],
        } : {}),
      };
    }),
    actions: [{ label: B.pricing_manage, tone: 'quiet', href: '/use/manage-usage-pricing' }],
  };
}
