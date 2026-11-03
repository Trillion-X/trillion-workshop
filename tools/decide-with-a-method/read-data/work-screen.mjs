// Native Decisions/Home screen projection over original carried domain owners.
import {currentPursuit} from './engine.mjs';
import {recordScopeMethods} from './record-scope.mjs';
import {planRecords} from './plan-records.mjs';
import {stanceId} from './record-stance.mjs';
import {checkQuestions} from './private-method.mjs';
import {helpedItem,whatHelpedOf} from './check-uses.mjs';
import {keepsDecisions} from './payment.mjs';
import {decisionLimit,pursuitsWords} from './allowance.mjs';
export function nativeWorkScreen({owner,records,store,engine,setting,readAllowance,currentPolicy,spacePursuits=async()=>[]}){
  return async(input={})=>{
    const {access}=await currentPolicy();
    const limit=decisionLimit(access);let allowance=null;
    if(limit){
      if(typeof readAllowance!=='function')throw new TypeError('The native screen requires its actual account allowance owner.');
      const saved=await readAllowance(access);
      allowance={count:saved.count,per:saved.per,used:saved.used};
    }
    let spaces=[],timer;try{spaces=await Promise.race([spacePursuits(),new Promise(resolve=>{timer=setTimeout(()=>resolve([]),1500);})]);}catch{spaces=[];}finally{clearTimeout(timer);}
    if(allowance&&!keepsDecisions(access))return {free:true,summaries:[],pursuits:[],space_pursuits:spaces,access,allowance};
    if(input.metadata_only)return {free:false,access,allowance,space_pursuits:spaces,pursuits_words:pursuitsWords(null)};
    if(input.native_collection_page){
      // A bounded source projection, with explicit coverage. Full-history
      // statistics are never approximated by adding per-resource medians.
      const limit=100;
      const summaries=await engine.summaries(limit+1);
      const ids=records.ids('pursuit',{limit:limit+1});
      const pursuits=ids.slice(0,limit).map(id=>records.read(id)).filter(row=>row&&currentPursuit(row));
      const planPage=planRecords(records).collectionPage({limit});
      const roots=Object.values(store.read({cases:summaries.slice(0,limit).map(row=>row.case_id)}).cases);
      const known=Object.keys(checkQuestions());
      return {free:false,summaries:summaries.slice(0,limit).map(row=>{const kept=records.read(stanceId(row.case_id));return kept?{...row,stance:kept.stance}:row;}),
        pursuits:recordScopeMethods.scopePursuitTree.call({store:{eeaf:records}},pursuits),space_pursuits:spaces,
        plans:planPage.plans,access,allowance,pursuits_words:pursuits.length||spaces.length?null:pursuitsWords(null),
        helped_items:roots.filter(row=>row.decision).map(row=>helpedItem(row,known)),
        collection_coverage:{scope:'newest_decisions',limit,more_decisions:summaries.length>limit,more_pursuits:ids.length>limit,more_plans:planPage.more}};
    }
    const [summaries,pursuits]=await Promise.all([engine.summaries(100),engine.pursuits()]);
    const known=Object.keys(checkQuestions());
    const helped=whatHelpedOf(await engine.mapDecided(root=>helpedItem(root,known)),{checkText:checkQuestions(),agentWork:store.settings('agent-work:').map(row=>row.value).filter(Boolean)});
    return {free:false,summaries:summaries.map(row=>{const kept=records.read(stanceId(row.case_id));return kept?{...row,stance:kept.stance}:row;}),
      pursuits:recordScopeMethods.scopePursuitTree.call({store:{eeaf:records}},pursuits),space_pursuits:spaces,
      plans:planRecords(records).list({limit:100}).plans,access,allowance,pursuits_words:pursuits.length||spaces.length?null:pursuitsWords(null),helped};
  };
}
