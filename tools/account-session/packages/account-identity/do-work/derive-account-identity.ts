import {
  materializeRoleAddressedRecords,
  type RoleMaterializationSpec,
} from '../../../../shared-code/packages/account-identity/read-data/account-identity-materialization';

export type DeriveAccountIdentityInput = {
  materialization_spec?: unknown;
  input?: unknown;
  email?: unknown;
};

export const ACCOUNT_IDENTITY_MATERIALIZATION_SPEC: RoleMaterializationSpec = {
  kind: 'role-addressed-materialization',
  source_roles: [
    {
      role: 'identity.input.primary',
      input_key: 'email',
      required: true,
      shape: 'text',
    },
  ],
  rules: [
    {
      role: 'identity.input.normalized',
      method: 'trim-lowercase-text',
      source_role: 'identity.input.primary',
      params: {
        invalid_message: 'Enter the email used for your Bitfield account.',
        max_length: 320,
        pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
      },
    },
    {
      role: 'identity.subject',
      method: 'content-hash-text',
      source_role: 'identity.input.normalized',
      params: {
        drop_hash_prefix_chars: 3,
        hash_input_prefix: 'account:',
        output_prefix: 'bitfield-account-',
      },
    },
    {
      role: 'identity.proof.email',
      method: 'content-hash-text',
      source_role: 'identity.input.normalized',
      params: {
        hash_input_prefix: 'email:',
      },
    },
  ],
  output_roles: [
    {
      role: 'identity.subject',
      label: 'Account ID',
      copyable: true,
      value: { from: 'rule', role: 'identity.subject' },
    },
    {
      role: 'identity.input.normalized',
      label: 'Account email',
      copyable: false,
      value: { from: 'rule', role: 'identity.input.normalized' },
    },
    {
      role: 'identity.proof.email',
      label: 'Email proof',
      copyable: true,
      value: { from: 'rule', role: 'identity.proof.email' },
    },
  ],
  projection: {
    address_label: 'package::account-identity::projection::roles',
    value_to_bytes: 'cell_table',
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function deriveAccountIdentity(input: DeriveAccountIdentityInput | unknown) {
  const body = isRecord(input) ? input : { email: input };
  const spec = body.materialization_spec ?? ACCOUNT_IDENTITY_MATERIALIZATION_SPEC;
  const roleInput = body.input ?? body;
  return materializeRoleAddressedRecords(spec, roleInput);
}
