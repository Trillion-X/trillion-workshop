// One storefront component for any installed public app with a merchant source.
// The page supplies a host element; this shared component owns the controls.
export function merchantStorefrontRuntime() {
  // A refusal the shop answered (already in plain words, through the host's gate) is shown; anything else, such as a
  // dropped connection, shows the control's own plain line.
  const refused = (result, fallback) => Object.assign(new Error(typeof result?.error === 'string' && result.error ? result.error : fallback), { answered: true });
  const shown = (error, fallback) => (error?.answered ? error.message : fallback);
  const make = (tag, className, words) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (words !== undefined) node.textContent = words;
    return node;
  };
  const priceText = (amount, currency) => {
    const value = Number(amount);
    if (!Number.isFinite(value) || !currency) return 'Price at checkout';
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value); }
    catch { return `${value.toFixed(2)} ${currency}`; }
  };
  for (const host of document.querySelectorAll('[data-trillion-storefront]')) {
    const status = make('p', 'trillion-shop-status', 'Loading products…');
    status.setAttribute('role', 'status');
    const grid = make('div', 'trillion-shop-grid');
    const bag = make('section', 'trillion-shop-bag');
    bag.hidden = true;
    const bagTitle = make('h3', '', 'Your bag');
    const bagItems = make('p', '', 'Your bag is empty.');
    const checkout = make('button', 'trillion-shop-checkout', 'Checkout');
    const more = make('button', 'trillion-shop-more', 'Load more products');
    more.type = 'button';
    more.hidden = true;
    checkout.type = 'button';
    checkout.disabled = true;
    bag.append(bagTitle, bagItems, checkout);
    host.replaceChildren(status, grid, more, bag);
    const contactAction = host.getAttribute('data-trillion-contact-action');
    if (/^[a-z][a-z0-9-]{1,79}$/.test(contactAction ?? '')) {
      const form = make('form', 'trillion-shop-contact');
      const heading = make('h3', '', host.getAttribute('data-trillion-contact-heading') || 'Interested in this shop?');
      const explanation = make('p', '', host.getAttribute('data-trillion-contact-description') || 'Leave your email so the team can hear from you.');
      const emailLabel = make('label', '', 'Email address');
      const email = make('input', 'trillion-shop-email');
      email.type = 'email';
      email.name = 'email';
      email.autocomplete = 'email';
      email.required = true;
      emailLabel.append(email);
      const consentLabel = make('label', 'trillion-shop-consent');
      const consent = make('input');
      consent.type = 'checkbox';
      consent.required = true;
      consentLabel.append(consent, make('span', '', host.getAttribute('data-trillion-contact-consent') || 'I agree that this team may contact me about this shop.'));
      const submit = make('button', 'trillion-shop-contact-submit', host.getAttribute('data-trillion-contact-submit') || 'Send my interest');
      submit.type = 'submit';
      const contactStatus = make('p', 'trillion-shop-contact-status', '');
      contactStatus.setAttribute('role', 'status');
      form.append(heading, explanation, emailLabel, consentLabel, submit, contactStatus);
      host.append(form);
      let requestKey = `shop-interest:${crypto.randomUUID()}`;
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        submit.disabled = true;
        contactStatus.textContent = 'Sending…';
        try {
          const response = await fetch(`/actions/${contactAction}`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': requestKey },
            body: JSON.stringify({ email: email.value.trim(), 'contact-ok': consent.checked }),
          });
          const result = await response.json();
          if (!response.ok || result.received !== true) throw refused(result, 'Your interest could not be sent.');
          contactStatus.textContent = 'Thanks. Your interest was sent to the team.';
          form.reset();
          requestKey = `shop-interest:${crypto.randomUUID()}`;
        } catch (error) { contactStatus.textContent = shown(error, 'Your interest could not be sent.'); }
        finally { submit.disabled = false; }
      });
    }
    const selected = new Map();
    let catalog = null;
    const showBag = () => {
      const count = [...selected.values()].reduce((sum, quantity) => sum + quantity, 0);
      bagItems.textContent = count ? `${count} item${count === 1 ? '' : 's'} in your bag` : 'Your bag is empty.';
      checkout.disabled = !count;
    };
    checkout.addEventListener('click', async () => {
      checkout.disabled = true;
      status.textContent = 'Opening checkout…';
      try {
        const response = await fetch('/commerce/checkout', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: [...selected].map(([variant_id, quantity]) => ({ variant_id, quantity })) }),
        });
        const result = await response.json();
        if (!response.ok) throw refused(result, 'Checkout is unavailable.');
        const destination = new URL(result.checkout_url);
        if (destination.protocol !== 'https:' || !destination.hostname.endsWith('.myshopify.com')) throw refused(null, 'Checkout is unavailable.'); // host-text-ok: serialized into the page, so it cannot import the shared rule
        window.location.assign(destination.href);
      } catch (error) { status.textContent = shown(error, 'Checkout is unavailable.'); showBag(); }
    });
    let nextCursor = null;
    let productCount = 0;
    const loadPage = async () => {
      more.disabled = true;
      status.textContent = productCount ? 'Loading more products…' : 'Loading products…';
      try {
      const address = nextCursor ? `/commerce/catalog?after=${encodeURIComponent(nextCursor)}` : '/commerce/catalog';
      const response = await fetch(address);
      const result = await response.json();
      if (!response.ok) throw refused(result, 'Shopping is unavailable.');
      catalog = result;
      const products = Array.isArray(catalog.products) ? catalog.products : [];
      productCount += products.length;
      if (productCount) bag.hidden = false;
      nextCursor = typeof result.next_cursor === 'string' ? result.next_cursor : null;
      status.textContent = productCount ? '' : 'No products are for sale yet.';
      more.hidden = !nextCursor;
      for (const product of products) {
        const card = make('article', 'trillion-shop-card');
        if (typeof product.image === 'string' && /^https:\/\//.test(product.image)) {
          const image = make('img', 'trillion-shop-image');
          image.src = product.image;
          image.alt = product.image_alt || product.title;
          image.loading = 'lazy';
          card.append(image);
        }
        card.append(make('h3', '', product.title), make('p', 'trillion-shop-description', product.description || ''));
        if (typeof product.product_url === 'string') {
          try {
            const details = new URL(product.product_url);
            if (details.protocol === 'https:') {
              const link = make('a', 'trillion-shop-details', 'View product details');
              link.href = details.href;
              link.target = '_blank';
              link.rel = 'noopener noreferrer';
              card.append(link);
            }
          } catch { /* The merchant did not provide a usable product page. */ }
        }
        const variants = Array.isArray(product.variants) ? product.variants : [];
        const chooser = make('select', 'trillion-shop-variants');
        chooser.setAttribute('aria-label', `Choose ${product.title}`);
        for (const variant of variants) {
          const option = make('option', '', `${variant.title === 'Default Title' ? product.title : variant.title} · ${priceText(variant.price, catalog.merchant?.currency)}${variant.available ? '' : ' · Sold out'}`);
          option.value = variant.id;
          option.disabled = !variant.available;
          chooser.append(option);
        }
        if (!variants.some(variant => variant.available)) chooser.disabled = true;
        const add = make('button', 'trillion-shop-add', chooser.disabled ? 'Sold out' : 'Add to bag');
        add.type = 'button';
        add.disabled = chooser.disabled;
        add.addEventListener('click', () => {
          const variant = variants.find(row => row.id === chooser.value);
          if (!variant?.available) return;
          const quantity = (selected.get(variant.id) ?? 0) + 1;
          if (quantity > 20 || (variant.stock !== null && quantity > variant.stock)) {
            status.textContent = 'That item is no longer available in that quantity.';
            return;
          }
          selected.set(variant.id, quantity);
          status.textContent = `${product.title} added to your bag.`;
          showBag();
        });
        card.append(chooser, add);
        grid.append(card);
      }
      } catch (error) { const said = shown(error, 'Shopping is unavailable.'); status.textContent = !productCount && said === 'This shop is not connected yet.'
        ? 'No products are for sale yet.' : said; }
      finally { more.disabled = false; }
    };
    more.addEventListener('click', loadPage);
    loadPage();
  }
}

export const merchantStorefrontScript = `(${merchantStorefrontRuntime.toString()})();`;
