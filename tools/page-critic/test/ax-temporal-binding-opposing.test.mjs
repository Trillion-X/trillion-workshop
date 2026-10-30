import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {launchChromium} from '../../../test-helpers/chromium.mjs';
import {collectControlNames} from '../do-work/collect-control-names.mjs';
import {bindControlNameEvidence, pageCraftMeasures} from '../do-work/measure-page-craft.mjs';

test('control_name excludes a fully clipped non-tabstop hidden form input without excluding visible or tabbable defects', {timeout: 15000}, async () => {
  const server = createServer((_request, response) => response.writeHead(200, {'content-type': 'text/html'}).end(`<!doctype html>
    <style>.hidden-form{clip-path:inset(50%);overflow:hidden;white-space:nowrap;border:0;padding:0;width:1px;height:1px;margin:-1px;position:fixed;top:0;left:0}</style>
    <button aria-label="Choose a value">Choose</button>
    <input id="hidden-form" class="hidden-form" aria-hidden="true" tabindex="-1">
    <input id="visible-unnamed">
    <input id="visible-hidden-aria" aria-hidden="true" tabindex="-1">
    <input id="tabbable-clipped" class="hidden-form" aria-hidden="true">
  `));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await launchChromium({headless:true, localOnly:{origin}});
    const page = await browser.newPage();
    await page.route(origin + '/**', route => route.continue());
    await page.goto(origin);
    const craft = JSON.parse(readFileSync(new URL('../read-data/page-craft-rules.json', import.meta.url), 'utf8'));
    const rule = craft.rules.find(row => row.id === 'control_name');
    const session = await page.context().newCDPSession(page);
    const collect = () => collectControlNames({send:(method, params) => session.send(method, params), selector:craft.selectors.control_name_candidates, roles:rule.roles});
    const measure = names => page.evaluate(async ({source, params}) => await eval(source)(params), {
      source:pageCraftMeasures,
      params:{rules:[rule], selectors:craft.selectors, freshDays:null, now:Date.now(), widthId:'390', controlNames:names},
    });
    const before = await collect();
    const raw = await measure(before);
    const bound = bindControlNameEvidence(raw, before, await collect());
    const finding = id => bound.found.find(row => row.displaySelector?.endsWith('#' + id));
    assert.equal(finding('hidden-form'), undefined, 'an aria-hidden, non-tabstop input with a completely empty clip is outside the visible control-name scope');
    assert.equal(before.find(row => row.selector?.endsWith('#hidden-form'))?.shown, false, 'the collector retains explicit hidden evidence rather than fabricating an AX name');
    assert.equal(finding('visible-unnamed')?.values.kind, 'unnamed', 'a visible unnamed native input is refused');
    assert.ok(finding('visible-hidden-aria'), 'aria-hidden alone does not suppress a visible control');
    assert.ok(finding('tabbable-clipped'), 'a hidden input in the tab sequence remains a defect candidate');
    assert.deepEqual(bound.unsupported, []);
    await page.evaluate(() => {
      document.querySelector('#visible-unnamed').remove();
      document.querySelector('#visible-hidden-aria').remove();
      document.querySelector('#tabbable-clipped').remove();
    });
    const cleanBefore = await collect();
    assert.deepEqual(bindControlNameEvidence(await measure(cleanBefore), cleanBefore, await collect()).found, [], 'the named trigger and hidden autofill input pass through the ordinary shared measure');
    await page.locator('#hidden-form').focus();
    const focusedBefore = await collect();
    assert.equal(focusedBefore.find(row => row.selector?.endsWith('#hidden-form'))?.shown, true, 'a focused clipped input remains in scope');
    await page.locator('button').focus();
    const clippedBefore = await collect();
    await page.evaluate(() => { document.querySelector('#hidden-form').style.clipPath = 'none'; });
    assert.ok(bindControlNameEvidence(await measure(clippedBefore), clippedBefore, await collect()).found.some(row => row.values.kind === 'unavailable'), 'revealing the clipped input between AX reads refuses its previous exclusion');
    await session.detach();
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});

test('control_name evidence is bound to the same current node and computed name used by measurement', {timeout: 30000}, async () => {
  const server = createServer((_request, response) => response.writeHead(200, {'content-type': 'text/html'}).end(
    '<!doctype html><html><body><main><button id="stable" aria-label="Named"></button></main></body></html>',
  ));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await launchChromium({headless: true});
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const craft = JSON.parse(readFileSync(new URL('../read-data/page-craft-rules.json', import.meta.url), 'utf8'));
    const rule = craft.rules.find(row => row.id === 'control_name');
    const session = await page.context().newCDPSession(page);
    const collect = () => collectControlNames({
      send: (method, params) => session.send(method, params),
      selector: craft.selectors.control_name_candidates,
      roles: rule.roles,
    });
    const measure = controlNames => page.evaluate(async ({source, params}) => await eval(source)(params), {
      source: pageCraftMeasures,
      params: {rules: [rule], selectors: craft.selectors, freshDays: null, now: Date.now(), widthId: '390', controlNames},
    });
    const measureBound = async before => bindControlNameEvidence(await measure(before), before, await collect());
    let before = await collect();
    assert.equal(before.length, 1);
    assert.equal(before[0].state, 'available');
    assert.equal(before[0].name, 'Named');
    assert.deepEqual((await measureBound(before)).found.filter(item => item.rule === 'control_name'), [], 'an unchanged named control passes');

    await page.evaluate(() => {
      const position = document.createElement('div');
      position.className = 'position-a';
      const moving = document.createElement('button');
      moving.setAttribute('aria-label', 'Class-position control');
      moving.style.cssText = 'width:32px;height:24px';
      position.append(moving);
      document.querySelector('main').append(position);
    });
    before = await collect();
    const classPosition = before.find(item => item.name === 'Class-position control');
    assert.ok(classPosition, 'the class-position fixture has a named browser AX record');
    assert.ok(classPosition.identitySelector && !classPosition.identitySelector.includes('position-a'), 'the structural identity excludes appearance classes');
    await page.evaluate(() => document.querySelector('.position-a').className = 'position-b');
    const classChanged = (await measureBound(before)).found.filter(item => item.rule === 'control_name');
    assert.deepEqual(classChanged, [], 'changing only an appearance class on the same named control must not invalidate AX identity');

    await page.evaluate(() => {
      for (const name of ['Contents control one', 'Contents control two']) {
        const contents = document.createElement('div');
        contents.style.display = 'contents';
        const button = document.createElement('button');
        button.setAttribute('aria-label', name);
        button.style.cssText = 'width:32px;height:24px';
        contents.append(button);
        document.querySelector('main').append(contents);
      }
    });
    before = await collect();
    const contentsRows = before.filter(item => item.name?.startsWith('Contents control'));
    assert.equal(contentsRows.length, 2, 'both display:contents controls have AX records');
    assert.notEqual(contentsRows[0].identitySelector, contentsRows[1].identitySelector, 'display:contents siblings retain distinct structural identities');
    assert.deepEqual((await measureBound(before)).found.filter(item => item.rule === 'control_name'), [], 'display:contents containers do not create an identity collision');

    await page.evaluate(() => {
      const order = document.createElement('div');
      order.id = 'structural-order';
      for (const name of ['First order control', 'Second order control']) {
        const button = document.createElement('button');
        button.setAttribute('aria-label', name);
        button.style.cssText = 'width:32px;height:24px';
        order.append(button);
      }
      document.querySelector('main').append(order);
    });
    before = await collect();
    const firstOrder = before.find(item => item.name === 'First order control');
    assert.ok(firstOrder?.identitySelector, 'the structural reorder fixture has identity evidence');
    await page.evaluate(() => {
      const parent = document.querySelector('#structural-order');
      parent.append(parent.children[0]);
    });
    const reordered = (await measureBound(before)).found.filter(item => item.rule === 'control_name');
    assert.ok(reordered.some(item => item.values.kind === 'unavailable'), 'a structural reorder between reads invalidates the path-to-node association');

    await page.evaluate(() => {
      const replacement = document.createElement('button');
      replacement.id = 'stable';
      document.querySelector('#stable').replaceWith(replacement);
    });
    const replacement = (await measureBound(before)).found.filter(item => item.rule === 'control_name');
    assert.ok(replacement.some(item => item.values.kind === 'unavailable'), 'replacing the named node with an unnamed node must refuse stale evidence');

    await page.evaluate(() => document.querySelector('#stable').setAttribute('aria-label', 'Named again'));
    before = await collect();
    assert.deepEqual((await measureBound(before)).found.filter(item => item.rule === 'control_name'), [], 'a current named observation passes');
    await page.evaluate(() => {
      const replacement = document.createElement('button');
      replacement.id = 'stable';
      replacement.setAttribute('aria-label', 'Named replacement');
      document.querySelector('#stable').replaceWith(replacement);
    });
    const namedReplacement = (await measureBound(before)).found.filter(item => item.rule === 'control_name');
    assert.ok(namedReplacement.some(item => item.values.kind === 'unavailable'), 'replacing a named node with a different named node must refuse stale identity evidence');

    before = await collect();
    await page.evaluate(() => document.querySelector('#stable').removeAttribute('aria-label'));
    const cleared = (await measureBound(before)).found.filter(item => item.rule === 'control_name');
    assert.ok(cleared.some(item => item.values.kind === 'unavailable'), 'clearing the name after collection must refuse stale evidence');

    await page.evaluate(() => document.querySelector('#stable').setAttribute('aria-label', 'Moving named control'));
    before = await collect();
    await page.evaluate(() => { document.querySelector('#stable').style.transform = 'translateY(12px)'; });
    assert.deepEqual((await measureBound(before)).found.filter(item => item.rule === 'control_name'), [], 'geometry-only movement does not invalidate AX evidence');

    before = await collect();
    await page.evaluate(() => {
      const hidden = document.createElement('button');
      hidden.id = 'hidden-during-measurement';
      hidden.hidden = true;
      document.querySelector('main').append(hidden);
    });
    assert.deepEqual((await measureBound(before)).found.filter(item => item.rule === 'control_name'), [], 'adding a control proven hidden must not invalidate visible-control evidence');

    before = await collect();
    await page.evaluate(() => document.querySelector('#hidden-during-measurement').remove());
    assert.deepEqual((await measureBound(before)).found.filter(item => item.rule === 'control_name'), [], 'removing a control proven hidden must not invalidate visible-control evidence');

    await page.evaluate(() => {
      const hidden = document.createElement('button');
      hidden.id = 'hidden-then-visible';
      hidden.hidden = true;
      document.querySelector('main').append(hidden);
    });
    before = await collect();
    await page.evaluate(() => { document.querySelector('#hidden-then-visible').hidden = false; });
    const revealed = (await measureBound(before)).found.filter(item => item.rule === 'control_name');
    assert.ok(revealed.some(item => item.values.kind === 'unavailable'), 'a control changing from proven hidden to visible must be refused');

    await page.evaluate(() => {
      const hidden = document.createElement('button');
      hidden.id = 'opacity-hidden-then-visible';
      hidden.style.cssText = 'width:32px;height:24px;opacity:0';
      document.querySelector('main').append(hidden);
    });
    before = await collect();
    const opacityBefore = before.find(item => item.selector?.includes('opacity-hidden-then-visible'));
    assert.ok(opacityBefore, 'the AX snapshot includes a layout-present opacity-zero candidate');
    assert.equal(opacityBefore.shown, false, 'opacity-zero is captured as not shown even if AX still supplies a node');
    const measuredWhileHidden = await measure(before);
    assert.ok(!measuredWhileHidden.found.some(item => item.selector?.includes('opacity-hidden-then-visible')), 'the in-page measure excludes the opacity-zero candidate');
    await page.evaluate(() => { document.querySelector('#opacity-hidden-then-visible').style.opacity = '1'; });
    const opacityAfter = await collect();
    const opacityBound = bindControlNameEvidence(measuredWhileHidden, before, opacityAfter).found.filter(item => item.rule === 'control_name');
    assert.ok(opacityBound.some(item => item.values.kind === 'unavailable' && item.displaySelector?.includes('opacity-hidden-then-visible')), 'revealing a control after measurement but before the second AX read must refuse its stale omission');

    before = await collect();
    await page.evaluate(() => {
      const added = document.createElement('button');
      added.id = 'added-during-measurement';
      document.querySelector('main').append(added);
    });
    const added = (await measureBound(before)).found.filter(item => item.rule === 'control_name');
    assert.ok(added.some(item => item.values.kind === 'unavailable' && item.displaySelector?.includes('added-during-measurement')), 'a control added during measurement must be reported unavailable');

    before = await collect();
    await page.evaluate(() => document.querySelector('#stable').remove());
    const missing = (await measureBound(before)).found.filter(item => item.rule === 'control_name');
    assert.ok(missing.some(item => item.values.kind === 'unavailable' && item.displaySelector === 'button#stable'), 'a control removed during measurement must refuse its stale result');

    await page.evaluate(() => {
      const missing = document.createElement('button');
      missing.id = 'visible-but-no-ax';
      missing.style.cssText = 'width:32px;height:24px';
      document.querySelector('main').append(missing);
    });
    const collectWithoutAX = () => collectControlNames({
      send: (method, params) => method === 'Accessibility.getFullAXTree' || method === 'Accessibility.getPartialAXTree'
        ? Promise.resolve({nodes: []})
        : session.send(method, params),
      selector: craft.selectors.control_name_candidates,
      roles: rule.roles,
    });
    const unknownBefore = await collectWithoutAX();
    const unknownRow = unknownBefore.find(item => item.selector?.includes('visible-but-no-ax'));
    assert.equal(unknownRow?.shown, true, 'the missing-AX fixture is a visible DOM control');
    assert.equal(unknownRow?.state, 'unavailable');
    const unknownMeasured = await measure(unknownBefore);
    const unknownAfter = await collectWithoutAX();
    const unknownBound = bindControlNameEvidence(unknownMeasured, unknownBefore, unknownAfter).found
      .filter(item => item.rule === 'control_name' && item.displaySelector?.includes('visible-but-no-ax'));
    assert.ok(unknownBound.some(item => item.values.kind === 'unavailable' && item.values.reason === 'no applicable accessibility-tree node'), 'visible missing-AX evidence remains unavailable, never suppressed');

    await session.detach();
    await page.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
