use bytes::Bytes;
use serde_json::{json, Value};
use slot_protocol::ActorContext;
use std::sync::{Arc, Mutex};
use workflow_core::executor::context::{DirectReadResult, OutsideAccess};
use workflow_core::{
    AsyncWorkflowExecutor, CachedDefinitionStore, Definition, ExecutionStatus, RetryPolicy,
    StartData, Step, StepEdge,
};

#[derive(Default)]
struct Probe(Mutex<Vec<String>>);
#[async_trait::async_trait]
impl OutsideAccess for Probe {
    async fn ask(
        &self,
        name: &str,
        _: &slot_protocol::PartitionKey,
        _: Bytes,
        _: Option<Bytes>,
    ) -> Result<Arc<[u8]>, String> {
        self.0.lock().unwrap().push(name.to_string());
        Ok(Arc::from(
            serde_json::to_vec(&json!({"ok": true}))
                .unwrap()
                .into_boxed_slice(),
        ))
    }
    async fn read(
        &self,
        _: &str,
        _: &slot_protocol::PartitionKey,
    ) -> Result<DirectReadResult, String> {
        Ok(DirectReadResult {
            bytes: Arc::from(Vec::<u8>::new().into_boxed_slice()),
            content_hash: "t14".into(),
        })
    }
}

fn definition(id: &str, topology: &str) -> Definition {
    let names: Vec<&str> = match topology {
        "one" => vec!["a"],
        "serial" | "repeat" | "self" | "nested" => vec!["a", "b", "c"],
        "diamond" | "shared" => vec!["a", "b", "c", "d"],
        _ => vec!["a", "b", "c"],
    };
    let mut steps: Vec<Step> = names
        .iter()
        .map(|step_id| {
            Step::new(
                step_id,
                "ask",
                json!({"name":format!("t14.probe:{step_id}"),"input":{}}),
            )
        })
        .collect();
    if topology == "fan-in" || topology == "diamond" || topology == "shared" {
        steps.last_mut().unwrap().join = "all".into();
    }
    let edges = match topology {
        "one" | "parallel" => vec![],
        "serial" | "repeat" | "self" | "nested" => vec![edge("a", "b"), edge("b", "c")],
        "fan-out" => vec![edge("a", "b"), edge("a", "c")],
        "fan-in" => vec![edge("a", "c"), edge("b", "c")],
        "diamond" | "shared" => vec![
            edge("a", "b"),
            edge("a", "c"),
            edge("b", "d"),
            edge("c", "d"),
        ],
        _ => vec![],
    };
    Definition {
        id: id.into(),
        partition_key: "partition:t14".into(),
        kind: "workflow".into(),
        name: id.into(),
        description: String::new(),
        input_schema: json!({}),
        steps,
        edges,
        trigger_type: Default::default(),
        trigger_source: String::new(),
        is_active: true,
        version: 1,
        extra: Value::Null,
        extra_properties: Default::default(),
    }
}
fn edge(from: &str, to: &str) -> StepEdge {
    StepEdge {
        from: from.into(),
        to: to.into(),
        kind: "always".into(),
        config: Value::Null,
    }
}

#[tokio::test]
async fn t14_actual_dag_topology_corpus_uses_async_executor_and_probe() {
    for topology in [
        "one", "serial", "parallel", "fan-out", "fan-in", "repeat", "self", "diamond", "nested",
        "shared",
    ] {
        let store = Arc::new(CachedDefinitionStore::new());
        let def = definition(&format!("t14:{topology}"), topology);
        let expected_steps = def.steps.len();
        store.insert_definition(def.clone());
        let probe = Arc::new(Probe::default());
        let executor = AsyncWorkflowExecutor::new(
            "partition:t14",
            slot_protocol::PartitionKey::hash_from("partition:t14"),
            probe.clone(),
            store,
            execution_types::ProductWordIds::new("example").expect("valid product word"),
        );
        let run = executor
            .execute_definition(
                def,
                StartData::default(),
                ActorContext::new("t14"),
                &RetryPolicy::default(),
            )
            .await
            .expect(topology);
        assert_eq!(run.status, ExecutionStatus::Completed, "{topology}");
        let calls = probe.0.lock().unwrap();
        assert_eq!(calls.len(), expected_steps, "{topology} exact step count");
        assert!(
            calls.iter().all(|call| call.starts_with("t14.probe:")),
            "{topology} exact probe identity"
        );
    }
}

#[tokio::test]
async fn t14_generated_graph_corpus_reaches_workflow_core() {
    let Some(path) = std::env::var_os("T14_GRAPH_CORPUS") else {
        return;
    };
    let corpus: Vec<Value> =
        serde_json::from_slice(&std::fs::read(path).expect("T14 corpus readback"))
            .expect("T14 corpus JSON");
    assert!(
        !corpus.is_empty(),
        "generated corpus must contain a replayable graph"
    );
    for graph in corpus {
        let case_id = graph["caseId"].as_str().expect("case identity");
        let topology = graph["topology"].as_str().expect("topology");
        let mut def = definition(case_id, topology);
        let store = Arc::new(CachedDefinitionStore::new());
        let expected_probe_count = if topology == "repeat"
            || topology == "self-compose"
            || topology == "shared-dependency"
        {
            2
        } else if topology == "nested-surface"
            || topology == "nested-experience"
            || topology == "nested"
        {
            1
        } else {
            def.steps.len()
        };
        if topology == "repeat" || topology == "self-compose" {
            let child_id = format!("{case_id}:repeat-child");
            store.insert_definition(definition(&child_id, "one"));
            def.steps = vec![Step::new(
                "repeat",
                "loop",
                json!({"definition_id":child_id, "source":{"$kind":"binding", "select":{"from":"input", "path":"items"}}, "item_var":"item", "max_iterations":2, "parallel":false}),
            )];
            def.edges.clear();
        } else if topology == "nested-surface"
            || topology == "nested-experience"
            || topology == "nested"
        {
            let child_id = format!("{case_id}:nested-child");
            store.insert_definition(definition(&child_id, "one"));
            def.steps = vec![Step::new(
                "nested",
                "action",
                json!({"definition_id":child_id, "definition_refs":[child_id], "inputs":{}}),
            )];
            def.edges.clear();
        } else if topology == "shared-dependency" {
            let child_id = format!("{case_id}:shared-child");
            store.insert_definition(definition(&child_id, "one"));
            def.steps = vec![
                Step::new(
                    "left-consumer",
                    "action",
                    json!({"definition_id":child_id, "definition_refs":[child_id], "inputs":{}}),
                ),
                Step::new(
                    "right-consumer",
                    "action",
                    json!({"definition_id":child_id, "definition_refs":[child_id], "inputs":{}}),
                ),
            ];
            def.edges.clear();
        }
        store.insert_definition(def.clone());
        let probe = Arc::new(Probe::default());
        let executor = AsyncWorkflowExecutor::new(
            "partition:t14",
            slot_protocol::PartitionKey::hash_from("partition:t14"),
            probe.clone(),
            store,
            execution_types::ProductWordIds::new("example").expect("valid product word"),
        );
        let mut start = StartData::default();
        if topology == "repeat" || topology == "self-compose" {
            start.input = json!({"items":[1,2]});
        }
        let result = executor
            .execute_definition(
                def,
                start,
                ActorContext::new("t14"),
                &RetryPolicy::default(),
            )
            .await;
        let instance = result.expect("canonical workflow invocation");
        assert_eq!(
            instance.status,
            ExecutionStatus::Completed,
            "{case_id} ({topology}) failed: {:?}",
            instance.error_message
        );
        let calls = probe.0.lock().unwrap();
        assert_eq!(
            calls.len(),
            expected_probe_count,
            "{case_id} ({topology}) exact owner probe count"
        );
        assert!(
            calls.iter().all(|call| call.starts_with("t14.probe:")),
            "{case_id} ({topology}) owner identity"
        );
    }
}

async fn execute(
    def: Definition,
) -> Result<workflow_core::domain::WorkflowInstance, workflow_core::domain::errors::WorkflowError> {
    let store = Arc::new(CachedDefinitionStore::new());
    store.insert_definition(def.clone());
    let executor = AsyncWorkflowExecutor::new(
        "partition:t14",
        slot_protocol::PartitionKey::hash_from("partition:t14"),
        Arc::new(Probe::default()),
        store,
        execution_types::ProductWordIds::new("example").expect("valid product word"),
    );
    executor
        .execute_definition(
            def,
            StartData::default(),
            ActorContext::new("t14"),
            &RetryPolicy::default(),
        )
        .await
}

#[tokio::test]
async fn t14_invalid_or_retracted_definitions_fail_closed_before_a_completed_dag() {
    let mut cycle = definition("t14:cycle", "serial");
    cycle.edges = vec![edge("a", "b"), edge("b", "a")];
    assert!(
        execute(cycle).await.is_err(),
        "cycle must be rejected before execution"
    );
    let mut missing = definition("t14:missing", "serial");
    missing.edges = vec![edge("a", "absent")];
    assert!(
        execute(missing).await.is_err(),
        "missing target must be rejected before execution"
    );
    let mut duplicate = definition("t14:duplicate", "serial");
    duplicate.steps[1].id = "a".into();
    assert!(
        execute(duplicate).await.is_err(),
        "duplicate step identity must be rejected before execution"
    );
    let mut retracted = definition("t14:retracted", "one");
    retracted.is_active = false;
    assert!(
        execute(retracted).await.is_err(),
        "retracted/inactive definition cannot execute"
    );
}

#[tokio::test]
async fn t14_nested_action_uses_definition_store_and_preserves_child_probe_identity() {
    let store = Arc::new(CachedDefinitionStore::new());
    let child = definition("t14:child", "one");
    store.insert_definition(child);
    let mut parent = definition("t14:parent", "one");
    parent.steps = vec![Step::new(
        "call-child",
        "action",
        json!({"definition_id":"t14:child", "definition_refs":["t14:child"], "inputs":{}}),
    )];
    let probe = Arc::new(Probe::default());
    let executor = AsyncWorkflowExecutor::new(
        "partition:t14",
        slot_protocol::PartitionKey::hash_from("partition:t14"),
        probe.clone(),
        store,
        execution_types::ProductWordIds::new("example").expect("valid product word"),
    );
    let result = executor
        .execute_definition(
            parent,
            StartData::default(),
            ActorContext::new("t14"),
            &RetryPolicy::default(),
        )
        .await
        .expect("nested action");
    assert_eq!(result.status, ExecutionStatus::Completed);
    assert_eq!(probe.0.lock().unwrap().as_slice(), ["t14.probe:a"]);
}

#[tokio::test]
async fn t14_repeat_loop_uses_owner_defined_termination_and_child_definition() {
    let store = Arc::new(CachedDefinitionStore::new());
    store.insert_definition(definition("t14:loop-child", "one"));
    let mut parent = definition("t14:loop-parent", "one");
    parent.steps = vec![Step::new(
        "repeat",
        "loop",
        json!({"definition_id":"t14:loop-child", "source":{"$kind":"binding", "select":{"from":"input", "path":"items"}}, "item_var":"item", "max_iterations":3, "parallel":false}),
    )];
    let probe = Arc::new(Probe::default());
    let executor = AsyncWorkflowExecutor::new(
        "partition:t14",
        slot_protocol::PartitionKey::hash_from("partition:t14"),
        probe.clone(),
        store,
        execution_types::ProductWordIds::new("example").expect("valid product word"),
    );
    let start = StartData {
        input: json!({"items":[1,2,3]}),
        ..Default::default()
    };
    let result = executor
        .execute_definition(
            parent,
            start,
            ActorContext::new("t14"),
            &RetryPolicy::default(),
        )
        .await
        .expect("bounded loop");
    assert_eq!(result.status, ExecutionStatus::Completed);
    assert_eq!(
        probe.0.lock().unwrap().len(),
        3,
        "each bounded item executes child once"
    );
}
