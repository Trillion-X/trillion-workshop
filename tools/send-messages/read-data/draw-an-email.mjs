// Letters for a face or a mark from a name: the first letter of its first two words.
function lettersOf(value) {
  return (textOrNull(value) ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((word) => [...word][0] ?? '').join('').toUpperCase();
}

/**
 * message: { preheader, markdown, action: {label, href}, footer_lines[], footer_links[{label, href}],
 *            brand: {name, image}, palette: {ink, accent, muted, paper, line, on_accent, card?},
 *            mark?: {name, src?, alt?}, people?: {faces: [{name, src?}], more?, line} }
 * `mark` opens the message with what it is about (a picture, else the name's first letters on a tile); `people`
 * shows who is in it as a row of faces and one line, after the words and before the action.
 * Returns { html, text }.
 */
export function emailMessageHtml(message) {
  const p = message?.palette ?? {};
  const color = (value) => (typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : 'inherit');
  const ink = color(p.ink); const accent = color(p.accent); const muted = color(p.muted);
  const paper = color(p.paper); const line = color(p.line); const onAccent = color(p.on_accent);
  // The action wears the look's primary button fill (src/mail-settings.json palette_roles `button`), not its accent.
  const buttonFill = color(p.button ?? p.accent);
  // The look's faces, as the email's palette carries them (src/mail-settings.json font_roles); single quotes only, so a
  // face name never closes the style attribute it sits in.
  const face = (value, generic) => (typeof value === 'string' && /^[\w\s,'"-]+$/.test(value) ? value.replace(/"/g, "'") : generic);
  // The look's corners, as the email's palette carries them (src/mail-settings.json radius_roles): a CSS length such as
  // '10px' (or a bare number). Read as pixels, bounded; a palette without one draws square corners.
  const radius = (value) => { const pixels = Number.parseFloat(value); return Number.isFinite(pixels) ? `${Math.max(0, Math.min(999, pixels))}px` : '0'; };
  const corner = { control: radius(p.radius_control), card: radius(p.radius_card), pill: radius(p.radius_pill) };
  const textFace = face(p.font, 'sans-serif'); const display = face(p.display_font, 'serif'); const mono = face(p.mono_font, 'monospace');
  const style = {
    p: `margin:0 0 16px;font-size:16px;line-height:1.6;color:${ink}`,
    h: `margin:28px 0 10px;font-family:${display};font-size:20px;line-height:1.3;color:${ink};font-weight:600`,
    list: `margin:0 0 16px;padding-left:22px;font-size:16px;line-height:1.6;color:${ink}`,
    quote: `margin:20px 0;font-family:${display};font-size:20px;line-height:1.45;color:${ink}`,
    code: `margin:0 0 16px;padding:12px 14px;border-radius:${corner.control};background:${line};font-family:${mono};font-size:14px;line-height:1.5;color:${ink};white-space:pre-wrap`,
    rule: `margin:24px 0;border:0;border-top:1px solid ${line}`,
  };
  const body = markdownBlocks(message?.markdown).map((block) => {
    const inline = (text) => inlineHtml(text, 'email-link').replace(/class="email-link"/g, `style="color:${ink};text-decoration:underline;text-decoration-color:${accent}"`);
    if (block.kind === 'heading') return `<h2 style="${style.h}">${inline(block.text)}</h2>`;
    if (block.kind === 'list') {
      const tag = block.ordered ? 'ol' : 'ul';
      return `<${tag} style="${style.list}">${block.items.map((item) => `<li style="margin:4px 0">${inline(item)}</li>`).join('')}</${tag}>`;
    }
    if (block.kind === 'quote') return `<blockquote style="${style.quote}">${inline(block.text)}</blockquote>`;
    if (block.kind === 'code') return `<pre style="${style.code}">${escapeHtml(block.text)}</pre>`;
    if (block.kind === 'rule') return `<hr style="${style.rule}"/>`;
    return `<p style="${style.p}">${inline(block.text)}</p>`;
  }).join('');
  const card = color(p.card ?? p.paper);
  const markSrc = safeHref(message?.mark?.src);
  const markLetters = lettersOf(message?.mark?.name);
  const markHtml = markSrc
    ? `<p style="margin:0 0 20px"><img src="${escapeHtml(markSrc)}" alt="${escapeHtml(message.mark.alt ?? '')}" width="56" height="56" style="display:block;width:56px;height:56px;border-radius:${corner.card};border:0;object-fit:cover"/></p>`
    : markLetters ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr><td width="56" height="56" align="center" valign="middle" style="width:56px;height:56px;border-radius:${corner.card};background:${ink};color:${card};font-family:${display};font-size:22px;line-height:56px">${escapeHtml(markLetters)}</td></tr></table>` : '';
  const faceStyle = `width:32px;height:32px;border-radius:${corner.pill};font-size:12px;font-weight:600;line-height:32px;text-align:center`;
  const faces = list(message?.people?.faces).slice(0, 6).map((face, index) => {
    const src = safeHref(face?.src);
    const inner = src ? `<img src="${escapeHtml(src)}" alt="" width="32" height="32" style="display:block;width:32px;height:32px;border-radius:${corner.pill};border:0"/>` : escapeHtml(lettersOf(face?.name));
    return inner ? `<td style="padding:0 6px 0 0"><div style="${faceStyle};background:${index === 0 ? ink : line};color:${index === 0 ? card : ink}">${inner}</div></td>` : '';
  }).join('');
  const more = Number.isInteger(message?.people?.more) && message.people.more > 0
    ? `<td style="padding:0 6px 0 0"><div style="${faceStyle};background:${card};color:${muted}">+${message.people.more}</div></td>` : '';
  const peopleLine = textOrNull(message?.people?.line);
  const peopleHtml = faces || peopleLine
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px"><tr>${faces}${more}${peopleLine ? `<td style="padding:0 0 0 6px;font-size:14px;line-height:1.4;color:${muted}">${escapeHtml(peopleLine)}</td>` : ''}</tr></table>` : '';
  const buttonSheen = typeof p.button_sheen === 'string' && /^linear-gradient\([\w\s.,()%#-]+\)$/.test(p.button_sheen) ? p.button_sheen : 'none';
  const buttonShadow = [p.button_highlight, p.button_shadow].filter(value => typeof value === 'string' && /^[\w\s.,()%#-]+$/.test(value)).join(',');
  const action = message?.action && safeHref(message.action.href) && textOrNull(message.action.label)
    ? `<p style="margin:24px 0"><a href="${escapeHtml(message.action.href)}" style="display:inline-block;padding:12px 20px;border-radius:${corner.control};background:${buttonFill};background-image:${buttonSheen};color:${onAccent};box-shadow:${buttonShadow || 'none'};font-weight:600;text-decoration:none">${escapeHtml(message.action.label)}</a></p>`
    : '';
  const footerLinks = list(message?.footer_links).map((link) => (safeHref(link?.href)
    ? `<a href="${escapeHtml(link.href)}" style="color:${muted};text-decoration:underline">${escapeHtml(link.label ?? '')}</a>` : '')).filter(Boolean).join(' &middot; ');
  const footerLines = list(message?.footer_lines).map((l) => `<p style="margin:4px 0;font-size:12px;line-height:1.5;color:${muted}">${escapeHtml(l)}</p>`).join('');
  const madeWith = message?.made_with && safeHref(message.made_with.href)
    ? `<p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:${muted}"><a href="${escapeHtml(message.made_with.href)}" style="color:${muted};text-decoration:none">${escapeHtml(message.made_with.label ?? '')}${safeHref(message.made_with.image) ? ` <img src="${escapeHtml(message.made_with.image)}" alt="${escapeHtml(message.made_with.alt ?? '')}" height="16" style="height:16px;width:auto;vertical-align:middle;border:0"/>` : ''}</a></p>` : '';
  const brand = message?.brand ?? {};
  const mark = safeHref(brand.image) ? `<img src="${escapeHtml(brand.image)}" alt="${escapeHtml(brand.name ?? '')}" height="24" style="height:24px;width:auto;border:0"/>` : `<strong style="color:${ink}">${escapeHtml(brand.name ?? '')}</strong>`;
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>'
    + `<meta name="color-scheme" content="${p.scheme === 'dark' ? 'dark' : 'light'}"/></head>`
    + `<body style="margin:0;padding:0;background:${paper}">`
    + (textOrNull(message?.preheader) ? `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(message.preheader)}</div>` : '')
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${paper}"><tr><td align="center" style="padding:32px 16px">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;text-align:left;font-family:${textFace}">`
    + `<tr><td style="padding:0 0 24px">${mark}</td></tr>`
    + `<tr><td>${markHtml}${body}${peopleHtml}${action}</td></tr>`
    + `<tr><td style="padding:28px 0 0;border-top:1px solid ${line}">${footerLinks ? `<p style="margin:0 0 8px;font-size:12px;color:${muted}">${footerLinks}</p>` : ''}${footerLines}${madeWith}</td></tr>`
    + '</table></td></tr></table></body></html>';
  const text = [
    markdownText(message?.markdown),
    peopleLine ?? '',
    message?.action && safeHref(message.action.href) ? `${message.action.label}: ${message.action.href}` : '',
    '--',
    ...list(message?.footer_links).filter((l) => safeHref(l?.href)).map((l) => `${l.label}: ${l.href}`),
    ...list(message?.footer_lines),
    ...(message?.made_with?.label && message?.made_with?.alt ? [`${message.made_with.label} ${message.made_with.alt}: ${message.made_with.href}`] : []),
  ].filter(Boolean).join('\n\n');
  return { html, text };
}
