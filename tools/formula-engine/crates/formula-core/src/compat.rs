//! Developer-facing type-compatibility lookup and markdown generator.
//! This mirrors the evaluator's behavior (arithmetic, comparisons, logical, access).

/// Canonical type ids (do not depend on runtime `Value`, this is a summary view)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TypeId {
    Null,
    Bool,
    Number,
    String,
    Array,
    Object,
}

pub const ALL_TYPES: &[TypeId] = &[
    TypeId::Null,
    TypeId::Bool,
    TypeId::Number,
    TypeId::String,
    TypeId::Array,
    TypeId::Object,
];

impl TypeId {
    pub fn as_str(self) -> &'static str {
        match self {
            TypeId::Null => "null",
            TypeId::Bool => "boolean",
            TypeId::Number => "number",
            TypeId::String => "string",
            TypeId::Array => "array",
            TypeId::Object => "object",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnOp {
    Neg,
    Not,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultKind {
    /// Operator returns a concrete type
    Type(TypeId),
    /// Operator returns `null` (null-propagation)
    Null,
    /// Operator yields a boolean (including 3VL for logical)
    Bool,
    /// Type mismatch
    Error,
}

/// Unary lookup
pub fn lookup_unop(op: UnOp, t: TypeId) -> ResultKind {
    match op {
        UnOp::Neg => match t {
            TypeId::Number => ResultKind::Type(TypeId::Number),
            TypeId::Null => ResultKind::Null,
            _ => ResultKind::Error,
        },
        UnOp::Not => match t {
            TypeId::Bool => ResultKind::Bool,
            TypeId::Null => ResultKind::Null,
            _ => ResultKind::Error,
        },
    }
}

/// Binary lookup (arithmetic/comparison/logical)
pub fn lookup_binop(op: BinOp, a: TypeId, b: TypeId) -> ResultKind {
    use BinOp::*;

    match op {
        Add => {
            if a == TypeId::Null || b == TypeId::Null {
                return ResultKind::Null;
            }
            if a == TypeId::String || b == TypeId::String {
                return ResultKind::Type(TypeId::String);
            }
            if a == TypeId::Number && b == TypeId::Number {
                return ResultKind::Type(TypeId::Number);
            }
            ResultKind::Error
        }
        Sub | Mul | Div | Mod => {
            if a == TypeId::Null || b == TypeId::Null {
                return ResultKind::Null;
            }
            if a == TypeId::Number && b == TypeId::Number {
                return ResultKind::Type(TypeId::Number);
            }
            ResultKind::Error
        }
        Eq | Ne => {
            // equality always yields Bool; special-cased for nulls at runtime:
            // - null == null -> true, null != null -> false
            // - null compared to non-null -> false / true respectively
            // - cross-type non-null equality -> false
            ResultKind::Bool
        }
        Lt | Le | Gt | Ge => {
            if a == TypeId::Null || b == TypeId::Null {
                return ResultKind::Null;
            }
            match (a, b) {
                (TypeId::Number, TypeId::Number) => ResultKind::Bool,
                (TypeId::String, TypeId::String) => ResultKind::Bool,
                _ => ResultKind::Error,
            }
        }
        And | Or => {
            // Three-valued logic; result domain is boolean with `null` as third value,
            // but from the type system perspective it's "boolean-like"
            ResultKind::Bool
        }
    }
}

/// Member access result kind given base type
pub fn lookup_member(base: TypeId) -> ResultKind {
    match base {
        TypeId::Null => ResultKind::Null,
        TypeId::Object => ResultKind::Type(TypeId::Null), // unknown field -> could be any; document as nullable
        _ => ResultKind::Error,
    }
}

/// Index access result kind given base and index type
pub fn lookup_index(base: TypeId, index: TypeId) -> ResultKind {
    match (base, index) {
        (TypeId::Null, _) => ResultKind::Null,
        (TypeId::Array, TypeId::Number) => ResultKind::Type(TypeId::Null), // element or null if OOB
        (TypeId::Object, TypeId::String) => ResultKind::Type(TypeId::Null), // value or null if missing
        _ => ResultKind::Error,
    }
}

/// Generate markdown aligned with docs/type-compatibility.md
pub fn generate_type_compat_markdown() -> String {
    let mut out = String::new();
    out.push_str("# Generated Type Compatibility Tables\n\n");

    // Unary
    out.push_str("## Unary\n\n");
    for op in [UnOp::Neg, UnOp::Not] {
        out.push_str(&format!("### `{:?}`\n", op));
        out.push_str("| Type | Result |\n|------|--------|\n");
        for t in ALL_TYPES {
            let r = lookup_unop(op, *t);
            out.push_str(&format!("| {} | {} |\n", t.as_str(), fmt_result(r)));
        }
        out.push('\n');
    }

    // Binary
    out.push_str("## Binary\n\n");
    let bin_ops = [
        BinOp::Add,
        BinOp::Sub,
        BinOp::Mul,
        BinOp::Div,
        BinOp::Mod,
        BinOp::Eq,
        BinOp::Ne,
        BinOp::Lt,
        BinOp::Le,
        BinOp::Gt,
        BinOp::Ge,
        BinOp::And,
        BinOp::Or,
    ];
    for op in bin_ops {
        out.push_str(&format!("### `{:?}`\n", op));
        out.push_str("| Left \\ Right | null | boolean | number | string | array | object |\n");
        out.push_str("|--------------|------|---------|--------|--------|-------|--------|\n");
        for a in ALL_TYPES {
            out.push_str(&format!("| {} ", a.as_str()));
            for b in ALL_TYPES {
                let r = lookup_binop(op, *a, *b);
                out.push_str(&format!("| {} ", fmt_result(r)));
            }
            out.push_str("|\n");
        }
        out.push('\n');
    }

    // Access
    out.push_str("## Member access `obj.prop`\n\n");
    out.push_str("| Base | Result |\n|------|--------|\n");
    for t in ALL_TYPES {
        out.push_str(&format!(
            "| {} | {} |\n",
            t.as_str(),
            fmt_result(lookup_member(*t))
        ));
    }
    out.push('\n');

    out.push_str("## Index access `base[idx]`\n\n");
    out.push_str("| Base \\ Index | null | boolean | number | string | array | object |\n");
    out.push_str("|--------------|------|---------|--------|--------|-------|--------|\n");
    for base in ALL_TYPES {
        out.push_str(&format!("| {} ", base.as_str()));
        for idx in ALL_TYPES {
            out.push_str(&format!("| {} ", fmt_result(lookup_index(*base, *idx))));
        }
        out.push_str("|\n");
    }
    out.push('\n');

    out
}

fn fmt_result(r: ResultKind) -> &'static str {
    match r {
        ResultKind::Type(t) => t.as_str(),
        ResultKind::Null => "null",
        ResultKind::Bool => "boolean",
        ResultKind::Error => "error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanity_binop_examples() {
        // string + number => string
        assert_eq!(
            lookup_binop(BinOp::Add, TypeId::String, TypeId::Number),
            ResultKind::Type(TypeId::String)
        );
        // number + null => null
        assert_eq!(
            lookup_binop(BinOp::Add, TypeId::Number, TypeId::Null),
            ResultKind::Null
        );
        // number * number => number
        assert_eq!(
            lookup_binop(BinOp::Mul, TypeId::Number, TypeId::Number),
            ResultKind::Type(TypeId::Number)
        );
        // boolean / number => error
        assert_eq!(
            lookup_binop(BinOp::Div, TypeId::Bool, TypeId::Number),
            ResultKind::Error
        );
        // eq always boolean (runtime decides truth)
        assert_eq!(
            lookup_binop(BinOp::Eq, TypeId::Object, TypeId::Array),
            ResultKind::Bool
        );
        // ordering with strings is allowed
        assert_eq!(
            lookup_binop(BinOp::Lt, TypeId::String, TypeId::String),
            ResultKind::Bool
        );
        // ordering null-propagates
        assert_eq!(
            lookup_binop(BinOp::Lt, TypeId::Number, TypeId::Null),
            ResultKind::Null
        );
        // ordering across incompatible types -> error
        assert_eq!(
            lookup_binop(BinOp::Lt, TypeId::Number, TypeId::String),
            ResultKind::Error
        );
    }

    #[test]
    fn sanity_unary_examples() {
        assert_eq!(
            lookup_unop(UnOp::Neg, TypeId::Number),
            ResultKind::Type(TypeId::Number)
        );
        assert_eq!(lookup_unop(UnOp::Neg, TypeId::Null), ResultKind::Null);
        assert_eq!(lookup_unop(UnOp::Not, TypeId::Bool), ResultKind::Bool);
        assert_eq!(lookup_unop(UnOp::Not, TypeId::String), ResultKind::Error);
    }

    #[test]
    fn access_examples() {
        // object.prop => nullable (unknown field existence)
        assert!(matches!(
            lookup_member(TypeId::Object),
            ResultKind::Type(TypeId::Null)
        ));
        // null.prop => null
        assert_eq!(lookup_member(TypeId::Null), ResultKind::Null);
        // array.prop => error
        assert_eq!(lookup_member(TypeId::Array), ResultKind::Error);

        // array[number] => nullable
        assert!(matches!(
            lookup_index(TypeId::Array, TypeId::Number),
            ResultKind::Type(TypeId::Null)
        ));
        // object[string] => nullable
        assert!(matches!(
            lookup_index(TypeId::Object, TypeId::String),
            ResultKind::Type(TypeId::Null)
        ));
        // null[...] => null
        assert_eq!(lookup_index(TypeId::Null, TypeId::Number), ResultKind::Null);
        // wrong base / index => error
        assert_eq!(
            lookup_index(TypeId::String, TypeId::Number),
            ResultKind::Error
        );
    }

    #[test]
    fn generates_markdown() {
        let md = generate_type_compat_markdown();
        assert!(md.contains("# Generated Type Compatibility Tables"));
        assert!(md.contains("### `Add`"));
        assert!(md.contains("## Member access"));
        assert!(md.lines().count() > 50);
    }
}
