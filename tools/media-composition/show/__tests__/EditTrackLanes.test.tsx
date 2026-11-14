import React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {EditTrackLanes} from '../components/EditTrackLanes';

beforeEach(()=>{vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const lanes=['video','caption','adjustment','audio'].map((role,index)=>({laneId:role,role,label:role,tone:role==='audio'?'audio':'source',duration:10,clips:[{clipId:role,sourceId:role,label:`Item ${index}`,inPoint:1,outPoint:4,laneStart:1,laneEnd:4}]}));
describe('direct timeline controls',()=>{
 it('places higher picture layers above the base picture and sound below, without cryptic kind letters',()=>{
  render(<EditTrackLanes composition={{durationSeconds:10,lanes} as any} playheadPct={0} selectedClipId={null} onSeek={()=>{}} onSelectClip={()=>{}} onTrim={()=>{}}/>);
  const labels=screen.getAllByText(/^(Video|Audio) \d+$/).map(node=>node.textContent);
  expect(labels).toEqual(['Video 3','Video 2','Video 1','Audio 1']);
  const snap=screen.getByRole('button',{name:'Snap to clips'});expect(snap.getAttribute('aria-pressed')).toBe('true');fireEvent.click(snap);expect(snap.getAttribute('aria-pressed')).toBe('false');
 });
 for(const role of ['video','caption','adjustment','audio'])it(`offers the same edge operation for ${role}`,()=>{
  const trim=vi.fn();render(<EditTrackLanes composition={{durationSeconds:10,lanes} as any} playheadPct={0} selectedClipId={role} onSeek={()=>{}} onSelectClip={()=>{}} onTrim={trim} getTrimRange={()=>({inPoint:1,outPoint:4})}/>);
  const clip=screen.getByRole('button',{name:`Item ${lanes.findIndex(lane=>lane.role===role)}`});fireEvent.keyDown(within(clip).getByRole('slider',{name:'Trim end'}),{key:'ArrowLeft'});expect(trim).toHaveBeenCalledWith(role,1,3.9);
 });
});
