//! crates/formula-engine/src/text.rs
//!
//! Purpose
//!   A formula written as text, compiled into one composition-ast binding, so a text formula and a binding are the
//!   same thing to the engine: =PRICE * QUANTITY, IF(@.done, "yes", "no") and FILTER(items, |x| => x.age > 3) are
//!   parsed by the formula grammar (formula-ast) and every operator and function is looked up in
//!   rules/text-formulas.json, which says the op:core id it runs and where each of its arguments goes.
//!
//!   compile(text) -> binding
//!     a literal          {select: {from: literal, value}} (a list or object holds the bindings of its parts)
//!     name, @.a.b        {select: {from: context, path}}: the row, the same at any depth (a nested argument's
//!                        `self` is the value its step runs on, so the row is read as the evaluation's context)
//!     @@, $scope         {select: {from: vars, key}}: the variable of that name
//!     a lambda parameter {select: {from: vars, key}}: the variable its function binds it to
//!     a op b, !a, -a     a's binding with the operator's step appended, b compiled into the step's argument
//!     a[i]               a's binding with the `index` step (lookup by key or position)
//!     F(x, y, ...)       the input argument's binding (a literal null without one) with F's op as the last step
//!
//! Non-negotiable invariants
//!   - No function, operator or op id is named here: they are rows of rules/text-formulas.json.
//!   - Nothing is evaluated here; the binding is evaluated by the engine like any other, under the same guards.
//!   - A name the table does not hold, too many arguments, a lambda outside a function that takes one, or a versioned
//!     call is refused with a sentence; nothing is guessed.

use crate::{limits, Refused};
use formula_ast::lexer::{Lexer, TokenType};
use formula_ast::parser::Parser;
use formula_ast::{AstNode, Expression, Literal};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

pub const TEXT_FORMULAS: &str = include_str!("../../../rules/text-formulas.json");

struct Table {
    data: Value,
    functions: HashMap<String, Value>,
}

fn table() -> &'static Table {
    static TABLE: OnceLock<Table> = OnceLock::new();
    TABLE.get_or_init(|| {
        let data: Value = serde_json::from_str(TEXT_FORMULAS).expect("rules/text-formulas.json is JSON");
        let mut functions = HashMap::new();
        for row in data["functions"].as_array().into_iter().flatten() {
            let names = std::iter::once(&row["name"]).chain(row["aliases"].as_array().into_iter().flatten());
            for name in names.filter_map(Value::as_str) {
                functions.insert(name.to_ascii_uppercase(), row.clone());
            }
        }
        Table { data, functions }
    })
}

/// Every function row of the table, for a caller that lists what text formulas can say.
pub fn functions() -> &'static Value {
    &table().data["functions"]
}

/// The text compiled into one binding, or the refusal that says why it cannot be.
pub fn compile(text: &str) -> Result<Value, Refused> {
    held_to_the_limits(text)?;
    let AstNode::Expression(expression) =
        Parser::new().parse(text).map_err(|error| Refused::Sentence(format!("The formula does not read: {error}.")))?;
    Compiler { scope: Vec::new() }.binding(&expression).map_err(Refused::Sentence)
}

/// The grammar is read by recursion, so before it is parsed a text is held to the binding limits of
/// rules/evaluation-guards.json: no more parts (tokens) than max_nodes, and no deeper nesting (brackets, lambdas and
/// runs of ! or unary -) than max_depth. A text past either is refused with the guard's own words.
fn held_to_the_limits(text: &str) -> Result<(), Refused> {
    let limits = limits();
    let (mut parts, mut open, mut lambdas, mut run, mut deepest) = (0usize, 0usize, 0usize, 0usize, 0usize);
    let mut after_operand = false;
    for token in Lexer::new(text) {
        let Ok(token) = token else { break };
        parts += 1;
        if parts > limits.max_nodes {
            return Err(Refused::Guard(limits.refusal("too_large", &[("limit", limits.max_nodes.into())])));
        }
        let kind = token.token_type;
        match kind {
            TokenType::LParen | TokenType::LBracket | TokenType::LBrace => open += 1,
            TokenType::RParen | TokenType::RBracket | TokenType::RBrace => open = open.saturating_sub(1),
            TokenType::Arrow => lambdas += 1,
            _ => {}
        }
        let unary = matches!(kind, TokenType::Not | TokenType::Minus) && !after_operand;
        run = if unary { run + 1 } else { 0 };
        deepest = deepest.max(open + lambdas + run);
        if deepest > limits.max_depth {
            return Err(Refused::Guard(limits.refusal("too_deep", &[("limit", limits.max_depth.into())])));
        }
        after_operand = matches!(
            kind,
            TokenType::Number(_) | TokenType::String(_) | TokenType::Boolean(_) | TokenType::Null | TokenType::Identifier(_)
                | TokenType::RParen | TokenType::RBracket | TokenType::RBrace | TokenType::At | TokenType::DoubleAt | TokenType::Scope
        );
    }
    Ok(())
}

struct Compiler {
    /// Lambda parameters in reach, innermost last, each with the variable it reads.
    scope: Vec<(String, String)>,
}

fn select(select: Value) -> Value {
    json!({ "$kind": "binding", "select": select })
}

fn literal(value: Value) -> Value {
    select(json!({ "from": "literal", "value": value }))
}

/// The binding with one more step at the end of its transform.
fn then(mut binding: Value, step: Value) -> Value {
    match binding.get_mut("transform").and_then(Value::as_array_mut) {
        Some(steps) => steps.push(step),
        None => binding["transform"] = json!([step]),
    }
    binding
}

fn step(op: &Value, args: Map<String, Value>) -> Value {
    if args.is_empty() { json!({ "op": op }) } else { json!({ "op": op, "args": args }) }
}

/// The serde name of an AST enum value (`Add`, `Not`), the key its row is found under.
fn key_of<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value).ok().and_then(|value| value.as_str().map(str::to_string)).unwrap_or_default()
}

impl Compiler {
    fn binding(&mut self, expression: &Expression) -> Result<Value, String> {
        match expression {
            Expression::Literal(value) => self.literal(value),
            Expression::Identifier(name) => Ok(self.name(name, &[])),
            Expression::MemberAccess(_) => match formula_ast::flatten_member_chain(expression) {
                Some((root, path)) => Ok(self.name(&root, &path)),
                None => {
                    let Expression::MemberAccess(access) = expression else { unreachable!() };
                    let base = self.binding(&access.object)?;
                    let index = &table().data["operators"]["index"];
                    Ok(then(base, step(&index["op"], Map::from_iter([(key(index), json!(access.property))]))))
                }
            },
            Expression::IndexAccess(access) => {
                let base = self.binding(&access.array)?;
                let index = &table().data["operators"]["index"];
                let at = self.binding(&access.index)?;
                Ok(then(base, step(&index["op"], Map::from_iter([(key(index), at)]))))
            }
            Expression::Binary(_) => {
                // a + b + c leans left as deep as it is long: its spine is walked in a loop, not by recursion.
                let mut spine = Vec::new();
                let mut base = expression;
                while let Expression::Binary(binary) = base {
                    spine.push(binary);
                    base = &binary.left;
                }
                let mut left = self.binding(base)?;
                for binary in spine.into_iter().rev() {
                    let row = &table().data["operators"]["binary"][key_of(&binary.op)];
                    if !row.is_object() {
                        return Err(format!("The operator {} has no row in rules/text-formulas.json.", key_of(&binary.op)));
                    }
                    let right = self.binding(&binary.right)?;
                    left = if row["values"].as_bool() == Some(true) {
                        then(literal(Value::Null), step(&row["op"], Map::from_iter([("values".to_string(), json!([left, right]))])))
                    } else {
                        then(left, step(&row["op"], Map::from_iter([(key(row), right)])))
                    };
                }
                Ok(left)
            }
            Expression::Unary(unary) => {
                let op = &table().data["operators"]["unary"][key_of(&unary.op)];
                if !op.is_string() {
                    return Err(format!("The operator {} has no row in rules/text-formulas.json.", key_of(&unary.op)));
                }
                Ok(then(self.binding(&unary.expr)?, step(op, Map::new())))
            }
            Expression::FunctionCall(call) => self.call(call),
            Expression::Lambda(_) => Err("A lambda (|x| => ...) is only an argument of a function that runs it on each item.".to_string()),
            Expression::VersionedIdentifier { name, version } => Err(format!("{name}@v{version}: no formula is versioned.")),
        }
    }

    fn literal(&mut self, value: &Literal) -> Result<Value, String> {
        Ok(literal(match value {
            Literal::Null => Value::Null,
            Literal::Boolean(value) => json!(value),
            Literal::Number(value) => json!(value),
            Literal::String(value) => json!(value),
            Literal::Array(items) => Value::Array(items.iter().map(|item| self.binding(item)).collect::<Result<_, _>>()?),
            Literal::Object(fields) => Value::Object(
                fields.iter().map(|(name, item)| Ok((name.clone(), self.binding(item)?))).collect::<Result<_, String>>()?,
            ),
        }))
    }

    /// A name with the path after it: a lambda parameter or a variable, else a field of the row.
    fn name(&self, root: &str, path: &[String]) -> Value {
        let path: Vec<Value> = path.iter().map(|part| json!(part)).collect();
        let bound = self.scope.iter().rev().find(|(name, _)| name == root).map(|(_, var)| var.clone());
        let (from, key, path) = match (bound, root) {
            (Some(var), _) => ("vars", Some(var), path),
            (None, "@") => ("context", None, path),
            (None, "@@" | "$scope") => ("vars", Some(root.to_string()), path),
            (None, _) => ("context", None, std::iter::once(json!(root)).chain(path).collect()),
        };
        let mut chosen = json!({ "from": from });
        if let Some(key) = key {
            chosen["key"] = json!(key);
        }
        if !path.is_empty() {
            chosen["path"] = Value::Array(path);
        }
        select(chosen)
    }

    fn call(&mut self, call: &formula_ast::FunctionCallExpr) -> Result<Value, String> {
        let name = call.function_name.to_ascii_uppercase();
        let row = table().functions.get(&name).ok_or_else(|| format!("{name} is not a function rules/text-formulas.json holds."))?;
        if let Some(version) = call.version {
            return Err(format!("{name}@v{version}: no formula is versioned."));
        }
        let given = &call.args;
        let mut used = 0usize;
        let mut open_ended = false;
        let mut at = |index: usize| {
            used = used.max(index + 1);
            given.get(index)
        };

        let input = match &row["input"] {
            Value::Null => literal(Value::Null),
            Value::Number(index) => {
                let index = index.as_u64().unwrap_or(0) as usize;
                match at(index) {
                    Some(argument) => self.binding(argument)?,
                    None => return Err(format!("{name} needs at least {} arguments.", index + 1)),
                }
            }
            spec => {
                let from = spec["list"].as_u64().unwrap_or(0) as usize;
                open_ended = true;
                match &given[from.min(given.len())..] {
                    [one] => self.binding(one)?,
                    many => literal(Value::Array(many.iter().map(|item| self.binding(item)).collect::<Result<_, _>>()?)),
                }
            }
        };

        let mut args = Map::new();
        if let Some(specs) = row["args"].as_object() {
            for (arg, spec) in specs {
                let value = match spec {
                    Value::Number(index) => {
                        let index = index.as_u64().unwrap_or(0) as usize;
                        match at(index) {
                            Some(argument) => self.binding(argument)?,
                            None => return Err(format!("{name} needs at least {} arguments.", index + 1)),
                        }
                    }
                    _ if spec.get("value").is_some() => spec["value"].clone(),
                    _ if spec.get("rest").is_some() => {
                        open_ended = true;
                        let from = spec["rest"].as_u64().unwrap_or(0) as usize;
                        Value::Array(given.iter().skip(from).map(|item| self.binding(item)).collect::<Result<_, _>>()?)
                    }
                    _ if spec.get("chain").is_some() => {
                        let index = spec["chain"].as_u64().unwrap_or(0) as usize;
                        let Some(Expression::Lambda(lambda)) = at(index) else {
                            return Err(format!("{name} needs a lambda such as |x| => ... as argument {}.", index + 1));
                        };
                        let (chain, item_var) = self.chain(&name, lambda, spec, row["yields_list"].as_bool() == Some(true))?;
                        if let Some(item_var) = item_var {
                            args.insert("item_var".to_string(), json!(item_var));
                        }
                        chain
                    }
                    _ => {
                        let index = spec["at"].as_u64().unwrap_or(0) as usize;
                        match at(index) {
                            Some(argument) => self.binding(argument)?,
                            None if spec["default"].is_null() => continue,
                            None => spec["default"].clone(),
                        }
                    }
                };
                args.insert(arg.clone(), value);
            }
        }
        if !open_ended && given.len() > used {
            return Err(format!("{name} takes at most {used} arguments, and {} were given.", given.len()));
        }
        Ok(then(input, step(&row["op"], args)))
    }

    /// A lambda as a chain of steps that starts from the bound value: its body, read with its parameters bound to the
    /// variables `binds` names. The item's variable is named after its parameter and handed back as the op's item_var.
    fn chain(&mut self, name: &str, lambda: &formula_ast::LambdaExpr, spec: &Value, yields_list: bool) -> Result<(Value, Option<String>), String> {
        let binds: Vec<&str> = spec["binds"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        if lambda.parameters.len() != binds.len() {
            return Err(format!("{name}'s lambda takes {} parameters, and {} were given.", binds.len(), lambda.parameters.len()));
        }
        let mut item_var = None;
        let reach = self.scope.len();
        for (parameter, bind) in lambda.parameters.iter().zip(&binds) {
            let var = if *bind == "item_var" {
                item_var = Some(parameter.clone());
                parameter.clone()
            } else {
                bind.to_string()
            };
            self.scope.push((parameter.clone(), var));
        }
        let body = self.binding(&lambda.body);
        self.scope.truncate(reach);
        let body = body?;
        let value = if yields_list { literal(json!([body])) } else { body };
        let coalesce = &table().data["operators"]["value_of"];
        Ok((json!([{ "op": coalesce["op"], "args": { "values": [value] } }]), item_var))
    }
}

/// The argument name an operator row puts its other operand under.
fn key(row: &Value) -> String {
    row["arg"].as_str().unwrap_or("value").to_string()
}
