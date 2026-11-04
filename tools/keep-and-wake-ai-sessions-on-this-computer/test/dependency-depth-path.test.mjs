import test from 'node:test';
import assert from 'node:assert/strict';
import {nextDependencyDepth,dependencyPathOf,MOST_DEPENDENCY_DEPTH} from '../src/failure.mjs';

const below=(parent,label)=>({dependency:{depth:nextDependencyDepth(parent,label),path:dependencyPathOf(parent,label)}});

test('each level names itself and the path keeps the levels above it, outermost first',()=>{
 const levels=['lifecycle','resolveSharedResource','acceptSpaceContentPage'];
 let commitment={};
 for(const label of levels)commitment=below(commitment,label);
 assert.deepEqual(commitment.dependency.path,levels);
 assert.equal(commitment.dependency.depth,3);
});

test('the warning from the sixth level on carries the path, and a level past the most is refused with it',()=>{
 const warned=[];
 const warn=console.warn;console.warn=(...args)=>warned.push(args);
 try{
  let commitment={};
  for(let level=1;level<=MOST_DEPENDENCY_DEPTH;level++)commitment=below(commitment,`step${level}`);
  assert.deepEqual(warned.map(([message,facts])=>[message,facts.depth]),[['dependency command nested deep',6],['dependency command nested deep',7],['dependency command nested deep',8]]);
  assert.deepEqual(warned.at(-1)[1].path.slice(0,3),['step1','step2','step3']);
  assert.throws(()=>nextDependencyDepth(commitment,'one-more'),error=>error.not_begun===true&&error.status===503&&error.dependency_path.at(-1)==='one-more');
 }finally{console.warn=warn;}
});

test('a path stays short and its labels are cut',()=>{
 let commitment={};
 for(let level=1;level<=8;level++)commitment={dependency:{depth:level,path:dependencyPathOf(commitment,'x'.repeat(100))}};
 assert.equal(commitment.dependency.path.length,8);
 assert.ok(commitment.dependency.path.every(label=>label.length===40));
 assert.equal(dependencyPathOf({dependency:{path:Array(10).fill('a')}},'b').length,10);
});
