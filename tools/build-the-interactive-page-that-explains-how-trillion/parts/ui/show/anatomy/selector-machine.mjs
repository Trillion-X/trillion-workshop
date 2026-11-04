// A domain-blind, isometric pick-and-place instrument. Geometry comes from MIT Anatomy.
import * as k from './iso-kit.mjs';
export function selectorMachine() {
 const W=920,H=540,base={x:-180,y:-84,w:360,d:168,r:10};
 const P=k.fitProjection([...k.boxCorners(base,-19,0),[-162,-45,108],[164,60,100]],W,H,{pad:72,azimuth:42,elevation:32});
 const S=(p,z,h,tone='mid',extra={})=>k.solidSvg(k.slabOf(p,z,h,P,5,.7),{tone,...extra});
 const L=(d,extra={})=>k.lineSvg(d,{tone:'lo',...extra});
 const dots=(points,z,tone='mid')=>k.dotsSvg(points.map(([x,y])=>k.iso([x,y,z],P)),{size:.55,tone});
 const rect=(x,y,w,d,r=1)=>({x,y,w,d,r});
 const order=items=>items.sort((a,b)=>k.depthOf(a.at,P)-k.depthOf(b.at,P)).map(a=>a.html).join('');
 let solids=0;
 const block=(p,z,h,tone='mid',extra={})=>{solids++;return S(p,z,h,tone,extra)};
 let body=k.groupSvg(`<path class="iso-halo" d="${k.haloOf(base,-20,12,P)}"/>`);
 for(const [x,y] of k.corners(base,20)) body+=block(rect(x-8,y-8,16,16,3),-19,7,'lo');
 body+=block(base,-12,12,'mid')+L(k.planOutline(k.insetPlan(base,5),0,P));
 body+=dots(k.corners(base,11),0,'hi');
 // The rear modular tool bank, attached to the bed.
 const bank=[];
 for(let i=0;i<4;i++){
  const x=-105+i*61,p=rect(x,-74,48,30,3);let html=block(p,0,7,'lo');
  html+=block(k.insetPlan(p,3),7,29,'mid',{inner:L(k.sideSeam(k.insetPlan(p,3),24,P,5))});
  html+=block(rect(x+8,-68,32,18,2),36,3,'hi')+dots([[x+11,-65],[x+37,-65],[x+11,-53],[x+37,-53]],39);
  for(let j=0;j<4;j++) html+=L(k.planOutline(rect(x+11+j*6,-64,3,10,.8),39,P,3),{tone:'faint'});
  html+=block(rect(x+17,-44,14,8,1),5,7,'lo')+dots([[x+21,-39],[x+27,-39]],12);
  bank.push({at:[x,-64,15],html});
 }
 body+=order(bank);
 // Two guide rails and fastened end stops.
 for(const y of [-24,20]){
  body+=block(rect(-155,y,310,8,2),0,5,'lo')+block(rect(-151,y+2,302,4,1),5,4,'hi');
  body+=dots([[-146,y+4],[146,y+4]],9);
 }
 for(const x of [-162,153]) body+=block(rect(x,-28,9,62,2),0,15,'mid')+dots([[x+4,-22],[x+4,27]],15);
 // Source-card holder: bottom, side walls, divider slots and real paper cards.
 body+=block(rect(-149,37,86,38,3),0,4,'lo');
 for(const y of [37,71]) body+=block(rect(-149,y,86,4,1),4,9,'mid');
 for(let i=0;i<5;i++){
  let x=-145+i*16;
  body+=block(rect(x,41,2,30,.4),4,8,'lo');
  const card=rect(x+3,45,10,23,.5);
  body+=block(card,4,12+i*1.8,'mid');
  for(let q=0;q<3;q++)body+=L(k.lineOnTop([x+5,49+q*4],[x+11,49+q*4],16+i*1.8,P),{free:true,tone:'faint'});
 }
 // Work bed: a ruled platen with exchangeable fixtures.
 body+=block(rect(-45,-12,99,28,3),0,5,'mid');
 for(let i=0;i<3;i++){
  body+=block(rect(-36+i*28,-8,20,20,2),5,3,'lo');
  body+=dots([[-31+i*28,-4],[-22+i*28,8]],8);
 }
 const ruler=rect(-143,79,282,4,1);body+=block(ruler,0,.6,'lo');
 const ticks=k.topTicks(-138,134,4,5,79,.6,[1.5,3],P);
 body+=L(ticks.minor)+L(ticks.major,{tone:'mid'});
 // Inspection nest and stamping head, with a paper result below it.
 body+=block(rect(96,-20,56,36,3),0,5,'mid')+block(rect(103,-17,41,27,2),5,3,'lo');
 body+=block(rect(111,-16,29,20,.5),8,.5,'hi');
 for(let q=0;q<3;q++)body+=L(k.lineOnTop([115,-12+q*4],[135,-12+q*4],8.5,P),{free:true,tone:'lo'});
 body+=block(rect(143,-17,7,23,1),5,40,'mid')+block(rect(123,-17,27,23,2),45,5,'mid');
 let stamp=block(rect(126,-12,10,12,1),35,10,'hi')+block(rect(118,-16,25,20,2),29,6,'mid');
 body+=k.groupSvg(stamp,{'data-stamp':'',transform:k.translateAlong(P,[0,0,0])});
 // Gantry: mounting shoes, posts, crossbeam, continuous scale, sliding saddle.
 for(const x of [-167,151]){
  body+=block(rect(x-4,-38,19,24,3),0,6,'lo')+dots([[x,-32],[x+11,-20]],6);
  body+=block(rect(x,-33,10,15,1),6,83,'mid',{inner:L(k.sideSeam(rect(x,-33,10,15,1),49,P,5))});
  body+=block(rect(x-3,-36,16,21,2),89,9,'hi')+dots([[x+1,-31],[x+10,-21]],98);
 }
 body+=block(rect(-167,-33,328,15,2),98,9,'mid')+block(rect(-158,-27,311,3,.5),107,.6,'hi');
 const t=k.topTicks(-153,149,4,5,-27,107.6,[1,2.6],P);body+=L(t.minor)+L(t.major,{tone:'hi'});
 // A flat linear motor, saddle and mechanical picker. No hidden cables or impossible crossings.
 let pick=block(rect(-139,-36,28,21,2),107,9,'hi');
 pick+=block(rect(-132,-33,14,15,1),116,5,'mid')+dots([[-129,-30],[-121,-20]],121,'hi');
 pick+=block(rect(-131,-18,13,7,1),80,27,'mid');
 pick+=block(rect(-128,-18,7,7,.6),26,54,'hi');
 pick+=block(rect(-134,-21,19,13,1),24,4,'mid');
 for(const x of [-134,-118])pick+=block(rect(x,-21,3,13,.4),15,9,'hi');
 body+=k.groupSvg(pick,{'data-picker':''});
 // One lit work card follows the picker: the selected needle mover.
 const card=rect(-132,-18,16,12,.4);
 let selected=block(card,13,1,'hi',{lit:true});
 selected+=L(k.lineOnTop([-129,-14],[-119,-14],14,P),{tone:'lit',free:true});
 body+=k.groupSvg(selected,{'data-selected':''});
 return {svg:k.figureSvg({width:W,height:H,label:'A detailed pick-and-place machine: source cards, interchangeable tool modules, a sliding picker and an inspection stamp.',body}),projection:P,solids};
}
