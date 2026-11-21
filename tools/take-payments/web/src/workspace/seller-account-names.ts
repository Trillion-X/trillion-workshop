// tools/take-payments/web/src/workspace/seller-account-names.ts
//
// PURPOSE
//   The names the account's vault holds, read at the account's door (seller-account.json `names_method`), for
//   seller-account.ts. Only the account's owner may read them; a refusal is null, so the connection is used as named.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { postJson } from '#workspace/api.ts';
import { SELLER_ACCOUNT, type ReadNames } from './seller-account';

export const readHeldNames: ReadNames = () =>
  postJson<{ names?: unknown }>(SELLER_ACCOUNT.names_method, {}).then(answer => (Array.isArray(answer?.names) ? answer.names.filter((name): name is string => typeof name === 'string') : null), () => null);
