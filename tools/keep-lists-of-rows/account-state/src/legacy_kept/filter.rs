//! Sparse reads of canonical optional kept membership facts. A point has
//! seven scalar bits, not seven SQL rows. Unknown optional data admits the page.
use crate::kept_runs;
use rusqlite::types::Value;
use std::collections::BTreeMap;

pub(super) struct Plan { pub value: Value, counts: Vec<usize> }
pub(super) fn plan(key: &str, bits: i64) -> Option<Plan> {
    let mut chunks = BTreeMap::<i64, (usize, Vec<(usize, u8)>)>::new();
    for (page, at, mask, bytes) in kept_runs::filter_probes(key, bits)? {
        chunks.entry(page).or_insert_with(|| (bytes, Vec::new())).1.push((at, mask));
    }
    let chunks = chunks.into_iter().map(|(page,(bytes,probes))|(page,bytes,probes)).collect::<Vec<_>>();
    let counts=chunks.iter().map(|(_,_,probes)|probes.len()).collect();
    Some(Plan { value: Value::Text(serde_json::to_string(&chunks).expect("bounded filter probe JSON")), counts })
}

pub(super) fn prefix(table: &str, plan: &Plan) -> String {
    let alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut reads=Vec::new();
    let mut holds=Vec::new();
    for (chunk,count) in plan.counts.iter().enumerate() {
        let bytes=format!("json_extract(?3,'$[{chunk}][1]')");
        let mut binary=Vec::new();let mut text=Vec::new();
        for sample in 0..*count {
            let at=format!("json_extract(?3,'$[{chunk}][2][{sample}][0]')");
            let mask=format!("json_extract(?3,'$[{chunk}][2][{sample}][1]')");
            let digit=|n|format!("(instr('{alphabet}',substr(body,(CAST(({at})/3 AS INTEGER)*4)+{n},1))-1)");
            let(d1,d2,d3,d4)=(digit(1),digit(2),digit(3),digit(4));
            let byte=format!("CASE ({at})%3 WHEN 0 THEN {d1}*4+CAST({d2}/16 AS INTEGER) WHEN 1 THEN ({d2}%16)*16+CAST({d3}/4 AS INTEGER) ELSE ({d3}%4)*64+{d4} END");
            text.push(format!("(({byte}) & {mask})!=0"));
            let hex=|n|format!("(instr('0123456789ABCDEF',substr(hex(substr(body,({at})+1,1)),{n},1))-1)");
            binary.push(format!("(({}*16+{}) & {mask})!=0",hex(1),hex(2)));
        }
        let valid_text=format!("length(body)=CAST(({bytes}+2)/3 AS INTEGER)*4 AND substr(body,1,length(body)-CASE ({bytes})%3 WHEN 0 THEN 0 WHEN 1 THEN 2 ELSE 1 END) NOT GLOB '*[^A-Za-z0-9+/]*' AND CASE ({bytes})%3 WHEN 0 THEN 1 WHEN 1 THEN substr(body,-2)='==' AND (instr('{alphabet}',substr(body,-3,1))-1)%16=0 WHEN 2 THEN substr(body,-1)='=' AND (instr('{alphabet}',substr(body,-2,1))-1)%4=0 END");
        let hold=format!("hold{chunk}");
        reads.push(format!("(SELECT CASE WHEN COUNT(*)=1 THEN CASE WHEN typeof(body)='blob' AND length(body)={bytes} THEN {} WHEN typeof(body)='text' AND ({valid_text}) THEN {} END END FROM (SELECT body FROM {table} WHERE page=json_extract(?3,'$[{chunk}][0]') LIMIT 2)) AS {hold}",binary.join(" AND "),text.join(" AND ")));
        holds.push(hold);
    }
    format!("filter_chunks AS MATERIALIZED (SELECT {}),membership AS MATERIALIZED (SELECT CASE WHEN {} THEN 1 ELSE {} END AS holds FROM filter_chunks)",reads.join(","),holds.iter().map(|hold|format!("{hold} IS NULL")).collect::<Vec<_>>().join(" OR "),holds.join(" AND "))
}
