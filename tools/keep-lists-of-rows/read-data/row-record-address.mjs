// A list's logical row type and its physical records need not have the same name.
// row_records { type, prefix } declares an existing address; without it, the caller's
// ordinary row-type template is preserved. This resolves addresses, never rights.
const text = (value, label) => {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be nonempty literal text without surrounding whitespace or control characters.`);
  }
  return value;
};
const idText = (value, label) => {
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be nonempty text.`);
  return value;
};

/** @param {{row_type?: string, row_records?: {type: string, prefix: string}}} list
 * @param {string} [typeTemplate] */
export function rowRecordAddress(list, typeTemplate = 'record:{row_type}') {
  if (!list || typeof list !== 'object' || Array.isArray(list)) throw new TypeError('A list definition is required.');
  let type, prefix;
  const declaredAddress = Object.hasOwn(list, 'row_records');
  if (declaredAddress) {
    const declared = list.row_records;
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)
      || Object.keys(declared).some(key => key !== 'type' && key !== 'prefix')) {
      throw new TypeError('row_records must declare exactly a record type and id prefix.');
    }
    type = text(declared.type, 'row_records.type');
    prefix = text(declared.prefix, 'row_records.prefix');
  } else {
    const logical = text(list.row_type, 'row_type');
    type = text(text(typeTemplate, 'Row type template').replaceAll('{row_type}', logical), 'Resolved row type');
    prefix = `${type}:`;
  }
  const localId = id => {
    idText(id, 'Record id');
    if (!id.startsWith(prefix) || id.length === prefix.length) throw new TypeError('Record id is outside this list’s declared prefix.');
    return id.slice(prefix.length);
  };
  const recordId = id => {
    idText(id, 'Row id');
    return `${prefix}${id}`;
  };
  // Legacy reads selected a kind, not a prefix. Only an explicit physical
  // declaration narrows that selection; malformed returned ids fail in localId.
  const query = Object.freeze({ type, ...(declaredAddress ? { prefix } : {}) });
  return Object.freeze({ type, prefix, query, recordId, localId });
}
