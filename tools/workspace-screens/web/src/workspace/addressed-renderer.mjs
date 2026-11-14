// An independently installed renderer receives resource DATA through the same
// presentation client as native shared screens. Loading code is never readiness.
import { createAddressedPresentationClient } from './addressed-presentation.mjs';
import { onResourceAction } from './resource-presentation-host.mjs';

export function mountAddressedRenderer({ element, binding, props, resolveRenderer, host, onError, beforeMount = () => {} }) {
  let gone = false, renderer, client, stopActions;
  const controller = new AbortController();
  const opening = (async () => {
    const implementation = await resolveRenderer(binding.renderer, { binding, signal: controller.signal });
    if (gone) return;
    if (typeof implementation?.mountPresentation !== 'function') throw new TypeError('This installed renderer does not implement current resource paint.');
    client = createAddressedPresentationClient({ ...host,
      paint: (value, context) => renderer.paint(value, context),
      onError,
    });
    beforeMount();
    renderer = await implementation.mountPresentation(element, { ...props, binding,
      signal: controller.signal,
      invoke: input => client.mutate(binding, { ...input, signal: controller.signal }),
    });
    if (gone) { renderer?.close?.(); return; }
    if (typeof renderer?.paint !== 'function' || typeof renderer?.close !== 'function') throw new TypeError('The renderer must supply paint and close.');
    const session = client.open(binding, { signal: controller.signal });
    stopActions = onResourceAction(envelope => {
      if (envelope.address === binding.address && envelope.generation === binding.generation)
        void session.refresh().catch(() => {});
    });
    await session.ready;
  })();
  void opening.catch(error => { if (!gone) onError(error); });
  const close = () => { if (gone) return; gone = true; controller.abort(); stopActions?.(); client?.close(); renderer?.close?.(); };
  close.ready = opening;
  close.update = next => renderer?.update?.(next) ?? false;
  return close;
}
