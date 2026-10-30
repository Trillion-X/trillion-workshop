import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {launchChromium} from '../../../test-helpers/chromium.mjs';
import {renderedLabelSizeMeasurements} from '../do-work/measure-rendered-label-size.mjs';
import {pageCraftMeasures} from '../do-work/measure-page-craft.mjs';

test('rendered SVG label size observes scaling, rotation, shear, hidden ancestors and unavailable geometry', {timeout: 30000}, async () => {
  const server = createServer((_request, response) => response.writeHead(200, {'content-type':'text/html'}).end(`<!doctype html><style>body{margin:0}svg{display:block}text{font-family:monospace}</style>
    <svg width="400" height="400" viewBox="0 0 800 800">
      <text data-teaching id="scaled" x="10" y="60" font-size="16">Tiny after viewBox</text>
      <text data-teaching id="readable" x="10" y="130" font-size="32">Readable after viewBox</text>
      <text data-teaching id="rotated" x="10" y="230" font-size="16" transform="rotate(45 10 230)">A long rotated tiny label</text>
      <text data-teaching id="multiline" x="10" y="350" font-size="16"><tspan x="10">Tiny line one</tspan><tspan x="10" dy="40">Tiny line two</tspan></text>
      <text data-teaching id="sheared" x="0" y="0" font-size="32" transform="matrix(1 0 10 0.5 400 650)">Flat</text>
      <text data-teaching id="sheared-readable" x="0" y="0" font-size="32" transform="matrix(1 0 1 1 10 740)">Readable shear</text>
      <g opacity="0"><text data-teaching id="hidden" x="10" y="450" font-size="8">Hidden text</text></g>
      <text id="unselected" x="10" y="500" font-size="8">Unselected decoration</text>
    </svg><p data-unavailable>HTML needs a different measurement</p>`));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await launchChromium({headless:true, localOnly:{origin}});
    const page = await browser.newPage({viewport:{width:390,height:844}});
    await page.route(origin + '/**', route => route.continue());
    await page.goto(origin);
    const rows = await page.evaluate(({source}) => {
      const measure = eval('(' + source + ')');
      const simplify = row => ({id:row.element.id, ...row.values});
      return {
        labels:measure({selector:'[data-teaching]',min_height_px:12}).map(simplify),
        unavailable:measure({selector:'[data-unavailable]',min_height_px:12}).map(simplify),
        rotatedUnionHeight:document.querySelector('#rotated').getBoundingClientRect().height,
        multilineUnionHeight:document.querySelector('#multiline').getBoundingClientRect().height,
      };
    }, {source:renderedLabelSizeMeasurements.toString()});
    assert.deepEqual(rows.labels.map(row => row.id), ['scaled','readable','rotated','multiline','sheared','sheared-readable']);
    assert.equal(rows.labels.find(row => row.id === 'sheared').kind, 'too-small', JSON.stringify(rows.labels.find(row => row.id === 'sheared')));
    assert.deepEqual(rows.labels.map(row => row.kind), ['too-small','measured','too-small','too-small','too-small','measured']);
    assert.ok(rows.rotatedUnionHeight > 12 && rows.multilineUnionHeight > 12, 'union bounds would falsely clear both tiny labels');
    assert.ok(rows.labels.find(row => row.id === 'scaled').height_px < 12, 'source16px is not displayed16px');
    assert.ok(rows.labels.find(row => row.id === 'readable').height_px >= 12);
    assert.equal(rows.unavailable[0].kind, 'unavailable', 'missing geometry is never a size pass');
    const shared = await page.evaluate(async ({source}) => await eval(source)({
      rules:[{id:'rendered_label_size',selector:'[data-teaching]',min_height_px:12}],
      selectors:{links:'a[href]'}, now:Date.now(), widthId:'390',
    }), {source:pageCraftMeasures});
    assert.deepEqual(shared.unsupported, [], 'the ordinary shared critic must implement the configured measurement');
    assert.equal(shared.rendered_labels.length, 6, 'selected readable labels also retain measured evidence');
    assert.deepEqual(shared.found.map(row => row.text), ['Tiny after viewBox','A long rotated tiny label','Tiny line oneTiny line two','Flat']);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
