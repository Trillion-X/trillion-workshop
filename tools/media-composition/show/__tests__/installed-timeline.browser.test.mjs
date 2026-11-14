import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';

// The consuming workspace supplies its address and open-editor adapter. No app
// identity, recording path, or customer data belongs to this shared check.
test('installed timeline previews held trims, persists timed edits and stacks picture above sound', {skip:!process.env.EDITOR_URL},async t=>{
 const dir=process.env.EDITOR_EVIDENCE_DIR;if(!dir)throw Error('Supply an evidence directory.');fs.mkdirSync(dir,{recursive:true});
 const browser=await chromium.launch(),context=await browser.newContext({viewport:{width:1440,height:1100},recordVideo:{dir}}),page=await context.newPage();t.after(async()=>{await page.screenshot({path:path.join(dir,'last-state.png')}).catch(()=>{});await context.close();await browser.close();});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(process.env.EDITOR_URL);
 const adapter=process.env.EDITOR_ADAPTER,method=process.env.EDITOR_OPEN_METHOD,id=process.env.EDITOR_DRAFT_ID;
 await page.waitForFunction(adapter=>!!window[adapter],adapter);
 await page.evaluate(({adapter,method,id})=>window[adapter][method](id),{adapter,method,id});
 await page.waitForFunction(()=>document.querySelector('.live-composition-source')?.readyState>=2);
 const timeline=page.getByRole('region',{name:'Saved video timeline'});
 await timeline.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(dir,'before.png')});
 if(process.env.EDITOR_BASELINE_ONLY)return;
 const snap=page.getByRole('button',{name:'Snap to clips',exact:true});await snap.click();assert.equal(await snap.getAttribute('aria-pressed'),'false');
 const inserted=[];
 for(const kind of JSON.parse(process.env.EDITOR_INSERT_KINDS||'[]')){
  const media=page.getByRole('button',{name:'Media',exact:true});if(await media.getAttribute('aria-expanded')!=='true')await media.click();
  await page.getByRole('tab',{name:({image:'Image',video:'Video',audio:'Audio'})[kind]+' library',exact:true}).click();
  await page.locator(`[data-kind="${kind}"]`).getByRole('button',{name:/^Insert /}).first().click();
  const label=kind==='audio'?'Audio 1':'Visual '+(inserted.filter(value=>value.startsWith('Visual')).length+1);await timeline.getByRole('button',{name:label,exact:true}).waitFor();inserted.push(label);
 }
 if(inserted.length)await page.getByRole('button',{name:'Media',exact:true}).click();
 const labels=await timeline.getByText(/^Video \d+$/).allTextContents();assert.ok(labels.length>=3);assert.equal(labels.at(-1),'Video 1');
 const outcomes=[];
 for(const label of [...JSON.parse(process.env.EDITOR_TRIM_LABELS||'[]'),...inserted]){
  const clip=timeline.getByRole('button',{name:label,exact:true});await clip.click();await clip.scrollIntoViewIfNeeded();
  const before=await clip.boundingBox(),handle=clip.getByRole('slider',{name:'Trim end',exact:true}),edge=await handle.boundingBox();assert.ok(edge);
  await page.mouse.move(edge.x+edge.width/2,edge.y+edge.height/2);await page.mouse.down();await page.mouse.move(edge.x+edge.width/2-30,edge.y+edge.height/2,{steps:10});
  const held=await clip.boundingBox();assert.ok(held.width<before.width-15,`${label} changes width before release`);await page.screenshot({path:path.join(dir,`held-${outcomes.length}.png`)});await page.mouse.up();
  const after=await clip.boundingBox();assert.ok(after.width<before.width-15,`${label} keeps its new length`);
  const leading=await clip.getByRole('slider',{name:'Trim start',exact:true}).boundingBox();await page.mouse.move(leading.x+leading.width/2,leading.y+leading.height/2);await page.mouse.down();await page.mouse.move(leading.x+leading.width/2+20,leading.y+leading.height/2,{steps:8});await page.mouse.up();
  const startTrimmed=await clip.boundingBox();assert.ok(startTrimmed.x>after.x+10,`${label} leading edge moves`);assert.ok(Math.abs(startTrimmed.x+startTrimmed.width-after.x-after.width)<2,`${label} trailing edge stays fixed`);
  outcomes.push({label,before:before.width,held:held.width,after:after.width,leadingEdgeMoves:true,trailingEdgePreserved:true});
 }
 const splits=[];
 for(const label of [...JSON.parse(process.env.EDITOR_TRIM_LABELS||'[]'),...inserted].reverse()){
  const clip=timeline.getByRole('button',{name:label,exact:true}).first();await clip.click();await clip.scrollIntoViewIfNeeded();
  const bounds=await clip.boundingBox(),ruler=await page.locator('[data-media-drop-target]').boundingBox(),count=await timeline.getByRole('button').count();
  await page.mouse.click(bounds.x+bounds.width/2,ruler.y+10);await page.waitForTimeout(180);
  await page.getByRole('button',{name:'Split at playhead',exact:true}).click();
  await page.waitForFunction(count=>document.querySelector('[aria-label="Saved video timeline"]').querySelectorAll('[role=button], button').length>count,count);
  const after=await timeline.getByRole('button').count();assert.equal(after,count+1,`${label} splits the selected layer`);splits.push(label);
 }
 await page.screenshot({path:path.join(dir,'after.png')});assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(dir,'readback.json'),JSON.stringify({visualTrackLabels:labels,snapToggle:true,heldTrims:outcomes,splits,errors},null,2));
});
