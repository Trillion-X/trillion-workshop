function isPlainRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function validateRefreshDescriptor(descriptor) {
  if (!isPlainRecord(descriptor)) throw new Error('Refresh descriptor is required.');
  if (typeof descriptor.id !== 'string' || descriptor.id.length === 0) {
    throw new Error('Refresh descriptor requires id.');
  }
  if (typeof descriptor.target_ref !== 'string' || descriptor.target_ref.length === 0) {
    throw new Error('Refresh descriptor requires target_ref.');
  }
  if (typeof descriptor.target !== 'string' || descriptor.target.length === 0) {
    throw new Error('Refresh descriptor requires target.');
  }
  if (typeof descriptor.operation !== 'string' || descriptor.operation.length === 0) {
    throw new Error('Refresh descriptor requires operation.');
  }
  return descriptor;
}

// One request object. The refresh descriptor is the request; any per-call payload rides
// under `input` inside it. Argument two is reserved by the Runtime Kit calling convention
// for the injected runtime context, which this builder never reads, so it takes none.
export function buildRefreshRequest(refreshRequest) {
  const { input, ...descriptor } = isPlainRecord(refreshRequest) ? refreshRequest : {};
  const refresh = validateRefreshDescriptor(descriptor);
  if (refresh.operation === 'execute_definition') {
    if (typeof refresh.definition_id !== 'string' || refresh.definition_id.length === 0) {
      throw new Error('Refresh descriptor requires definition_id for execute_definition.');
    }
    const request = {
      target: refresh.target,
      payload: {
        operation: refresh.operation,
        definition_id: refresh.definition_id,
        include_steps: false,
        include_output: false,
        input: {
          ...(isPlainRecord(input) ? input : {}),
          target_ref: refresh.target_ref,
          descriptor_id: refresh.id,
        },
      },
    };
    console.log('[suggested-match] refresh descriptor accepted', { descriptor_id: refresh.id });
    return request;
  }
  const request = {
    target: refresh.target,
    payload: {
      operation: refresh.operation,
      target_ref: refresh.target_ref,
      input: isPlainRecord(input) ? input : {},
    },
  };
  console.log('[suggested-match] refresh descriptor accepted', { descriptor_id: refresh.id });
  return request;
}
