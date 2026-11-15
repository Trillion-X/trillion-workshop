-- measure-activity.sql: every query behind measured-activity-2026-10-23-copy.json (format storage-sim-measured-activity/1).
-- Rerun on a future consenting account copy: clone each object read-only (APFS clonefile), open it with
--   sqlite3 -readonly "file:<clone>?mode=ro&immutable=1" < one query below, redirect the tab-separated output to out/<label>.tsv
-- Every query prints rows of (metric, day, value) or, for the record_log type query, (day, type, group, class, n).
-- Days are local calendar days in MDT (UTC-6, shifted in SQL) unless a query says UTC day key.
-- Object roles: founder own-records = RecordBook own-record-resource; founder namespace = RecordBook namespace-resource;
--   key gate = AccountControl gate:[...,"key:..."] holding account_control_permits; quota = AccountControl quota:<account> holding resource_budget_permits.
-- Run order: queries, then the LOAD section (loads out/*.tsv into sqlite :memory:), then the ASSEMBLE section, which prints the JSON.
-- Scan times on the 2026-10-23 copy (clone on APFS, 4 scans in parallel): record_log of the 10.6 GB own-records object 11 to 28 s per query, namespace object 9 to 19 s, permit tables 8 to 20 s, all others under 8 s.


-- ===== QUERY 10_records_by_day_type =====
-- METRIC record_creates / record_updates / record_deletes by local day (MDT), record type and machinery-or-user group
-- OBJECT RecordBook (own-records for the founder account; namespace book; or a second account's own-records); TABLE record_log; COLUMNS system_time (UTC ISO text, shifted -6 hours to MDT), envelopes (JSON array of envelopes)
-- class rule: delete = envelope has remove; update = envelope has set, or has value with a non-null prior; create = envelope has value and prior is null
-- group rule: machinery = type is execution, file-arrival, arrival, table-schema-change, message-source-key, message-case, computer-sources, voice-session, trigger-dispatch-outcome, told-the-person, or starts with resource-, agent-, notice-, decision-step, decision-call, workflow-dispatch; user = every other type
select strftime('%Y-%m-%d', substr(l.system_time,1,19), '-6 hours') as day,
       coalesce(json_extract(a.value,'$.type'), json_extract(a.value,'$.prior.type')) as type,
       case when coalesce(json_extract(a.value,'$.type'), json_extract(a.value,'$.prior.type')) in
              ('execution','file-arrival','arrival','table-schema-change','message-source-key','message-case','computer-sources','voice-session','trigger-dispatch-outcome','told-the-person')
              or coalesce(json_extract(a.value,'$.type'), json_extract(a.value,'$.prior.type')) like 'resource-%'
              or coalesce(json_extract(a.value,'$.type'), json_extract(a.value,'$.prior.type')) like 'agent-%'
              or coalesce(json_extract(a.value,'$.type'), json_extract(a.value,'$.prior.type')) like 'notice-%'
              or coalesce(json_extract(a.value,'$.type'), json_extract(a.value,'$.prior.type')) like 'decision-step%'
              or coalesce(json_extract(a.value,'$.type'), json_extract(a.value,'$.prior.type')) like 'decision-call%'
              or coalesce(json_extract(a.value,'$.type'), json_extract(a.value,'$.prior.type')) like 'workflow-dispatch%'
            then 'machinery' else 'user' end as grp,
       case when json_extract(a.value,'$.remove') is not null then 'delete'
            when json_extract(a.value,'$.set') is not null then 'update'
            when json_extract(a.value,'$.value') is not null and json_type(a.value,'$.prior') = 'object' then 'update'
            when json_extract(a.value,'$.value') is not null then 'create'
            else 'other' end as class,
       count(*) as n
from record_log l, json_each(l.envelopes) a
group by 1,2,3,4;

-- ===== QUERY 11_execution_families =====
-- METRIC execution_creates_<family> by local day (MDT); one execution record is one receipt per request (AI tool call, REST poll, or internal command)
-- OBJECT RecordBook own-records or namespace; TABLE record_log; COLUMNS system_time, envelopes -> value.operation of type execution
-- family rule: tool: prefix = tool call; 'POST /' or 'GET /' prefix = REST agent plumbing (polling, presence, claims); everything else = internal command receipt (claims:*, notices:*, namespace*, presentation:*)
select 'execution_creates_' ||
       case when json_extract(a.value,'$.value.operation') like 'tool:%' then 'tool'
            when json_extract(a.value,'$.value.operation') like 'POST /%' or json_extract(a.value,'$.value.operation') like 'GET /%' then 'rest'
            else 'internal' end as metric,
       strftime('%Y-%m-%d', substr(l.system_time,1,19), '-6 hours') as day,
       count(*) as n
from record_log l, json_each(l.envelopes) a
where json_extract(a.value,'$.type') = 'execution' and json_extract(a.value,'$.value') is not null
group by 1,2;

-- ===== QUERY 12_log_activity_by_day =====
-- METRIC activity per local day (MDT): log rows, distinct active hours (any, user, machinery), distinct agents (actor_context.reader key), peak distinct agents per hour, peak distinct agents in one 10-minute window, agent-hours
-- OBJECT RecordBook own-records; TABLE record_log; COLUMNS system_time, actor_context (JSON: reader = credential key of the caller), envelopes
-- agent rule: an agent is a distinct actor_context.reader value (a credential key). This is an upper bound on AIs: a person's own devices also hold keys.
-- user-row rule: the row holds at least one envelope of a user type (see 10_records_by_day_type group rule)
with rows as (
  select l.rowid as rid, strftime('%Y-%m-%d', substr(l.system_time,1,19), '-6 hours') as day,
         cast(strftime('%s', substr(l.system_time,1,19)) as integer) as ts,
         json_extract(l.actor_context,'$.reader') as reader,
         exists (select 1 from json_each(l.envelopes) a
                 where coalesce(json_extract(a.value,'$.type'), json_extract(a.value,'$.prior.type')) not in
                       ('execution','file-arrival','arrival','table-schema-change','message-source-key','message-case','computer-sources','voice-session','trigger-dispatch-outcome','told-the-person')
                   and coalesce(json_extract(a.value,'$.type'), json_extract(a.value,'$.prior.type')) not like 'resource-%'
                   and coalesce(json_extract(a.value,'$.type'), json_extract(a.value,'$.prior.type')) not like 'agent-%'
                   and coalesce(json_extract(a.value,'$.type'), json_extract(a.value,'$.prior.type')) not like 'notice-%'
                   and coalesce(json_extract(a.value,'$.type'), json_extract(a.value,'$.prior.type')) not like 'decision-step%'
                   and coalesce(json_extract(a.value,'$.type'), json_extract(a.value,'$.prior.type')) not like 'decision-call%'
                   and coalesce(json_extract(a.value,'$.type'), json_extract(a.value,'$.prior.type')) not like 'workflow-dispatch%') as is_user
  from record_log l
), hourly as (
  select day, ts/3600 as h, count(distinct reader) as agents from rows where reader is not null group by 1,2
), tenmin as (
  select day, ts/600 as w, count(distinct reader) as agents from rows where reader is not null group by 1,2
)
select 'log_rows', day, count(*) from rows group by 2
union all select 'active_hours_any', day, count(distinct ts/3600) from rows group by 2
union all select 'active_hours_user', day, count(distinct ts/3600) from rows where is_user group by 2
union all select 'active_hours_machinery', day, count(distinct ts/3600) from rows where not is_user group by 2
union all select 'distinct_agents', day, count(distinct reader) from rows where reader is not null group by 2
union all select 'agent_hours', day, count(*) from hourly group by 2
union all select 'peak_agents_in_one_hour', day, max(agents) from hourly group by 2
union all select 'peak_agents_in_10_minutes', day, max(agents) from tenmin group by 2;

-- ===== QUERY 13_log_gaps =====
-- METRIC idle-gap distribution between consecutive record_log rows (all rows; user rows only); seconds
-- OBJECT RecordBook own-records; TABLE record_log; COLUMN system_time
-- Output day column is 'all' (whole span, rows with a gap of more than 1 day excluded from the percentiles because the account was paused)
with t as (
  select cast(strftime('%s', substr(system_time,1,19)) as integer) as ts from record_log
), g as (
  select ts - lag(ts) over (order by ts) as gap from t
), r as (
  select gap, row_number() over (order by gap) as rn, count(*) over () as n from g where gap is not null and gap <= 86400
)
select 'gap_gt_10s', 'all', sum(gap > 10) from r
union all select 'gap_gt_70s', 'all', sum(gap > 70) from r
union all select 'gap_gt_140s', 'all', sum(gap > 140) from r
union all select 'gap_gt_600s', 'all', sum(gap > 600) from r
union all select 'gap_gt_3600s', 'all', sum(gap > 3600) from r
union all select 'gap_count', 'all', count(*) from r
union all select 'gap_p50_s', 'all', gap from r where rn = (n+1)/2
union all select 'gap_p90_s', 'all', gap from r where rn = (n*9+9)/10
union all select 'gap_p99_s', 'all', gap from r where rn = (n*99+99)/100;

-- ===== QUERY 14_agent_cards_by_day =====
-- METRIC distinct AIs (agent-card records, one per registered AI) touched per local day (MDT), peak per hour, peak per 10-minute window, AI-hours
-- OBJECT RecordBook own-records; TABLE record_log; COLUMNS system_time, envelopes -> id and type of type agent-card (an update of an agent card is its presence/capacity/heartbeat write)
with e as (
  select strftime('%Y-%m-%d', substr(l.system_time,1,19), '-6 hours') as day,
         cast(strftime('%s', substr(l.system_time,1,19)) as integer) as ts,
         json_extract(a.value,'$.id') as agent
  from record_log l, json_each(l.envelopes) a
  where coalesce(json_extract(a.value,'$.type'), json_extract(a.value,'$.prior.type')) = 'agent-card'
), hourly as (select day, ts/3600 as h, count(distinct agent) as n from e group by 1,2),
tenmin as (select day, ts/600 as w, count(distinct agent) as n from e group by 1,2)
select 'agent_cards_touched', day, count(distinct agent) from e group by 2
union all select 'agent_card_writes', day, count(*) from e group by 2
union all select 'agent_cards_peak_in_one_hour', day, max(n) from hourly group by 2
union all select 'agent_cards_peak_in_10_minutes', day, max(n) from tenmin group by 2
union all select 'agent_card_hours', day, count(*) from hourly group by 2;

-- ===== QUERY 15_agents_with_tool_calls =====
-- METRIC AI tool calls per active AI-hour: tool execution receipts per local day, distinct callers (actor_context.reader) that made them, caller-hours, peak callers in one 10-minute window
-- OBJECT RecordBook own-records; TABLE record_log; COLUMNS system_time, actor_context.reader, envelopes -> value.operation like 'tool:%' on type execution creates
with e as (
  select strftime('%Y-%m-%d', substr(l.system_time,1,19), '-6 hours') as day,
         cast(strftime('%s', substr(l.system_time,1,19)) as integer) as ts,
         json_extract(l.actor_context,'$.reader') as reader
  from record_log l, json_each(l.envelopes) a
  where json_extract(a.value,'$.type') = 'execution' and json_extract(a.value,'$.value') is not null
    and json_extract(a.value,'$.value.operation') like 'tool:%'
), h as (select day, reader, ts/3600 as hr from e group by 1,2,3),
w as (select day, ts/600 as w, count(distinct reader) as n from e group by 1,2)
select 'tool_exec_calls', day, count(*) from e group by 2
union all select 'tool_exec_callers', day, count(distinct reader) from e group by 2
union all select 'tool_exec_caller_hours', day, count(*) from h group by 2
union all select 'tool_exec_peak_callers_10min', day, max(n) from w group by 2;

-- ===== QUERY 16_activity_feed_by_day =====
-- METRIC AI tool uses recorded in the activity feed per local day (MDT): rows, active hours, peak rows in one hour, distinct tools, distinct agents
-- OBJECT RecordBook own-records; TABLE activity_g1 (second account) or activity_g21 and activity_g22 (founder; the feed keeps only the newest ~7,000 rows, so older days are absent); COLUMNS at (UTC ISO), row.$.tool, row.$.agent
-- one feed row is one AI tool use shown to the person
with a as (
  select strftime('%Y-%m-%d', substr(at,1,19), '-6 hours') as day, cast(strftime('%s', substr(at,1,19)) as integer) / 3600 as hr,
         json_extract(row,'$.tool') as tool, json_extract(row,'$.agent') as agent
  from activity_g1
), h as (select day, hr, count(*) as n from a group by 1,2)
select 'activity_tool_uses', day, count(*) from a group by 2
union all select 'activity_active_hours', day, count(*) from h group by 2
union all select 'activity_peak_per_hour', day, max(n) from h group by 2
union all select 'activity_distinct_tools', day, count(distinct tool) from a group by 2
union all select 'activity_distinct_agents', day, count(distinct agent) from a where agent is not null group by 2;

-- ===== QUERY 16b_activity_feed_founder =====
-- METRIC AI tool uses recorded in the activity feed per local day (MDT): rows, active hours, peak rows in one hour, distinct tools, distinct agents
-- OBJECT RecordBook own-records (founder); TABLES activity_g21 and activity_g22 (the feed keeps only the newest ~7,000 rows, so only the last day is present); COLUMNS at (UTC ISO), row.$.tool, row.$.agent
-- one feed row is one AI tool use shown to the person
with a as (
  select strftime('%Y-%m-%d', substr(at,1,19), '-6 hours') as day, cast(strftime('%s', substr(at,1,19)) as integer) / 3600 as hr,
         json_extract(row,'$.tool') as tool, json_extract(row,'$.agent') as agent
  from (select * from activity_g21 union all select * from activity_g22)
), h as (select day, hr, count(*) as n from a group by 1,2)
select 'activity_tool_uses', day, count(*) from a group by 2
union all select 'activity_active_hours', day, count(*) from h group by 2
union all select 'activity_peak_per_hour', day, max(n) from h group by 2
union all select 'activity_distinct_tools', day, count(distinct tool) from a group by 2
union all select 'activity_distinct_agents', day, count(distinct agent) from a where agent is not null group by 2;

-- ===== QUERY 17_messages_by_speaker =====
-- METRIC conversation messages created per local day (MDT) by speaker class, and distinct hours with a person-typed message
-- OBJECT RecordBook own-records; TABLE record_log; COLUMNS system_time, envelopes -> type message value.speaker
-- speaker class rule: speaker = 'person' is typed by the person; speaker = 'ai' is written by an AI; any other speaker label (heard-voice labels, 'Unsure (...)') is class voice
with m as (
  select strftime('%Y-%m-%d', substr(l.system_time,1,19), '-6 hours') as day,
         cast(strftime('%s', substr(l.system_time,1,19)) as integer) / 3600 as hr,
         case json_extract(a.value,'$.value.speaker') when 'person' then 'person' when 'ai' then 'ai' else 'voice' end as cls
  from record_log l, json_each(l.envelopes) a
  where json_extract(a.value,'$.type') = 'message' and json_extract(a.value,'$.value') is not null and json_type(a.value,'$.prior') is not 'object'
)
select 'messages_' || cls, day, count(*) from m group by 1,2
union all select 'person_message_active_hours', day, count(distinct hr) from m where cls = 'person' group by 2;

-- ===== QUERY 18_activity_feed_gaps =====
-- METRIC idle-gap distribution between consecutive AI tool uses in the activity feed (seconds); gaps over 1 day dropped
-- OBJECT RecordBook own-records (second account); TABLE activity_g1; COLUMN at
with t as (select cast(strftime('%s', substr(at,1,19)) as integer) as ts from activity_g1),
g as (select ts - lag(ts) over (order by ts) as gap from t),
r as (select gap, row_number() over (order by gap) as rn, count(*) over () as n from g where gap is not null and gap <= 86400)
select 'feed_gap_gt_70s','all',sum(gap>70) from r
union all select 'feed_gap_gt_600s','all',sum(gap>600) from r
union all select 'feed_gap_gt_3600s','all',sum(gap>3600) from r
union all select 'feed_gap_count','all',count(*) from r
union all select 'feed_gap_p50_s','all',gap from r where rn=(n+1)/2
union all select 'feed_gap_p90_s','all',gap from r where rn=(n*9+9)/10
union all select 'feed_gap_p99_s','all',gap from r where rn=(n*99+99)/100;

-- ===== QUERY 20_gate_permits_by_day =====
-- METRIC gate_permits per local day (MDT), total and by operation group: one gate permit is one gated command (screen read, hand-off step, notice take, tool run)
-- OBJECT AccountControl gate (the key gate of the account); TABLE account_control_permits; COLUMNS created_at_ms (epoch ms, shifted -6 hours), target_json.$.operation, state
select 'gate_permits_all' as metric, strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', '-6 hours') as day, count(*) as n from account_control_permits group by 2
union all select 'gate_presentation_read', strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', '-6 hours'), count(*) from account_control_permits where json_extract(target_json,'$.operation') = 'presentation:read' group by 2
union all select 'gate_presentation_subscribe', strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', '-6 hours'), count(*) from account_control_permits where json_extract(target_json,'$.operation') = 'presentation:subscribe' group by 2
union all select 'gate_presentation_mount', strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', '-6 hours'), count(*) from account_control_permits where json_extract(target_json,'$.operation') = 'presentation:mount' group by 2
union all select 'gate_claims_all', strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', '-6 hours'), count(*) from account_control_permits where json_extract(target_json,'$.operation') like 'claims:%' group by 2
union all select 'gate_claims_publish', strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', '-6 hours'), count(*) from account_control_permits where json_extract(target_json,'$.operation') in ('claims:publish','claims:handOffForAi') group by 2
union all select 'gate_claims_take', strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', '-6 hours'), count(*) from account_control_permits where json_extract(target_json,'$.operation') in ('claims:take','claims:pull') group by 2
union all select 'gate_claims_ack_release', strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', '-6 hours'), count(*) from account_control_permits where json_extract(target_json,'$.operation') in ('claims:ack','claims:release','claims:finish') group by 2
union all select 'gate_lists', strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', '-6 hours'), count(*) from account_control_permits where json_extract(target_json,'$.operation') like 'lists:%' group by 2
union all select 'gate_tools', strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', '-6 hours'), count(*) from account_control_permits where json_extract(target_json,'$.operation') like 'tools:%' group by 2
union all select 'gate_not_completed', strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', '-6 hours'), count(*) from account_control_permits where state <> 'completed' group by 2;

-- ===== QUERY 21_budget_permits_by_day =====
-- METRIC budget_permits per local day (MDT), total and by purpose group: one budget permit is one bookkeeping request metered against the account's resource budget
-- OBJECT AccountControl quota (resource budget) of the account; TABLE resource_budget_permits; COLUMNS created_at_ms (epoch ms, shifted -6 hours), facts_json.$.purpose, state
select 'budget_permits_all' as metric, strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', '-6 hours') as day, count(*) as n from resource_budget_permits group by 2
union all select 'budget_namespaceHttp', strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', '-6 hours'), count(*) from resource_budget_permits where json_extract(facts_json,'$.purpose') = 'rpc:namespaceHttp' group by 2
union all select 'budget_shared', strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', '-6 hours'), count(*) from resource_budget_permits where json_extract(facts_json,'$.purpose') like 'rpc:shared%' group by 2
union all select 'budget_presentation_read', strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', '-6 hours'), count(*) from resource_budget_permits where json_extract(facts_json,'$.purpose') = 'rpc:presentation:read' group by 2
union all select 'budget_not_settled', strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', '-6 hours'), count(*) from resource_budget_permits where state <> 'settled' group by 2;

-- ===== QUERY 22_gate_activity =====
-- METRIC activity per local day (MDT) from gate permit timestamps: distinct active hours (any command; person-screen commands only), and idle-gap distribution
-- OBJECT AccountControl gate; TABLE account_control_permits; COLUMNS created_at_ms, target_json.$.operation
-- person-screen rule: operation is presentation:mount, presentation:subscribe, screens:spend, screens:waitingOnYou, lists:putRows, lists:put, tell:request or attention:request (a person opening or touching a screen); presentation:read is excluded because a mounted screen re-reads on its own
with p as (
  select created_at_ms/1000 as ts, strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch', '-6 hours') as day,
         json_extract(target_json,'$.operation') in ('presentation:mount','presentation:subscribe','screens:spend','screens:waitingOnYou','lists:putRows','lists:put','tell:request','attention:request') as person
  from account_control_permits
)
select 'gate_active_hours_any', day, count(distinct ts/3600) from p group by 2
union all select 'gate_active_hours_person_screen', day, count(distinct ts/3600) from p where person group by 2
union all select 'gate_permits_person_screen', day, count(*) from p where person group by 2;

-- ===== QUERY 23_gate_gaps =====
-- METRIC idle-gap distribution between consecutive gate permits (all; person-screen commands only); seconds; gaps over 1 day dropped
-- OBJECT AccountControl gate; TABLE account_control_permits; COLUMNS created_at_ms, target_json.$.operation
with all_t as (select created_at_ms/1000 as ts from account_control_permits),
person_t as (select created_at_ms/1000 as ts from account_control_permits where json_extract(target_json,'$.operation') in ('presentation:mount','presentation:subscribe','screens:spend','screens:waitingOnYou','lists:putRows','lists:put','tell:request','attention:request')),
ga as (select ts - lag(ts) over (order by ts) as gap from all_t),
gp as (select ts - lag(ts) over (order by ts) as gap from person_t),
ra as (select gap, row_number() over (order by gap) as rn, count(*) over () as n from ga where gap is not null and gap <= 86400),
rp as (select gap, row_number() over (order by gap) as rn, count(*) over () as n from gp where gap is not null and gap <= 86400)
select 'gate_all_gap_gt_70s','all',sum(gap>70) from ra
union all select 'gate_all_gap_gt_600s','all',sum(gap>600) from ra
union all select 'gate_all_gap_gt_3600s','all',sum(gap>3600) from ra
union all select 'gate_all_gap_count','all',count(*) from ra
union all select 'gate_all_gap_p50_s','all',gap from ra where rn=(n+1)/2
union all select 'gate_all_gap_p90_s','all',gap from ra where rn=(n*9+9)/10
union all select 'gate_all_gap_p99_s','all',gap from ra where rn=(n*99+99)/100
union all select 'gate_person_gap_gt_70s','all',sum(gap>70) from rp
union all select 'gate_person_gap_gt_600s','all',sum(gap>600) from rp
union all select 'gate_person_gap_gt_3600s','all',sum(gap>3600) from rp
union all select 'gate_person_gap_count','all',count(*) from rp
union all select 'gate_person_gap_p50_s','all',gap from rp where rn=(n+1)/2
union all select 'gate_person_gap_p90_s','all',gap from rp where rn=(n*9+9)/10
union all select 'gate_person_gap_p99_s','all',gap from rp where rn=(n*99+99)/100;

-- ===== QUERY 30_tasks_by_day =====
-- METRIC workshop tasks per local day (MDT): one task is one tool run or internal command; split into the known no-op loop tool and the rest
-- OBJECT RecordBook own-records (AI tool runs) or namespace (internal namespace commands); TABLE workshop_tasks; COLUMNS sort_at (UTC ISO, shifted -6 hours), tool_id, state
-- no-op loop tool: tool:weigh-steps-ais-left-you ("A weigh is already running", 0 seconds, did nothing), looped 2026-10-07 to 2026-10-12
-- sort_at is the task's newest sort time (latest version), so a task that ran over several days is counted on its last day
select 'tasks_all' as metric, strftime('%Y-%m-%d', substr(sort_at,1,19), '-6 hours') as day, count(*) as n from workshop_tasks group by 2
union all select 'tasks_noop_loop_tool', strftime('%Y-%m-%d', substr(sort_at,1,19), '-6 hours'), count(*) from workshop_tasks where tool_id = 'tool:weigh-steps-ais-left-you' group by 2
union all select 'tasks_excluding_loop', strftime('%Y-%m-%d', substr(sort_at,1,19), '-6 hours'), count(*) from workshop_tasks where tool_id is null or tool_id <> 'tool:weigh-steps-ais-left-you' group by 2
union all select 'tasks_failed_excluding_loop', strftime('%Y-%m-%d', substr(sort_at,1,19), '-6 hours'), count(*) from workshop_tasks where state = 'failed' and (tool_id is null or tool_id <> 'tool:weigh-steps-ais-left-you') group by 2
union all select 'distinct_tools_excluding_loop', strftime('%Y-%m-%d', substr(sort_at,1,19), '-6 hours'), count(distinct tool_id) from workshop_tasks where tool_id <> 'tool:weigh-steps-ais-left-you' group by 2
union all select 'tasks_poll_tools_excluding_loop', strftime('%Y-%m-%d', substr(sort_at,1,19), '-6 hours'), count(*) from workshop_tasks where tool_id like 'tool:google-%' or tool_id like 'tool:github-%' or tool_id like 'tool:stripe-%' or tool_id = 'tool:list-connections' group by 2;

-- ===== QUERY 31_namespace_steps_by_day =====
-- METRIC namespace operation steps per local day (MDT), by the day of the task that owns them
-- OBJECT RecordBook namespace; TABLES namespace_operation_steps join workshop_tasks on task_id; COLUMNS ordinal, sort_at
select 'namespace_steps' as metric, strftime('%Y-%m-%d', substr(t.sort_at,1,19), '-6 hours') as day, count(*) as n
from namespace_operation_steps s join workshop_tasks t on t.task_id = s.task_id group by 2;

-- ===== QUERY 40_files_by_day =====
-- METRIC file records per local day (MDT): files stored, bytes stored, names recorded, aliases added, chunks stored
-- OBJECT RecordBook namespace; TABLES namespace_files (stored_at, byte_length, spans), namespace_names (named_at), namespace_aliases (added_at), namespace_chunks (stored_at)
-- a name record is a path entry in a folder (collection); a moved or renamed file writes a new name; namespace_moves holds only an in-flight move and is not a history
select 'files_stored' as metric, strftime('%Y-%m-%d', substr(stored_at,1,19), '-6 hours') as day, count(*) as n from namespace_files group by 2
union all select 'file_bytes_stored', strftime('%Y-%m-%d', substr(stored_at,1,19), '-6 hours'), sum(byte_length) from namespace_files group by 2
union all select 'file_spans', strftime('%Y-%m-%d', substr(stored_at,1,19), '-6 hours'), sum(spans) from namespace_files group by 2
union all select 'file_names_recorded', strftime('%Y-%m-%d', substr(named_at,1,19), '-6 hours'), count(*) from namespace_names group by 2
union all select 'file_aliases_added', strftime('%Y-%m-%d', substr(added_at,1,19), '-6 hours'), count(*) from namespace_aliases group by 2
union all select 'file_chunks_stored', strftime('%Y-%m-%d', substr(stored_at,1,19), '-6 hours'), count(*) from namespace_chunks group by 2;

-- ===== QUERY 41_folders =====
-- METRIC folder (collection) count and names per folder, whole table
-- OBJECT RecordBook namespace; TABLE namespace_names; COLUMN collection
select 'folders_total', 'all', count(distinct collection) from namespace_names
union all select 'names_total', 'all', count(*) from namespace_names
union all select 'files_total', 'all', count(*) from namespace_files;

-- ===== QUERY 50_metered_calls_by_day =====
-- METRIC store requests ("calls") per UTC day (the stored day key; it is a UTC day and cannot be converted to MDT), per purpose; top-level purposes only (purposes whose name has ' > ' are alarm/wake children counted inside their parent)
-- OBJECT RecordBook own-records or namespace; TABLE metered_use_days; COLUMNS day, purposes (JSON purpose -> {calls, statements, rows_read, rows_written})
select 'meter:' || p.key as metric, m.day as day, json_extract(p.value, '$.calls') as n
from metered_use_days m, json_each(m.purposes) p
where p.key not like '% > %' and json_extract(p.value, '$.calls') is not null;

-- ===== QUERY 51_model_spend_by_day =====
-- METRIC model calls per UTC day (stored day key): calls paid and made, refused by the budget, answered from the remembered-answers cache, input and output tokens
-- OBJECT RecordBook own-records; TABLE model_spend; COLUMNS day, calls, refused, remembered, input_tokens, output_tokens
select 'model_calls' as metric, day, sum(calls) from model_spend group by 2
union all select 'model_refused', day, sum(refused) from model_spend group by 2
union all select 'model_remembered', day, sum(remembered) from model_spend group by 2
union all select 'model_input_tokens', day, sum(input_tokens) from model_spend group by 2
union all select 'model_output_tokens', day, sum(output_tokens) from model_spend group by 2;

-- ===== QUERY 60_object_bytes =====
-- METRIC object size in bytes (the seat's data size is the sum over the account's objects)
-- OBJECT any SQLite object; PRAGMAS page_count * page_size
select 'object_bytes', 'all', page_count * page_size from pragma_page_count(), pragma_page_size();

-- ===== LOAD =====
-- LOAD: put every query output (tab separated, no header) into the staging tables. Run the assemble section afterwards.
-- Each query output file is loaded with its account, family and the object it was run against.
.bail on
.mode tabs
create table raw (account text, family text, metric text, day text, value real);
create table rec (account text, family text, day text, type text, grp text, class text, n integer);
create table stage (metric text, day text, value real);
create table stage_rec (day text, type text, grp text, class text, n integer);
.import out/f_own_records.tsv stage_rec
insert into rec select 'founder', 'own_log', day, type, grp, class, n from stage_rec;
delete from stage_rec;
.import out/f_ns_records.tsv stage_rec
insert into rec select 'founder', 'ns_log', day, type, grp, class, n from stage_rec;
delete from stage_rec;
.import out/s_own_records.tsv stage_rec
insert into rec select 'second', 'own_log', day, type, grp, class, n from stage_rec;
delete from stage_rec;
.import out/s_ns_records.tsv stage_rec
insert into rec select 'second', 'ns_log', day, type, grp, class, n from stage_rec;
delete from stage_rec;
.import out/f_own_exec.tsv stage
insert into raw select 'founder', 'own_log', metric, day, value from stage;
delete from stage;
.import out/f_own_activity.tsv stage
insert into raw select 'founder', 'own_log', metric, day, value from stage;
delete from stage;
.import out/f_own_agentcards.tsv stage
insert into raw select 'founder', 'own_log', metric, day, value from stage;
delete from stage;
.import out/f_own_toolcallers.tsv stage
insert into raw select 'founder', 'own_log', metric, day, value from stage;
delete from stage;
.import out/f_messages.tsv stage
insert into raw select 'founder', 'own_log', metric, day, value from stage;
delete from stage;
.import out/f_own_gaps.tsv stage
insert into raw select 'founder', 'own_log', metric, day, value from stage;
delete from stage;
.import out/f_ns_exec.tsv stage
insert into raw select 'founder', 'ns_log', metric, day, value from stage;
delete from stage;
.import out/f_gate_permits.tsv stage
insert into raw select 'founder', 'gate', metric, day, value from stage;
delete from stage;
.import out/f_gate_activity.tsv stage
insert into raw select 'founder', 'gate', metric, day, value from stage;
delete from stage;
.import out/f_gate_gaps.tsv stage
insert into raw select 'founder', 'gate', metric, day, value from stage;
delete from stage;
.import out/f_budget_permits.tsv stage
insert into raw select 'founder', 'budget', metric, day, value from stage;
delete from stage;
.import out/f_own_tasks.tsv stage
insert into raw select 'founder', 'own_tasks', metric, day, value from stage;
delete from stage;
.import out/f_ns_tasks.tsv stage
insert into raw select 'founder', 'ns_tasks', metric, day, value from stage;
delete from stage;
.import out/f_ns_steps.tsv stage
insert into raw select 'founder', 'ns_tasks', metric, day, value from stage;
delete from stage;
.import out/f_files.tsv stage
insert into raw select 'founder', 'files', metric, day, value from stage;
delete from stage;
.import out/f_folders.tsv stage
insert into raw select 'founder', 'files', metric, day, value from stage;
delete from stage;
.import out/f_own_meter.tsv stage
insert into raw select 'founder', 'meter_own', metric, day, value from stage;
delete from stage;
.import out/f_ns_meter.tsv stage
insert into raw select 'founder', 'meter_ns', metric, day, value from stage;
delete from stage;
.import out/f_model.tsv stage
insert into raw select 'founder', 'model', metric, day, value from stage;
delete from stage;
.import out/f_activity.tsv stage
insert into raw select 'founder', 'feed', metric, day, value from stage;
delete from stage;
.import out/s_own_exec.tsv stage
insert into raw select 'second', 'own_log', metric, day, value from stage;
delete from stage;
.import out/s_ns_exec.tsv stage
insert into raw select 'second', 'ns_log', metric, day, value from stage;
delete from stage;
.import out/s_budget_permits.tsv stage
insert into raw select 'second', 'budget', metric, day, value from stage;
delete from stage;
.import out/s_own_tasks.tsv stage
insert into raw select 'second', 'own_tasks', metric, day, value from stage;
delete from stage;
.import out/s_own_meter.tsv stage
insert into raw select 'second', 'meter_own', metric, day, value from stage;
delete from stage;
.import out/s_ns_meter.tsv stage
insert into raw select 'second', 'meter_ns', metric, day, value from stage;
delete from stage;
.import out/s_activity.tsv stage
insert into raw select 'second', 'feed', metric, day, value from stage;
delete from stage;
.import out/s_activity_gaps.tsv stage
insert into raw select 'second', 'feed', metric, day, value from stage;
delete from stage;

-- ===== ASSEMBLE =====
-- ASSEMBLE: turn the staged query outputs into the storage-sim-measured-activity/1 JSON document.
-- Inputs: tables raw and rec (see LOAD); tables sizes, windows, notes, sources defined below. Output: one JSON text.

-- record envelopes -> metrics: record_<class>s_<group> and record_<class>s_all and record_<class>s_type:<type>
insert into raw select account, family, 'record_' || class || 's_' || grp, day, sum(n) from rec where class <> 'other' group by 1,2,3,4;
insert into raw select account, family, 'record_' || class || 's_all', day, sum(n) from rec where class <> 'other' group by 1,2,3,4;
insert into raw select account, family, 'record_' || class || 's_type:' || type, day, sum(n) from rec where class <> 'other' group by 1,2,3,4;
-- keep per-type metrics only for types whose total is at least 100 records
delete from raw where metric like 'record\_%s\_type:%' escape '\' and (account, family, metric) in
  (select account, family, metric from raw where metric like 'record\_%s\_type:%' escape '\' group by 1,2,3 having sum(value) < 100);
-- meter metrics: keep the 12 busiest purposes per object plus every search purpose, add the all-purpose total
insert into raw select account, family, 'meter_calls_all_top_level', day, sum(value) from raw where metric like 'meter:%' group by 1,2,4;
delete from raw where metric like 'meter:%' and metric not like '%earch%' and (account, family, metric) not in
  (select account, family, metric from (select account, family, metric, row_number() over (partition by account, family order by sum(value) desc) as r from raw where metric like 'meter:%' group by 1,2,3) where r <= 12);
-- derived ratios (no zero fill: only days where the denominator exists)
insert into raw select 'founder', 'derived', 'ratio_budget_permits_per_gate_permit', g.day, 1.0 * b.value / g.value
  from raw g join raw b on b.account = g.account and b.day = g.day
  where g.account = 'founder' and g.family = 'gate' and g.metric = 'gate_permits_all' and g.value > 0 and b.family = 'budget' and b.metric = 'budget_permits_all';
insert into raw select 'founder', 'derived', 'ratio_tool_exec_calls_per_caller_hour', c.day, 1.0 * c.value / h.value
  from raw c join raw h on h.account = c.account and h.day = c.day
  where c.account = 'founder' and c.family = 'own_log' and c.metric = 'tool_exec_calls' and h.family = 'own_log' and h.metric = 'tool_exec_caller_hours' and h.value > 0;
insert into raw select 'founder', 'derived', 'ratio_tool_exec_calls_per_agent_card_hour', c.day, 1.0 * c.value / h.value
  from raw c join raw h on h.account = c.account and h.day = c.day
  where c.account = 'founder' and c.family = 'own_log' and c.metric = 'tool_exec_calls' and h.family = 'own_log' and h.metric = 'agent_card_hours' and h.value > 0;
insert into raw select 'founder', 'derived', 'ratio_namespace_steps_per_task', s.day, 1.0 * s.value / t.value
  from raw s join raw t on t.account = s.account and t.day = s.day
  where s.account = 'founder' and s.family = 'ns_tasks' and s.metric = 'namespace_steps' and t.family = 'ns_tasks' and t.metric = 'tasks_all' and t.value > 0;
insert into raw select 'founder', 'derived', 'ratio_tasks_excluding_loop_per_gate_permit', t.day, 1.0 * t.value / g.value
  from raw t join raw g on g.account = t.account and g.day = t.day
  where t.account = 'founder' and t.family = 'own_tasks' and t.metric = 'tasks_excluding_loop' and g.family = 'gate' and g.metric = 'gate_permits_all' and g.value > 0;

create table windows (account text, family text, first_day text, last_day text, partial text);
insert into windows values
 ('founder','own_log','2026-10-17','2026-10-22','2026-10-16 (starts 13:46 MDT), 2026-10-23 (ends 01:12 MDT)'),
 ('founder','ns_log','2026-10-21','2026-10-21','2026-10-20 (starts 03:55 MDT), 2026-10-22 (ends 17:37 MDT); the log holds no other days'),
 ('founder','gate','2026-10-16','2026-10-22','2026-10-15 (starts 16:07 MDT), 2026-10-23 (ends about 13:34 MDT)'),
 ('founder','budget','2026-10-16','2026-10-22','2026-10-15, 2026-10-23 (partial)'),
 ('founder','derived','2026-10-16','2026-10-22','see the numerator and denominator families'),
 ('founder','own_tasks','2026-09-28','2026-10-22','2026-09-27 (import day), 2026-10-23 (partial)'),
 ('founder','ns_tasks','2026-10-21','2026-10-21','2026-10-20 (starts 03:55 MDT), 2026-10-22 (partial)'),
 ('founder','files','2026-09-28','2026-10-22','2026-09-26, 2026-09-27 (import days), 2026-10-23 (partial)'),
 ('founder','meter_own','2026-10-17','2026-10-22','2026-10-16, 2026-10-23 (partial, UTC days)'),
 ('founder','meter_ns','2026-10-17','2026-10-22','2026-10-16, 2026-10-23 (partial, UTC days)'),
 ('founder','model','2026-10-05','2026-10-22','2026-10-04, 2026-10-23 (partial, UTC days)'),
 ('second','budget','2026-10-21','2026-10-22','2026-10-20 (partial), 2026-10-23 (partial)'),
 ('second','own_tasks','2026-10-17','2026-10-22','2026-10-16 (partial)'),
 ('second','meter_own','2026-10-17','2026-10-22','2026-10-16, 2026-10-23 (partial, UTC days)'),
 ('second','meter_ns','2026-10-21','2026-10-22','short history'),
 ('second','feed','2026-10-17','2026-10-22','2026-10-16 (starts 16:30 MDT)');

create table sources (account text, family text, object text, tbl text, col text, query text);
insert into sources values
 ('founder','own_log','RecordBook/cdae20b0f3 (own-records)','record_log','system_time; actor_context; envelopes','records_by_day_type, execution_families, log_activity_by_day, agent_cards_by_day, agents_with_tool_calls, messages_by_speaker, log_gaps'),
 ('founder','ns_log','RecordBook/dd58a43209 (namespace)','record_log','system_time; envelopes','records_by_day_type, execution_families'),
 ('founder','gate','AccountControl/a56a1218db (key gate)','account_control_permits','created_at_ms; target_json.operation','gate_permits_by_day, gate_activity, gate_gaps'),
 ('founder','budget','AccountControl/be804850ee (quota)','resource_budget_permits','created_at_ms; facts_json.purpose','budget_permits_by_day'),
 ('founder','derived','founder gate, quota, own-records, namespace','ratio of the named metrics','daily values of the numerator and denominator','assemble'),
 ('founder','own_tasks','RecordBook/cdae20b0f3 (own-records)','workshop_tasks','sort_at; tool_id; state','tasks_by_day'),
 ('founder','ns_tasks','RecordBook/dd58a43209 (namespace)','workshop_tasks; namespace_operation_steps','sort_at; task_id','tasks_by_day, namespace_steps_by_day'),
 ('founder','files','RecordBook/dd58a43209 (namespace)','namespace_files; namespace_names; namespace_aliases; namespace_chunks','stored_at; named_at; added_at; byte_length; spans','files_by_day, folders'),
 ('founder','meter_own','RecordBook/cdae20b0f3 (own-records)','metered_use_days','day (UTC day key); purposes.calls','metered_calls_by_day'),
 ('founder','meter_ns','RecordBook/dd58a43209 (namespace)','metered_use_days','day (UTC day key); purposes.calls','metered_calls_by_day'),
 ('founder','model','RecordBook/cdae20b0f3 (own-records)','model_spend','day (UTC day key); calls; refused; remembered; input_tokens; output_tokens','model_spend_by_day'),
 ('founder','feed','RecordBook/cdae20b0f3 (own-records)','activity_g21; activity_g22','at; row.tool; row.agent','activity_feed_by_day'),
 ('founder','bytes','all founder objects','page_count * page_size','pragma page_count, page_size','object_bytes'),
 ('second','own_log','RecordBook/77d8e62cf9 (own-records)','record_log','system_time; envelopes','records_by_day_type, execution_families'),
 ('second','ns_log','RecordBook/649a4d18d6 (namespace)','record_log','system_time; envelopes','records_by_day_type, execution_families'),
 ('second','budget','AccountControl/de90cb76b9 (quota)','resource_budget_permits','created_at_ms','budget_permits_by_day'),
 ('second','own_tasks','RecordBook/77d8e62cf9 (own-records)','workshop_tasks','sort_at; tool_id; state','tasks_by_day'),
 ('second','meter_own','RecordBook/77d8e62cf9 (own-records)','metered_use_days','day (UTC day key); purposes.calls','metered_calls_by_day'),
 ('second','meter_ns','RecordBook/649a4d18d6 (namespace)','metered_use_days','day (UTC day key); purposes.calls','metered_calls_by_day'),
 ('second','feed','RecordBook/77d8e62cf9 (own-records)','activity_g1','at; row.tool; row.agent','activity_feed_by_day, activity_feed_gaps'),
 ('second','bytes','all second-account objects','page_count * page_size','pragma page_count, page_size','object_bytes');

create table notes (pattern text, note text);
insert into notes values
 ('record_%', 'Counted from record_log envelopes. The log holds every write from the 2026-10-16 13:46 MDT cutover (rowid 1..N, no gaps in row ids), so 2026-10-17 and 2026-10-18 are true zero days (the account was parked). The founder own-records log is the only complete record-write history; the second account''s log keeps about one hour only.'),
 ('execution_creates_%', 'One execution record is one receipt per request. family tool = AI tool call; rest = REST agent plumbing (polling, presence, claims); internal = internal command receipt.'),
 ('log_rows', 'Rows in record_log; one row is one write transaction part.'),
 ('active_hours_%', 'Local clock hours (MDT) with at least one log row; user = a row with a user-content envelope; machinery = a row of machinery envelopes only. An AI writing a message counts as user content, so user hours are not the person''s hours; see person_message_active_hours.'),
 ('distinct_agents', 'Distinct actor_context.reader credential keys. Upper bound on AIs: the person''s own devices also hold keys.'),
 ('peak_agents_%', 'Maximum distinct reader keys writing in one clock hour or one 10-minute window.'),
 ('agent_hours', 'Count of (reader key, clock hour) pairs.'),
 ('agent_card%', 'Agent-card records are one per registered AI; a write is a presence, capacity or heartbeat update. Day 2026-10-22 shows a swarm of 382 cards touched and 49 in one 10-minute window; the cause (real swarm, test fixture or loop) is not identifiable from counts alone.'),
 ('tool_exec_%', 'Tool execution receipts (operation starts with tool:) in the log; the clean AI-tool-call count for the log window.'),
 ('messages_%', 'Conversation messages created (no prior). Class by speaker: person = typed by the person; voice = heard-voice labels. No ai-speaker messages appear in the log window.'),
 ('person_message_active_hours', 'Clock hours with at least one person-typed message: the closest measure of the person''s own active hours.'),
 ('gap_%', 'Seconds between consecutive log rows (all rows), whole span, gaps over one day dropped. 5 gaps over one hour in 376,973 gaps.'),
 ('gate_permits_all', 'One gate permit is one gated command, including screen reads. 2026-10-19 to 2026-10-22 are billing-incident days; 2026-10-15 to 2026-10-18 show only a mounted screen heartbeat (about 500 to 1,000 per day).'),
 ('gate_presentation_read', 'Screen reads: the only table that records reads. 2026-10-19 to 2026-10-22 hold 37,270 to 180,887 per day, a re-read loop of mounted screens (about 2 per second on 2026-10-20), not a person reading.'),
 ('gate_%', 'See gate_permits_all. Operation groups are exact operation names listed in the query.'),
 ('budget_permits_all', 'One budget permit is one bookkeeping request. 2026-10-22 and 2026-10-23 are dominated by shared-space bootstrap and lifecycle requests (budget_shared) and are loop traffic of the billing incident.'),
 ('budget_%', 'See budget_permits_all.'),
 ('ratio_budget_permits_per_gate_permit', 'Measured ratio varies from 0.0 to 1.3 per day; the simulation README uses 6 budget permits per gate permit (from a longer window).'),
 ('tasks_all', 'Workshop tasks by newest sort time. 2026-10-07 to 2026-10-12 hold the no-op loop tool.'),
 ('tasks_noop_loop_tool', 'tool:weigh-steps-ais-left-you, the no-op "A weigh is already running" runs: 384,527 of 476,050 founder tasks, 2026-10-07 to 2026-10-12.'),
 ('tasks_excluding_loop', 'All tasks except the no-op loop tool. Includes scheduled poll tools (calendar, mail, repository, payments listing) listed in tasks_poll_tools_excluding_loop.'),
 ('namespace_steps', 'Steps of namespace internal commands, dated by their task.'),
 ('files_stored', 'Files stored (uploaded or arrived). 2026-09-26 and 2026-09-27 are import days.'),
 ('file_%', 'See files_stored. namespace_moves holds one in-flight move and no history, so folder changes are recorded only as new name records.'),
 ('folders_total', 'Count of distinct folders (collections) in namespace_names, whole table.'),
 ('meter_%', 'Store requests per UTC day from metered_use_days (the stored key is a UTC day and cannot be shifted to MDT). Top-level purposes only.'),
 ('model_%', 'Model calls per UTC day from model_spend. 2026-10-05 to 2026-10-10 hold the paid-model loop (refused 177,871 on 2026-10-08).'),
 ('activity_%', 'AI tool uses shown in the activity feed. The founder feed keeps only the newest 7,000 rows (about 13 hours); the second account feed is complete.'),
 ('feed_gap_%', 'Seconds between consecutive activity-feed rows, whole span, gaps over one day dropped.'),
 ('gate_person_%', 'Gate gaps between person-screen commands (mount, subscribe, spend, put rows, tell, attention).'),
 ('gate_all_%', 'Gate gaps between any two gate permits.'),
 ('ratio_%', 'Ratio of two measured daily metrics, only on days where the denominator is above zero.'),
 ('object_bytes%', 'Sum of SQLite object sizes (page_count * page_size). The frozen retired PersonStore copy is listed separately.');

create table object_bytes (account text, object text, role text, bytes integer);
insert into object_bytes values
 ('founder','RecordBook/cdae20b0f3','own-records (o3)',10589802496),
 ('founder','RecordBook/dd58a43209','namespace (o4)',10537172992),
 ('founder','PersonStore/38230817ef','retired frozen copy (o2)',4427423744),
 ('founder','AccountControl/be804850ee','quota (o8)',2432622592),
 ('founder','AccountControl/a56a1218db','key gate (o21)',1905360896),
 ('founder','PersonWork/f6d085f210','search follower (o5)',917016576),
 ('founder','AccountControl/e8af73ba0b','original-work catalogue (o7)',62033920),
 ('founder','AccountControl/44375965bb','policy (o9)',48373760),
 ('founder','AccountControl/8211d5dac2','gate (o10)',180224),
 ('founder','AccountControl/f4f282cba2','gate (o20)',126976),
 ('founder','AccountControl/398a9682db','gate (o31)',126976),
 ('founder','AccountControl/b674c6b2dd','policy of the person (o33)',122880),
 ('second','RecordBook/77d8e62cf9','own-records (o26)',127234048),
 ('second','AccountControl/de90cb76b9','quota (o27)',27951104),
 ('second','RecordBook/649a4d18d6','namespace (o25)',15687680),
 ('second','PersonStore/1b625c0e1b','person store (o24)',3416064),
 ('second','AccountControl/6067c70c6e','original-work catalogue (o28)',233472),
 ('second','AccountControl/cef8763fd7','policy (o34)',159744);
insert into raw select account, 'bytes', 'object_bytes_total', 'all', sum(bytes) from object_bytes group by 1;
insert into raw select 'founder', 'bytes', 'object_bytes_without_retired_copy', 'all', sum(bytes) from object_bytes where account = 'founder' and role not like 'retired%';

-- daily series over each metric's window, zero filled except ratios and scalars
create table series as
with k as (select distinct account, family, metric from raw where day <> 'all' and day <> ''),
d as (
  select account, family, first_day as day, last_day from windows
  union all select account, family, date(day, '+1 day'), last_day from d where day < last_day
)
select k.account, k.family, k.metric, d.day,
       case when k.metric like 'ratio\_%' escape '\' then (select value from raw r where r.account = k.account and r.family = k.family and r.metric = k.metric and r.day = d.day)
            else coalesce((select sum(value) from raw r where r.account = k.account and r.family = k.family and r.metric = k.metric and r.day = d.day), 0) end as val
from k join d on d.account = k.account and d.family = k.family;
delete from series where val is null;

create table stats as
with r as (select *, row_number() over (partition by account, family, metric order by val) as rn, count(*) over (partition by account, family, metric) as n from series),
ra as (select *, row_number() over (partition by account, family, metric order by val) as rn, count(*) over (partition by account, family, metric) as n from series where val > 0)
select s.account, s.family, s.metric,
  (select count(*) from series x where x.account = s.account and x.family = s.family and x.metric = s.metric) as days_counted,
  (select min(val) from r where r.account = s.account and r.family = s.family and r.metric = s.metric and r.rn = (r.n * 10 + 99) / 100) as p10,
  (select min(val) from r where r.account = s.account and r.family = s.family and r.metric = s.metric and r.rn = (r.n * 50 + 99) / 100) as p50,
  (select min(val) from r where r.account = s.account and r.family = s.family and r.metric = s.metric and r.rn = (r.n * 90 + 99) / 100) as p90,
  (select max(val) from series x where x.account = s.account and x.family = s.family and x.metric = s.metric) as mx,
  (select count(*) from ra where ra.account = s.account and ra.family = s.family and ra.metric = s.metric) as days_active,
  (select min(val) from ra where ra.account = s.account and ra.family = s.family and ra.metric = s.metric and ra.rn = (ra.n * 50 + 99) / 100) as p50_active,
  (select min(val) from ra where ra.account = s.account and ra.family = s.family and ra.metric = s.metric and ra.rn = (ra.n * 90 + 99) / 100) as p90_active
from (select distinct account, family, metric from raw) s;

create table doc as
select json_object(
  'format','storage-sim-measured-activity/1',
  'source', json_object(
     'copy','real-current-account-closure-35 restored copy under the restore owner repository's (cloudflare-stop) .state folder (not the live account)',
     'span','2026-10-16 13:46 MDT to 2026-10-23 about 13:34 MDT (record_log 2026-10-16 13:46 to 2026-10-23 01:12 MDT; permits 2026-10-15 to 2026-10-23; task, file and model tables reach back to 2026-09-26)',
     'zone','MDT (UTC-6); days are local calendar days except the stored UTC day keys of metered_use_days and model_spend (marked per_utc_day)',
     'cloned_at','2026-10-28 09:58 MDT',
     'clone_owner','cloudflare-stop restore owner: scripts/local-restore-clone.mjs cloneRestoreFile (APFS clonefile)',
     'open_mode','sqlite3 file:<clone>?mode=ro&immutable=1',
     'percentile_rule','nearest rank over the metric''s complete local days (zero filled; see window); p50_active and p90_active use only days with value above zero; days at either edge of the data are partial and excluded from percentiles but kept in by_day',
     'caveat','2026-10-19 to 2026-10-23 are billing-incident days; the founder account was parked 2026-10-17 and 2026-10-18; the second account is nearly idle (two active days). Rates are not a typical seat.'),
  'accounts', json_group_array(json(a.acc))) as j
from (
  select json_object(
    'account', o.account,
    'objects', json((select json_group_array(json_object('object', b.object, 'role', b.role, 'bytes', b.bytes)) from object_bytes b where b.account = o.account)),
    'metrics', json((
      select json_group_array(json(m.obj)) from (
        select json_object(
          'name', case when st.family in ('ns_log','meter_ns','ns_tasks') and st.metric not like 'namespace\_%' escape '\' then 'namespace_' || st.metric else st.metric end,
          'unit', case when st.metric like '%\_hours%' escape '\' or st.metric like 'active\_hours%' escape '\' then 'hours_per_day'
                       when st.metric like 'meter:%' or st.metric like 'meter\_%' escape '\' or st.family in ('model') then 'per_utc_day'
                       when st.metric like 'ratio\_%' escape '\' then 'ratio_per_day'
                       when st.metric like '%\_gap\_%s' escape '\' then 'seconds'
                       when st.metric like '%\_gap\_gt\_%' escape '\' or st.metric like '%\_gap\_count' escape '\' then 'count_whole_span'
                       when st.metric like 'object\_bytes%' escape '\' then 'bytes'
                       when st.metric like 'folders\_total' or st.metric like 'names\_total' or st.metric like 'files\_total' then 'count_whole_table'
                       when st.metric like 'file\_bytes%' escape '\' then 'bytes_per_day'
                       when st.metric like '%peak%' or st.metric like 'distinct\_%' escape '\' or st.metric like '%\_callers%' escape '\' or st.metric like 'agent\_cards\_%' escape '\' or st.metric like 'activity\_distinct%' escape '\' then 'count_per_day'
                       else 'per_day' end,
          'by_day', json((select json_group_object(r.day, r.value) from raw r where r.account = st.account and r.family = st.family and r.metric = st.metric and r.day <> '')),
          'complete_days', (select w.first_day || '..' || w.last_day from windows w where w.account = st.account and w.family = st.family),
          'days_counted', st.days_counted, 'p10', st.p10, 'p50', st.p50, 'p90', st.p90, 'max', st.mx,
          'days_active', st.days_active, 'p50_active', st.p50_active, 'p90_active', st.p90_active,
          'partial_days_excluded', (select w.partial from windows w where w.account = st.account and w.family = st.family),
          'source', json_object('object', (select s.object from sources s where s.account = st.account and s.family = st.family), 'table', (select s.tbl from sources s where s.account = st.account and s.family = st.family), 'column', (select s.col from sources s where s.account = st.account and s.family = st.family), 'query', 'measure-activity.sql: ' || (select s.query from sources s where s.account = st.account and s.family = st.family)),
          'note', (select n.note from notes n where st.metric like n.pattern order by length(n.pattern) desc limit 1)
        ) as obj
        from stats st where st.account = o.account order by st.family, st.metric
      ) m))
  ) as acc
  from (select distinct account from raw) o order by o.account
) a;
select json(j) from doc;
