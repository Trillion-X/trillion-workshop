// crates/formula-ast/src/lib.rs
//
// Formula AST — Shared Expression Types + Pure Compute (Leaf Crate)
//
// Pure data types for the formula abstract syntax tree, plus the Lexer and
// Parser that produce them. All modules are pure compute (zero I/O, zero
// heavy dependencies). Both formula-engine (evaluator) and trigger-engine
// (condition matcher) import from here instead of depending on each other.
//
// L088: Natural bedrock for Expression types AND their producers (Lexer/Parser)
// — the deepest shared ancestor where N>1 consumers converge.
// Parser/Lexer are pure compute that produce the crate's own types.
//
//! Defines the Abstract Syntax Tree (AST) structures for the Formula Engine.
//! The AST is the canonical, intermediate representation of a parsed formula.

use serde::{Deserialize, Serialize};

pub mod human_formula;
pub mod lexer;
pub mod parser;

pub use human_formula::*;

/// One structural AST depth authority shared by validation and compilation.
pub const MAX_FORMULA_AST_DEPTH: usize = 128;

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

// ====== AST utilities: validation, traversal, analysis, pretty-printing ======
use std::collections::{BTreeSet, HashSet, VecDeque};
use std::fmt;

// ---------- 1.4.7: Validation ----------

/// How strict validation should behave.
#[derive(Debug, Clone)]
pub struct ValidationConfig {
    /// Maximum allowed recursion depth (to prevent pathological inputs).
    pub max_depth: usize,
}

impl Default for ValidationConfig {
    fn default() -> Self {
        Self {
            max_depth: MAX_FORMULA_AST_DEPTH,
        }
    }
}

/// Hook for your app/domain to validate identifiers, members, and functions.
pub trait IdentifierResolver {
    /// Return true if a bare identifier like `user` is valid in your context.
    fn is_valid_identifier(&self, name: &str) -> bool;

    /// Return true if `property` is valid on the chain `base` (e.g., ["user","profile"] -> "name").
    /// Default: permissive.
    fn is_valid_member(&self, _base_chain: &[&str], _property: &str) -> bool {
        true
    }

    /// Return true if a function (and optional version) is valid.
    /// Default: permissive.
    fn is_valid_function(&self, _name: &str, _version: Option<u32>) -> bool {
        true
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ValidationErrorKind {
    // Existing
    EmptyIdentifier,
    DepthLimitExceeded { limit: usize, at_depth: usize },
    UnknownIdentifier { name: String },
    InvalidMember { base: String, property: String },
    InvalidFunction { name: String, version: Option<u32> },

    // Restored structural checks
    EmptyFunctionName,
    EmptyPropertyName,
    EmptyObjectKey,
    EmptyLambdaParameter { index: usize },
    DuplicateObjectKey { key: String },
    DuplicateLambdaParameter { parameter: String },

    // Reserved (not truly meaningful without a definition graph, but kept for API parity)
    CyclicReference { identifier: String },

    // Catch-all
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ValidationError {
    pub kind: ValidationErrorKind,
    /// Rough path for context (e.g., ["Binary","left","Identifier(user)"])
    pub path: Vec<String>,
}

impl ValidationError {
    fn at(kind: ValidationErrorKind, path: Vec<String>) -> Self {
        Self { kind, path }
    }
}

impl AstNode {
    /// Validate the AST with a config and optional resolver.
    pub fn validate_with(
        &self,
        cfg: &ValidationConfig,
        resolver: Option<&dyn IdentifierResolver>,
    ) -> Result<(), Vec<ValidationError>> {
        match self {
            AstNode::Expression(e) => e.validate_with(cfg, resolver),
        }
    }
}

impl Expression {
    pub fn validate(&self) -> Result<(), Vec<ValidationError>> {
        self.validate_with(&ValidationConfig::default(), None)
    }

    pub fn validate_with(
        &self,
        cfg: &ValidationConfig,
        resolver: Option<&dyn IdentifierResolver>,
    ) -> Result<(), Vec<ValidationError>> {
        let mut errs = Vec::new();
        self.validate_inner(cfg, resolver, &mut errs, 0, &mut vec!["Root".to_string()]);
        if errs.is_empty() {
            Ok(())
        } else {
            Err(errs)
        }
    }

    fn validate_inner(
        &self,
        cfg: &ValidationConfig,
        resolver: Option<&dyn IdentifierResolver>,
        out: &mut Vec<ValidationError>,
        depth: usize,
        path: &mut Vec<String>,
    ) {
        if depth > cfg.max_depth {
            out.push(ValidationError::at(
                ValidationErrorKind::DepthLimitExceeded {
                    limit: cfg.max_depth,
                    at_depth: depth,
                },
                path.clone(),
            ));
            return;
        }

        match self {
            Expression::Identifier(name) => {
                if name.trim().is_empty() {
                    out.push(ValidationError::at(
                        ValidationErrorKind::EmptyIdentifier,
                        path.clone(),
                    ));
                }
                if let Some(r) = resolver {
                    if !r.is_valid_identifier(name) {
                        out.push(ValidationError::at(
                            ValidationErrorKind::UnknownIdentifier { name: name.clone() },
                            path.clone(),
                        ));
                    }
                }
            }

            Expression::MemberAccess(ma) => {
                if ma.property.trim().is_empty() {
                    out.push(ValidationError::at(
                        ValidationErrorKind::EmptyPropertyName,
                        path.clone(),
                    ));
                }

                // Validate the object subtree
                path.push("MemberAccess.object".into());
                ma.object
                    .validate_inner(cfg, resolver, out, depth + 1, path);
                path.pop();

                // If we can flatten a chain, validate each step
                if let Some((base, chain)) = flatten_member_chain(self) {
                    if let Some(r) = resolver {
                        // Keep owned Strings, borrow as &str for the resolver
                        let mut base_chain: Vec<String> = vec![base];
                        for prop in chain {
                            let borrowed: Vec<&str> =
                                base_chain.iter().map(|s| s.as_str()).collect();
                            if !r.is_valid_member(&borrowed, &prop) {
                                out.push(ValidationError::at(
                                    ValidationErrorKind::InvalidMember {
                                        base: borrowed.join("."),
                                        property: prop.clone(),
                                    },
                                    path.clone(),
                                ));
                            }
                            base_chain.push(prop);
                        }
                    }
                }
            }

            Expression::IndexAccess(ix) => {
                path.push("IndexAccess.array".into());
                ix.array.validate_inner(cfg, resolver, out, depth + 1, path);
                path.pop();

                path.push("IndexAccess.index".into());
                ix.index.validate_inner(cfg, resolver, out, depth + 1, path);
                path.pop();
            }

            Expression::FunctionCall(fc) => {
                if fc.function_name.trim().is_empty() {
                    out.push(ValidationError::at(
                        ValidationErrorKind::EmptyFunctionName,
                        path.clone(),
                    ));
                }
                if let Some(r) = resolver {
                    if !r.is_valid_function(&fc.function_name, fc.version) {
                        out.push(ValidationError::at(
                            ValidationErrorKind::InvalidFunction {
                                name: fc.function_name.clone(),
                                version: fc.version,
                            },
                            path.clone(),
                        ));
                    }
                }
                for (i, arg) in fc.args.iter().enumerate() {
                    path.push(format!("FunctionCall.args[{i}]"));
                    arg.validate_inner(cfg, resolver, out, depth + 1, path);
                    path.pop();
                }
            }

            Expression::Binary(b) => {
                path.push("Binary.left".into());
                b.left.validate_inner(cfg, resolver, out, depth + 1, path);
                path.pop();

                path.push("Binary.right".into());
                b.right.validate_inner(cfg, resolver, out, depth + 1, path);
                path.pop();
            }

            Expression::Unary(u) => {
                path.push("Unary.expr".into());
                u.expr.validate_inner(cfg, resolver, out, depth + 1, path);
                path.pop();
            }

            Expression::Lambda(l) => {
                for (i, p) in l.parameters.iter().enumerate() {
                    if p.trim().is_empty() {
                        let mut pth = path.clone();
                        pth.push(format!("Lambda.param[{i}]"));
                        out.push(ValidationError::at(
                            ValidationErrorKind::EmptyLambdaParameter { index: i },
                            pth,
                        ));
                    }
                }

                let mut seen: HashSet<&str> = HashSet::new();
                for p in &l.parameters {
                    let key = p.trim();
                    if !key.is_empty() && !seen.insert(key) {
                        let mut pth = path.clone();
                        pth.push("Lambda.params".into());
                        out.push(ValidationError::at(
                            ValidationErrorKind::DuplicateLambdaParameter {
                                parameter: p.clone(),
                            },
                            pth,
                        ));
                    }
                }

                path.push("Lambda.body".into());
                l.body.validate_inner(cfg, resolver, out, depth + 1, path);
                path.pop();
            }

            Expression::VersionedIdentifier { name, .. } => {
                if name.trim().is_empty() {
                    out.push(ValidationError::at(
                        ValidationErrorKind::EmptyIdentifier,
                        path.clone(),
                    ));
                }
                if let Some(r) = resolver {
                    if !r.is_valid_identifier(name) {
                        out.push(ValidationError::at(
                            ValidationErrorKind::UnknownIdentifier { name: name.clone() },
                            path.clone(),
                        ));
                    }
                }
            }

            Expression::Literal(lit) => match lit {
                Literal::Array(items) => {
                    for (i, e) in items.iter().enumerate() {
                        path.push(format!("Array[{i}]"));
                        e.validate_inner(cfg, resolver, out, depth + 1, path);
                        path.pop();
                    }
                }
                Literal::Object(props) => {
                    let mut keys: HashSet<&str> = HashSet::new();
                    for (k, v) in props {
                        let trimmed = k.trim();
                        if trimmed.is_empty() {
                            let mut pth = path.clone();
                            pth.push("Object.<empty-key>".into());
                            out.push(ValidationError::at(
                                ValidationErrorKind::EmptyObjectKey,
                                pth,
                            ));
                        } else if !keys.insert(trimmed) {
                            let mut pth = path.clone();
                            pth.push(format!("Object.{k}"));
                            out.push(ValidationError::at(
                                ValidationErrorKind::DuplicateObjectKey { key: k.clone() },
                                pth,
                            ));
                        }

                        path.push(format!("Object.{k}"));
                        v.validate_inner(cfg, resolver, out, depth + 1, path);
                        path.pop();
                    }
                }
                _ => {}
            },
        }
    }
}

// ---------- 1.4.8: Traversal Utilities ----------

/// Structured visitor for the AST. All methods are no-ops by default,
/// so you can override only what you care about.
///
/// Use:
///   struct MyVisitor { count: usize }
///   impl Visitor for MyVisitor {
///       fn enter_expression(&mut self, _e: &Expression) { self.count += 1; }
///   }
///   expr.accept(&mut MyVisitor { count: 0 });
pub trait Visitor {
    // generic entry/exit around every Expression node
    fn enter_expression(&mut self, _e: &Expression) {}
    fn leave_expression(&mut self, _e: &Expression) {}

    // leaves
    fn visit_literal(&mut self, _l: &Literal) {}
    fn visit_identifier(&mut self, _name: &str) {}
    fn visit_versioned_identifier(&mut self, _name: &str, _version: u32) {}

    // composite nodes (enter/leave give you pre/post hooks)
    fn enter_binary(&mut self, _b: &BinaryExpr) {}
    fn leave_binary(&mut self, _b: &BinaryExpr) {}

    fn enter_unary(&mut self, _u: &UnaryExpr) {}
    fn leave_unary(&mut self, _u: &UnaryExpr) {}

    fn enter_function_call(&mut self, _f: &FunctionCallExpr) {}
    fn leave_function_call(&mut self, _f: &FunctionCallExpr) {}

    fn enter_member_access(&mut self, _m: &MemberAccessExpr) {}
    fn leave_member_access(&mut self, _m: &MemberAccessExpr) {}

    fn enter_index_access(&mut self, _i: &IndexAccessExpr) {}
    fn leave_index_access(&mut self, _i: &IndexAccessExpr) {}

    fn enter_lambda(&mut self, _l: &LambdaExpr) {}
    fn leave_lambda(&mut self, _l: &LambdaExpr) {}
}

impl Expression {
    /// Pre-order traversal: visit node, then children.
    pub fn pre_order(&self, f: &mut dyn FnMut(&Expression)) {
        f(self);
        self.for_each_child(|c| c.pre_order(f));
    }

    /// Post-order traversal: visit children, then node.
    pub fn post_order(&self, f: &mut dyn FnMut(&Expression)) {
        self.for_each_child(|c| c.post_order(f));
        f(self);
    }

    /// Breadth-first traversal.
    pub fn breadth_first(&self, f: &mut dyn FnMut(&Expression)) {
        let mut q: VecDeque<&Expression> = VecDeque::new();
        q.push_back(self);
        while let Some(node) = q.pop_front() {
            f(node);
            match node {
                Expression::Literal(Literal::Array(items)) => {
                    for e in items {
                        q.push_back(e);
                    }
                }
                Expression::Literal(Literal::Object(props)) => {
                    for (_, v) in props {
                        q.push_back(v);
                    }
                }
                Expression::Binary(b) => {
                    q.push_back(&b.left);
                    q.push_back(&b.right);
                }
                Expression::Unary(u) => {
                    q.push_back(&u.expr);
                }
                Expression::FunctionCall(fc) => {
                    for a in &fc.args {
                        q.push_back(a);
                    }
                }
                Expression::MemberAccess(ma) => {
                    q.push_back(&ma.object);
                }
                Expression::IndexAccess(ix) => {
                    q.push_back(&ix.array);
                    q.push_back(&ix.index);
                }
                Expression::Lambda(l) => {
                    q.push_back(&l.body);
                }
                // Leaves
                Expression::Identifier(_)
                | Expression::VersionedIdentifier { .. }
                | Expression::Literal(_) => {}
            }
        }
    }

    /// Helper to iterate children of any expression.
    fn for_each_child(&self, mut f: impl FnMut(&Expression)) {
        match self {
            Expression::Literal(lit) => match lit {
                Literal::Array(items) => {
                    for e in items {
                        f(e)
                    }
                }
                Literal::Object(props) => {
                    for (_, v) in props {
                        f(v)
                    }
                }
                _ => {} // Primitive literals have no children
            },
            Expression::Binary(b) => {
                f(&b.left);
                f(&b.right);
            }
            Expression::Unary(u) => f(&u.expr),
            Expression::FunctionCall(fc) => {
                for a in &fc.args {
                    f(a)
                }
            }
            Expression::MemberAccess(ma) => f(&ma.object),
            Expression::IndexAccess(ix) => {
                f(&ix.array);
                f(&ix.index);
            }
            Expression::Lambda(l) => f(&l.body),
            // Leaf nodes:
            Expression::Identifier(_) => {}
            Expression::VersionedIdentifier { .. } => {}
        }
    }
}

// ---------- 1.4.9: AST Analysis Tools ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct AstStats {
    pub node_count: usize,
    pub max_depth: usize,
    pub binary_ops: usize,
    pub function_calls: usize,
    /// Number of subtrees that are purely literal and thus constant-foldable.
    pub constant_folding_candidates: usize,
    /// All bare identifiers referenced (not including member chains).
    pub identifiers: BTreeSet<String>,
    /// All function calls as (name, version)
    pub functions: BTreeSet<(String, Option<u32>)>,
}

impl AstNode {
    pub fn analyze(&self) -> AstStats {
        match self {
            AstNode::Expression(e) => e.analyze(),
        }
    }

    pub fn count_nodes(&self) -> usize {
        match self {
            AstNode::Expression(e) => e.count_nodes(),
        }
    }
}

impl Expression {
    pub fn count_nodes(&self) -> usize {
        let mut n = 0usize;
        self.pre_order(&mut |_| n += 1);
        n
    }

    pub fn analyze(&self) -> AstStats {
        let mut stats = AstStats::default();
        let mut max_depth = 0usize;

        // dependencies
        let mut idents: BTreeSet<String> = BTreeSet::new();
        let mut funcs: BTreeSet<(String, Option<u32>)> = BTreeSet::new();

        // track constant-only subtrees
        fn is_const(e: &Expression) -> bool {
            match e {
                Expression::Literal(_) => true,
                Expression::Unary(u) => is_const(&u.expr),
                Expression::Binary(b) => is_const(&b.left) && is_const(&b.right),
                Expression::Identifier(_) => false,
                Expression::VersionedIdentifier { .. } => false,
                Expression::FunctionCall(_) => false,
                Expression::MemberAccess(_) => false,
                Expression::IndexAccess(ix) => is_const(&ix.array) && is_const(&ix.index),
                Expression::Lambda(_) => false,
            }
        }

        self.pre_order(&mut |e| {
            stats.node_count += 1;

            // depths
            let d = e.depth();
            if d > max_depth {
                max_depth = d;
            }

            match e {
                Expression::Identifier(name) => {
                    idents.insert(name.clone());
                }
                Expression::VersionedIdentifier { name, .. } => {
                    idents.insert(name.clone());
                }
                Expression::FunctionCall(fc) => {
                    stats.function_calls += 1;
                    funcs.insert((fc.function_name.clone(), fc.version));
                }
                Expression::Binary(_) => {
                    stats.binary_ops += 1;
                }
                _ => {}
            }

            if is_const(e) {
                // Don't count leaf literals; we care about *candidates* where
                // a non-leaf expression is constant.
                match e {
                    Expression::Literal(_) => {}
                    _ => stats.constant_folding_candidates += 1,
                }
            }
        });

        stats.max_depth = max_depth;
        stats.identifiers = idents;
        stats.functions = funcs;
        stats
    }

    /// Compute depth of this node (root=1).
    pub fn depth(&self) -> usize {
        match self {
            Expression::Literal(Literal::Array(items)) => {
                1 + items.iter().map(|e| e.depth()).max().unwrap_or(0)
            }
            Expression::Literal(Literal::Object(props)) => {
                1 + props.iter().map(|(_, v)| v.depth()).max().unwrap_or(0)
            }
            Expression::Binary(b) => 1 + std::cmp::max(b.left.depth(), b.right.depth()),
            Expression::Unary(u) => 1 + u.expr.depth(),
            Expression::FunctionCall(fc) => {
                1 + fc.args.iter().map(|a| a.depth()).max().unwrap_or(0)
            }
            Expression::MemberAccess(ma) => 1 + ma.object.depth(),
            Expression::IndexAccess(ix) => 1 + std::cmp::max(ix.array.depth(), ix.index.depth()),
            Expression::Lambda(l) => 1 + l.body.depth(),
            Expression::Identifier(_) => 1,
            Expression::VersionedIdentifier { .. } => 1,
            Expression::Literal(_) => 1,
        }
    }

    /// Collect dotted identifier paths like `user.profile.name` **if** the chain
    /// roots at a bare identifier. Returns base identifiers set and dotted paths set.
    pub fn dependencies(&self) -> (BTreeSet<String>, BTreeSet<String>) {
        let mut bases = BTreeSet::new();
        let mut dotted = BTreeSet::new();

        self.pre_order(&mut |e| {
            if let Some((base, chain)) = flatten_member_chain(e) {
                bases.insert(base.clone());
                if !chain.is_empty() {
                    let path = std::iter::once(base)
                        .chain(chain)
                        .collect::<Vec<_>>()
                        .join(".");
                    dotted.insert(path);
                }
            } else if let Expression::Identifier(name) = e {
                bases.insert(name.clone());
            } else if let Expression::VersionedIdentifier { name, .. } = e {
                bases.insert(name.clone());
            }
        });

        (bases, dotted)
    }
}

// ---------- 1.4.10: Pretty Printing & Debug Aids ----------

impl fmt::Display for AstNode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AstNode::Expression(e) => write!(f, "{e}"),
        }
    }
}

impl fmt::Display for Expression {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Expression::Literal(l) => write!(f, "{l}"),
            Expression::Identifier(s) => write!(f, "{s}"),
            Expression::VersionedIdentifier { name, version } => write!(f, "{name}@v{version}"),
            Expression::Binary(b) => {
                let lp = prec_of(&b.left);
                let rp = prec_of(&b.right);
                let p = prec_of_op(&b.op);

                let left_s = b.left.to_string();
                let right_s = b.right.to_string();

                let left_out = if lp < p {
                    format!("({left_s})")
                } else {
                    left_s
                };
                let right_out = if rp <= p || matches!(&b.right, Expression::Unary(_)) {
                    format!("({right_s})")
                } else {
                    right_s
                };

                write!(f, "{} {} {}", left_out, op_str(&b.op), right_out)
            }
            Expression::Unary(u) => {
                let s = match u.op {
                    UnaryOp::Not => "!",
                    UnaryOp::Negate => "-",
                };
                let inner = u.expr.to_string();
                let need_paren = matches!(&u.expr, Expression::Binary(_) | Expression::Lambda(_));
                if need_paren {
                    write!(f, "{s}({inner})")
                } else {
                    write!(f, "{s}{inner}")
                }
            }
            Expression::FunctionCall(fc) => {
                if let Some(v) = fc.version {
                    write!(f, "{}@v{}(", fc.function_name, v)?;
                } else {
                    write!(f, "{}(", fc.function_name)?;
                }
                for (i, a) in fc.args.iter().enumerate() {
                    if i > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{a}")?;
                }
                write!(f, ")")
            }
            Expression::MemberAccess(ma) => {
                write!(f, "{}.{}", chain_left(&ma.object), ma.property)
            }
            Expression::IndexAccess(ix) => write!(f, "{}[{}]", chain_left(&ix.array), ix.index),
            Expression::Lambda(l) => {
                write!(f, "|")?;
                for (i, p) in l.parameters.iter().enumerate() {
                    if i > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{p}")?;
                }
                write!(f, "| => {}", l.body)
            }
        }
    }
}

impl fmt::Display for Literal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Literal::Null => write!(f, "null"),
            Literal::Boolean(b) => write!(f, "{}", if *b { "true" } else { "false" }),
            Literal::Number(n) => write!(f, "{n}"),
            Literal::String(s) => write!(f, "\"{}\"", escape_string(s)),
            Literal::Array(items) => {
                write!(f, "[")?;
                for (i, e) in items.iter().enumerate() {
                    if i > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{e}")?;
                }
                write!(f, "]")
            }
            Literal::Object(props) => {
                write!(f, "#{{")?;
                for (i, (k, v)) in props.iter().enumerate() {
                    if i > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{k}: {v}")?;
                }
                write!(f, "}}")
            }
        }
    }
}

/// Multi-line ASCII tree (for debugging).
impl Expression {
    pub fn to_tree(&self) -> String {
        let mut out = String::new();
        self.tree_inner(&mut out, 0);
        out
    }

    fn tree_inner(&self, out: &mut String, indent: usize) {
        use std::fmt::Write as _;
        let pad = "  ".repeat(indent);
        match self {
            Expression::Identifier(s) => {
                let _ = writeln!(out, "{pad}Identifier({s})");
            }
            Expression::VersionedIdentifier { name, version } => {
                let _ = writeln!(out, "{pad}VersionedIdentifier({name}@v{version})");
            }
            Expression::Literal(l) => {
                let _ = writeln!(out, "{pad}Literal({l})");
            }
            Expression::Unary(u) => {
                let _ = writeln!(out, "{pad}Unary({:?})", u.op);
                u.expr.tree_inner(out, indent + 1);
            }
            Expression::Binary(b) => {
                let _ = writeln!(out, "{pad}Binary({:?})", b.op);
                b.left.tree_inner(out, indent + 1);
                b.right.tree_inner(out, indent + 1);
            }
            Expression::FunctionCall(fc) => {
                let _ = writeln!(
                    out,
                    "{pad}FunctionCall({} @ {:?})",
                    fc.function_name, fc.version
                );
                for a in &fc.args {
                    a.tree_inner(out, indent + 1)
                }
            }
            Expression::MemberAccess(ma) => {
                let _ = writeln!(out, "{pad}MemberAccess(.{})", ma.property);
                ma.object.tree_inner(out, indent + 1);
            }
            Expression::IndexAccess(ix) => {
                let _ = writeln!(out, "{pad}IndexAccess");
                ix.array.tree_inner(out, indent + 1);
                ix.index.tree_inner(out, indent + 1);
            }
            Expression::Lambda(l) => {
                let _ = writeln!(out, "{pad}Lambda(|{}|)", l.parameters.join(", "));
                l.body.tree_inner(out, indent + 1);
            }
        }
    }

    /// Structured traversal using a Visitor. Keeps your existing closure APIs.
    pub fn accept(&self, v: &mut dyn Visitor) {
        self.accept_inner(v);
    }

    fn accept_inner(&self, v: &mut dyn Visitor) {
        v.enter_expression(self);
        match self {
            Expression::Literal(l) => {
                v.visit_literal(l);
            }
            Expression::Identifier(s) => {
                v.visit_identifier(s);
            }
            Expression::VersionedIdentifier { name, version } => {
                v.visit_versioned_identifier(name, *version);
            }
            Expression::Binary(b) => {
                v.enter_binary(b);
                b.left.accept_inner(v);
                b.right.accept_inner(v);
                v.leave_binary(b);
            }
            Expression::Unary(u) => {
                v.enter_unary(u);
                u.expr.accept_inner(v);
                v.leave_unary(u);
            }
            Expression::FunctionCall(f) => {
                v.enter_function_call(f);
                for a in &f.args {
                    a.accept_inner(v);
                }
                v.leave_function_call(f);
            }
            Expression::MemberAccess(m) => {
                v.enter_member_access(m);
                m.object.accept_inner(v);
                v.leave_member_access(m);
            }
            Expression::IndexAccess(i) => {
                v.enter_index_access(i);
                i.array.accept_inner(v);
                i.index.accept_inner(v);
                v.leave_index_access(i);
            }
            Expression::Lambda(l) => {
                v.enter_lambda(l);
                l.body.accept_inner(v);
                v.leave_lambda(l);
            }
        }
        v.leave_expression(self);
    }
}

impl AstNode {
    /// Convenience: accept on the root enum.
    pub fn accept(&self, v: &mut dyn Visitor) {
        match self {
            AstNode::Expression(e) => e.accept(v),
        }
    }
}

// ---------- helpers ----------

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

// Print left side of a chain without adding extra parens for common cases.
fn chain_left(e: &Expression) -> String {
    match e {
        Expression::Identifier(_)
        | Expression::VersionedIdentifier { .. }
        | Expression::MemberAccess(_)
        | Expression::IndexAccess(_) => e.to_string(),
        _ => format!("({e})"),
    }
}

// Precedence helpers for Display
fn prec_of(expr: &Expression) -> u8 {
    match expr {
        Expression::Binary(b) => prec_of_op(&b.op),
        Expression::Unary(_) => 7, // Unary operations are highest precedence
        _ => 8, // Literals, identifiers, etc. have highest precedence (no parens needed)
    }
}
fn prec_of_op(op: &BinaryOp) -> u8 {
    // Use consistent precedence levels with parser (fixed inconsistency)
    match op {
        BinaryOp::Or => 1,
        BinaryOp::And => 2,
        BinaryOp::Eq | BinaryOp::NotEq => 3,
        BinaryOp::Lt | BinaryOp::Lte | BinaryOp::Gt | BinaryOp::Gte => 4,
        BinaryOp::Add | BinaryOp::Subtract => 5,
        BinaryOp::Multiply | BinaryOp::Divide | BinaryOp::Modulo => 6,
    }
}
fn op_str(op: &BinaryOp) -> &'static str {
    match op {
        BinaryOp::Add => "+",
        BinaryOp::Subtract => "-",
        BinaryOp::Multiply => "*",
        BinaryOp::Divide => "/",
        BinaryOp::Modulo => "%",
        BinaryOp::Eq => "==",
        BinaryOp::NotEq => "!=",
        BinaryOp::Lt => "<",
        BinaryOp::Lte => "<=",
        BinaryOp::Gt => ">",
        BinaryOp::Gte => ">=",
        BinaryOp::And => "&&",
        BinaryOp::Or => "||",
    }
}
fn escape_string(s: &str) -> String {
    s.chars()
        .flat_map(|c| match c {
            '\\' => "\\\\".chars().collect::<Vec<_>>(),
            '\"' => "\\\"".chars().collect(),
            '\n' => "\\n".chars().collect(),
            '\r' => "\\r".chars().collect(),
            '\t' => "\\t".chars().collect(),
            _ => vec![c],
        })
        .collect()
}

#[cfg(test)]
mod ast_util_tests {
    use super::*;

    #[test]
    fn bfs_traversal_matches_preorder_count() {
        let expr = Expression::Binary(Box::new(BinaryExpr {
            op: BinaryOp::Add,
            left: Expression::FunctionCall(Box::new(FunctionCallExpr {
                function_name: "SUM".into(),
                version: None,
                args: vec![
                    Expression::Literal(Literal::Number(1.0)),
                    Expression::Literal(Literal::Number(2.0)),
                ],
            })),
            right: Expression::MemberAccess(Box::new(MemberAccessExpr {
                object: Expression::Identifier("user".into()),
                property: "name".into(),
            })),
        }));

        let preorder = expr.count_nodes();

        let mut bfs_count = 0usize;
        expr.breadth_first(&mut |_| bfs_count += 1);

        assert!(preorder >= 1);
        assert_eq!(preorder, bfs_count);
    }

    #[test]
    fn validation_catches_structural_issues() {
        // Duplicate object keys and empty key
        let obj = Expression::Literal(Literal::Object(vec![
            ("".into(), Expression::Literal(Literal::Number(1.0))),
            ("dup".into(), Expression::Literal(Literal::Number(2.0))),
            ("dup".into(), Expression::Literal(Literal::Number(3.0))),
        ]));

        let errs = obj.validate().unwrap_err();
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidationErrorKind::EmptyObjectKey)));
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidationErrorKind::DuplicateObjectKey { .. })));

        // Lambda param duplicates + empty param
        let lam = Expression::Lambda(Box::new(LambdaExpr {
            parameters: vec!["x".into(), "".into(), "x".into()],
            body: Expression::Identifier("x".into()),
        }));
        let errs = lam.validate().unwrap_err();
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidationErrorKind::EmptyLambdaParameter { .. })));
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidationErrorKind::DuplicateLambdaParameter { .. })));

        // Member access with empty property
        let ma = Expression::MemberAccess(Box::new(MemberAccessExpr {
            object: Expression::Identifier("user".into()),
            property: "".into(),
        }));
        let errs = ma.validate().unwrap_err();
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidationErrorKind::EmptyPropertyName)));

        // Function call empty name
        let call = Expression::FunctionCall(Box::new(FunctionCallExpr {
            function_name: "   ".into(),
            version: None,
            args: vec![],
        }));
        let errs = call.validate().unwrap_err();
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidationErrorKind::EmptyFunctionName)));
    }

    #[test]
    fn display_pretty_print_is_reasonable() {
        let expr = Expression::Binary(Box::new(BinaryExpr {
            op: BinaryOp::Multiply,
            left: Expression::Binary(Box::new(BinaryExpr {
                op: BinaryOp::Add,
                left: Expression::Identifier("a".into()),
                right: Expression::Literal(Literal::Number(2.0)),
            })),
            right: Expression::Unary(Box::new(UnaryExpr {
                op: UnaryOp::Negate,
                expr: Expression::Identifier("b".into()),
            })),
        }));

        let s = expr.to_string();

        assert!(s.contains("*"));
        assert!(s.contains("+"));
        assert!(s.contains("-b") || s.contains("- b")); // formatting nuance
    }

    #[test]
    fn bfs_order_is_deterministic_small_tree() {
        // 1 + (2 * 3)
        let expr = Expression::Binary(Box::new(BinaryExpr {
            op: BinaryOp::Add,
            left: Expression::Literal(Literal::Number(1.0)),
            right: Expression::Binary(Box::new(BinaryExpr {
                op: BinaryOp::Multiply,
                left: Expression::Literal(Literal::Number(2.0)),
                right: Expression::Literal(Literal::Number(3.0)),
            })),
        }));

        let mut order = Vec::new();
        expr.breadth_first(&mut |e| order.push(e.to_string()));

        assert_eq!(order, vec!["1 + 2 * 3", "1", "2 * 3", "2", "3",]);
    }

    #[test]
    fn precedence_and_associativity_display() {
        // a + b * c  (no unnecessary parens)
        let e1 = Expression::Binary(Box::new(BinaryExpr {
            op: BinaryOp::Add,
            left: Expression::Identifier("a".into()),
            right: Expression::Binary(Box::new(BinaryExpr {
                op: BinaryOp::Multiply,
                left: Expression::Identifier("b".into()),
                right: Expression::Identifier("c".into()),
            })),
        }));
        assert_eq!(format!("{e1}"), "a + b * c");

        // (a + b) * c  (needs parens on left)
        let e2 = Expression::Binary(Box::new(BinaryExpr {
            op: BinaryOp::Multiply,
            left: Expression::Binary(Box::new(BinaryExpr {
                op: BinaryOp::Add,
                left: Expression::Identifier("a".into()),
                right: Expression::Identifier("b".into()),
            })),
            right: Expression::Identifier("c".into()),
        }));
        assert_eq!(format!("{e2}"), "(a + b) * c");

        // (a + 2) * (-b) exact rendering
        let e3 = Expression::Binary(Box::new(BinaryExpr {
            op: BinaryOp::Multiply,
            left: Expression::Binary(Box::new(BinaryExpr {
                op: BinaryOp::Add,
                left: Expression::Identifier("a".into()),
                right: Expression::Literal(Literal::Number(2.0)),
            })),
            right: Expression::Unary(Box::new(UnaryExpr {
                op: UnaryOp::Negate,
                expr: Expression::Identifier("b".into()),
            })),
        }));
        assert_eq!(format!("{e3}"), "(a + 2) * (-b)");
    }

    struct FakeResolver;
    impl IdentifierResolver for FakeResolver {
        fn is_valid_identifier(&self, name: &str) -> bool {
            matches!(name, "ok" | "user")
        }
        fn is_valid_member(&self, base_chain: &[&str], prop: &str) -> bool {
            base_chain == ["user"] && matches!(prop, "name" | "email")
        }
        fn is_valid_function(&self, name: &str, version: Option<u32>) -> bool {
            name == "GOOD" && version == Some(2)
        }
    }

    #[test]
    fn resolver_validation_flags_unknowns() {
        let expr = Expression::Binary(Box::new(BinaryExpr {
            op: BinaryOp::Add,
            left: Expression::MemberAccess(Box::new(MemberAccessExpr {
                object: Expression::Identifier("user".into()),
                property: "badprop".into(), // invalid member
            })),
            right: Expression::FunctionCall(Box::new(FunctionCallExpr {
                function_name: "BAD".into(), // invalid function+version
                version: Some(1),
                args: vec![Expression::Identifier("nope".into())], // invalid id
            })),
        }));

        let errs = expr
            .validate_with(&ValidationConfig::default(), Some(&FakeResolver))
            .unwrap_err();
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidationErrorKind::InvalidMember { .. })));
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidationErrorKind::InvalidFunction { .. })));
        assert!(errs.iter().any(|e| matches!(e.kind, ValidationErrorKind::UnknownIdentifier { ref name } if name == "nope")));
    }

    #[test]
    fn depth_limit_trips() {
        // Build a deep left-leaning binary chain
        let mut e = Expression::Literal(Literal::Number(0.0));
        for _ in 0..10 {
            e = Expression::Binary(Box::new(BinaryExpr {
                op: BinaryOp::Add,
                left: e,
                right: Expression::Literal(Literal::Number(1.0)),
            }));
        }

        let cfg = ValidationConfig { max_depth: 5 };
        let errs = e.validate_with(&cfg, None).unwrap_err();
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidationErrorKind::DepthLimitExceeded { .. })));
    }

    #[test]
    fn dependencies_and_functions_extraction() {
        // user.name + F@v2(orders, 3)
        let expr = Expression::Binary(Box::new(BinaryExpr {
            op: BinaryOp::Add,
            left: Expression::MemberAccess(Box::new(MemberAccessExpr {
                object: Expression::Identifier("user".into()),
                property: "name".into(),
            })),
            right: Expression::FunctionCall(Box::new(FunctionCallExpr {
                function_name: "F".into(),
                version: Some(2),
                args: vec![
                    Expression::Identifier("orders".into()),
                    Expression::Literal(Literal::Number(3.0)),
                ],
            })),
        }));

        let (bases, dotted) = expr.dependencies();
        assert!(bases.contains("user"));
        assert!(bases.contains("orders"));
        assert!(dotted.contains("user.name"));

        let stats = expr.analyze();
        assert!(stats.functions.contains(&("F".to_string(), Some(2))));
    }

    #[test]
    fn constant_folding_candidates_are_counted() {
        // (1 + 2) * 3  => both inner add and outer mul are constant subtrees
        let expr = Expression::Binary(Box::new(BinaryExpr {
            op: BinaryOp::Multiply,
            left: Expression::Binary(Box::new(BinaryExpr {
                op: BinaryOp::Add,
                left: Expression::Literal(Literal::Number(1.0)),
                right: Expression::Literal(Literal::Number(2.0)),
            })),
            right: Expression::Literal(Literal::Number(3.0)),
        }));

        let stats = expr.analyze();
        assert_eq!(stats.constant_folding_candidates, 2);
    }

    // Cycle detection tests live in formula-engine (crates/formula-engine/src/deps.rs)
    // where DependencyProvider and detect_cycles are defined. They were mistakenly
    // placed here during CI-12 Parser/Lexer extraction — moved back.

    #[test]
    fn visitor_counts_nodes_matches_count_nodes() {
        let expr = Expression::Binary(Box::new(BinaryExpr {
            op: BinaryOp::Add,
            left: Expression::FunctionCall(Box::new(FunctionCallExpr {
                function_name: "SUM".into(),
                version: Some(2),
                args: vec![
                    Expression::Literal(Literal::Number(1.0)),
                    Expression::Identifier("x".into()),
                ],
            })),
            right: Expression::Unary(Box::new(UnaryExpr {
                op: UnaryOp::Negate,
                expr: Expression::Identifier("y".into()),
            })),
        }));

        struct Counter(usize);
        impl Visitor for Counter {
            fn enter_expression(&mut self, _e: &Expression) {
                self.0 += 1;
            }
        }

        let mut v = Counter(0);
        expr.accept(&mut v);
        assert_eq!(v.0, expr.count_nodes());
    }

    #[test]
    fn visitor_collects_identifiers_and_functions() {
        let expr = Expression::Binary(Box::new(BinaryExpr {
            op: BinaryOp::Add,
            left: Expression::MemberAccess(Box::new(MemberAccessExpr {
                object: Expression::Identifier("user".into()),
                property: "name".into(),
            })),
            right: Expression::FunctionCall(Box::new(FunctionCallExpr {
                function_name: "F".into(),
                version: Some(3),
                args: vec![Expression::Identifier("orders".into())],
            })),
        }));

        use std::collections::BTreeSet;
        struct Collector {
            ids: BTreeSet<String>,
            funcs: BTreeSet<(String, Option<u32>)>,
        }
        impl Visitor for Collector {
            fn visit_identifier(&mut self, name: &str) {
                self.ids.insert(name.to_string());
            }
            fn visit_versioned_identifier(&mut self, name: &str, _v: u32) {
                self.ids.insert(name.to_string());
            }
            fn enter_function_call(&mut self, f: &FunctionCallExpr) {
                self.funcs.insert((f.function_name.clone(), f.version));
            }
        }

        let mut c = Collector {
            ids: BTreeSet::new(),
            funcs: BTreeSet::new(),
        };
        expr.accept(&mut c);

        assert!(c.ids.contains("user"));
        assert!(c.ids.contains("orders"));
        assert!(c.funcs.contains(&("F".to_string(), Some(3))));
    }

    #[test]
    fn round_trip_parse_print_parse_equivalence_basic() {
        use crate::parser::Parser;
        let input = "a + (b * (c + 2)) - -d";

        let mut parser = Parser::new();
        let ast1 = parser.parse(input).expect("parse 1");
        let printed = match &ast1 {
            AstNode::Expression(e) => e.to_string(),
        };

        let mut parser2 = Parser::new();
        let ast2 = parser2.parse(&printed).expect("parse 2");
        assert_eq!(
            ast1, ast2,
            "AST should be structurally identical after print"
        );
    }

    #[test]
    fn round_trip_handles_functions_members_and_arrays() {
        use crate::parser::Parser;
        let input = r#"F@v2(user.name, [1, 2, 3], #{"k": 10})"#;

        let mut parser = Parser::new();
        let ast1 = parser.parse(input).expect("parse 1");
        let printed = match &ast1 {
            AstNode::Expression(e) => e.to_string(),
        };

        let mut parser2 = Parser::new();
        let ast2 = parser2.parse(&printed).expect("parse 2");
        assert_eq!(ast1, ast2);
    }

    fn nested_unary(depth: usize) -> Expression {
        (0..depth).fold(
            Expression::Literal(Literal::Number(1.0)),
            |expression, _| {
                Expression::Unary(Box::new(UnaryExpr {
                    op: UnaryOp::Negate,
                    expr: expression,
                }))
            },
        )
    }

    #[test]
    fn structural_depth_boundary_accepts_128_and_rejects_129() {
        nested_unary(MAX_FORMULA_AST_DEPTH)
            .validate_with(&ValidationConfig::default(), None)
            .expect("depth 128 is the accepted structural boundary");
        let errors = nested_unary(MAX_FORMULA_AST_DEPTH + 1)
            .validate_with(&ValidationConfig::default(), None)
            .expect_err("depth 129 must be rejected");
        assert!(errors.iter().any(|error| matches!(
            error.kind,
            ValidationErrorKind::DepthLimitExceeded {
                limit: MAX_FORMULA_AST_DEPTH,
                at_depth: 129
            }
        )));
    }
}

// ============================================================================
// Envelope Dispatch Types — Formula Evaluation Request/Reply
// ============================================================================
//
// Shared types for Envelope-based formula evaluation. Used by:
// - workflow (consumer): builds FormulaEvalRequest, reads FormulaEvalReply
// - formula-engine (producer): reads FormulaEvalRequest, builds FormulaEvalReply
//
// Both import from this leaf crate — neither depends on the other.
// This enables the Request/Reply Envelope pattern (§23B):
//   workflow → "formula:evaluate" Envelope → formula-engine → Reply Envelope → workflow

/// Request payload for formula evaluation via Envelope dispatch.
///
/// The requesting Slot (e.g., workflow) serializes this as the Envelope payload.
/// The formula-engine Slot deserializes it, evaluates, and sends a Reply.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormulaEvalRequest {
    /// The expression string to parse and evaluate.
    /// e.g., "steps.s1.count * input.price"
    pub expression: String,

    /// Variable bindings available during evaluation.
    /// Keys are scope names (e.g., "input", "steps", "context"),
    /// values are the JSON data for each scope.
    pub variables: serde_json::Value,
}

/// Reply payload for formula evaluation via Envelope dispatch.
///
/// The formula-engine Slot serializes this as the Reply Envelope payload.
/// The requesting Slot deserializes it to get the evaluation result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormulaEvalReply {
    /// The evaluated result as a JSON value.
    /// Null if evaluation produced no value.
    pub result: serde_json::Value,

    /// Error message if evaluation failed. None on success.
    pub error: Option<String>,
}

/// Request payload for generic binding evaluation via Envelope dispatch.
///
/// The caller provides a machine-readable binding AST plus a generic runtime
/// context object. The evaluator owns only this generic contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BindingEvalRequest {
    /// Machine-readable binding AST.
    pub binding: serde_json::Value,
    /// Generic caller-owned runtime context map.
    pub context: serde_json::Value,
}

/// Reply payload for generic binding evaluation via Envelope dispatch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BindingEvalReply {
    /// The evaluated result as JSON.
    pub result: serde_json::Value,
}

/// Batch request: evaluate multiple expressions in a single Envelope round-trip.
///
/// Template resolution often needs to evaluate many binding expressions
/// within a single step's parameters. Batching avoids N round-trips.
/// Each item has a `binding_id` so the requester can match results to
/// the original binding locations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormulaEvalBatchRequest {
    /// All expressions to evaluate, each with a unique ID for matching.
    pub evaluations: Vec<FormulaEvalBatchItem>,

    /// Shared variable bindings for all evaluations in this batch.
    /// (All bindings in a single step share the same ExecutionContext.)
    pub variables: serde_json::Value,
}

/// A single evaluation within a batch request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormulaEvalBatchItem {
    /// Unique ID for matching this evaluation to its result.
    /// The requester generates this; the responder echoes it.
    pub binding_id: String,

    /// The expression string to parse and evaluate.
    pub expression: String,
}

/// Reply payload for batch formula evaluation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormulaEvalBatchReply {
    /// Results in the same order as the request's evaluations.
    pub results: Vec<FormulaEvalBatchResult>,
}

/// A single result within a batch reply.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormulaEvalBatchResult {
    /// Matches the binding_id from the request.
    pub binding_id: String,

    /// The evaluated result, or null if evaluation failed.
    pub result: serde_json::Value,

    /// Error message if this specific evaluation failed.
    pub error: Option<String>,
}
