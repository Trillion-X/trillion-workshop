// The share's page, one thing at a time: the item shown, and under it a strip of every item to pick from. Without this script every
// item is shown in order and each still plays; with it, picking an item pauses the others and the address keeps which one (#item-<n>).
(() => {
  const main = document.querySelector('.share-items');
  const items = [...document.querySelectorAll('.share-item')];
  if (!main || items.length < 2) return;
  document.documentElement.classList.add('one-at-a-time');
  const strip = document.createElement('nav');
  strip.className = 'share-strip';
  strip.setAttribute('aria-label', 'Items');
  const buttons = items.map(item => {
    const button = document.createElement('button');
    button.type = 'button';
    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    if (item.dataset.poster) thumb.style.backgroundImage = `url("${item.dataset.poster}")`;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.dataset.name || '';
    button.append(thumb, label);
    button.addEventListener('click', () => show(items.indexOf(item), true));
    strip.append(button);
    return button;
  });
  main.after(strip);
  const show = (n, chosen) => {
    items.forEach((item, at) => {
      const shown = at === n;
      item.classList.toggle('is-shown', shown);
      buttons[at].setAttribute('aria-current', shown ? 'true' : 'false');
      if (!shown) item.querySelectorAll('video,audio').forEach(media => media.pause());
    });
    if (chosen) {
      history.replaceState(null, '', `#item-${n}`);
      buttons[n].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };
  const fromAddress = () => {
    const n = Number((location.hash.match(/^#item-(\d+)$/) || [])[1]);
    return Number.isInteger(n) && n < items.length ? n : 0;
  };
  document.addEventListener('keydown', event => {
    if (event.target.closest('input,textarea,select')) return;
    const at = items.findIndex(item => item.classList.contains('is-shown'));
    if (event.key === 'ArrowRight' && at < items.length - 1) show(at + 1, true);
    if (event.key === 'ArrowLeft' && at > 0) show(at - 1, true);
  });
  window.addEventListener('hashchange', () => show(fromAddress(), false));
  show(fromAddress(), false);
})();
