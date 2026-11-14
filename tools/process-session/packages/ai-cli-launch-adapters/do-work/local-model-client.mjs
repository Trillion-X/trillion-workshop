function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function localUrl(value, label) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password) {
    throw new Error(`${label} must use a local model endpoint on this Mac.`);
  }
  return url;
}

function getAt(value, parts) {
  let current = value;
  for (const part of parts || []) current = current?.[part];
  return current;
}

async function requestJson(url, {method = 'GET', body, timeoutMs = 120000, signal} = {}) {
  const response = await fetch(localUrl(url, 'Model URL'), {
    method,
    redirect: 'error',
    headers: body === undefined ? undefined : {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
  });
  if (!response.ok) throw new Error(`The local model returned ${response.status}.`);
  return response.json();
}

function renderTemplate(value, context) {
  if (Array.isArray(value)) return value.map(item => renderTemplate(item, context));
  if (plainObject(value)) {
    if (typeof value.setting === 'string') return context[value.setting];
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTemplate(item, context)]));
  }
  return value;
}

function modelSettings(adapter, model) {
  return (adapter.settings || []).filter(setting => !setting.when_model_capability || (model.capabilities || []).includes(setting.when_model_capability)).map(setting => ({
    ...setting,
    default: setting.default ?? '',
  }));
}

export function loadSearchChatConfig(value) {
  if (!plainObject(value) || value.schema !== 'bitfield.local-model-client/v1' || !Array.isArray(value.catalog_sources) || !Array.isArray(value.adapters)) {
    throw new Error('The local model configuration is invalid.');
  }
  return structuredClone(value);
}

export async function discoverInvocationCatalog(value) {
  const config = loadSearchChatConfig(value);
  const adapters = new Map(config.adapters.map(adapter => [adapter.id, adapter]));
  const options = [];
  for (const source of config.catalog_sources) {
    if (source.kind !== 'ollama-models') continue;
    const adapter = adapters.get(source.adapter_id);
    if (!adapter) continue;
    let models = [];
    let available = false;
    try {
      const reply = await requestJson(source.url, {timeoutMs: source.timeout_ms || 3000});
      models = reply.models || [];
      available = true;
    } catch {}
    for (const model of models) {
      const id = String(model.model || model.name || '');
      if (!id || (source.required_capability && !(model.capabilities || []).includes(source.required_capability))) continue;
      options.push({
        id: `${source.adapter_id}::${id}`,
        adapter_id: source.adapter_id,
        model_id: id,
        label: id,
        provider_label: source.label,
        transport: source.transport,
        available,
        discovered_from: source.id,
        settings: modelSettings(adapter, model),
        is_default: id === source.default_model_id,
      });
    }
  }
  options.sort((a, b) => Number(b.available) - Number(a.available) || Number(b.is_default) - Number(a.is_default) || a.label.localeCompare(b.label));
  return {schema: 'bitfield.model-invocation-catalog/v1', generated_at: new Date().toISOString(), options};
}

export async function invokeConfiguredModel({invocation, messages, prompt, signal}, value) {
  const config = loadSearchChatConfig(value);
  const adapter = config.adapters.find(candidate => candidate.id === invocation.adapter_id);
  if (!adapter) throw new Error('The selected local model connection is unavailable.');
  const context = {
    ...(invocation.settings || {}),
    model: invocation.model_id,
    messages: adapter.messages_source === 'grounded_prompt' ? [{role: 'user', content: prompt}] : messages,
    prompt,
  };
  if (context.thinking === 'true') context.thinking = true;
  if (context.thinking === 'false') context.thinking = false;
  const reply = await requestJson(adapter.url, {
    method: 'POST',
    body: renderTemplate(adapter.body, context),
    timeoutMs: adapter.timeout_ms,
    signal,
  });
  const answer = getAt(reply, adapter.response_path);
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('The local model returned an empty answer.');
  return {answer: answer.trim(), adapter_id: adapter.id, model_id: invocation.model_id, settings: invocation.settings || {}, transport: adapter.kind};
}
