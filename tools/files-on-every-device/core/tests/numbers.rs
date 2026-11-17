//! No arbitrary constants: every number the core plans with comes from DATA (contract.json, the contract's own
//! settings handed in at setup) or is derived from a measurement (link.rs). This test reads the core's source and
//! refuses any number in code but 0 and 1, and one unit (milliseconds in a second); and it holds contract.json's
//! `bounds` to the contract's settings file, where the numbers live.

use std::path::Path;

use serde_json::Value;

/// The source with its comments and string literals blanked, so only code is read.
fn code_of(text: &str) -> String {
    let mut code = String::new();
    for line in text.lines() {
        let mut out = String::new();
        let mut in_string = false;
        let mut previous = ' ';
        let mut characters = line.chars().peekable();
        while let Some(character) = characters.next() {
            if in_string {
                if character == '"' && previous != '\\' {
                    in_string = false;
                }
                previous = if character == '\\' && previous == '\\' { ' ' } else { character };
                continue;
            }
            if character == '/' && characters.peek() == Some(&'/') {
                break;
            }
            if character == '"' {
                in_string = true;
                out.push_str("\"\"");
                previous = character;
                continue;
            }
            // A character literal (b'a', '.', '/') is text, never a number.
            if character == '\'' {
                let rest: String = characters.clone().take(3).collect();
                if rest.chars().nth(1) == Some('\'') || (rest.starts_with('\\') && rest.chars().nth(2) == Some('\'')) {
                    let skip = if rest.starts_with('\\') { 3 } else { 2 };
                    for _ in 0..skip {
                        characters.next();
                    }
                    continue;
                }
            }
            out.push(character);
            previous = character;
        }
        code.push_str(&out);
        code.push('\n');
    }
    code
}

/// Every number written in code: a digit run not inside a name.
fn numbers_in(code: &str) -> Vec<String> {
    let mut found = Vec::new();
    let characters: Vec<char> = code.chars().collect();
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        let inside_name = index > 0 && (characters[index - 1].is_alphanumeric() || characters[index - 1] == '_');
        if character.is_ascii_digit() && !inside_name {
            let start = index;
            while index < characters.len() && (characters[index].is_ascii_alphanumeric() || characters[index] == '_' || (characters[index] == '.' && characters.get(index + 1).is_some_and(char::is_ascii_digit))) {
                index += 1;
            }
            found.push(characters[start..index].iter().collect());
        } else {
            index += 1;
        }
    }
    found
}

#[test]
fn the_core_writes_no_number_but_zero_and_one() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let unit = "const MS_PER_SECOND: u64 = 1000;";
    let mut refused = Vec::new();
    for entry in std::fs::read_dir(folder).unwrap() {
        let path = entry.unwrap().path();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.matches(unit).count() <= 1);
        for number in numbers_in(&code_of(&text.replace(unit, ""))) {
            if !matches!(number.as_str(), "0" | "1" | "0.0" | "1.0") {
                refused.push(format!("{}: {number}", path.display()));
            }
        }
    }
    assert!(refused.is_empty(), "numbers in code: {refused:?}");
}

#[test]
fn the_check_finds_a_number_in_code() {
    assert_eq!(numbers_in(&code_of("let piece = 8 * MIB; // 64 in a comment\nlet name = \"v2\";")), vec!["8"]);
    assert!(numbers_in(&code_of("let dot = '.'.len_utf8() + b'7' as usize;")).is_empty());
}

#[test]
fn the_bounds_are_the_contracts_own_settings() {
    let contract: Value = serde_json::from_str(include_str!("../contract.json")).unwrap();
    let settings: Value = serde_json::from_str(include_str!("../../../live-namespace/src/account_files/settings.json")).unwrap();
    for (bound, path) in contract["bounds"].as_object().unwrap() {
        let mut value = &settings;
        for part in path.as_str().unwrap().split('.') {
            value = &value[part];
        }
        assert!(value.as_u64().is_some_and(|number| number > 0), "{bound} names {path}, which the settings do not hold");
    }
}
