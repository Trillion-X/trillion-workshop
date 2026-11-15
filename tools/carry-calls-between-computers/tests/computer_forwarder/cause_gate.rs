//! The existing full pre-push gate executes this target. Each fixture plants a
//! distinct way an error or refusal could lose its mandatory construction cause.
#[path = "../../src/mcp/cause_gate.rs"]
mod checker;

#[test]
fn every_refusal_cause_inventory_names_primitive_error_return_signatures_only() {
    for (error, category) in [
        ("String", "String"),
        ("&'static str", "&str"),
        ("&str", "&str"),
        ("()", "()"),
        ("std::io::Error", "io::Error"),
    ] {
        let source = format!("fn parse(input: &str) -> Result<Vec<String>, {error}> {{ todo!() }}");
        let found = checker::primitive_source(&source);
        assert_eq!(found.len(), 1, "{source}");
        assert_eq!(
            (
                found[0].function.as_str(),
                found[0].category.as_str(),
                found[0].line
            ),
            ("parse", category, 1)
        );
    }
    let source = "type Code = &'static str; type Answer<T> = std::result::Result<T, Code>;\nfn parse() -> Answer<String> { todo!() }\nfn nested() -> Option<Result<Vec<u8>, ()>> { todo!() }\nfn read() -> io::Result<Vec<u8>> { todo!() }";
    let found = checker::primitive_source(source);
    assert_eq!(
        found
            .iter()
            .map(|item| (item.function.as_str(), item.category.as_str()))
            .collect::<Vec<_>>(),
        [("parse", "&str"), ("nested", "()"), ("read", "io::Error")]
    );
    assert_eq!(
        checker::primitive_source(
            "use std::io::Result as IoResult; fn read() -> IoResult<Vec<u8>>;"
        )
        .len(),
        1
    );
    assert_eq!(
        checker::primitive_source(
            "fn parse<T: Fn() -> String>(input: T) -> Result<String, String> { todo!() }"
        )
        .len(),
        1
    );
    assert!(checker::primitive_source(
        r#"
        // fn fake() -> Result<(), String>;
        const WORDS: &str = "fn fake() -> Result<(), String>";
        fn classifier() -> &'static str { "denied" }
        fn value() -> String { String::new() }
        fn parse() -> Result<String, LocalError> { todo!() }
        fn safe() -> Result<String, CodedError<&'static str>> { todo!() }
        fn callback<T: Fn() -> Result<(), String>>(f: T) -> bool { true }
        type Key = Zeroizing<[u8; 32]>;
        type Table<T = Vec<u8>> = Vec<T>;
    "#
    )
    .is_empty());
}

#[test]
fn every_refusal_cause_inventory_keeps_standard_io_abi_with_a_source_wrapped_body() {
    let positive = "impl std::io::Read for Reader { fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> { trillion_local::io_operation!(self.file.read(buffer)) } }";
    assert!(checker::primitive_source(positive).is_empty());
    assert!(checker::primitive_source("fn write() -> io::Result<()> { work().map_err(|error| crate::refusal_cause::locate_io(error, trillion_local::cause!())) }").is_empty());
    for body in [
        "self.file.read(buffer)",
        "// io_operation!(self.file.read(buffer))\nself.file.read(buffer)",
        r#"let fake = "locate_io(error, cause)"; self.file.read(buffer)"#,
        "fn helper() -> io::Result<()> { io_operation!(work()) } self.file.read(buffer)",
        "#[cfg(test)] fn helper() { io_operation!(work()); } self.file.read(buffer)",
        "if flag { return self.file.read(buffer); } crate::io_operation!(self.file.read(buffer))",
        "crate::io_operation!(self.file.read(buffer))?; self.file.read(buffer)",
        "self.file.read(buffer)?; crate::io_operation!(self.file.read(buffer))",
        "crate::io_operation!(self.file.read(buffer)?.read(buffer))",
        "crate::io_operation!({ return self.file.read(buffer); })",
        "if flag { self.file.read(buffer) } else { crate::io_operation!(self.file.read(buffer)) }",
        "match flag { true => self.file.read(buffer), false => crate::io_operation!(self.file.read(buffer)) }",
        "loop { crate::io_operation!(self.file.read(buffer))?; return self.file.read(buffer); }",
        "loop { crate::io_operation!(self.file.read(buffer))?; break self.file.read(buffer); }",
    ] {
        let source = format!("impl std::io::Read for Reader {{ fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {{ {body} }} }}");
        assert!(
            checker::primitive_source(&source)
                .iter()
                .any(|item| item.function == "read" && item.category == "io::Error"),
            "{source}"
        );
    }
    for body in [
        "if flag { return crate::io_operation!(self.file.read(buffer)); } crate::io_operation!(self.file.read(buffer))",
        "crate::io_operation!(self.file.read(buffer))?; Ok(1)",
        "match flag { true => crate::io_operation!(self.file.read(buffer)), false => Ok(0) }",
        "if flag { crate::io_operation!(self.file.read(buffer)) } else { Ok(0) }",
        "let value = (crate::io_operation!(self.file.read(buffer))?); Ok(value)",
        "Err(crate::refusal_cause::locate_io(error, crate::cause!()))",
        "loop { if flag { return crate::io_operation!(self.file.read(buffer)); } crate::io_operation!(self.file.read(buffer))?; }",
    ] {
        assert!(checker::primitive_source(&format!("fn read() -> io::Result<usize> {{ {body} }}")).is_empty(), "{body}");
    }
    assert_eq!(
        checker::primitive_source("fn raw() -> Result<(), String> { io_operation!(work()) }").len(),
        1
    );
}

#[test]
fn nested_guarded_io_propagation_inside_parentheses_keeps_valid_delimiters() {
    // The real folder_identity expression from account_files/account_routes.rs.
    // Its prefix at the inner ? has an opening '(' whose close is later.
    let source = r#"
        fn folder_identity(folder: &Path) -> std::io::Result<String> {
            let metadata = crate::io_operation!((std::fs::metadata(folder)).map_err(std::io::Error::from))?;
            let created = crate::io_operation!((crate::io_operation!((metadata
                .created()).map_err(std::io::Error::from))?
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(std::io::Error::other)).map_err(std::io::Error::from))?;
            Ok(format!("{}", created.as_secs()))
        }
    "#;
    assert!(checker::primitive_source(source).is_empty());
    let unguarded = source.replace(
        "crate::io_operation!((metadata\n                .created()).map_err(std::io::Error::from))?",
        "metadata.created()?",
    );
    let found = checker::primitive_source(&unguarded);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].function, "folder_identity");
    assert_eq!(found[0].category, "io::Error");
    assert_eq!(
        checker::primitive_source("fn broken() -> io::Result<()> { crate::io_operation!(work())")
            .len(),
        1
    );
}

#[test]
fn every_refusal_cause_inventory_excludes_only_test_contexts() {
    let source = r#"
        #[cfg(test)] mod tests { fn fake() -> Result<(), String> { todo!() } enum BadError { Bad } }
        #[cfg(all(test, target_os = "linux"))] fn fake_also() -> Result<(), String> { todo!() }
        #[test] fn a_test() -> Result<(), String> { todo!() }
        fn real() -> Result<(), String> { todo!() }
    "#;
    let found = checker::primitive_source(source);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].function, "real");
    assert!(checker::inventory_source("src/new.rs", source).is_empty());
    assert!(checker::inventory_source("src/new_tests.rs", "enum Error { Bare }").is_empty());
    assert_eq!(
        checker::primitive_source(
            "#[cfg(any(test, feature = \"runtime\"))] fn real() -> Result<(), String> { todo!() }"
        )
        .len(),
        1
    );
}

#[test]
fn every_refusal_cause_inventory_finds_unlisted_types_and_requires_mandatory_fields() {
    for declaration in [
        "enum FreshError { Failed }",
        "struct FreshRefusal;",
        "struct ApiError(String, bool, Option<Cause>);",
        "enum Trouble { Bad } impl std::error::Error for Trouble {}",
        "#[derive(thiserror::Error)] pub(crate) enum Trouble { Bad }",
        "struct CallFailure { cause: Option<Cause> }",
        "enum Kind { Bad } trillion_local::impl_caused!(Kind);",
        "enum Kind { Bad } impl Caused for Kind {}",
    ] {
        assert_eq!(
            checker::inventory_source("src/new.rs", declaration).len(),
            1,
            "{declaration}"
        );
    }
    for declaration in [
        "enum FreshError { Failed(Cause), Named { cause: crate::refusal_cause::Cause, detail: String } }",
        "pub struct ApiError(pub String, pub bool, pub(crate) Cause);",
        "struct CallFailure { pub cause: crate::refusal_cause::ReportedCause }",
        "enum Trouble { Bad(Cause) } impl std::error::Error for Trouble { fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) } }",
        "#[derive(Error)] enum Trouble { Bad(Cause) }",
        "// enum FreshError { Failed }\nconst WORDS: &str = r#\"enum FreshError { Failed }\"#;",
        "enum Colour { Red, Blue }",
        "enum QuotaErrorKind { Bounds, Source } struct Refusals { count: usize }",
        "enum StartError { Failed(ReportedCause) }",
        "enum SupplyFailure { Refused(local_engine::refusal_cause::Cause) }",
        "enum StartError { Failed { cause: ReportedCause } }",
        "enum Kind { Bad(Cause) } trillion_local::impl_caused!(Kind);",
        "enum Answer { Good(String), Refused { code: String, cause: Cause } }",
    ] {
        assert!(checker::inventory_source("src/new.rs", declaration).is_empty(), "{declaration}");
    }
}

#[test]
fn standard_error_erasure_keeps_each_local_stored_cause() {
    let declaration = "struct Problem { cause: Cause } ";
    for implementation in [
        "impl std::error::Error for Problem {}",
        "impl std::error::Error for Problem { fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { None } }",
        "impl std::error::Error for Problem { fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { if flag { Some(&self.cause) } else { None } } }",
    ] {
        let source = format!("{declaration}{implementation}");
        let found = checker::inventory_source("src/new.rs", &source);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].contains("implementation drops its stored Cause"));
    }
    for body in [
        "Some(&self.cause)",
        "Some(self.cause_ref())",
        "self.inner.source()",
        "std::error::Error::source(&self.inner)",
    ] {
        let source = format!("{declaration}impl std::error::Error for Problem {{ fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {{ {body} }} }}");
        assert!(
            checker::inventory_source("src/new.rs", &source).is_empty(),
            "{source}"
        );
    }
    assert!(checker::error_source_inventory_source(
        "src/mcp/cause.rs",
        "pub struct Cause { inner: Site } impl std::error::Error for Cause {}"
    )
    .is_empty());
    assert!(checker::inventory_source("src/new.rs", "#[cfg(test)] mod tests { struct Problem { cause: Cause } impl std::error::Error for Problem {} }").is_empty());
    assert_eq!(checker::inventory_source("src/new.rs", "use std::error::Error as StdError; struct Problem { cause: Cause } impl StdError for Problem {}").len(), 1);
}

#[test]
fn boxed_literal_refusal_cannot_erase_its_construction_site() {
    let bare = r#"fn run() -> Result<(), Box<dyn std::error::Error>> { Err("refused".into()) }"#;
    let found = checker::boxed_literal_source("src/new.rs", bare);
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].contains("literal Err.into erases"));
    assert!(checker::boxed_literal_source(
        "src/new.rs",
        &bare.replace(
            r#""refused".into()"#,
            r#"CodedError::new("refused").into()"#
        )
    )
    .is_empty());
    assert!(
        checker::boxed_literal_source("src/new.rs", &format!("#[cfg(test)] {bare}")).is_empty()
    );
    assert!(checker::boxed_literal_source(
        "src/new.rs",
        r#"fn run() -> Result<(), CodedError<&str>> { Err("refused".into()) }"#
    )
    .is_empty());
    assert_eq!(
        checker::boxed_literal_source(
            "src/new.rs",
            &format!(
                "use std::error::Error as StdError; {}",
                bare.replace("std::error::Error", "StdError")
            )
        )
        .len(),
        1
    );
}

#[test]
fn every_result_error_slot_requires_causes_without_an_error_type_name() {
    for signature in [
        "fn run() -> Result<(), Problem> { todo!() }",
        "fn run() -> std::result::Result<(), crate::Problem> { todo!() }",
        "type Trouble = Problem; fn run() -> Result<(), Trouble> { todo!() }",
        "type Answer<T> = Result<T, Problem>; fn run() -> Answer<()> { todo!() }",
        "fn run() -> Option<Result<(), Problem>> { todo!() }",
    ] {
        let bare = format!("enum Problem {{ Bad }} {signature}");
        let found = checker::inventory_source("src/new.rs", &bare);
        assert_eq!(found.len(), 1, "{bare}: {found:?}");
        assert!(found[0].contains("Problem::Bad"), "{found:?}");
        let caused = bare.replacen("Bad", "Bad(Cause)", 1);
        assert!(
            checker::inventory_source("src/new.rs", &caused).is_empty(),
            "{caused}"
        );
    }
    let struct_error = "struct Limit { retry: u64 } fn run() -> Result<(), Limit> { todo!() }";
    assert_eq!(
        checker::inventory_source("src/new.rs", struct_error).len(),
        1
    );
    assert!(checker::inventory_source("src/new.rs", "enum State { Ready, Failed } enum Problem { Bad(Cause) } fn read() -> Result<State, Problem> { todo!() }").is_empty());
}

#[test]
fn every_refusal_cause_inventory_exempts_only_the_intrinsic_coordinate_primitive() {
    let primitive = "pub struct Cause { inner: CauseInner } impl std::error::Error for Cause {}";
    assert!(checker::inventory_source("src/mcp/cause.rs", primitive).is_empty());
    assert_eq!(
        checker::inventory_source("src/other.rs", primitive).len(),
        1
    );
    assert_eq!(
        checker::inventory_source(
            "src/mcp/cause.rs",
            "struct Other { inner: CauseInner } impl std::error::Error for Other {}"
        )
        .len(),
        1
    );
    assert_eq!(
        checker::inventory_source(
            "src/mcp/cause.rs",
            "enum Cause { Missing } impl std::error::Error for Cause {}"
        )
        .len(),
        1
    );
    assert_eq!(
        checker::inventory_source(
            "src/mcp/cause.rs",
            "mod other { struct Cause { inner: Site } impl std::error::Error for Cause {} }"
        )
        .len(),
        1
    );
    let both = format!("{primitive} struct OtherError {{ message: String }}");
    let refused = checker::inventory_source("src/mcp/cause.rs", &both);
    assert_eq!(refused.len(), 1);
    assert!(refused[0].contains("OtherError"));
}

#[test]
fn every_refusal_cause_inventory_keeps_mixed_status_review_separate_from_enforcement() {
    let source =
        "enum State { Ready, Failed } enum Answer { Good(String), Refused { code: String } }";
    let enforced = checker::inventory_source("src/new.rs", source);
    assert_eq!(enforced.len(), 1);
    assert!(enforced[0].contains("Answer::Refused"));
    assert_eq!(
        checker::inventory_mixed_source("src/new.rs", source).len(),
        2
    );
}

#[test]
fn every_refusal_cause_gate_rejects_each_missing_variant_cause() {
    for (path, name) in [
        ("src/workspace_session/owner_wait.rs", "Error"),
        ("src/workspace_heads.rs", "Error"),
        ("src/workspace_show_rules.rs", "Error"),
        (
            "src/local_account/native_command_context/workspace_write.rs",
            "Error",
        ),
        (
            "src/local_account/native_command_context/workspace_write_output.rs",
            "Error",
        ),
        (
            "src/local_account/native_command_context/execution_metadata.rs",
            "Error",
        ),
        (
            "src/local_account/native_command_context/privacy.rs",
            "PrivacyError",
        ),
        (
            "src/local_account/native_command_context/method_effect_context.rs",
            "ReadError",
        ),
        ("src/wake.rs", "Failure"),
        ("src/record_value/erasure_owner.rs", "OwnerError"),
        ("src/record_sealed.rs", "Error"),
        ("src/record_indexes.rs", "Error"),
        ("src/record_indexes/current.rs", "Error"),
        ("src/legacy_records.rs", "Error"),
        ("src/kept_runs.rs", "Error"),
        ("src/rule_bindings.rs", "Error"),
        ("src/account_files/moves.rs", "Refusal"),
        ("src/account_files/take.rs", "VerifyError"),
        ("src/account_files/paged_spans.rs", "Error"),
        ("src/secrets.rs", "Error"),
        ("src/record_value.rs", "Error"),
        ("src/record_canonical.rs", "Error"),
        ("src/record_model_policy.rs", "Error"),
        ("src/record_write_model.rs", "Error"),
        ("src/record_write_model/write_command.rs", "Error"),
        ("src/eeaf_value.rs", "Error"),
        ("src/ecma_json.rs", "Error"),
        ("src/workspace_store.rs", "Kind"),
        (
            "src/local_account/native_command_context/workspace_write_sql.rs",
            "Error",
        ),
        ("src/local_account/record_writer.rs", "Error"),
        ("src/local_account/command_journal.rs", "Error"),
        ("src/account.rs", "AccountError"),
        ("src/workspace.rs", "WorkspaceError"),
        ("src/account/account_routes.rs", "Refusal"),
        ("src/tool_runs/tools.rs", "Failure"),
        ("src/records.rs", "Error"),
        ("src/eeaf_store.rs", "Error"),
        ("src/account_files/account_routes.rs", "Failure"),
        ("src/account_files/objects.rs", "ObjectError"),
        ("src/account_files/mod.rs", "AccountFilesError"),
    ] {
        let good = format!("pub enum {name} {{ Existing(crate::refusal_cause::Cause), Fresh(Cause), Named {{ value: bool, cause: Cause }} }}");
        assert!(checker::check_source(path, &good).is_empty(), "{path}");
        for violation in [
            "NewVariant",
            "NewVariant(String)",
            "NewVariant(Option<Cause>)",
            "NewVariant { cause: String }",
            "NewVariant { cause: Option<Cause> }",
        ] {
            let planted = good.replacen("Fresh(Cause)", violation, 1);
            let refused = checker::check_source(path, &planted);
            assert_eq!(refused.len(), 1, "{path}: {violation}: {refused:?}");
            assert!(refused[0].contains("NewVariant"), "{refused:?}");
        }
    }
}

#[test]
fn every_refusal_cause_gate_rejects_bare_outcome_unknown_at_both_record_owners() {
    for path in ["src/records.rs", "src/eeaf_store.rs"] {
        assert!(checker::check_source(
            path,
            "pub enum Error { Invalid(String, Cause), OutcomeUnknown(Cause) }"
        )
        .is_empty());
        for violation in [
            "OutcomeUnknown",
            "OutcomeUnknown(String)",
            "OutcomeUnknown(Option<Cause>)",
        ] {
            let refused = checker::check_source(path, &format!("pub enum Error {{ {violation} }}"));
            assert_eq!(refused.len(), 1, "{path}: {refused:?}");
            assert!(refused[0].contains("OutcomeUnknown"));
        }
    }
}

#[test]
fn every_refusal_cause_gate_rejects_uncarrying_public_refusal() {
    for field in [
        "",
        "cause: String,",
        "cause: Option<Cause>,",
        "cause: &'static str,",
    ] {
        let source = format!("pub struct OperationFailure {{ pub code: String, {field} }}");
        assert_eq!(
            checker::check_source("src/mcp.rs", &source).len(),
            1,
            "{field}"
        );
    }
    assert!(checker::check_source(
        "src/mcp.rs",
        "pub struct OperationFailure { pub code: String, pub cause: crate::refusal_cause::ReportedCause, }"
    )
    .is_empty());
}

#[test]
fn every_refusal_cause_gate_rejects_uncarrying_app_failure() {
    assert!(checker::check_source(
        "src/mcp_apps.rs",
        "pub struct Failure { code: String, cause: crate::refusal_cause::Cause, }"
    )
    .is_empty());
    assert!(checker::check_source(
        "src/tool_fact_page.rs",
        "pub struct Failure { code: String, pub cause: Cause }"
    )
    .is_empty());
    for field in ["", "cause: String,", "cause: Option<Cause>,"] {
        assert_eq!(
            checker::check_source(
                "src/mcp_apps.rs",
                &format!("pub struct Failure {{ code: String, {field} }}")
            )
            .len(),
            1
        );
    }
}

#[test]
fn every_refusal_cause_gate_finds_other_error_types_in_a_migrated_file() {
    for source in [
        "pub struct Error { cause: Cause } enum Refusal { Missing }",
        "pub struct Error { cause: Cause } enum SourceFailure { Missing }",
        "pub struct Error { reason: String }",
    ] {
        assert_eq!(
            checker::check_source("src/legacy_kept.rs", source).len(),
            1,
            "{source}"
        );
    }
    assert!(checker::check_source("src/legacy_kept.rs", "pub struct Error { cause: Cause } enum Refusal { Denied(Cause) } enum SourceFailure { Stale(Cause) }").is_empty());
}

#[test]
fn every_refusal_cause_gate_reads_rust_tokens_and_fails_closed() {
    let source = r####"
        // pub enum Error { Decoy(Cause) }
        /* outer /* pub enum Error { Decoy(Cause) } */ comment */
        const DECOY: &str = r#"pub enum Error { Decoy(Cause) }"#;
        pub enum Error {
            #[doc = "comma, brace } and Cause are words"]
            OutcomeUnknown,
        }
    "####;
    let refused = checker::check_source("src/records.rs", source);
    assert_eq!(refused.len(), 1);
    assert!(refused[0].contains("OutcomeUnknown"));
    for source in ["", "pub enum Error {", "pub enum Error {}"] {
        assert!(
            !checker::check_source("src/records.rs", source).is_empty(),
            "{source}"
        );
    }
}

#[test]
fn every_refusal_cause_gate_checks_the_tree_the_gate_is_running() {
    let refused = checker::check_tree(std::path::Path::new(env!("CARGO_MANIFEST_DIR")));
    assert!(refused.is_empty(), "{refused:#?}");
}

#[test]
fn every_refusal_cause_gate_refuses_fabricated_sites_and_aliases() {
    for call in [
        "Cause::__site(secret)",
        "Alias::__site(secret)",
        "<Cause>::__site(secret)",
        "let forge = Cause::__site; forge(secret)",
        "Alias::__caller(secret)",
        "let forge = Cause::__caller; forge(secret)",
        "Cause::__from_site(&SITE)",
        "let forge = Cause::__from_site; forge(&SITE)",
        "crate::__refusal_site!(private_value)",
        "macro_rules! __refusal_site { () => { private_value }; }",
    ] {
        assert_eq!(checker::check_site_calls("src/new.rs", call).len(), 1);
        assert!(checker::check_site_calls("src/mcp/cause.rs", call).is_empty());
    }
    assert!(checker::check_site_calls(
        "src/new.rs",
        r#"// Cause::__site(secret)
        const TEXT: &str = "Cause::__site(secret)";"#
    )
    .is_empty());
}

#[test]
fn every_refusal_cause_gate_rejects_fabricated_literal_wire_causes() {
    let literal = r#"fn run() { Cause::from_wire("generic@src/wrong.rs:1:1:failure").unwrap(); }"#;
    assert_eq!(checker::check_site_calls("src/new.rs", literal).len(), 1);
    assert!(checker::check_site_calls("src/cause_tests.rs", literal).is_empty());
    assert!(checker::check_site_calls("src/new.rs", &format!("#[cfg(test)] {literal}")).is_empty());
    assert!(checker::check_site_calls(
        "src/new.rs",
        "fn decode(wire: &str) { Cause::from_wire(wire); }"
    )
    .is_empty());
}

#[test]
fn every_refusal_cause_gate_keeps_io_errno_readers_on_the_metadata_aware_accessor() {
    assert_eq!(
        checker::check_site_calls(
            "src/new.rs",
            "fn errno(error: &io::Error) -> Option<i32> { error.raw_os_error() }"
        )
        .len(),
        1
    );
    assert!(checker::check_site_calls(
        "src/new.rs",
        "fn errno(error: &io::Error) -> Option<i32> { crate::refusal_cause::raw_os_error(error) }"
    )
    .is_empty());
    assert!(checker::check_site_calls(
        "src/mcp/cause.rs",
        "fn raw_os_error(error: &io::Error) -> Option<i32> { error.raw_os_error() }"
    )
    .is_empty());
    assert_eq!(
        checker::check_site_calls(
            "src/new.rs",
            "macro_rules! io_operation { ($work:expr) => { $work }; }"
        )
        .len(),
        1
    );
}

#[test]
fn wire_refusals_require_cause_while_success_and_code_data_stay_plain() {
    for variant in [
        "Refused { code: String }",
        "Denied",
        "OutcomeUnknown",
        "Error(String)",
    ] {
        // Unknown outcomes in wire replies are failures too.
        let source = format!("enum DeviceReply {{ Accepted, {variant} }}");
        assert!(
            !checker::inventory_source("src/new_wire.rs", &source).is_empty(),
            "{source}"
        );
    }
    assert!(checker::inventory_source("src/new_wire.rs", "enum DeviceReply { Accepted, Refused { code: String, cause: Cause }, Error(String, Cause) }").is_empty());
    assert!(
        checker::inventory_source("src/codes.rs", "enum Code { Refused, Error, Failed }")
            .is_empty()
    );
}

#[test]
fn every_refusal_cause_gate_refuses_a_fresh_cause_comparison_in_production() {
    for call in [
        "fn f(e: Error) -> bool { e == crate::cause!(Error::Bounds) }",
        "fn f(e: Error) -> bool { e != trillion_local::cause!(Error::Bounds) }",
        "fn f(e: Error) -> bool { e == crate::carry_cause!(Error::Bounds, source) }",
        "fn f(e: Error) -> bool { e.kind == super::cause!(Refusal::ValueBound) }",
    ] {
        assert_eq!(checker::check_site_calls("src/new.rs", call).len(), 1, "{call}");
    }
    assert!(checker::check_site_calls("src/new.rs", "fn f(e: Error) -> bool { matches!(e, Error::Bounds(_)) }").is_empty());
    assert!(checker::check_site_calls(
        "src/new.rs",
        "fn f(e: Error) -> Error { if e == Error::Bounds(site) { e } else { cause!(Error::Bounds) } }"
    )
    .is_empty());
    assert!(checker::check_site_calls(
        "src/new.rs",
        "#[cfg(test)]\nmod tests { fn f(e: Error) { assert!(e == crate::cause!(Error::Bounds)); } }"
    )
    .is_empty());
}

const WORDS_FILE: &str = include_str!("../../src/tool_runs/tools/computer/words.json");
const FAILURE_SOURCE: &str = include_str!("../../src/tool_runs/tools.rs");
const RELEASES_SOURCE: &str = include_str!("../../src/native_entry/computer/releases.rs");
const PERSON_PRESENT_SOURCE: &str = include_str!("../../src/account/person_present.rs");

fn shipped_sources(file: &str) -> Option<String> {
    match file {
        "src/tool_runs/tools.rs" => Some(FAILURE_SOURCE.to_owned()),
        "src/native_entry/computer/releases.rs" => Some(RELEASES_SOURCE.to_owned()),
        _ => None,
    }
}

fn shipped_constants(name: &str) -> Option<String> {
    let needle = format!("const {name}: &str = \"");
    [FAILURE_SOURCE, PERSON_PRESENT_SOURCE].iter().find_map(|source| {
        let at = source.find(&needle)? + needle.len();
        Some(source[at..at + source[at..].find('"')?].to_owned())
    })
}

#[test]
fn every_refusal_code_of_the_gated_owners_has_words_and_the_shipped_words_answer_no_other_code() {
    let words = checker::refusal_words_from(WORDS_FILE, &shipped_sources, &shipped_constants);
    assert!(words.found.is_empty(), "{:#?}", words.found);
    // Twenty-five Failure variants: the one that carries another variant's code (Detailed) has none of its own.
    assert_eq!(words.codes.keys().filter(|key| key.starts_with("Failure::")).count(), 24);
    assert_eq!(words.codes.get("Refusal::CopyRefused").map(String::as_str), Some("release_copy_refused"));
    assert_eq!(words.codes.get("Failure::NeedsPersonPresent").map(String::as_str), Some("needs_person_present"));
    assert_eq!(words.facts["workshop_rows_duplicate_id"], ["tool"]);
}

#[test]
fn every_refusal_words_gate_reports_each_code_that_has_no_words_key() {
    // The words file as it was before the per-code table: words for two codes only. Every other code of the 25 Failure
    // variants, and of CopyRefused, is reported, one sentence each.
    let kept: serde_json::Value = serde_json::from_str(WORDS_FILE).unwrap();
    let mut thin = kept.clone();
    thin["codes"].as_object_mut().unwrap().retain(|code, _| matches!(code.as_str(), "workshop_tool_capability_not_offered_here" | "workshop_tool_computer_boundary_absent"));
    let words = checker::refusal_words_from(&thin.to_string(), &shipped_sources, &shipped_constants);
    let missing: Vec<&String> = words.found.iter().filter(|line| line.contains("has no words key")).collect();
    assert_eq!(missing.len(), 23, "{missing:#?}");
    assert!(missing.iter().any(|line| line.contains("Failure::DuplicateTool answers code workshop_rows_duplicate_id")));
    assert!(missing.iter().any(|line| line.contains("Refusal::CopyRefused answers code release_copy_refused")));
}

#[test]
fn every_refusal_words_gate_refuses_a_key_no_refusal_answers_and_an_arm_with_no_code() {
    let mut extra: serde_json::Value = serde_json::from_str(WORDS_FILE).unwrap();
    extra["codes"]["no_refusal_answers_this"] = serde_json::json!({"words": "x"});
    let words = checker::refusal_words_from(&extra.to_string(), &shipped_sources, &shipped_constants);
    assert_eq!(words.found.len(), 1, "{:#?}", words.found);
    assert!(words.found[0].contains("no_refusal_answers_this is answered by no gated refusal"));
    let owner = "pub enum Error { Refused(Cause) } impl Error { pub fn code(&self) -> &'static str { match self { Self::Refused(_) => format!(\"x\") } } }";
    let words = serde_json::json!({"gated": [{"file": "src/owner.rs", "owner": "Error"}], "codes": {}}).to_string();
    let found = checker::refusal_words_from(&words, &|_| Some(owner.to_owned()), &|_| None).found;
    assert!(found.iter().any(|line| line.contains("the code of Refused is neither a string, a constant nor a carried code")), "{found:#?}");
}

#[test]
fn every_refusal_facts_gate_refuses_a_name_the_code_did_not_declare_and_an_unknown_variant() {
    let words = checker::refusal_words_from(WORDS_FILE, &shipped_sources, &shipped_constants);
    let site = |source: &str| checker::check_fact_sites("src/tool_runs/tools/catalog.rs", source, &words);
    assert!(site("fn f(id: &str) { let _ = crate::facts!(Failure::DuplicateTool; tool = id); }").is_empty());
    assert!(site("fn f(error: &E) { let _ = crate::facts!(Failure::Unavailable; path = p, kind = k, os_error = o,); }").is_empty());
    let undeclared = site("fn f(id: &str) { let _ = crate::facts!(Failure::DuplicateTool; tool = id, file = id); }");
    assert_eq!(undeclared.len(), 1, "{undeclared:#?}");
    assert!(undeclared[0].contains("fills file, which code workshop_rows_duplicate_id does not declare"));
    assert_eq!(site("fn f() { let _ = crate::facts!(Failure::Busy; tool = id); }").len(), 1, "a code that declares no facts takes none");
    assert_eq!(site("fn f() { let _ = crate::facts!(Failure::NoSuchVariant; tool = id); }").len(), 1);
    assert_eq!(site("fn f() { let _ = crate::facts!(tool = id); }").len(), 1);
    // Test code, comments and strings are not production sites.
    assert!(site("#[cfg(test)] mod tests { fn f() { let _ = crate::facts!(Failure::Busy; x = 1); } }").is_empty());
    assert!(site("// crate::facts!(Failure::Busy; x = 1)\nconst T: &str = \"facts!(Failure::Busy; x = 1)\";").is_empty());
}
