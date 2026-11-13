// tools/export-documents-to-files/do-work/render-docx.mjs
//
// The docx renderer: a document as a Word file with real styles. The title is a Title paragraph, headings are
// Heading 1 to 6 (so Word's navigation pane and contents see them), lists use Word numbering with nesting, tables
// have a repeating shaded header row. The page size comes from the request and the margins from the page layout. Built from the
// standard library only (zip.mjs).
import { writeZip } from './zip.mjs';
import { cellText, largest, numericColumns } from './document.mjs';
import { layoutNamed } from './layout.mjs';

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const xmlText = value => cellText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A run of text; a line break inside becomes a Word break. */
function runs(text, { bold = false } = {}) {
  const properties = bold ? '<w:rPr><w:b/></w:rPr>' : '';
  return xmlText(text).replace(/\r\n?/g, '\n').split('\n').map(line => `<w:r>${properties}<w:t xml:space="preserve">${line}</w:t></w:r>`).join('<w:r><w:br/></w:r>');
}

const paragraph = (text, { style, bold, extra = '' } = {}) => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>${runs(text, { bold })}</w:p>`;

function listParagraphs(items, depth, numId) {
  return items.flatMap(item => [
    `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${Math.min(depth, 8)}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${runs(item.text)}</w:p>`,
    ...listParagraphs(item.children, depth + 1, numId),
  ]);
}

function table(block, contentWidth) {
  const columns = block.columns.length;
  if (columns === 0) return '';
  const weight = index => Math.max(block.columns[index].length + 3, Math.min(40, largest(block.rows.map(row => cellText(row[index]).length))));
  const weights = block.columns.map((_, index) => weight(index));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const widths = weights.map(value => Math.floor((value * contentWidth) / total));
  const numeric = numericColumns(block);
  const cell = (text, width, header, right) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="EDEDED"/>' : ''}</w:tcPr>${paragraph(text, { bold: header, extra: `<w:spacing w:before="40" w:after="40"/>${right ? '<w:jc w:val="right"/>' : ''}` })}</w:tc>`;
  const row = (cells, header) => `<w:tr><w:trPr><w:cantSplit/>${header ? '<w:tblHeader/>' : ''}</w:trPr>${cells.map((text, index) => cell(text, widths[index], header, numeric[index])).join('')}</w:tr>`;
  return [
    block.title ? paragraph(block.title, { style: 'TableTitle' }) : '',
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${contentWidth}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${widths.map(width => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`,
    row(block.columns, true),
    ...block.rows.map(cells => row(cells, false)),
    '</w:tbl>',
    '<w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>',
  ].join('');
}

const style = (id, name, { basedOn = 'Normal', run = '', paragraphProperties = '', next } = {}) =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="${basedOn}"/>${next ? `<w:next w:val="${next}"/>` : ''}<w:qFormat/><w:pPr>${paragraphProperties}</w:pPr><w:rPr>${run}</w:rPr></w:style>`;

function styles(options) {
  const heading = (level, size) => style(`Heading${level}`, `heading ${level}`, { next: 'Normal', paragraphProperties: `<w:keepNext/><w:spacing w:before="${options.heading_before}" w:after="80"/><w:outlineLvl w:val="${level - 1}"/>`, run: `<w:b/><w:sz w:val="${size * 2}"/>` });
  return `${HEAD}<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${options.font}" w:hAnsi="${options.font}" w:cs="${options.font}" w:eastAsia="${options.font}"/><w:sz w:val="${options.body_size * 2}"/><w:szCs w:val="${options.body_size * 2}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + style('Title', 'Title', { next: 'Normal', run: `<w:b/><w:sz w:val="${options.title_size * 2}"/>`, paragraphProperties: '<w:spacing w:after="240"/>' })
    + options.heading_sizes.map((size, index) => heading(index + 1, size)).join('')
    + style('ListParagraph', 'List Paragraph', { paragraphProperties: '<w:spacing w:after="60"/><w:contextualSpacing/>' })
    + style('TableTitle', 'Table Title', { run: '<w:b/>', paragraphProperties: '<w:keepNext/><w:spacing w:before="160" w:after="60"/>' })
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`).join('')
    + '</w:tblBorders></w:tblPr></w:style></w:styles>';
}

const BULLETS = ['•', '–', '▪'];
function numbering(orderedCount) {
  const level = (index, format, text) => `<w:lvl w:ilvl="${index}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + index * 360}" w:hanging="360"/></w:pPr></w:lvl>`;
  const bullet = `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${Array.from({ length: 9 }, (_, index) => level(index, 'bullet', BULLETS[index % BULLETS.length])).join('')}</w:abstractNum>`;
  const decimal = `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/>${Array.from({ length: 9 }, (_, index) => level(index, index % 2 === 0 ? 'decimal' : 'lowerLetter', `%${index + 1}.`)).join('')}</w:abstractNum>`;
  const nums = ['<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>']
    .concat(Array.from({ length: orderedCount }, (_, index) => `<w:num w:numId="${index + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`));
  return `${HEAD}<w:numbering ${NS}>${bullet}${decimal}${nums.join('')}</w:numbering>`;
}

/** @returns {Buffer} the bytes of the Word file for `document`. */
export function renderDocx(document, options, { size }) {
  // Word counts in twentieths of a point; the margin is the page layout's, as for the other page formats.
  const margin = layoutNamed(options.layout).page.margin * 20;
  const page = { width: size.width * 20, height: size.height * 20, margin };
  const contentWidth = page.width - 2 * page.margin;
  let ordered = 0;
  const body = [
    document.title ? paragraph(document.title, { style: 'Title' }) : '',
    ...document.blocks.map(block => {
      if (block.kind === 'heading') return paragraph(block.text, { style: `Heading${block.level}` });
      if (block.kind === 'paragraph') return paragraph(block.text);
      if (block.kind === 'list') {
        if (block.ordered) ordered += 1;
        return listParagraphs(block.items, 0, block.ordered ? ordered + 1 : 1).join('');
      }
      if (block.kind === 'table') return table(block, contentWidth);
      throw new Error(`The docx renderer cannot draw a ${block.kind} block.`);
    }),
  ].join('');
  const section = `<w:sectPr><w:pgSz w:w="${page.width}" w:h="${page.height}"/><w:pgMar w:top="${page.margin}" w:right="${page.margin}" w:bottom="${page.margin}" w:left="${page.margin}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
  const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  return writeZip([
    { name: '[Content_Types].xml', data: `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { name: '_rels/.rels', data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId1', 'officeDocument', 'word/document.xml')}<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: 'docProps/core.xml', data: `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlText(document.title)}</dc:title></cp:coreProperties>` },
    { name: 'word/_rels/document.xml.rels', data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId1', 'styles', 'styles.xml')}${rel('rId2', 'numbering', 'numbering.xml')}</Relationships>` },
    { name: 'word/document.xml', data: `${HEAD}<w:document ${NS}><w:body>${body}${section}</w:body></w:document>` },
    { name: 'word/styles.xml', data: styles(options) },
    { name: 'word/numbering.xml', data: numbering(ordered) },
  ]);
}
