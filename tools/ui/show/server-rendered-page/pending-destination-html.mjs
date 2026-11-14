import { escapeHtml } from './page-sections-html.mjs';

/** Keep one visible page while a same-origin destination finishes opening. */
export function pendingDestinationHtml({ title, message }) {
  const heading = escapeHtml(title);
  const detail = escapeHtml(message);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${heading}</title>`
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;'
    + 'justify-content:center;font:16px/1.6 system-ui,sans-serif;color:#293c38;'
    + 'background:#f3f5f0}main{padding:24px;text-align:center}h1{font-size:20px;'
    + 'line-height:1.3;margin:0 0 8px}p{margin:0}</style></head>'
    + `<body><main role="status" aria-live="polite"><h1>${heading}</h1><p>${detail}</p></main>`
    + '<script>async function checkDestination(){try{const response=await fetch(location.pathname,'
    + '{credentials:"same-origin",cache:"no-store"});if(response.redirected){const destination='
    + 'new URL(response.url);if(destination.origin===location.origin){location.assign(destination.href);return}}'
    + 'if(response.status===200){location.reload();return}}catch{}setTimeout(checkDestination,3000)}'
    + 'setTimeout(checkDestination,3000)</script></body></html>';
}
