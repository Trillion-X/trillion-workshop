export interface AccountSessionClient {
  send<TResponse>(
    target: string,
    payload: unknown,
    options?: { requestId?: string },
  ): Promise<TResponse>;
}

export async function endSession<TResponse>(
  client: AccountSessionClient,
  input: {
    requestId?: string;
  },
): Promise<TResponse> {
  return client.send<TResponse>(
    'account-session.end-session',
    {
      payload: { action: 'end_session' },
    },
    { requestId: input.requestId },
  );
}
