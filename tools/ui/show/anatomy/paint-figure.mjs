// Mount the SVG returned by the shared geometry renderer; never mount active HTML.
const previous = new WeakMap();
export function paintFigure(host, figure) {
 if (!host?.replaceChildren || typeof figure?.svg !== 'string') throw new TypeError('A figure needs a host and rendered SVG');
 if (previous.get(host) === figure.svg) return;
 const parsed = new DOMParser().parseFromString(figure.svg, 'image/svg+xml');
 const root = parsed.documentElement;
 if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg' || parsed.querySelector('parsererror')) throw new TypeError('Invalid figure SVG');
 if (root.querySelector('script,foreignObject,iframe,object,embed,audio,video,animate,animateMotion,animateTransform,set')) throw new TypeError('Active content is not a figure');
 for (const element of [root, ...root.querySelectorAll('*')]) for (const attribute of element.attributes) {
  if (/^on/i.test(attribute.name) || /href$/i.test(attribute.localName) && !attribute.value.startsWith('#')) throw new TypeError('Active or external figure attribute');
  if (/url\(\s*["']?(?!#)/i.test(attribute.value.replace(/url\(\s*["']?#/gi, 'local('))) throw new TypeError('External figure style');
 }
 for (const style of root.querySelectorAll('style')) if (/@import|url\(\s*["']?(?!#)/i.test(style.textContent.replace(/url\(\s*["']?#/gi, 'local('))) throw new TypeError('External figure stylesheet');
 host.replaceChildren(host.ownerDocument.importNode(root, true));
 previous.set(host, figure.svg);
}
