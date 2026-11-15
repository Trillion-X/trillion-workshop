// test/web-conversations/lazy-chat.mjs
//
// PURPOSE
//   A made-up WhatsApp-shaped chat page for Save this chat's tests: the chat holds 120 messages but shows the last 20,
//   and adds 20 older ones a moment after its scrolling pane reaches the top, the way web.whatsapp.com loads a long
//   chat. reverse draws the pane bottom-up (flex-direction: column-reverse, as ChatGPT's pane is); dropsFar takes rows
//   far below the view off the page, as pages that keep only what is near the view do. Every person and word is made up.

// A WhatsApp-shaped chat that holds 120 messages but shows the last 20, adds 20 older ones a moment after its pane
// reaches the top, and (when dropsFar) takes rows far below the view off the page, as long chats do.
export const lazyChat = ({ reverse = false, dropsFar = false } = {}) => [
  '<!doctype html><html><head><meta charset="utf-8"><title>WhatsApp</title><style>',
  `body { margin: 0 } #pane { height: 400px; overflow-y: auto; ${reverse ? 'display: flex; flex-direction: column-reverse;' : ''} } .row { height: 40px }`,
  '</style></head><body><div id="main"><header><span dir="auto" title="Kiln club">Kiln club</span></header>',
  '<div id="pane"><div id="list"></div></div></div><script>',
  'const pane = document.getElementById("pane"), list = document.getElementById("list");',
  'const row = n => { const holder = document.createElement("div"); holder.className = "row"; holder.dataset.id = `false_120363000000000001-g@example.com_M${n}_15550001111-c@example.com`;',
  '  const said = document.createElement("div"); said.setAttribute("data-pre-plain-text", `[10:${String(n % 60).padStart(2, "0")}, 9/28/2026] Ana: `);',
  '  const words = document.createElement("span"); words.className = "selectable-text"; words.textContent = `Message ${n}`; said.append(words); holder.append(said); return holder; };',
  'let from = 100, loading = false; for (let n = 100; n < 120; n++) list.append(row(n));',
  `const atStart = () => ${reverse ? 'pane.scrollHeight - pane.clientHeight + pane.scrollTop < 40' : 'pane.scrollTop < 40'};`,
  `${reverse ? '' : 'pane.scrollTop = pane.scrollHeight;'}`,
  'pane.addEventListener("scroll", () => {',
  `  ${dropsFar ? 'for (const holder of [...list.children]) if (holder.getBoundingClientRect().top > pane.getBoundingClientRect().bottom + 400) holder.remove();' : ''}`,
  '  if (!atStart() || loading || from === 0) return;',
  '  loading = true;',
  '  setTimeout(() => { const older = []; for (let n = from - 20; n < from; n++) older.push(row(n)); from -= 20;',
  `    list.prepend(...older); ${reverse ? '' : 'pane.scrollTop += older.length * 40;'} loading = false; }, 150);`,
  '});',
  '</script></body></html>'].join('\n');
