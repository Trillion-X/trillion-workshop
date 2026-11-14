export {
  ACCOUNT_IDENTITY_MATERIALIZATION_SPEC,
  deriveAccountIdentity,
  type DeriveAccountIdentityInput,
} from './do-work/derive-account-identity';
export {
  decodeRoleAddressedMaterializationResult,
  materializeRoleAddressedRecords,
  readMaterializedRoleValue,
  type MaterializedRoleRow,
  type RoleAddressedMaterializationResult,
  type RoleMaterializationSpec,
} from '../../../shared-code/packages/account-identity/read-data/account-identity-materialization';
