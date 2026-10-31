// A small local shop app for the tests: a home screen, a cart screen where a quantity is set and a total shown, a
// save that calls an API, and a receipt upload. `startShop({ broken: true })` ships a bug a person would hit: the
// total ignores the quantity and the save answers 500. `setBroken(false)` is the fix, without restarting.
import { createServer } from 'node:http';

const page = (title, body, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}<script>${script}</script></body></html>`;

const screens = broken => ({
  '/': page('Tiny shop', '<h1>Tiny shop</h1><nav><a href="/cart">Cart</a> <a href="/about">About</a></nav><p>One kind of mug, $29.</p>'),
  '/about': page('About', '<h1>About</h1><a href="/">Home</a>'),
  '/cart': page('Cart', `<h1>Cart</h1>
    <label for="qty">Quantity</label><input id="qty" type="number" value="1" min="1">
    <button type="button" id="update">Update total</button>
    <p id="total">Total: $29</p>
    <button type="button" id="save">Save cart</button><p id="saved" role="status"></p>
    <label for="receipt">Receipt</label><input id="receipt" type="file"><p id="chosen"></p>
    <a href="/">Home</a>`, `
    document.getElementById('update').addEventListener('click', () => {
      const qty = Number(document.getElementById('qty').value);
      document.getElementById('total').textContent = 'Total: $' + (${broken ? '29' : '29 * qty'});
    });
    document.getElementById('save').addEventListener('click', async () => {
      const answer = await fetch('/api/save', { method: 'POST' });
      if (!answer.ok) console.error('save failed with ' + answer.status);
      document.getElementById('saved').textContent = answer.ok ? 'Saved' : 'Could not save';
    });
    document.getElementById('receipt').addEventListener('change', event => {
      document.getElementById('chosen').textContent = 'Chosen: ' + [...event.target.files].map(file => file.name).join(', ');
    });`),
});

export async function startShop({ broken }) {
  const state = { broken };
  const server = createServer((request, response) => {
    if (request.url === '/api/save') { response.writeHead(state.broken ? 500 : 200, { 'content-type': 'application/json' }); response.end('{}'); return; }
    const html = screens(state.broken)[request.url.split('?')[0]];
    response.writeHead(html ? 200 : 404, { 'content-type': 'text/html' });
    response.end(html ?? 'not here');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}/`, setBroken: value => { state.broken = value; }, close: () => new Promise(done => server.close(done)) };
}
