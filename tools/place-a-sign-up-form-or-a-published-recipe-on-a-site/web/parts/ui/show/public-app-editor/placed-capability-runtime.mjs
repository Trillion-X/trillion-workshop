// Served from the current Trillion host. Public pages hold only placement ids;
// the host resolves each published source again on every visit.
import { publicAppActionForm, publicAppRunForm } from './public-app-run-form.mjs';

export function publicAppRunResult(result, value, schema = {}) {
  const heading = document.createElement('strong');
  heading.className = 'trillion-placed-capability__result-heading';
  heading.textContent = 'Result';
  const body = document.createElement('div');
  const labelOf = key => `${key.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase())}`;
  const primitive = item => item === null ? '—' : typeof item === 'boolean' ? (item ? 'Yes' : 'No') : String(item);
  const fields = (parent, object, properties = {}, depth = 0) => {
    const list = document.createElement('dl');
    list.className = 'trillion-placed-capability__result-fields';
    for (const [key, item] of Object.entries(object).slice(0, 24)) {
      const row = document.createElement('div');
      row.className = 'trillion-placed-capability__result-field';
      const name = document.createElement('dt');
      name.textContent = typeof properties[key]?.title === 'string' ? properties[key].title : labelOf(key);
      const answer = document.createElement('dd');
      if (Array.isArray(item)) {
        const items = document.createElement('ul');
        for (const part of item.slice(0, 24)) {
          const entry = document.createElement('li');
          entry.textContent = part && typeof part === 'object' ? JSON.stringify(part) : primitive(part);
          items.append(entry);
        }
        answer.append(items);
      } else if (item && typeof item === 'object' && depth < 2) {
        fields(answer, item, properties[key]?.properties ?? {}, depth + 1);
      } else answer.textContent = item && typeof item === 'object' ? JSON.stringify(item) : primitive(item);
      row.append(name, answer);
      list.append(row);
    }
    parent.append(list);
  };
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) fields(body, value, schema.properties ?? {});
  else {
    const copy = document.createElement('p');
    copy.textContent = value === undefined ? 'Done.' : primitive(value);
    body.append(copy);
  }
  result.replaceChildren(heading, body);
  result.dataset.state = 'completed';
}

export function placedCapabilityRuntime(makeRunForm = publicAppRunForm, renderResult = publicAppRunResult, makeActionForm = publicAppActionForm) {
  const pending = new Map();
  // A visitor action (a sign-up, a waitlist) draws as its own form; its words come from the placement's DATA.
  const renderAction = item => {
    const form = makeActionForm(item);
    if (!form) throw new Error('unavailable');
    const words = item.form ?? {};
    const card = document.createElement('article');
    card.className = 'trillion-placed-capability';
    if (typeof words.title === 'string') {
      const title = document.createElement('h2');
      title.textContent = words.title;
      card.append(title);
    }
    if (typeof words.description === 'string') {
      const description = document.createElement('p');
      description.textContent = words.description;
      card.append(description);
    }
    const result = form.querySelector('[data-run-result]');
    const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    // One key per submitted answer, including retries after edits are undone. Adding an empty repeated row does not
    // change the canonical answer and must not turn an uncertain previous send into a second record.
    const answerKeys = new Map();
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (form.getAttribute('aria-busy') === 'true') return;
      const answer = form.readActionAnswer();
      if (answer === null) return;
      const wire = JSON.stringify(answer);
      if (!answerKeys.has(wire)) answerKeys.set(wire, newKey());
      const key = answerKeys.get(wire);
      const controls = Array.from(form.querySelectorAll('input, textarea, button'), control => [control, control.disabled]);
      for (const [control] of controls) control.disabled = true;
      form.setAttribute('aria-busy', 'true');
      result.dataset.state = 'working';
      result.setAttribute('role', 'status');
      result.setAttribute('aria-live', 'polite');
      result.textContent = 'Sending…';
      try {
        const response = await fetch(item.action_url, { method: 'POST', credentials: 'omit',
          headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: wire });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          result.dataset.state = 'failed';
          result.setAttribute('role', 'alert');
          result.setAttribute('aria-live', 'assertive');
          result.textContent = typeof body.error === 'string' && body.error.length <= 200 ? body.error : 'This could not be sent. Try again.';
          return;
        }
        const done = document.createElement('p');
        done.className = 'trillion-placed-capability__result';
        done.dataset.state = 'completed';
        done.setAttribute('role', 'status');
        done.textContent = typeof words.done_message === 'string' ? words.done_message : 'Thank you. Your answer was sent.';
        form.replaceWith(done);
      } catch {
        result.dataset.state = 'failed';
        result.setAttribute('role', 'alert');
        result.setAttribute('aria-live', 'assertive');
        result.textContent = 'This could not be sent. Check your connection and try again.';
      } finally {
        form.setAttribute('aria-busy', 'false');
        for (const [control, disabled] of controls) control.disabled = disabled;
      }
    });
    card.append(form);
    return card;
  };
  const safeLink = value => {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      if (url.origin !== 'https://app.gettrillion.ai' || url.search || url.hash) return null;
      if (/^\/marketplace(?:\/[^/]+)?\/?$/.test(decodeURIComponent(url.pathname)) || /^\/(?:workshop|runs)\/?$/.test(url.pathname)) return url.href;
    } catch { /* Invalid source-owned link. */ }
    return null;
  };
  const render = (view, run = null) => {
    const card = document.createElement('article');
    card.className = `trillion-placed-capability${view.display_style === 'plain' ? ' trillion-placed-capability--plain' : ''}`;
    const label = document.createElement('small');
    label.textContent = view.source_label;
    const title = document.createElement('h2');
    title.textContent = view.title;
    const description = document.createElement('p');
    description.textContent = view.description;
    card.append(label, title, description);
    for (const section of view.sections ?? []) {
      const region = document.createElement('section');
      if (typeof section.heading === 'string') {
        const heading = document.createElement('h3');
        heading.textContent = section.heading;
        region.append(heading);
      }
      if (typeof section.text === 'string') {
        const copy = document.createElement('p');
        copy.textContent = section.text;
        region.append(copy);
      }
      if (Array.isArray(section.items) && section.items.length) {
        const list = document.createElement('ul');
        for (const rowData of section.items) {
          const row = document.createElement('li');
          const content = rowData.label || rowData.text || '';
          const href = safeLink(rowData.href);
          if (href) {
            const link = document.createElement('a');
            link.textContent = content;
            link.href = href;
            row.append(link);
          } else row.textContent = content;
          if (rowData.text && rowData.label) {
            const detail = document.createElement('span');
            detail.textContent = rowData.text;
            row.append(detail);
          }
          list.append(row);
        }
        region.append(list);
      }
      card.append(region);
    }
    const linked = new Set();
    const addLink = (labelText, href) => {
      const destination = safeLink(href);
      if (typeof labelText !== 'string' || !destination) return;
      const key = `${labelText}\u0000${destination}`;
      if (linked.has(key)) return;
      linked.add(key);
      const link = document.createElement('a');
      link.textContent = labelText;
      link.href = destination;
      card.append(link);
    };
    if (view.actions?.length) {
      for (const action of view.actions) addLink(action.label, action.href);
    } else addLink('Open in Trillion', view.href);
    if (run && typeof run.action_url === 'string' && run.input_schema && typeof run.input_schema === 'object') {
      const form = makeRunForm(run);
      if (form) {
        const submit = form.querySelector('[data-run-submit]');
        const result = form.querySelector('[data-run-result]');
        form.addEventListener('submit', async event => {
          event.preventDefault();
          submit.disabled = true;
          result.textContent = 'Running…';
          result.dataset.state = 'working';
          const inputValue = {};
          for (const field of form.querySelectorAll('[name]')) {
            if (field.type === 'checkbox') inputValue[field.name] = field.checked;
            else if (field.dataset.valueType) {
              const number = Number(field.value);
              const minimum = Number(field.dataset.minimum);
              const maximum = Number(field.dataset.maximum);
              if (!Number.isFinite(number) || (field.dataset.minimum && number < minimum) || (field.dataset.maximum && number > maximum)) {
                result.textContent = `Check ${field.name} and try again.`;
                submit.disabled = false;
                return;
              }
              inputValue[field.name] = number;
            } else inputValue[field.name] = field.value;
          }
          try {
            const response = await fetch(run.action_url, { method: 'POST', credentials: 'omit', headers: {
              'content-type': 'application/json', 'idempotency-key': Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''),
            }, body: JSON.stringify({ input: inputValue }) });
            let answer = await response.json();
            if (response.status === 202 && answer.result?.task_id) {
              const statusUrl = new URL(run.action_url, location.href);
              statusUrl.searchParams.set('task_id', answer.result.task_id);
              for (let attempt = 0; attempt < 60 && answer.result?.state !== 'completed' && answer.result?.state !== 'failed'; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                const status = await fetch(statusUrl, { credentials: 'omit' });
                answer = await status.json();
              }
            }
            if (answer.result?.state === 'failed' || answer.result?.state !== 'completed') throw new Error('This run is taking longer than expected. Keep this page open and try again shortly.');
            const value = answer.result?.output ?? answer.result?.error ?? (answer.result?.state === 'completed' ? 'Done.' : 'This is still running. Check again in a moment.');
            renderResult(result, value, run.output_schema);
          } catch { result.dataset.state = 'failed'; result.textContent = 'This could not be run. Try again.'; }
          finally { submit.disabled = false; }
        });
        card.append(form);
      }
    }
    return card;
  };
  for (const slot of document.querySelectorAll('[data-trillion-placement]')) {
    const id = slot.getAttribute('data-trillion-placement');
    if (!/^[a-z][a-z0-9-]{1,79}$/.test(id ?? '')) continue;
    if (!pending.has(id)) pending.set(id, fetch(`/capabilities/${encodeURIComponent(id)}`, { credentials: 'omit' }).then(async response => {
      if (!response.ok) throw new Error('unavailable');
      const body = await response.text();
      if (new TextEncoder().encode(body).byteLength > 32_768) throw new Error('unavailable');
      const item = JSON.parse(body);
      if (Array.isArray(item.fields)) {
        if (item.action_url !== `/capabilities/${id}/actions` || (item.form !== undefined && (!item.form || typeof item.form !== 'object'))) throw new Error('unavailable');
        return { action: item };
      }
      const view = item.view;
      if (view?.schema !== 'trillion.public-visitor-view/1' || typeof view.source_label !== 'string' ||
          typeof view.title !== 'string' || typeof view.description !== 'string' ||
          (view.display_style !== undefined && !['card', 'plain'].includes(view.display_style)) ||
          !safeLink(view.href) ||
          !Array.isArray(view.sections ?? []) || !Array.isArray(view.actions ?? [])) throw new Error('unavailable');
      const run = item.run;
      if (run !== undefined && (!run || typeof run !== 'object' || !/^\/capabilities\/[a-z][a-z0-9-]{1,79}\/actions$/.test(run.action_url ?? '') ||
          !Number.isInteger(run.runs_per_day) || !Number.isInteger(run.max_input_bytes) || run.max_input_bytes > 16_384 ||
          !run.input_schema || typeof run.input_schema !== 'object')) throw new Error('unavailable');
      return { view, run: run ?? null };
    }));
    pending.get(id).then(({ action, view, run }) => slot.replaceChildren(action ? renderAction(action) : render(view, run))).catch(() => { slot.textContent = 'This item is unavailable.'; });
  }
}

export const placedCapabilityScript = `(${placedCapabilityRuntime.toString()})(${publicAppRunForm.toString()},${publicAppRunResult.toString()},${publicAppActionForm.toString()});`;
