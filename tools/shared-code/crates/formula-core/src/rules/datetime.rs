//! DateTime RewriteRules for the Formula Engine Solver
//!
//! This module implements datetime operations for the Formula Engine:
//! - DATE(year, month, day) -> Date
//! - TIME(hour, minute, second) -> Time
//! - DATETIME(date, time) -> DateTime
//! - NOW() -> DateTime (current timestamp)
//! - TODAY() -> Date (current date)
//! - YEAR/MONTH/DAY/HOUR/MINUTE/SECOND extractors
//! - DATEADD/DATEDIFF for date arithmetic
//! - WEEKDAY, WEEKNUM, ISOWEEKNUM for week calculations
//! - FORMAT_DATE for date formatting
//! - USER_TZ() -> String (user's configured timezone)
//!
//! # ops-core Delegation
//!
//! Most datetime rules delegate to ops-core for pure date/time operations.
//!
//! **Exceptions that cannot delegate**:
//! - `NowRule` / `TodayRule`: Require `EvaluationContext.now_timestamp` for deterministic
//!   timestamps (frozen at evaluation start for consistency)
//! - `UserTzRule`: Requires `EvaluationContext.user_timezone` for user's configured timezone
//!
//! See `rules/README.md` for the full delegation pattern documentation.

use crate::rules::{
    ErrorKind, RewriteRule, RuleCostModel, RuleError, RuleProperties, SolverContext,
};
use crate::{Hyperedge, Manifold, Node, NodeId, Value};
use ops_core::{EvalContext, OpError, OpValue};

// --- ops-core Integration Helpers ---

/// Convert ops-core OpError to formula-engine RuleError
fn op_error_to_rule_error(e: OpError) -> RuleError {
    match &e {
        OpError::TypeMismatch {
            expected, actual, ..
        } => RuleError::ConstraintViolation(ErrorKind::TypeMismatch {
            expected: expected.clone(),
            found: actual.clone(),
        }),
        OpError::NumericOverflow { .. } => {
            RuleError::ConstraintViolation(ErrorKind::ArithmeticOverflow)
        }
        OpError::InvalidArgument { reason, .. } => {
            RuleError::ConstraintViolation(ErrorKind::InvalidArgument(reason.clone()))
        }
        _ => RuleError::ConstraintViolation(ErrorKind::InvalidArgument(e.to_string())),
    }
}

/// Convert formula-engine Value to ops-core OpValue
fn to_op_value(val: &Value) -> OpValue {
    OpValue::from(val.inner().clone())
}

/// Convert ops-core OpValue to formula-engine Value
fn from_op_value(op_val: OpValue) -> Value {
    Value(op_val.into_inner())
}

/// Create default EvalContext for ops-core operations
fn default_ctx() -> EvalContext {
    EvalContext::default()
}

/// Get a resolved value from manifold as OpValue
fn get_op_value(manifold: &Manifold, node_id: NodeId) -> Result<OpValue, RuleError> {
    match manifold.get_node(node_id) {
        Some(Node::Ready(val)) => Ok(to_op_value(val)),
        Some(Node::Pending) => Ok(OpValue::null()),
        None => Err(RuleError::PatternMismatch),
    }
}

// --- Context-Aware Rules (Cannot delegate to ops-core) ---

// NOW and USERTZ require EvaluationContext for deterministic behavior
// They have special `rewrite_with_context` methods and their standard
// `rewrite` implementations return errors requiring context.

use chrono::{TimeZone, Utc};
use chrono_tz::Tz;
use std::str::FromStr;

/// Parse timezone string with proper error handling.
fn parse_tz(s: &str) -> Result<Tz, RuleError> {
    Tz::from_str(s).map_err(|_| {
        RuleError::ConstraintViolation(ErrorKind::InvalidArgument(format!(
            "Unknown or unsupported timezone: {}",
            s
        )))
    })
}

/// Format datetime to RFC3339 string.
fn to_rfc3339<T: TimeZone>(dt: chrono::DateTime<T>) -> String
where
    T::Offset: std::fmt::Display,
{
    dt.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true)
}

/// Convert UTC datetime to specified timezone.
fn utc_to_tz(utc: chrono::DateTime<Utc>, tz: Tz) -> chrono::DateTime<Tz> {
    tz.from_utc_datetime(&utc.naive_utc())
}

/// Safely extracts a resolved string value from a node.
fn get_resolved_string(manifold: &Manifold, node_id: NodeId) -> Result<Option<String>, RuleError> {
    match manifold.get_node(node_id) {
        Some(Node::Ready(val)) => {
            if val.is_null() {
                return Ok(None);
            }
            val.inner()
                .as_str()
                .map(|s| Some(s.to_string()))
                .ok_or_else(|| {
                    RuleError::ConstraintViolation(ErrorKind::TypeMismatch {
                        expected: "string".into(),
                        found: val.type_name().into(),
                    })
                })
        }
        _ => Err(RuleError::PatternMismatch),
    }
}

/// NOW([timezone]) -> RFC3339 string in the provided timezone (or UTC)
pub struct NowRule;
impl NowRule {
    // Special context-aware rewrite method
    pub fn rewrite_with_context(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        ctx: &crate::context::EvaluationContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() > 1 {
            return Err(RuleError::PatternMismatch);
        }

        // Use the deterministic time from the context
        let deterministic_now = *ctx.get_deterministic_now();

        let result = if edge.input_nodes.len() == 1 {
            let tz_opt = get_resolved_string(manifold, edge.input_nodes[0])?;
            match tz_opt {
                Some(tz_str) => {
                    let tz = parse_tz(&tz_str)?;
                    Value::string(to_rfc3339(utc_to_tz(deterministic_now, tz)))
                }
                None => Value::null(),
            }
        } else {
            Value::string(to_rfc3339(deterministic_now))
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }
        Ok(())
    }
}
impl RewriteRule for NowRule {
    fn pattern(&self) -> &str {
        "Now([timezone])"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: false, // Current time changes
            is_idempotent: false,
            reduces_graph: true,
            max_cost_ops: 50,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        self.rewrite_with_context(manifold, edge, ctx.evaluation_context)
    }
}

/// USERTZ() -> IANA timezone string from context
pub struct UserTzRule;
impl UserTzRule {
    // Special context-aware rewrite method
    pub fn rewrite_with_context(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        ctx: &crate::context::EvaluationContext,
    ) -> Result<(), RuleError> {
        if !edge.input_nodes.is_empty() {
            return Err(RuleError::PatternMismatch);
        }

        let user_timezone = ctx.get_user_timezone();
        let result = Value::string(user_timezone);

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }
        Ok(())
    }
}
impl RewriteRule for UserTzRule {
    fn pattern(&self) -> &str {
        "UserTz()"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 25,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        self.rewrite_with_context(manifold, edge, ctx.evaluation_context)
    }
}

// --- Standard DateTime Rules (Delegated to ops-core) ---

/// DATE(year, month, day) -> "YYYY-MM-DD"
/// Delegates to ops_core::datetime::make_date
pub struct DateRule;
impl RewriteRule for DateRule {
    fn pattern(&self) -> &str {
        "Date(year, month, day)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 100,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 3 {
            return Err(RuleError::PatternMismatch);
        }

        let op_year = get_op_value(manifold, edge.input_nodes[0])?;
        let op_month = get_op_value(manifold, edge.input_nodes[1])?;
        let op_day = get_op_value(manifold, edge.input_nodes[2])?;

        let result = ops_core::datetime::make_date(&op_year, &op_month, &op_day, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// TIME(hour, minute, second, [millisecond]) -> "HH:MM:SS(.mmm)"
/// Delegates to ops_core::datetime::make_time
pub struct TimeRule;
impl RewriteRule for TimeRule {
    fn pattern(&self) -> &str {
        "Time(hour, minute, second, [millisecond])"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 100,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if !(edge.input_nodes.len() == 3 || edge.input_nodes.len() == 4) {
            return Err(RuleError::PatternMismatch);
        }

        let op_hour = get_op_value(manifold, edge.input_nodes[0])?;
        let op_minute = get_op_value(manifold, edge.input_nodes[1])?;
        let op_second = get_op_value(manifold, edge.input_nodes[2])?;

        // ops-core make_time doesn't support milliseconds, so we use basic make_time
        let result =
            ops_core::datetime::make_time(&op_hour, &op_minute, &op_second, &default_ctx())
                .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// DATEADD(datetime, amount, unit) -> RFC3339 string
/// Delegates to ops_core::datetime::date_add
pub struct DateAddRule;
impl RewriteRule for DateAddRule {
    fn pattern(&self) -> &str {
        "DateAdd(datetime, amount, unit)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: false,
            reduces_graph: true,
            max_cost_ops: 200,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 3 {
            return Err(RuleError::PatternMismatch);
        }

        let op_datetime = get_op_value(manifold, edge.input_nodes[0])?;
        let op_amount = get_op_value(manifold, edge.input_nodes[1])?;
        let op_unit = get_op_value(manifold, edge.input_nodes[2])?;

        let result =
            ops_core::datetime::date_add(&op_datetime, &op_amount, &op_unit, &default_ctx())
                .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// YEAR(date_or_datetime) -> number
/// Delegates to ops_core::datetime::extract with unit "year"
pub struct YearRule;
impl RewriteRule for YearRule {
    fn pattern(&self) -> &str {
        "Year(date_or_datetime)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 50,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_datetime = get_op_value(manifold, edge.input_nodes[0])?;
        let result =
            ops_core::datetime::extract(&op_datetime, &OpValue::string("year"), &default_ctx())
                .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// MONTH(date_or_datetime) -> number
/// Delegates to ops_core::datetime::extract with unit "month"
pub struct MonthRule;
impl RewriteRule for MonthRule {
    fn pattern(&self) -> &str {
        "Month(date_or_datetime)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 50,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_datetime = get_op_value(manifold, edge.input_nodes[0])?;
        let result =
            ops_core::datetime::extract(&op_datetime, &OpValue::string("month"), &default_ctx())
                .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// DAY(date_or_datetime) -> number
/// Delegates to ops_core::datetime::extract with unit "day"
pub struct DayRule;
impl RewriteRule for DayRule {
    fn pattern(&self) -> &str {
        "Day(date_or_datetime)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 50,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_datetime = get_op_value(manifold, edge.input_nodes[0])?;
        let result =
            ops_core::datetime::extract(&op_datetime, &OpValue::string("day"), &default_ctx())
                .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// TIMESTAMP(datetime) -> number (milliseconds since epoch)
/// Delegates to ops_core::datetime::timestamp
pub struct TimestampRule;
impl RewriteRule for TimestampRule {
    fn pattern(&self) -> &str {
        "Timestamp(datetime)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 75,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_datetime = get_op_value(manifold, edge.input_nodes[0])?;
        let result = ops_core::datetime::timestamp(&op_datetime, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// FROM_TIMESTAMP(milliseconds, [timezone]) -> RFC3339 string
/// Delegates to ops_core::datetime::from_timestamp or from_timestamp_tz
pub struct FromTimestampRule;
impl RewriteRule for FromTimestampRule {
    fn pattern(&self) -> &str {
        "FromTimestamp(milliseconds, [timezone])"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 100,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if !(edge.input_nodes.len() == 1 || edge.input_nodes.len() == 2) {
            return Err(RuleError::PatternMismatch);
        }

        let op_ms = get_op_value(manifold, edge.input_nodes[0])?;

        let result = if edge.input_nodes.len() == 2 {
            let op_tz = get_op_value(manifold, edge.input_nodes[1])?;
            ops_core::datetime::from_timestamp_tz(&op_ms, &op_tz, &default_ctx())
                .map_err(op_error_to_rule_error)?
        } else {
            ops_core::datetime::from_timestamp(&op_ms, &default_ctx())
                .map_err(op_error_to_rule_error)?
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// HOUR(datetime) -> number
/// Delegates to ops_core::datetime::extract with unit "hour"
pub struct HourRule;
impl RewriteRule for HourRule {
    fn pattern(&self) -> &str {
        "Hour(datetime)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 50,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_datetime = get_op_value(manifold, edge.input_nodes[0])?;
        let result =
            ops_core::datetime::extract(&op_datetime, &OpValue::string("hour"), &default_ctx())
                .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// MINUTE(datetime) -> number
/// Delegates to ops_core::datetime::minute
pub struct MinuteRule;
impl RewriteRule for MinuteRule {
    fn pattern(&self) -> &str {
        "Minute(datetime)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 50,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_datetime = get_op_value(manifold, edge.input_nodes[0])?;
        let unit = OpValue::string("minute");
        let result = ops_core::datetime::extract(&op_datetime, &unit, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// SECOND(datetime) -> number
/// Delegates to ops_core::datetime::extract with unit="second"
pub struct SecondRule;
impl RewriteRule for SecondRule {
    fn pattern(&self) -> &str {
        "Second(datetime)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 50,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_datetime = get_op_value(manifold, edge.input_nodes[0])?;
        let unit = OpValue::string("second");
        let result = ops_core::datetime::extract(&op_datetime, &unit, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// DATEDIFF(start_date, end_date, unit) -> number
/// Delegates to ops_core::datetime::date_diff
pub struct DateDiffRule;
impl RewriteRule for DateDiffRule {
    fn pattern(&self) -> &str {
        "DateDiff(start_date, end_date, unit)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 200,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 3 {
            return Err(RuleError::PatternMismatch);
        }

        let op_start = get_op_value(manifold, edge.input_nodes[0])?;
        let op_end = get_op_value(manifold, edge.input_nodes[1])?;
        let op_unit = get_op_value(manifold, edge.input_nodes[2])?;

        let result = ops_core::datetime::date_diff(&op_start, &op_end, &op_unit, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// DATEFORMAT(datetime, format, [timezone]) -> string
/// Delegates to ops_core::datetime::format_date or format_date_tz
pub struct DateFormatRule;
impl RewriteRule for DateFormatRule {
    fn pattern(&self) -> &str {
        "DateFormat(datetime, format, [timezone])"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 200,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if !(edge.input_nodes.len() == 2 || edge.input_nodes.len() == 3) {
            return Err(RuleError::PatternMismatch);
        }

        let op_datetime = get_op_value(manifold, edge.input_nodes[0])?;
        let op_format = get_op_value(manifold, edge.input_nodes[1])?;

        let result = if edge.input_nodes.len() == 3 {
            let op_tz = get_op_value(manifold, edge.input_nodes[2])?;
            ops_core::datetime::format_date_tz(&op_datetime, &op_format, &op_tz, &default_ctx())
                .map_err(op_error_to_rule_error)?
        } else {
            ops_core::datetime::format_date(&op_datetime, &op_format, &default_ctx())
                .map_err(op_error_to_rule_error)?
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// CONVERT_TZ(datetime, from_tz, to_tz) -> RFC3339 string
/// Delegates to ops_core::datetime::convert_tz
pub struct ConvertTzRule;
impl RewriteRule for ConvertTzRule {
    fn pattern(&self) -> &str {
        "ConvertTz(datetime, from_tz, to_tz)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 150,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 3 {
            return Err(RuleError::PatternMismatch);
        }

        let op_datetime = get_op_value(manifold, edge.input_nodes[0])?;
        let op_from_tz = get_op_value(manifold, edge.input_nodes[1])?;
        let op_to_tz = get_op_value(manifold, edge.input_nodes[2])?;

        let result =
            ops_core::datetime::convert_tz(&op_datetime, &op_from_tz, &op_to_tz, &default_ctx())
                .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// WORKDAYS(start_date, end_date, [holidays]) -> number
/// Delegates to ops_core::datetime::workdays
pub struct WorkdaysRule;
impl RewriteRule for WorkdaysRule {
    fn pattern(&self) -> &str {
        "Workdays(start_date, end_date, [holidays])"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 300,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if !(edge.input_nodes.len() == 2 || edge.input_nodes.len() == 3) {
            return Err(RuleError::PatternMismatch);
        }

        let op_start = get_op_value(manifold, edge.input_nodes[0])?;
        let op_end = get_op_value(manifold, edge.input_nodes[1])?;
        let op_holidays = if edge.input_nodes.len() == 3 {
            get_op_value(manifold, edge.input_nodes[2])?
        } else {
            OpValue::null()
        };

        let result = ops_core::datetime::workdays(&op_start, &op_end, &op_holidays, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// START_OF(datetime, unit, [timezone]) -> RFC3339 string
/// Delegates to ops_core::datetime::start_of
pub struct StartOfRule;
impl RewriteRule for StartOfRule {
    fn pattern(&self) -> &str {
        "StartOf(datetime, unit, [timezone])"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 200,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if !(edge.input_nodes.len() == 2 || edge.input_nodes.len() == 3) {
            return Err(RuleError::PatternMismatch);
        }

        let op_datetime = get_op_value(manifold, edge.input_nodes[0])?;
        let op_unit = get_op_value(manifold, edge.input_nodes[1])?;
        let op_tz = if edge.input_nodes.len() == 3 {
            get_op_value(manifold, edge.input_nodes[2])?
        } else {
            OpValue::null()
        };

        let result = ops_core::datetime::start_of(&op_datetime, &op_unit, &op_tz, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// END_OF(datetime, unit, [timezone]) -> RFC3339 string
/// Delegates to ops_core::datetime::end_of
pub struct EndOfRule;
impl RewriteRule for EndOfRule {
    fn pattern(&self) -> &str {
        "EndOf(datetime, unit, [timezone])"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 200,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if !(edge.input_nodes.len() == 2 || edge.input_nodes.len() == 3) {
            return Err(RuleError::PatternMismatch);
        }

        let op_datetime = get_op_value(manifold, edge.input_nodes[0])?;
        let op_unit = get_op_value(manifold, edge.input_nodes[1])?;
        let op_tz = if edge.input_nodes.len() == 3 {
            get_op_value(manifold, edge.input_nodes[2])?
        } else {
            OpValue::null()
        };

        let result = ops_core::datetime::end_of(&op_datetime, &op_unit, &op_tz, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// DATETIME(year, month, day, hour, minute, second, [timezone]) -> RFC3339 string
/// Delegates to ops_core::datetime::make_datetime
pub struct DateTimeRule;
impl RewriteRule for DateTimeRule {
    fn pattern(&self) -> &str {
        "DateTime(year, month, day, hour, minute, second, [timezone])"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 150,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if !(edge.input_nodes.len() == 6 || edge.input_nodes.len() == 7) {
            return Err(RuleError::PatternMismatch);
        }

        let op_year = get_op_value(manifold, edge.input_nodes[0])?;
        let op_month = get_op_value(manifold, edge.input_nodes[1])?;
        let op_day = get_op_value(manifold, edge.input_nodes[2])?;
        let op_hour = get_op_value(manifold, edge.input_nodes[3])?;
        let op_minute = get_op_value(manifold, edge.input_nodes[4])?;
        let op_second = get_op_value(manifold, edge.input_nodes[5])?;
        let op_tz = if edge.input_nodes.len() == 7 {
            get_op_value(manifold, edge.input_nodes[6])?
        } else {
            OpValue::null()
        };

        let result = ops_core::datetime::make_datetime(
            &op_year,
            &op_month,
            &op_day,
            &op_hour,
            &op_minute,
            &op_second,
            &op_tz,
            &default_ctx(),
        )
        .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// TIMEFORMAT(datetime, format, [timezone]) -> string
/// Delegates to ops_core::datetime::format_time
pub struct TimeFormatRule;
impl RewriteRule for TimeFormatRule {
    fn pattern(&self) -> &str {
        "TimeFormat(datetime, format, [timezone])"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 200,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if !(edge.input_nodes.len() == 2 || edge.input_nodes.len() == 3) {
            return Err(RuleError::PatternMismatch);
        }

        let op_datetime = get_op_value(manifold, edge.input_nodes[0])?;
        let op_format = get_op_value(manifold, edge.input_nodes[1])?;
        let op_tz = if edge.input_nodes.len() == 3 {
            get_op_value(manifold, edge.input_nodes[2])?
        } else {
            OpValue::null()
        };

        let result =
            ops_core::datetime::format_time(&op_datetime, &op_format, &op_tz, &default_ctx())
                .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// WEEKDAY(date, [timezone]) -> number (1=Sunday, 7=Saturday)
/// Delegates to ops_core::datetime::weekday
pub struct WeekdayRule;
impl RewriteRule for WeekdayRule {
    fn pattern(&self) -> &str {
        "Weekday(date, [timezone])"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 100,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if !(edge.input_nodes.len() == 1 || edge.input_nodes.len() == 2) {
            return Err(RuleError::PatternMismatch);
        }

        let op_datetime = get_op_value(manifold, edge.input_nodes[0])?;
        let op_tz = if edge.input_nodes.len() == 2 {
            get_op_value(manifold, edge.input_nodes[1])?
        } else {
            OpValue::null()
        };

        let result = ops_core::datetime::weekday(&op_datetime, &op_tz, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}
