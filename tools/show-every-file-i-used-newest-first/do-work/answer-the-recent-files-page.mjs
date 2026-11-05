function nativeRecentFiles(sql,namespaceHttp){
  const resolved=new Map();
  const use=recentFilesStore(sql,{locate:identity=>resolved.get(identity)??null});
  const resolve=async ref=>{
    const row=await namespaceHttp('/namespace/files/lookup','POST',fileLookupBody(ref,{metadata:'file'})).catch(error=>{if(error.status===404)return null;throw error;});
    if(row?.identity)resolved.set(row.identity,row.names?.length?row:null);
    return row?.identity?row:null;
  };
  const recent=async input=>{
    const asked=Number(input?.limit),limit=Math.max(1,Math.min(recentSettings.list_max,Number.isSafeInteger(asked)&&asked>0?asked:recentSettings.list_default));
    const older=readTimeCursor(input?.before),after=afterTimeCursor(older,'MAX(at)','identity');
    const page=sql.exec(`SELECT identity FROM recent_file_uses GROUP BY identity HAVING ${after.sql}
      ORDER BY MAX(at) DESC,identity DESC LIMIT ?`,...after.args,limit+1).toArray();
    await Promise.all(page.map(row=>resolve(row.identity)));
    return use.recent(input??{});
  };
  const record=async input=>{
    const found=await resolve(input?.file);
    if(!found)throw new Error(`${String(input?.file??'')} is not in your files.`);
    resolved.set(found.identity,found);
    return use.record({...input,file:found.identity});
  };
  return {recent,record};
}
