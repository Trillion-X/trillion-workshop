//! crates/formula-engine/src/grammar/mod.rs
//!
//! Purpose
//!   The grammar of a formula written as text: the tokens (lexer.rs), the parser that reads them into one expression
//!   (parser.rs) and the expression's shape (below). src/text.rs compiles that expression into a binding; nothing here
//!   evaluates anything. Moved here from tools/shared-code/crates/formula-ast, whose other parts (validation, display,
//!   the request shapes of the retired formula-core evaluator) had no caller left.

use serde::{Deserialize, Serialize};

pub mod lexer;
pub mod parser;

/// The root node of any parsed formula. The Formula Engine is architecturally designed for single expressions only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum AstNode {
    Expression(Expression),
}

/// Represents an expression that evaluates to a value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Expression {
    Literal(Literal),
    Identifier(String),
    VersionedIdentifier { name: String, version: u32 },
    Binary(Box<BinaryExpr>),
    Unary(Box<UnaryExpr>),
    FunctionCall(Box<FunctionCallExpr>),
    MemberAccess(Box<MemberAccessExpr>),
    IndexAccess(Box<IndexAccessExpr>),
    Lambda(Box<LambdaExpr>),
}

/// Represents a lambda expression: |param1, param2| => body
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LambdaExpr {
    pub parameters: Vec<String>,
    pub body: Expression,
}

/// Represents a literal value in the formula.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Literal {
    Null,
    Boolean(bool),
    Number(f64),
    String(String),
    Array(Vec<Expression>),
    Object(Vec<(String, Expression)>),
}

/// Represents a binary operation (e.g., 1 + 2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BinaryExpr {
    pub op: BinaryOp,
    pub left: Expression,
    pub right: Expression,
}

/// Represents a unary operation (e.g., -5 or !true).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UnaryExpr {
    pub op: UnaryOp,
    pub expr: Expression,
}

/// Represents a function call (e.g., SUM(my_array) or CALCULATE_LTV@v2(customer)).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FunctionCallExpr {
    pub function_name: String,
    pub version: Option<u32>, // For versioned UDF calls (e.g., FunctionName@v2)
    pub args: Vec<Expression>,
}

/// Represents member access (e.g., user.profile.name).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemberAccessExpr {
    pub object: Expression,
    pub property: String,
}

/// Represents index access (e.g., array[0] or tasks[i]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IndexAccessExpr {
    pub array: Expression,
    pub index: Expression,
}

/// Enumerates all possible binary operators.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum BinaryOp {
    // Arithmetic
    Add,
    Subtract,
    Multiply,
    Divide,
    Modulo,

    // Comparison
    Eq,    // ==
    NotEq, // !=
    Lt,    // <
    Lte,   // <=
    Gt,    // >
    Gte,   // >=

    // Logical
    And, // &&
    Or,  // ||
}

/// Enumerates all possible unary operators.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum UnaryOp {
    Not,
    Negate,
}

// Returns (base, chain) if expression is a proper dotted chain starting at Identifier.
// E.g. user.profile.name -> ("user", ["profile","name"])
pub fn flatten_member_chain(e: &Expression) -> Option<(String, Vec<String>)> {
    fn recur(e: &Expression, out: &mut Vec<String>) -> Option<String> {
        match e {
            Expression::MemberAccess(ma) => {
                out.push(ma.property.clone());
                recur(&ma.object, out)
            }
            Expression::Identifier(s) => Some(s.clone()),
            Expression::VersionedIdentifier { name, .. } => Some(name.clone()),
            _ => None,
        }
    }

    let mut props = Vec::new();
    let base = recur(e, &mut props)?;
    props.reverse();
    Some((base, props))
}
