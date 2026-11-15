//! Single-source registry for Formula callable execution and discovery.

use crate::rules::RewriteRule;
use formula_ast::FormulaFunctionDescriptor;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use thiserror::Error;

pub struct RegisteredRule {
    pub descriptor: FormulaFunctionDescriptor,
    pub rule: Arc<dyn RewriteRule + Send + Sync>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RegistryError {
    #[error("function descriptor field `{0}` must be non-empty")]
    EmptyField(&'static str),
    #[error("function name `{0}` must be uppercase")]
    NonUppercase(String),
    #[error("function name or alias collision: `{0}`")]
    Collision(String),
}

/// Each callable is registered once with the descriptor returned to authoring
/// clients. Aliases and canonical names resolve to the same `RegisteredRule`.
pub struct RuleRegistry {
    by_canonical_name: BTreeMap<String, Arc<RegisteredRule>>,
    by_lookup_name: HashMap<String, Arc<RegisteredRule>>,
}

impl RuleRegistry {
    pub fn new() -> Self {
        Self {
            by_canonical_name: BTreeMap::new(),
            by_lookup_name: HashMap::new(),
        }
    }

    pub fn with_builtin_rules() -> Self {
        let mut registry = Self::new();
        registry.register_all_builtins();
        registry
    }

    pub fn register<R>(
        &mut self,
        descriptor: FormulaFunctionDescriptor,
        rule: R,
    ) -> Result<(), RegistryError>
    where
        R: RewriteRule + Send + Sync + 'static,
    {
        validate_descriptor(&descriptor)?;

        let mut lookup_names = Vec::with_capacity(descriptor.aliases.len() + 1);
        lookup_names.push(descriptor.name.clone());
        lookup_names.extend(descriptor.aliases.iter().cloned());
        if let Some(collision) = lookup_names
            .iter()
            .find(|name| self.by_lookup_name.contains_key(name.as_str()))
        {
            return Err(RegistryError::Collision(collision.clone()));
        }

        let canonical_name = descriptor.name.clone();
        let registered = Arc::new(RegisteredRule {
            descriptor,
            rule: Arc::new(rule),
        });
        self.by_canonical_name
            .insert(canonical_name, Arc::clone(&registered));
        for lookup_name in lookup_names {
            self.by_lookup_name
                .insert(lookup_name, Arc::clone(&registered));
        }
        Ok(())
    }

    pub fn get(&self, name: &str) -> Option<Arc<RegisteredRule>> {
        self.by_lookup_name.get(&name.to_uppercase()).cloned()
    }

    pub fn function_descriptors(&self) -> Vec<FormulaFunctionDescriptor> {
        let mut descriptors: Vec<_> = self
            .by_canonical_name
            .values()
            .map(|entry| entry.descriptor.clone())
            .collect();
        descriptors.sort_by(|left, right| {
            (&left.category, &left.name, &left.id).cmp(&(&right.category, &right.name, &right.id))
        });
        descriptors
    }

    pub fn revision(&self) -> String {
        let bytes = serde_json::to_vec(&self.function_descriptors())
            .expect("function descriptors are serializable");
        content_crypto::Multihash::blake3(&bytes).to_code_hex()
    }

    pub fn rule_names(&self) -> Vec<&str> {
        self.by_canonical_name.keys().map(String::as_str).collect()
    }

    pub fn len(&self) -> usize {
        self.by_canonical_name.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_canonical_name.is_empty()
    }

    fn register_builtin<R>(
        &mut self,
        name: &str,
        aliases: &[&str],
        category: &str,
        summary: &str,
        rule: R,
    ) where
        R: RewriteRule + Send + Sync + 'static,
    {
        let descriptor = FormulaFunctionDescriptor {
            id: format!("formula.function.{}", name.to_ascii_lowercase()),
            name: name.to_string(),
            aliases: aliases.iter().map(|alias| (*alias).to_string()).collect(),
            category: category.to_string(),
            signature: rule.pattern().to_string(),
            summary: summary.to_string(),
        };
        self.register(descriptor, rule)
            .unwrap_or_else(|error| panic!("invalid built-in `{name}`: {error}"));
    }

    fn register_all_builtins(&mut self) {
        self.register_math_rules();
        self.register_text_rules();
        self.register_logical_rules();
        self.register_datetime_rules();
        self.register_array_rules();
        self.register_conversion_rules();
        self.register_graph_rules();
        self.register_security_rules();
        self.register_crypto_rules();
    }

    fn register_math_rules(&mut self) {
        use super::math::*;
        self.register_builtin("ADD", &[], "math", "Adds numeric values.", AddRule);
        self.register_builtin(
            "SUB",
            &["SUBTRACT"],
            "math",
            "Subtracts numeric values.",
            SubRule,
        );
        self.register_builtin(
            "MUL",
            &["MULTIPLY"],
            "math",
            "Multiplies numeric values.",
            MulRule,
        );
        self.register_builtin(
            "DIV",
            &["DIVIDE"],
            "math",
            "Divides numeric values.",
            DivRule,
        );
        self.register_builtin(
            "MOD",
            &["MODULO"],
            "math",
            "Returns a numeric remainder.",
            ModRule,
        );
        self.register_builtin("CEIL", &["CEILING"], "math", "Rounds upward.", CeilRule);
        self.register_builtin("FLOOR", &[], "math", "Rounds downward.", FloorRule);
        self.register_builtin("ABS", &[], "math", "Returns absolute magnitude.", AbsRule);
        self.register_builtin("SIGN", &[], "math", "Returns a number's sign.", SignRule);
        self.register_builtin("ROUND", &[], "math", "Rounds a numeric value.", RoundRule);
        self.register_builtin("DSUM", &[], "math", "Sums decimal values.", DSumRule);
        self.register_builtin("MIN", &[], "math", "Returns the minimum value.", MinRule);
        self.register_builtin("MAX", &[], "math", "Returns the maximum value.", MaxRule);
        self.register_builtin(
            "AVERAGE",
            &["AVG"],
            "math",
            "Returns the arithmetic mean.",
            AverageRule,
        );
        self.register_builtin(
            "MEDIAN",
            &[],
            "math",
            "Returns the median value.",
            MedianRule,
        );
        self.register_builtin("COUNT", &[], "math", "Counts supplied values.", CountRule);
        self.register_builtin("SQRT", &[], "math", "Returns a square root.", SqrtRule);
        self.register_builtin(
            "EXP",
            &[],
            "math",
            "Returns the natural exponential.",
            ExpRule,
        );
        self.register_builtin("LN", &[], "math", "Returns a natural logarithm.", LnRule);
        self.register_builtin(
            "LOG10",
            &["LOG"],
            "math",
            "Returns a base-10 logarithm.",
            Log10Rule,
        );
        self.register_builtin("LOG2", &[], "math", "Returns a base-2 logarithm.", Log2Rule);
        self.register_builtin("SIN", &[], "math", "Returns the sine.", SinRule);
        self.register_builtin("COS", &[], "math", "Returns the cosine.", CosRule);
        self.register_builtin("TAN", &[], "math", "Returns the tangent.", TanRule);
        self.register_builtin(
            "ASIN",
            &["ARCSIN"],
            "math",
            "Returns the inverse sine.",
            AsinRule,
        );
        self.register_builtin(
            "ACOS",
            &["ARCCOS"],
            "math",
            "Returns the inverse cosine.",
            AcosRule,
        );
        self.register_builtin(
            "ATAN",
            &["ARCTAN"],
            "math",
            "Returns the inverse tangent.",
            AtanRule,
        );
        self.register_builtin("CBRT", &[], "math", "Returns a cube root.", CbrtRule);
        self.register_builtin(
            "POW",
            &["POWER"],
            "math",
            "Raises a value to a power.",
            PowRule,
        );
        self.register_builtin("PI", &[], "math", "Returns the pi constant.", PiRule);
        self.register_builtin("E", &[], "math", "Returns Euler's number.", ERule);
        self.register_builtin("FSUM", &[], "math", "Sums floating-point values.", FSumRule);
        self.register_builtin(
            "FMEDIAN",
            &[],
            "math",
            "Returns a floating-point median.",
            FMedianRule,
        );
    }

    fn register_text_rules(&mut self) {
        use super::text::*;
        self.register_builtin(
            "CONCAT",
            &[],
            "text",
            "Concatenates text values.",
            ConcatRule,
        );
        self.register_builtin("LEN", &["LENGTH"], "text", "Returns text length.", LenRule);
        self.register_builtin(
            "TRIM",
            &[],
            "text",
            "Trims surrounding whitespace.",
            TrimRule,
        );
        self.register_builtin(
            "UPPER",
            &[],
            "text",
            "Converts text to uppercase.",
            UpperRule,
        );
        self.register_builtin(
            "LOWER",
            &[],
            "text",
            "Converts text to lowercase.",
            LowerRule,
        );
        self.register_builtin("LEFT", &[], "text", "Returns text from the left.", LeftRule);
        self.register_builtin(
            "RIGHT",
            &[],
            "text",
            "Returns text from the right.",
            RightRule,
        );
        self.register_builtin(
            "MID",
            &["SUBSTRING"],
            "text",
            "Returns a text segment.",
            MidRule,
        );
        self.register_builtin("FIND", &[], "text", "Finds text within text.", FindRule);
        self.register_builtin(
            "SUBSTITUTE",
            &[],
            "text",
            "Substitutes matching text.",
            SubstituteRule,
        );
        self.register_builtin("SPLIT", &[], "text", "Splits text into values.", SplitRule);
        self.register_builtin("JOIN", &[], "text", "Joins values into text.", JoinRule);
        self.register_builtin(
            "CONTAINS",
            &[],
            "text",
            "Tests whether text contains text.",
            ContainsRule,
        );
        self.register_builtin("REPEAT", &[], "text", "Repeats text.", RepeatRule);
        self.register_builtin(
            "LTRIM",
            &["TRIMLEFT"],
            "text",
            "Trims leading whitespace.",
            LTrimRule,
        );
        self.register_builtin(
            "RTRIM",
            &["TRIMRIGHT"],
            "text",
            "Trims trailing whitespace.",
            RTrimRule,
        );
        self.register_builtin(
            "BASE64_ENCODE",
            &["BASE64ENCODE"],
            "text",
            "Encodes text as Base64.",
            Base64EncodeRule,
        );
        self.register_builtin(
            "BASE64_DECODE",
            &["BASE64DECODE"],
            "text",
            "Decodes Base64 text.",
            Base64DecodeRule,
        );
        self.register_builtin("FORMAT", &[], "text", "Formats text values.", FormatRule);
        self.register_builtin(
            "REPLACE",
            &[],
            "text",
            "Replaces a text range.",
            ReplaceRule,
        );
        self.register_builtin(
            "NORMALIZE",
            &[],
            "text",
            "Normalizes Unicode text.",
            NormalizeRule,
        );
        self.register_builtin(
            "CASEFOLD",
            &[],
            "text",
            "Case-folds Unicode text.",
            CaseFoldRule,
        );
        self.register_builtin(
            "REGEX_EXTRACT",
            &[],
            "text",
            "Extracts a regular-expression match.",
            RegexExtractRule,
        );
        self.register_builtin(
            "JSON_PARSE",
            &[],
            "text",
            "Parses JSON text.",
            JsonParseRule,
        );
    }

    fn register_logical_rules(&mut self) {
        use super::logical::*;
        self.register_builtin(
            "AND",
            &[],
            "logical",
            "Returns logical conjunction.",
            AndRule,
        );
        self.register_builtin("OR", &[], "logical", "Returns logical disjunction.", OrRule);
        self.register_builtin("NOT", &[], "logical", "Negates a logical value.", NotRule);
        self.register_builtin("XOR", &[], "logical", "Returns exclusive-or.", XorRule);
        self.register_builtin(
            "IF",
            &[],
            "logical",
            "Selects a branch by condition.",
            IfRule,
        );
        self.register_builtin(
            "SWITCH",
            &[],
            "logical",
            "Selects a matching branch.",
            SwitchRule,
        );
        self.register_builtin(
            "COALESCE",
            &[],
            "logical",
            "Returns the first non-null value.",
            CoalesceRule,
        );
        self.register_builtin(
            "ISNULL",
            &["IS_NULL"],
            "logical",
            "Tests for null.",
            IsNullRule,
        );
        self.register_builtin(
            "ISEMPTY",
            &["IS_EMPTY"],
            "logical",
            "Tests for an empty value.",
            IsEmptyRule,
        );
        self.register_builtin(
            "IFERROR",
            &["IF_ERROR"],
            "logical",
            "Selects a fallback on error.",
            IfErrorRule,
        );
        self.register_builtin(
            "TRY",
            &[],
            "logical",
            "Captures an evaluation error.",
            TryRule,
        );
        self.register_builtin(
            "IFNULL",
            &["IF_NULL"],
            "logical",
            "Selects a fallback for null.",
            IfNullRule,
        );
        self.register_builtin(
            "BOOL",
            &["BOOLEAN"],
            "logical",
            "Converts a value to boolean.",
            BoolRule,
        );
    }

    fn register_datetime_rules(&mut self) {
        use super::datetime::*;
        self.register_builtin(
            "NOW",
            &[],
            "datetime",
            "Returns deterministic evaluation time.",
            NowRule,
        );
        self.register_builtin("DATE", &[], "datetime", "Constructs a date.", DateRule);
        self.register_builtin("TIME", &[], "datetime", "Constructs a time.", TimeRule);
        self.register_builtin(
            "DATETIME",
            &[],
            "datetime",
            "Constructs a date-time.",
            DateTimeRule,
        );
        self.register_builtin("YEAR", &[], "datetime", "Returns a year.", YearRule);
        self.register_builtin("MONTH", &[], "datetime", "Returns a month.", MonthRule);
        self.register_builtin("DAY", &[], "datetime", "Returns a day.", DayRule);
        self.register_builtin("HOUR", &[], "datetime", "Returns an hour.", HourRule);
        self.register_builtin("MINUTE", &[], "datetime", "Returns a minute.", MinuteRule);
        self.register_builtin("SECOND", &[], "datetime", "Returns a second.", SecondRule);
        self.register_builtin(
            "WEEKDAY",
            &[],
            "datetime",
            "Returns a weekday.",
            WeekdayRule,
        );
        self.register_builtin(
            "DATEADD",
            &["DATE_ADD"],
            "datetime",
            "Adds a date interval.",
            DateAddRule,
        );
        self.register_builtin(
            "DATEDIFF",
            &["DATE_DIFF"],
            "datetime",
            "Returns a date difference.",
            DateDiffRule,
        );
        self.register_builtin(
            "DATE_FORMAT",
            &["DATEFORMAT", "FORMATDATE", "FORMAT_DATE"],
            "datetime",
            "Formats a date.",
            DateFormatRule,
        );
        self.register_builtin(
            "TIME_FORMAT",
            &["TIMEFORMAT", "FORMATTIME", "FORMAT_TIME"],
            "datetime",
            "Formats a time.",
            TimeFormatRule,
        );
        self.register_builtin(
            "CONVERT_TZ",
            &["CONVERTTZ"],
            "datetime",
            "Converts a timezone.",
            ConvertTzRule,
        );
        self.register_builtin(
            "WORKDAYS",
            &[],
            "datetime",
            "Counts working days.",
            WorkdaysRule,
        );
        self.register_builtin(
            "TIMESTAMP",
            &[],
            "datetime",
            "Creates a timestamp.",
            TimestampRule,
        );
        self.register_builtin(
            "FROM_TIMESTAMP",
            &["FROMTIMESTAMP"],
            "datetime",
            "Reads a timestamp.",
            FromTimestampRule,
        );
        self.register_builtin(
            "START_OF",
            &["STARTOF"],
            "datetime",
            "Returns an interval start.",
            StartOfRule,
        );
        self.register_builtin(
            "END_OF",
            &["ENDOF"],
            "datetime",
            "Returns an interval end.",
            EndOfRule,
        );
        self.register_builtin(
            "USER_TZ",
            &["USERTZ"],
            "datetime",
            "Returns the evaluation timezone.",
            UserTzRule,
        );
    }

    fn register_array_rules(&mut self) {
        use super::array::*;
        self.register_builtin(
            "ARRAY_LENGTH",
            &["ARRAYLENGTH"],
            "array",
            "Returns array length.",
            ArrayLengthRule,
        );
        self.register_builtin(
            "ARRAY_GET",
            &["ARRAYGET", "NTH"],
            "array",
            "Returns an array element.",
            ArrayGetRule,
        );
        self.register_builtin(
            "ARRAY_CONTAINS",
            &["ARRAYCONTAINS", "INCLUDES"],
            "array",
            "Tests array membership.",
            ArrayContainsRule,
        );
        self.register_builtin("LOOKUP", &[], "array", "Looks up a value.", LookupRule);
        self.register_builtin(
            "INDEX_OF",
            &["INDEXOF"],
            "array",
            "Returns an element index.",
            IndexOfRule,
        );
        self.register_builtin("FILTER", &[], "array", "Filters array values.", FilterRule);
        self.register_builtin("MAP", &[], "array", "Maps array values.", MapRule);
        self.register_builtin("REDUCE", &[], "array", "Reduces array values.", ReduceRule);
        self.register_builtin(
            "COUNTIF",
            &["COUNT_IF"],
            "array",
            "Counts matching values.",
            CountIfRule,
        );
        self.register_builtin("SIZE", &[], "array", "Returns collection size.", SizeRule);
    }

    fn register_conversion_rules(&mut self) {
        use super::conversion::*;
        self.register_builtin(
            "VALUE",
            &["TONUMBER", "TO_NUMBER"],
            "conversion",
            "Converts to a number.",
            ValueRule,
        );
        self.register_builtin(
            "TEXT",
            &["TOSTRING", "TO_STRING"],
            "conversion",
            "Converts to text.",
            TextRule,
        );
        self.register_builtin(
            "IS_NUMBER",
            &["ISNUMBER"],
            "conversion",
            "Tests for a number.",
            IsNumberRule,
        );
        self.register_builtin(
            "IS_NAN",
            &["ISNAN"],
            "conversion",
            "Tests for NaN.",
            IsNanRule,
        );
        self.register_builtin(
            "IS_FINITE",
            &["ISFINITE"],
            "conversion",
            "Tests for a finite number.",
            IsFiniteRule,
        );
    }

    fn register_graph_rules(&mut self) {
        use super::graph::*;
        self.register_builtin(
            "PARENTS",
            &[],
            "graph",
            "Returns parent entities.",
            ParentsRule,
        );
        self.register_builtin(
            "CHILDREN",
            &[],
            "graph",
            "Returns child entities.",
            ChildrenRule,
        );
        self.register_builtin(
            "NEIGHBORS",
            &[],
            "graph",
            "Returns neighboring entities.",
            NeighborsRule,
        );
        self.register_builtin(
            "TRAVERSE",
            &[],
            "graph",
            "Traverses entity relationships.",
            TraverseRule,
        );
    }

    fn register_security_rules(&mut self) {
        use super::security::*;
        self.register_builtin("CAN", &[], "security", "Tests a permission.", CanRule);
        self.register_builtin(
            "CURRENT_USER",
            &["CURRENTUSER"],
            "security",
            "Returns the current user.",
            CurrentUserRule,
        );
        self.register_builtin(
            "GET_ENTITY",
            &["GETENTITY"],
            "security",
            "Reads an authorized entity.",
            GetEntityRule,
        );
        self.register_builtin(
            "EMIT_EVENT",
            &["EMITEVENT"],
            "security",
            "Emits an authorized event.",
            EmitEventRule,
        );
        self.register_builtin(
            "HAS_ROLE",
            &["HASROLE"],
            "security",
            "Tests a user role.",
            HasRoleRule,
        );
    }

    fn register_crypto_rules(&mut self) {
        use super::crypto::*;
        self.register_builtin("HASH", &["BLAKE3"], "crypto", "Hashes a value.", HashRule);
        self.register_builtin(
            "HMAC",
            &[],
            "crypto",
            "Authenticates a value with HMAC.",
            HmacRule,
        );
    }
}

impl Default for RuleRegistry {
    fn default() -> Self {
        Self::with_builtin_rules()
    }
}

pub struct RuleRegistryBuilder {
    registry: RuleRegistry,
    include_math: bool,
    include_text: bool,
    include_logical: bool,
    include_datetime: bool,
    include_array: bool,
    include_conversion: bool,
    include_graph: bool,
    include_security: bool,
    include_crypto: bool,
}

impl RuleRegistryBuilder {
    pub fn new() -> Self {
        Self {
            registry: RuleRegistry::new(),
            include_math: false,
            include_text: false,
            include_logical: false,
            include_datetime: false,
            include_array: false,
            include_conversion: false,
            include_graph: false,
            include_security: false,
            include_crypto: false,
        }
    }

    pub fn with_all() -> Self {
        Self {
            include_math: true,
            include_text: true,
            include_logical: true,
            include_datetime: true,
            include_array: true,
            include_conversion: true,
            include_graph: true,
            include_security: true,
            include_crypto: true,
            ..Self::new()
        }
    }

    pub fn with_math(mut self) -> Self {
        self.include_math = true;
        self
    }
    pub fn with_text(mut self) -> Self {
        self.include_text = true;
        self
    }
    pub fn with_logical(mut self) -> Self {
        self.include_logical = true;
        self
    }
    pub fn with_datetime(mut self) -> Self {
        self.include_datetime = true;
        self
    }
    pub fn with_array(mut self) -> Self {
        self.include_array = true;
        self
    }
    pub fn with_conversion(mut self) -> Self {
        self.include_conversion = true;
        self
    }
    pub fn with_graph(mut self) -> Self {
        self.include_graph = true;
        self
    }
    pub fn with_security(mut self) -> Self {
        self.include_security = true;
        self
    }
    pub fn with_crypto(mut self) -> Self {
        self.include_crypto = true;
        self
    }

    pub fn build(mut self) -> RuleRegistry {
        if self.include_math {
            self.registry.register_math_rules();
        }
        if self.include_text {
            self.registry.register_text_rules();
        }
        if self.include_logical {
            self.registry.register_logical_rules();
        }
        if self.include_datetime {
            self.registry.register_datetime_rules();
        }
        if self.include_array {
            self.registry.register_array_rules();
        }
        if self.include_conversion {
            self.registry.register_conversion_rules();
        }
        if self.include_graph {
            self.registry.register_graph_rules();
        }
        if self.include_security {
            self.registry.register_security_rules();
        }
        if self.include_crypto {
            self.registry.register_crypto_rules();
        }
        self.registry
    }
}

impl Default for RuleRegistryBuilder {
    fn default() -> Self {
        Self::with_all()
    }
}

fn validate_descriptor(descriptor: &FormulaFunctionDescriptor) -> Result<(), RegistryError> {
    for (field, value) in [
        ("id", descriptor.id.as_str()),
        ("name", descriptor.name.as_str()),
        ("category", descriptor.category.as_str()),
        ("signature", descriptor.signature.as_str()),
        ("summary", descriptor.summary.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(RegistryError::EmptyField(field));
        }
    }
    for name in std::iter::once(&descriptor.name).chain(descriptor.aliases.iter()) {
        if name.trim().is_empty() {
            return Err(RegistryError::EmptyField("alias"));
        }
        if *name != name.to_uppercase() {
            return Err(RegistryError::NonUppercase(name.clone()));
        }
    }
    let mut names = std::collections::BTreeSet::new();
    for name in std::iter::once(&descriptor.name).chain(descriptor.aliases.iter()) {
        if !names.insert(name) {
            return Err(RegistryError::Collision(name.clone()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::math::AbsRule;

    fn descriptor(name: &str, aliases: &[&str]) -> FormulaFunctionDescriptor {
        FormulaFunctionDescriptor {
            id: format!("formula.function.{}", name.to_ascii_lowercase()),
            name: name.to_string(),
            aliases: aliases.iter().map(|alias| (*alias).to_string()).collect(),
            category: "test".to_string(),
            signature: format!("{name}(value)"),
            summary: format!("Tests {name}."),
        }
    }

    #[test]
    fn exact_callable_catalog_bijection_and_aliases() {
        let registry = RuleRegistry::with_builtin_rules();
        let descriptors = registry.function_descriptors();
        assert_eq!(descriptors.len(), registry.len());
        for descriptor in descriptors {
            let canonical = registry.get(&descriptor.name).expect("canonical callable");
            assert_eq!(canonical.descriptor, descriptor);
            for alias in &descriptor.aliases {
                let resolved = registry.get(alias).expect("alias callable");
                assert!(Arc::ptr_eq(&canonical, &resolved));
            }
        }
    }

    #[test]
    fn rejects_name_and_alias_collisions() {
        let mut registry = RuleRegistry::new();
        registry
            .register(descriptor("ABS", &["MAG"]), AbsRule)
            .unwrap();
        assert_eq!(
            registry.register(descriptor("MAG", &[]), AbsRule),
            Err(RegistryError::Collision("MAG".to_string()))
        );
    }

    #[test]
    fn deterministic_catalog_bytes_and_revision() {
        let first = RuleRegistry::with_builtin_rules();
        let second = RuleRegistry::with_builtin_rules();
        let fixture = include_str!("../../tests/fixtures/builtin-function-catalog-v1.json")
            .trim_end()
            .as_bytes();
        assert_eq!(
            serde_json::to_vec(&first.function_descriptors()).unwrap(),
            fixture
        );
        assert_eq!(
            serde_json::to_vec(&first.function_descriptors()).unwrap(),
            serde_json::to_vec(&second.function_descriptors()).unwrap()
        );
        assert_eq!(first.revision(), second.revision());
    }

    #[test]
    fn builder_selective_categories() {
        let registry = RuleRegistryBuilder::new()
            .with_math()
            .with_conversion()
            .build();
        assert!(registry.get("DIV").is_some());
        assert!(registry.get("VALUE").is_some());
        assert!(registry.get("TRAVERSE").is_none());
    }
}
