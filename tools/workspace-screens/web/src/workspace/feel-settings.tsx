import {FeelSettings} from '../../../../feel/show/FeelSettings';
import {type FeelRows} from '../../../../feel/show/mount-feel';
import {ScreenState,useScreenLoad} from '../../../../ui/show/screen-state';
import {refusal} from './failure';
import {presentationRows} from './presentation-rows.mjs';
export const readFeelRows=()=>presentationRows('feel') as Promise<FeelRows>;
export function CurrentFeelSettings(){
 const loaded=useScreenLoad('current-feel-rows',{read:readFeelRows,loading:{label:'Loading Feel',layout:'rows'},failed:refusal('Feel could not load')});
 return loaded.state?<ScreenState state={loaded.state}/>:<FeelSettings rows={loaded.value} readRows={readFeelRows}/>;
}
