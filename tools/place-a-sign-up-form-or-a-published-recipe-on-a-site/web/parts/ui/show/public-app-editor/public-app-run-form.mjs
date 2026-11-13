// Shared, schema-driven controls for a capability that a public page can run.
// This form lives with the UI part so public app consumers provide data and copy only.
export function publicAppRunForm(run) {
  if (!run || typeof run !== 'object' || !run.input_schema || typeof run.input_schema !== 'object') return null;
  const fields = run.input_schema.properties && typeof run.input_schema.properties === 'object'
    ? Object.entries(run.input_schema.properties) : [];
  if (!fields.length || fields.length > 20) return null;
  const form = document.createElement('form');
  form.className = 'trillion-placed-capability__run';
  const required = new Set(Array.isArray(run.input_schema.required) ? run.input_schema.required : []);
  for (const [name, schema] of fields) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) || !schema || typeof schema !== 'object' ||
        !['string', 'number', 'integer', 'boolean'].includes(schema.type)) continue;
    const label = document.createElement('label');
    const words = name.replaceAll('_', ' ');
    label.textContent = String(schema.title ?? `${words[0].toUpperCase()}${words.slice(1)}`);
    const input = document.createElement(schema.type === 'boolean' ? 'input' : 'textarea');
    input.name = name;
    input.required = schema.type === 'boolean' ? false : required.has(name);
    if (schema.type === 'boolean') input.type = 'checkbox';
    else {
      input.rows = 2;
      if (Number.isInteger(schema.maxLength)) input.maxLength = Math.min(schema.maxLength, run.max_input_bytes);
      if (schema.type === 'number' || schema.type === 'integer') {
        input.inputMode = 'decimal';
        input.dataset.valueType = schema.type;
        if (Number.isFinite(schema.minimum)) input.dataset.minimum = String(schema.minimum);
        if (Number.isFinite(schema.maximum)) input.dataset.maximum = String(schema.maximum);
      }
    }
    input.className = 'trillion-placed-capability__input';
    label.append(input);
    form.append(label);
  }
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.dataset.runSubmit = '';
  submit.textContent = 'Run';
  const result = document.createElement('output');
  result.className = 'trillion-placed-capability__result';
  result.dataset.runResult = '';
  result.setAttribute('aria-live', 'polite');
  form.append(submit, result);
  return form;
}

// Shared controls for a visitor action a public page collects (a sign-up, a waitlist, a question): one control per
// declared field, typed by the field, labelled by the placement's words. Text fields can use a roomy textarea or
// repeated entries, which remain one canonical newline-separated text answer. A field the page address fills
// (from_page_address) is carried hidden, with its value read from that query parameter of the page.
export function publicAppActionForm(item) {
  if (!item || !Array.isArray(item.fields) || !item.fields.length || item.fields.length > 40) return null;
  const words = item.form && typeof item.form === 'object' ? item.form : {};
  const byId = new Map((Array.isArray(words.fields) ? words.fields : []).map(field => [field.id, field]));
  // These are the existing visitor-action wire limits (public-app-definition and public-app-host), not row limits.
  // Validate without maxlength: pasting an over-limit answer must leave the whole answer available to edit.
  const textLimit = 4000, answerByteLimit = 16_384;
  const prefix = `visitor-${Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const form = document.createElement('form');
  form.className = 'trillion-placed-capability__run';
  form.noValidate = true;
  form.setAttribute('aria-label', typeof words.title === 'string' ? words.title : 'Your response');
  const records = [];
  let entryId = 0;
  const valueOf = record => {
    if (record.field.type === 'boolean') return record.controls[0].checked;
    const values = record.controls.map(control => control.value);
    const value = record.repeatable ? values.filter(value => value !== '').join('\n') : values[0];
    return record.field.type === 'number' && value !== '' ? Number(value) : value;
  };
  const errorOf = record => {
    const value = valueOf(record);
    if (record.field.required && value === '') return `Enter ${record.label.toLocaleLowerCase()}.`;
    if (typeof value === 'string' && value.length > textLimit) return `Use ${textLimit.toLocaleString('en-US')} characters or fewer${record.repeatable ? ' across these entries' : ''}. Your text is still here.`;
    const invalid = record.controls.find(control => control.validity?.valid === false);
    if (invalid) return invalid.validationMessage || `Check ${record.label.toLocaleLowerCase()}.`;
    if (record.field.type === 'number' && value !== '' && !Number.isFinite(value)) return 'Enter a number.';
    if (record.field.type === 'email' && value !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Enter an email address.';
    if (record.field.type === 'date' && value !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Enter a date.';
    return '';
  };
  const showError = (record, message) => {
    for (const control of record.controls) control.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (record.repeatable && record.region) record.region.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (record.error) { record.error.textContent = message; record.error.hidden = !message; }
  };
  const update = record => {
    const value = valueOf(record);
    if (record.hint) {
      const length = typeof value === 'string' ? value.length : 0;
      record.hint.textContent = length >= textLimit * .9 && length <= textLimit
        ? `${(textLimit - length).toLocaleString('en-US')} characters left${record.repeatable ? ' across all entries' : ''}.` : '';
    }
    if ((typeof value === 'string' && value.length > textLimit) || record.error?.textContent) showError(record, errorOf(record));
  };
  const makeControl = (record, multiline = false) => {
    // A one-row textarea also preserves line breaks when several entries are pasted together.
    const control = document.createElement(multiline || record.repeatable ? 'textarea' : 'input');
    control.name = record.field.id;
    control.id = `${prefix}-${record.field.id}-${++entryId}`;
    control.dataset.fieldType = record.field.type;
    if (multiline || record.repeatable) {
      control.rows = multiline ? 6 : 1;
      if (multiline) control.dataset.multiline = '';
    } else control.type = record.field.type === 'boolean' ? 'checkbox' : record.field.type;
    control.required = !record.repeatable && record.field.type !== 'boolean' && record.field.required === true;
    if (record.field.type === 'email') control.autocomplete = 'email';
    if (record.field.type === 'number') control.inputMode = 'decimal';
    control.className = 'trillion-placed-capability__input';
    control.setAttribute('aria-describedby', `${prefix}-${record.field.id}-hint ${prefix}-${record.field.id}-error`);
    control.addEventListener('input', () => update(record));
    record.controls.push(control);
    return control;
  };
  for (const field of item.fields) {
    if (!/^[a-z][a-z0-9-]{1,79}$/.test(field?.id ?? '') || !['text', 'email', 'number', 'boolean', 'date'].includes(field.type)) continue;
    const shown = byId.get(field.id) ?? {};
    const named = field.id.replaceAll('-', ' ');
    const record = { field, label: typeof shown.label === 'string' ? shown.label : `${named[0].toUpperCase()}${named.slice(1)}`,
      repeatable: field.type === 'text' && shown.repeatable === true, controls: [] };
    records.push(record);
    if (typeof shown.from_page_address === 'string') {
      const input = document.createElement('input');
      input.name = field.id;
      input.dataset.fieldType = field.type;
      input.type = 'hidden';
      input.value = new URLSearchParams(location.search).get(shown.from_page_address) ?? '';
      record.hidden = true;
      record.controls.push(input);
      form.append(input);
      continue;
    }
    const region = document.createElement(record.repeatable ? 'fieldset' : 'div');
    region.className = 'trillion-placed-capability__field';
    record.region = region;
    const label = document.createElement(record.repeatable ? 'legend' : 'label');
    label.textContent = record.label + (record.repeatable && field.required ? ' (at least one)' : '');
    region.append(label);
    if (record.repeatable) {
      const rows = document.createElement('div');
      rows.className = 'trillion-placed-capability__entries';
      const entries = [];
      const renumber = () => entries.forEach((entry, index) => {
        entry.label.textContent = `${record.label} ${index + 1}`;
        entry.remove.setAttribute('aria-label', `${typeof shown.remove_label === 'string' ? shown.remove_label : `Remove ${record.label.toLocaleLowerCase()}`} ${index + 1}`);
      });
      const addEntry = () => {
        const row = document.createElement('div');
        row.className = 'trillion-placed-capability__entry';
        const input = makeControl(record);
        const entryLabel = document.createElement('label');
        entryLabel.className = 'trillion-placed-capability__entry-label';
        entryLabel.htmlFor = input.id;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'trillion-placed-capability__secondary';
        remove.textContent = typeof shown.remove_label === 'string' ? shown.remove_label : 'Remove';
        const entry = { row, input, label: entryLabel, remove };
        remove.addEventListener('click', () => {
          const index = entries.indexOf(entry);
          entries.splice(index, 1);
          record.controls.splice(record.controls.indexOf(input), 1);
          row.remove();
          const next = entries[index] ?? entries[index - 1];
          renumber(); update(record); (next?.input ?? record.add).focus();
        });
        row.append(entryLabel, input, remove); rows.append(row); entries.push(entry); renumber(); update(record);
        return entry;
      };
      addEntry();
      const add = document.createElement('button');
      record.add = add;
      add.type = 'button';
      add.setAttribute('aria-describedby', `${prefix}-${field.id}-error`);
      add.className = 'trillion-placed-capability__secondary';
      add.textContent = typeof shown.add_label === 'string' ? shown.add_label : 'Add another';
      add.addEventListener('click', () => addEntry().input.focus());
      region.append(rows, add);
    } else {
      const input = makeControl(record, field.type === 'text' && shown.multiline === true);
      label.htmlFor = input.id;
      region.append(input);
    }
    const hint = document.createElement('small');
    hint.id = `${prefix}-${field.id}-hint`;
    hint.className = 'trillion-placed-capability__hint';
    if (field.type === 'text') record.hint = hint;
    const error = document.createElement('span');
    error.id = `${prefix}-${field.id}-error`;
    error.className = 'trillion-placed-capability__field-error';
    error.hidden = true;
    record.error = error;
    region.append(hint, error); update(record); form.append(region);
  }
  if (!records.some(record => !record.hidden)) return null;
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.dataset.runSubmit = '';
  submit.textContent = typeof words.submit_label === 'string' ? words.submit_label : 'Send';
  const result = document.createElement('output');
  result.className = 'trillion-placed-capability__result';
  result.dataset.runResult = '';
  result.setAttribute('aria-live', 'polite');
  form.readActionAnswer = () => {
    const answer = {};
    let first = null, firstVisible = null;
    for (const record of records) {
      const error = errorOf(record);
      showError(record, error);
      if (error && !first) first = record;
      if (error && !record.hidden && !firstVisible) firstVisible = record;
      const value = valueOf(record);
      if (value !== '') answer[record.field.id] = value;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(answer)).byteLength;
    if (first || bytes > answerByteLimit) {
      result.dataset.state = 'failed';
      result.setAttribute('role', 'alert');
      result.setAttribute('aria-live', 'assertive');
      result.textContent = first ? (first.hidden ? errorOf(first) : 'Please check the highlighted fields.') : 'This response is too long. Shorten it before sending; everything you entered is still here.';
      if (firstVisible) (firstVisible.controls[0] ?? firstVisible.add).focus();
      return null;
    }
    return answer;
  };
  form.append(submit, result);
  return form;
}
