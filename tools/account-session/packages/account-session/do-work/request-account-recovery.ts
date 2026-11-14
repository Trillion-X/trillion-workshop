export interface AccountSessionClient {
  send<TResponse>(
    target: string,
    payload: unknown,
    options?: { requestId?: string },
  ): Promise<TResponse>;
}

export interface RequestAccountRecoveryInput {
  methodFamily: string;
  accountIdHash?: string;
  devicePublicKeyHash?: string;
  evidenceHashes?: string[];
  requestId?: string;
}

export function buildAccountRecoveryPayload(input: RequestAccountRecoveryInput) {
  return {
    method_family: input.methodFamily,
    account_id_hash: input.accountIdHash ?? null,
    device_public_key_hash: input.devicePublicKeyHash ?? null,
    evidence_hashes: input.evidenceHashes ?? [],
  };
}

export async function requestAccountRecovery<TResponse>(
  client: AccountSessionClient,
  input: RequestAccountRecoveryInput,
): Promise<TResponse> {
  return client.send<TResponse>(
    'account-session.request-recovery',
    {
      payload: buildAccountRecoveryPayload(input),
    },
    { requestId: input.requestId },
  );
}
