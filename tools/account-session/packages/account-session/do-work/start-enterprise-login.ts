export interface AccountSessionClient {
  send<TResponse>(
    target: string,
    payload: unknown,
    options?: { requestId?: string },
  ): Promise<TResponse>;
}

export interface StartEnterpriseLoginInput {
  identityProviderConfigId: string;
  returnUrl: string;
  requestId?: string;
}

export function buildEnterpriseLoginPayload(input: StartEnterpriseLoginInput) {
  return {
    identity_provider_config_id: input.identityProviderConfigId,
    return_url: input.returnUrl,
  };
}

export async function startEnterpriseLogin<TResponse>(
  client: AccountSessionClient,
  input: StartEnterpriseLoginInput,
): Promise<TResponse> {
  return client.send<TResponse>(
    'account-session.start-identity-provider-session',
    buildEnterpriseLoginPayload(input),
    { requestId: input.requestId },
  );
}
