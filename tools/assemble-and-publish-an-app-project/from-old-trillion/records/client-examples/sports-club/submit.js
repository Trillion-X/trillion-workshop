const form = document.querySelector('#inquiry-form');
const status = document.querySelector('#preview-note');
const button = form?.querySelector('button[type="submit"]');
let pending = null;

form?.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity() || !button) return;

  const values = new FormData(form);
  const fields = Object.fromEntries(
    ['name', 'email', 'experience', 'focus', 'note']
      .map(key => [key, String(values.get(key) ?? '').trim()])
      .filter(([, value]) => value)
  );
  const body = JSON.stringify(fields);
  if (!pending || pending.body !== body) pending = { body, key: crypto.randomUUID().replaceAll('-', '') };

  button.disabled = true;
  status.textContent = 'Saving your test response…';
  try {
    const response = await fetch('/actions/send-intake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
      body,
      credentials: 'omit'
    });
    const result = await response.json();
    if (!response.ok || result.received !== true) throw new Error(result.error || 'The response was not saved.');
    status.textContent = 'Your test response was saved for the page owner in Trillion.';
    form.reset();
    pending = null;
  } catch (error) {
    status.textContent = `${error.message || 'The response was not saved.'} Check your connection and try again.`;
  } finally {
    button.disabled = false;
  }
});
