//! Optional invocation-local work accounting over the existing execution boundary.
//! No run state or authored data carries this meter. Legacy public context and
//! error layouts remain unchanged. These units are dispatches, iterations and
//! action ancestry; they are not instruction fuel or a total memory bound.
use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};
use crate::{domain::{WorkflowError, PendingWrite}, executor::context::{OutsideAccess, DirectReadResult}};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedRunLimits {
    pub max_step_attempts: usize,
    pub max_loop_iterations: usize,
    pub max_action_depth: usize,
}
impl BoundedRunLimits {
    pub fn validate(self) -> Result<Self, WorkflowError> {
        if [self.max_step_attempts, self.max_loop_iterations, self.max_action_depth].contains(&0) {
            return Err(WorkflowError::ResourcePolicyInvalid {
                reason: "bounded execution limits must all be positive".into(),
                field: "bounded_run_limits".into(),
            });
        }
        Ok(self)
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedRunUsage {
    pub step_attempts: usize,
    pub loop_iterations: usize,
    pub action_depth: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BudgetExceeded {
    pub code: &'static str,
    pub dimension: String,
    pub attempted: usize,
    pub limit: usize,
    pub overflow: bool,
    pub step_attempts_used: usize,
    pub loop_iterations_used: usize,
    pub action_depth_used: usize,
}

/// An additive bounded API error, leaving exhaustive legacy error matches intact.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum BoundedExecutionError {
    Workflow(WorkflowError),
    Budget(BudgetExceeded),
}
impl From<WorkflowError> for BoundedExecutionError {
    fn from(error: WorkflowError) -> Self { Self::Workflow(error) }
}
impl std::fmt::Display for BoundedExecutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Workflow(error) => std::fmt::Display::fmt(error, f),
            Self::Budget(error) => write!(f, "{}: {} attempted {}, limit {}", error.code, error.dimension, error.attempted, error.limit),
        }
    }
}
impl std::error::Error for BoundedExecutionError {}

#[derive(Default)]
struct State { usage: BoundedRunUsage, exhausted: Option<BudgetExceeded> }

/// One shared ephemeral meter, retained by a bounded invocation's dependency edge.
pub struct RunBudget { limits: BoundedRunLimits, state: Mutex<State> }
impl RunBudget {
    pub(crate) fn new(limits: BoundedRunLimits) -> Self {
        Self { limits, state: Mutex::new(State::default()) }
    }
    pub(crate) fn usage(&self) -> BoundedRunUsage {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).usage
    }
    pub(crate) fn refusal(&self) -> Option<BudgetExceeded> {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).exhausted.clone()
    }
    pub(crate) fn is_exhausted(&self) -> bool {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).exhausted.is_some()
    }
    fn execution_error(error: &BudgetExceeded) -> WorkflowError {
        WorkflowError::ExecutionFailed {
            reason: format!("{}: {} attempted {}, limit {}", error.code, error.dimension, error.attempted, error.limit),
            hint: "The host-owned invocation allowance is exhausted".into(),
        }
    }
    fn refuse(state: &mut State, dimension: &'static str, attempted: usize, limit: usize, overflow: bool) -> WorkflowError {
        let used = state.usage;
        let error = state.exhausted.get_or_insert_with(|| BudgetExceeded {
            code: "FE_RUN_BUDGET_EXCEEDED", dimension: dimension.into(), attempted, limit, overflow,
            step_attempts_used: used.step_attempts,
            loop_iterations_used: used.loop_iterations,
            action_depth_used: used.action_depth,
        });
        Self::execution_error(error)
    }
    pub(crate) fn reserve(&self, dimension: &'static str, amount: usize) -> Result<(), WorkflowError> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(error) = &state.exhausted { return Err(Self::execution_error(error)); }
        let (current, limit) = match dimension {
            "step_attempts" => (state.usage.step_attempts, self.limits.max_step_attempts),
            "loop_iterations" => (state.usage.loop_iterations, self.limits.max_loop_iterations),
            _ => return Err(WorkflowError::ResourcePolicyInvalid { field: "budget_dimension".into(), reason: "unknown execution dimension".into() }),
        };
        let Some(attempted) = current.checked_add(amount) else {
            return Err(Self::refuse(&mut state, dimension, usize::MAX, limit, true));
        };
        if attempted > limit { return Err(Self::refuse(&mut state, dimension, attempted, limit, false)); }
        if dimension == "step_attempts" { state.usage.step_attempts = attempted; }
        else { state.usage.loop_iterations = attempted; }
        Ok(())
    }
    pub(crate) fn enter_action(&self, parent_depth: usize) -> Result<(), WorkflowError> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(error) = &state.exhausted { return Err(Self::execution_error(error)); }
        let Some(attempted) = parent_depth.checked_add(1) else {
            return Err(Self::refuse(&mut state, "action_depth", usize::MAX, self.limits.max_action_depth, true));
        };
        if attempted > self.limits.max_action_depth {
            return Err(Self::refuse(&mut state, "action_depth", attempted, self.limits.max_action_depth, false));
        }
        state.usage.action_depth = state.usage.action_depth.max(attempted);
        Ok(())
    }
}

/// All outside-work behavior is delegated unchanged. Only the bounded invocation
/// adds a meter, shared through ordinary dependency cloning without a registry.
pub(crate) struct BudgetedAccess { inner: Arc<dyn OutsideAccess>, budget: Arc<RunBudget> }
impl BudgetedAccess {
    pub(crate) fn new(inner: Arc<dyn OutsideAccess>, budget: Arc<RunBudget>) -> Self { Self { inner, budget } }
}
#[async_trait::async_trait]
impl OutsideAccess for BudgetedAccess {
    fn run_budget(&self) -> Option<&RunBudget> { Some(&self.budget) }
    async fn store_immutable_content(&self, partition: &slot_protocol::PartitionKey, content: Arc<[u8]>) -> Result<slot_protocol::ImmutableContentRef, String> {
        self.inner.store_immutable_content(partition, content).await
    }
    async fn ask_immutable_content(&self, name: &str, partition: &slot_protocol::PartitionKey, payload: bytes::Bytes, context: Option<bytes::Bytes>) -> Result<slot_protocol::ImmutableContentRef, String> {
        self.inner.ask_immutable_content(name, partition, payload, context).await
    }
    async fn ask(&self, name: &str, partition: &slot_protocol::PartitionKey, payload: bytes::Bytes, context: Option<bytes::Bytes>) -> Result<Arc<[u8]>, String> {
        self.inner.ask(name, partition, payload, context).await
    }
    async fn ask_with_pending_writes(&self, name: &str, partition: &slot_protocol::PartitionKey, payload: bytes::Bytes, context: Option<bytes::Bytes>, pending: &[PendingWrite]) -> Result<Arc<[u8]>, String> {
        self.inner.ask_with_pending_writes(name, partition, payload, context, pending).await
    }
    async fn ask_immutable_content_with_pending_writes(&self, name: &str, partition: &slot_protocol::PartitionKey, payload: bytes::Bytes, context: Option<bytes::Bytes>, pending: &[PendingWrite]) -> Result<slot_protocol::ImmutableContentRef, String> {
        self.inner.ask_immutable_content_with_pending_writes(name, partition, payload, context, pending).await
    }
    async fn read(&self, from: &str, partition: &slot_protocol::PartitionKey) -> Result<DirectReadResult, String> {
        self.inner.read(from, partition).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Distinct;
    #[async_trait::async_trait]
    impl OutsideAccess for Distinct {
        async fn store_immutable_content(&self, _: &slot_protocol::PartitionKey, _: Arc<[u8]>) -> Result<slot_protocol::ImmutableContentRef, String> { Err("original-store".into()) }
        async fn ask_immutable_content(&self, _: &str, _: &slot_protocol::PartitionKey, _: bytes::Bytes, _: Option<bytes::Bytes>) -> Result<slot_protocol::ImmutableContentRef, String> { Err("original-immutable".into()) }
        async fn ask(&self, _: &str, _: &slot_protocol::PartitionKey, _: bytes::Bytes, _: Option<bytes::Bytes>) -> Result<Arc<[u8]>, String> { Err("original-ask".into()) }
        async fn ask_with_pending_writes(&self, _: &str, _: &slot_protocol::PartitionKey, _: bytes::Bytes, _: Option<bytes::Bytes>, _: &[PendingWrite]) -> Result<Arc<[u8]>, String> { Err("original-pending".into()) }
        async fn ask_immutable_content_with_pending_writes(&self, _: &str, _: &slot_protocol::PartitionKey, _: bytes::Bytes, _: Option<bytes::Bytes>, _: &[PendingWrite]) -> Result<slot_protocol::ImmutableContentRef, String> { Err("original-pending-immutable".into()) }
        async fn read(&self, _: &str, _: &slot_protocol::PartitionKey) -> Result<DirectReadResult, String> { Err("original-read".into()) }
    }
    #[tokio::test]
    async fn invocation_meter_preserves_every_supplied_outside_route() {
        let budget = Arc::new(RunBudget::new(BoundedRunLimits { max_step_attempts: 1, max_loop_iterations: 1, max_action_depth: 1 }));
        let access = BudgetedAccess::new(Arc::new(Distinct), budget);
        let partition = slot_protocol::PartitionKey::hash_from("example");
        assert_eq!(access.store_immutable_content(&partition, Arc::from(&b"x"[..])).await.err().unwrap(), "original-store");
        assert_eq!(access.ask_immutable_content("x", &partition, bytes::Bytes::new(), None).await.err().unwrap(), "original-immutable");
        assert_eq!(access.ask("x", &partition, bytes::Bytes::new(), None).await.err().unwrap(), "original-ask");
        assert_eq!(access.ask_with_pending_writes("x", &partition, bytes::Bytes::new(), None, &[]).await.err().unwrap(), "original-pending");
        assert_eq!(access.ask_immutable_content_with_pending_writes("x", &partition, bytes::Bytes::new(), None, &[]).await.err().unwrap(), "original-pending-immutable");
        assert_eq!(access.read("x", &partition).await.err().unwrap(), "original-read");
        assert_eq!(access.run_budget().unwrap().usage(), BoundedRunUsage::default());
    }
    #[test]
    fn checked_counter_overflow_stays_sticky_across_dimensions() {
        let budget = RunBudget::new(BoundedRunLimits { max_step_attempts: usize::MAX, max_loop_iterations: usize::MAX, max_action_depth: usize::MAX });
        budget.reserve("step_attempts", usize::MAX).unwrap();
        assert!(budget.reserve("step_attempts", 1).is_err());
        let first = budget.refusal().unwrap();
        assert!(first.overflow);
        assert_eq!(first.limit, usize::MAX);
        assert!(budget.reserve("loop_iterations", 1).is_err());
        assert_eq!(budget.refusal().unwrap(), first);
    }
    #[test]
    fn checked_depth_overflow_does_not_admit_a_descendant() {
        let budget = RunBudget::new(BoundedRunLimits { max_step_attempts: 1, max_loop_iterations: 1, max_action_depth: usize::MAX });
        assert!(budget.enter_action(usize::MAX).is_err());
        let failure = budget.refusal().unwrap();
        assert!(failure.overflow);
        assert_eq!(failure.dimension, "action_depth");
        assert_eq!(budget.usage().action_depth, 0);
    }
}
