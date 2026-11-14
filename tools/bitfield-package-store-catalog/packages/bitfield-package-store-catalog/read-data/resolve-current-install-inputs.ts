import { sendRequestToBitfieldTarget, type BitfieldRuntimeContext } from '@bitfield/runtime-kit';
import { resolveInstallInputs } from './resolve-install-inputs';

/** Reads only this owner's current catalog. Caller catalog/trust/pointer values are ignored. */
export async function resolveCurrentInstallInputs(input: { package_identity: string; package_set?: string }, _context?: BitfieldRuntimeContext,
  send = sendRequestToBitfieldTarget) {
  let catalog: unknown;
  try {
    const raw: any = await send({ target: 'engine.operation.label-addressed', payload: {
      operation_label: 'engine.operation.read-current', address_mode: 'label_hash',
      address_label: 'package::bitfield-package-store-catalog::stored-bytes::catalog-data',
    } });
    const value = raw.payload instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(raw.payload)) : raw.payload ?? raw;
    if (value.found === true) {
      catalog = value.payload;
      if (typeof catalog === 'string') catalog = JSON.parse(catalog);
      if (!catalog && typeof value.payload_base64 === 'string') catalog = JSON.parse(atob(value.payload_base64));
    }
  } catch { /* Absence or unreadable current data cannot grant installation. */ }
  return resolveInstallInputs(catalog, { package_identity: input.package_identity, package_set: input.package_set });
}
