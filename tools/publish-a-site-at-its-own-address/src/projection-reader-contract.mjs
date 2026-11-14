import { isObject, objectList, text } from './configured-record-action-projection.mjs';

export function decodeProjectionRows(value) {
  const rows = Array.isArray(value) ? value : objectList(value?.rows);
  return rows
    .filter((row) => row.kind === 'projection-row')
    .map((row) => ({
      subjectRef: text(row.subject_ref),
      projectionRef: text(row.projection_ref),
      fields: Object.fromEntries(
        objectList(row.field_roles).map((field) => [
          text(field.role),
          {
            fieldRef: text(field.field_ref),
            value: field.value ?? null,
          },
        ]),
      ),
      actions: objectList(row.action_roles).map((action) => ({
        role: text(action.role),
        actionRef: text(action.action_ref),
      })),
      views: objectList(row.view_roles).map((view) => ({ ...view })),
      history: objectList(row.history),
    }))
    .filter((row) => row.subjectRef);
}

export function buildReaderContract(rows, platform) {
  if (!['react-desktop-browser', 'ios-jscore'].includes(platform)) {
    throw new Error(`unsupported platform ${platform}`);
  }
  return {
    platform,
    rows: decodeProjectionRows(rows),
    invokeShape: {
      kind: 'owner-action-intent',
      fields: ['target', 'payload'],
    },
  };
}

export function lastExternalAddress(row) {
  const direct = row?.fields?.external_address?.value;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const fromHistory = [...(row?.history ?? [])]
    .reverse()
    .map((entry) => (isObject(entry.fields) ? entry.fields.external_address : undefined))
    .find((value) => typeof value === 'string' && value.length > 0);
  return fromHistory ?? null;
}

export function assertSameProjectionForPlatforms(rows) {
  const react = buildReaderContract(rows, 'react-desktop-browser');
  const ios = buildReaderContract(rows, 'ios-jscore');
  if (JSON.stringify(react.rows) !== JSON.stringify(ios.rows)) {
    throw new Error('platform projection rows diverged');
  }
  return { react, ios };
}
