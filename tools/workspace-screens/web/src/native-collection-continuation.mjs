// Preserve the historical array body while carriers retain its continuation.
export const nativeCollectionContinuation=Symbol.for('trillion.native.collection.continuation');
export const nativeCollectionCoverage=Symbol.for('trillion.native.collection.coverage');
export function withNativeCollectionContinuation(body,next,coverage){
 if(next&&body&&typeof body==='object')Object.defineProperty(body,nativeCollectionContinuation,{value:next,configurable:true});
 if(coverage&&body&&typeof body==='object')Object.defineProperty(body,nativeCollectionCoverage,{value:coverage,configurable:true});
 return body;
}
export function nativeCollectionAnswer(body){
 const next=body?.[nativeCollectionContinuation];
 const coverage=body?.[nativeCollectionCoverage];
 return Array.isArray(body)?{items:body,...(next?{next_before:next}:{}),...(coverage?{collection_coverage:coverage}:{})}:body;
}
