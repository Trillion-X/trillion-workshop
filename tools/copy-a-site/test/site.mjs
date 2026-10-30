// A small site the copy-a-site test copies: a home page whose words are drawn by its script, a nested page reached
// by a link, a style sheet that uses a picture in turn, and a link to another site that must stay where it is.
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
export const pages = {
  '/': { type: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/look/site.css"><link rel="icon" href="/favicon.ico"><script src="/app.js"></script></head><body><main id="root"></main><a href="/guides/first">First guide</a> <a href="https://elsewhere.example/">Elsewhere</a> <form><input aria-label="Question"><button type="submit">Ask</button></form><button type="button">Choose</button> <img src="/pictures/court.png" onclick="alert(1)"></body></html>' },
  '/app.js': { type: 'text/javascript', body: "addEventListener('DOMContentLoaded', () => { document.getElementById('root').textContent = 'Drawn by the page'; });" },
  '/look/site.css': { type: 'text/css', body: "main { background: url('../pictures/ball.png'); }" },
  '/pictures/court.png': { type: 'image/png', body: pixel },
  '/pictures/ball.png': { type: 'image/png', body: pixel },
  '/favicon.ico': { type: 'image/vnd.microsoft.icon', body: Buffer.from('AAABAA==', 'base64') },
  '/guides/first': { type: 'text/html', body: '<!doctype html><html><head><title>First guide</title></head><body><h1>The first guide</h1><a href="/">Home</a></body></html>' },
  '/sitemap.xml': { type: 'application/xml', body: '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://copy-a-site.example/listed-only</loc></url><url><loc>https://elsewhere.example/not-ours</loc></url></urlset>' },
  '/listed-only': { type: 'text/html', body: '<!doctype html><html><head><title>Listed page</title></head><body><h1>Only in the sitemap</h1><a href="/">Home</a></body></html>' },
};
