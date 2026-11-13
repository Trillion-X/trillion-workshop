// tools/export-documents-to-files/do-work/render-xlsx.mjs
//
// The xlsx renderer: each table of the document is a sheet (named by the table's title), with a bold, frozen header
// row; numbers and true/false are stored as numbers and booleans, never as words. Headings, paragraphs and lists, when
// there are any, are rows of a first sheet named by the format row. Built from the standard library only (zip.mjs).
import { writeZip } from './zip.mjs';
import { cellText, largest } from './document.mjs';

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const xmlText = value => cellText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const letters = index => { let name = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name; return name; };

function cell(value, at, header, format) {
  const style = header ? ' s="1"' : format ? ` s="${format}"` : '';
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${at}"${style}><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${at}"${style} t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${at}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
}

function sheet(rows, { header, formats }) {
  const longestLine = value => cellText(value).split('\n').reduce((most, line) => Math.max(most, line.length), 0);
  const widest = Array.from({ length: largest(rows.map(row => row.length)) }, (_, index) => largest(rows.map(row => longestLine(row[index]))));
  const columns = widest.map((chars, index) => `<col min="${index + 1}" max="${index + 1}" width="${Math.min(60, Math.max(8, chars + 2))}" customWidth="1"/>`).join('');
  const lines = rows.map((row, y) => `<row r="${y + 1}">${row.map((value, x) => cell(value, `${letters(x)}${y + 1}`, header && y === 0, y > 0 || !header ? formats?.[x] : 0)).join('')}</row>`).join('');
  const pane = header ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
  return `${HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${columns ? `<cols>${columns}</cols>` : ''}<sheetData>${lines}</sheetData></worksheet>`;
}

/** One number format per currency: the locale's symbol before the figure, two decimals, thousands grouped, a minus sign for a negative. */
function numFmts(codes, locale) {
  if (codes.length === 0) return '';
  const symbolOf = code => new Intl.NumberFormat(locale, { style: 'currency', currency: code }).formatToParts(0).find(part => part.type === 'currency').value;
  return `<numFmts count="${codes.length}">${codes.map((code, index) => `<numFmt numFmtId="${164 + index}" formatCode="${xmlText(`"${symbolOf(code)}"#,##0.00;-"${symbolOf(code)}"#,##0.00`)}"/>`).join('')}</numFmts>`;
}

const flatList = (items, depth = 0) => items.flatMap(item => [['  '.repeat(depth) + item.text], ...flatList(item.children, depth + 1)]);

function sheetName(wanted, taken) {
  const base = (wanted || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
  taken.add(name.toLowerCase());
  return name;
}

/** @returns {Buffer} the bytes of the Excel file for `document`. */
export function renderXlsx(document, { text_sheet: textSheet }, { locale }) {
  const taken = new Set();
  // One cell style per currency a table declares (index 2 on: 0 is plain, 1 is the bold header).
  const currencies = [];
  const styleOf = code => { if (!code) return 0; if (!currencies.includes(code)) currencies.push(code); return currencies.indexOf(code) + 2; };
  const sheets = [];
  const notes = [];
  // A document that is one untitled table is that table: the sheet takes the document's title.
  const lone = document.blocks.length === 1 && document.blocks[0].kind === 'table' && !document.blocks[0].title;
  if (document.title && !lone) notes.push([document.title]);
  for (const block of document.blocks) {
    if (block.kind === 'table') sheets.push({ name: sheetName(block.title || (lone ? document.title : ''), taken), rows: [block.columns, ...block.rows], header: true, formats: (block.currencies ?? []).map(styleOf) });
    else if (block.kind === 'heading' || block.kind === 'paragraph') notes.push([block.text]);
    else if (block.kind === 'list') notes.push(...flatList(block.items));
    else throw new Error(`The xlsx renderer cannot draw a ${block.kind} block.`);
  }
  if (notes.length > 0 || sheets.length === 0) sheets.unshift({ name: sheetName(textSheet, taken), rows: notes, header: false });
  const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  return writeZip([
    { name: '[Content_Types].xml', data: `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId1', 'officeDocument', 'xl/workbook.xml')}</Relationships>` },
    { name: 'xl/workbook.xml', data: `${HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((one, index) => `<sheet name="${xmlText(one.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => rel(`rId${index + 1}`, 'worksheet', `worksheets/sheet${index + 1}.xml`)).join('')}${rel(`rId${sheets.length + 1}`, 'styles', 'styles.xml')}</Relationships>` },
    { name: 'xl/styles.xml', data: `${HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts(currencies, locale)}<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${2 + currencies.length}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>${currencies.map((_, index) => `<xf numFmtId="${164 + index}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`).join('')}</cellXfs></styleSheet>` },
    ...sheets.map((one, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: sheet(one.rows, one) })),
  ]);
}
