//! The one-look tests, ported from old trillion at 4ffa1dc4a2^ (Trillion-X/trillion git history):
//! test/one-look-literals.test.mjs (scripts/check-one-look.mjs: a file that draws a page writes no colour, face or
//! corner of its own) and test/one-look-rendered.test.mjs (scripts/check-one-look-rendered.mjs: every surface wears the
//! same look's tokens). The old rendered check opened a browser; what it read (the page's background, text, faces and
//! primary button) all comes from the look's palette and stylesheet, so here every page is checked to carry exactly
//! that look and to use only classes the look styles. And the shell itself: every old sign-in page's description,
//! drawn here, is old trillion's HTML byte for byte (tests/fixtures/one-look/old-pages.json).

use super::*;
use crate::account::sign_in::{pages, way_pages, ways::{Typed, WaySettings}, StartingRows};
use ring::digest;
use serde_json::Value;
use std::collections::BTreeSet;

fn old_pages() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/one-look/old-pages.json")).expect("old pages")
}

fn sha256(text: &str) -> String {
    digest::digest(&digest::SHA256, text.as_bytes()).as_ref().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The look's pieces as the old shell wrote them into a page.
fn pieces(look: &Look) -> Vec<(&'static str, String)> {
    let palette = format!(":root{{{}}}", look.palette.0.iter().map(|(name, value)| format!("{name}:{value}")).collect::<Vec<_>>().join(";"));
    vec![
        ("palette", palette),
        ("sections_css", format!("{}{}{}", look.sections_css, look.browse_css, look.work_css)),
        ("reveal_script", look.reveal_script.clone()),
        ("code_script", look.code_script.clone()),
        ("reveal_icons", look.reveal_icons.clone()),
    ]
}

#[test]
fn the_product_look_is_old_trillions_look() {
    let look = pages::look();
    assert!(!look.palette.0.is_empty(), "the product settings carry a page_look");
    let fixture = old_pages();
    for (name, piece) in pieces(look) {
        assert_eq!(sha256(&piece), fixture["pieces"][name].as_str().expect("pinned"), "the look's {name} is old trillion's");
    }
}

#[test]
fn every_old_sign_in_page_draws_byte_for_byte() {
    // Old src/html-page.mjs gave every page old src/client.js as its script; the engine's pages carry their own.
    let mut look = pages::look().clone();
    look.bundle_url = Some("/client.js".to_string());
    let fixture = old_pages();
    let cases = fixture["cases"].as_array().expect("cases");
    assert!(cases.len() >= 13);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let page: Page = serde_json::from_value(case["description"].clone()).unwrap_or_else(|error| panic!("{name}: {error}"));
        let mut expected = case["html"].as_str().expect("html").to_string();
        for (piece, value) in pieces(&look) {
            expected = expected.replace(&format!("{{{{{piece}}}}}"), &value);
        }
        let drawn = document(&look, &page);
        if drawn != expected {
            let at = drawn.bytes().zip(expected.bytes()).position(|(a, b)| a != b).unwrap_or(drawn.len().min(expected.len()));
            let from = at.saturating_sub(120);
            panic!("{name} differs at byte {at}:\n new: {}\n old: {}", &drawn[from..(at + 200).min(drawn.len())], &expected[from..(at + 200).min(expected.len())]);
        }
    }
}

#[test]
fn a_description_naming_a_part_the_shell_does_not_draw_does_not_read() {
    let refused = serde_json::from_value::<Page>(serde_json::json!({"title": "t", "sections": [{"heading": "h", "cards": []}]}));
    assert!(refused.is_err(), "nothing is dropped silently");
}

#[test]
fn every_dynamic_text_is_escaped() {
    let look = pages::look();
    let hostile = "<script>alert(1)</script>\"'&";
    let page = Page {
        title: hostile.to_string(),
        sections: vec![Section {
            heading: Some(hostile.to_string()),
            body: Some(hostile.to_string()),
            fields: vec![Field { name: Some("a".into()), label: Some(hostile.into()), value: Some(hostile.into()), placeholder: Some(hostile.into()), ..Default::default() }],
            actions: vec![
                Action::link(hostile, "/x\"><script>", None),
                Action::link(hostile, "javascript:alert(1)", None),
                Action { button: Some(Pairs(vec![("next".into(), hostile.into())])), ..Action::link(hostile, "#", None) },
            ],
            ..Default::default()
        }],
        ..Default::default()
    };
    let html = document(look, &page);
    assert!(!html.contains("<script>alert"));
    assert!(!html.contains("javascript:"));
    assert!(!html.contains("\"><script>"));
}

// --- the engine's own pages ---

fn engine_pages() -> Vec<(String, String)> {
    let rows = StartingRows::for_tests();
    let w = rows.sign_in_words.clone();
    let ways: WaySettings = rows.sign_in_ways.clone();
    let kept = Typed::default();
    let form = |focus: Option<&'static str>, message: Option<&str>| way_pages::Form {
        words: &w, ways: &ways, base: "", next: "/home", request: None, kept: &kept, message: message.map(str::to_string), focus,
    };
    let mut out = vec![
        ("sign-in".to_string(), pages::sign_in(&w, "/home", "", false, Some(&ways))),
        ("sign-in-connecting".to_string(), pages::sign_in(&w, "/home", "", true, Some(&ways))),
        ("connect".to_string(), pages::connect(&w, "req123", "Claude", "")),
        ("add-passkey".to_string(), pages::add_passkey(&w, Some("abc"), "", Some(&ways))),
        ("offer-passkey".to_string(), pages::offer_passkey(&w, "/home", "")),
        ("sign-up".to_string(), pages::sign_up(&w, None)),
        ("sign-up-plan".to_string(), pages::sign_up(&w, Some("/buy/offer%3Aplan"))),
        ("notice".to_string(), pages::notice(&w, pages::Notice::Refused)),
        ("way-notice".to_string(), way_pages::notice(&w, "Done.", "/home")),
        ("shown-once".to_string(), way_pages::shown_once(&w, "Codes", "Keep these.", &["abcd-efgh".to_string()], "/home")),
    ];
    for row in &ways.rows {
        out.push((format!("way-{}", row.way), way_pages::sign_in(row, None, &form(None, None))));
        if row.proof == super::super::ways::Proof::Sent {
            out.push((format!("way-{}-sent", row.way), way_pages::sign_in(row, Some("a@example.test"), &form(Some("code"), Some("Sent.")))));
        }
        out.push((format!("setup-{}", row.way), way_pages::setup(row, false, false, &way_pages::Step::Start, &form(None, None))));
    }
    let view = way_pages::Security { words: &w, ways: &ways, base: "", passkeys: 2, held: Default::default(), keys: vec![("k1".into(), "Mac".into(), "abcd".into())], waiting: 1, message: None };
    out.push(("security".to_string(), way_pages::security(&view)));
    out
}

#[test]
fn every_engine_page_wears_the_one_look() {
    let look = pages::look();
    let palette = pieces(look).remove(0).1;
    let sheet = format!("{}{}{}", look.sections_css, look.browse_css, look.work_css);
    let mark = crate::account_files::identity::identity().expect("product settings").brand_mark_path.clone();
    for (name, html) in engine_pages() {
        // The look and nothing else: the palette, the base rules and the shell's sheet, in that order, once each.
        let styles: Vec<&str> = html.split("<style>").skip(1).map(|rest| rest.split("</style>").next().unwrap_or("")).collect();
        assert_eq!(styles, vec![palette.as_str(), look.base_css.as_str(), sheet.as_str()], "{name} wears the look's styles and no other");
        assert!(!html.contains(" style="), "{name} writes no style of its own");
        assert!(html.contains(&format!("data-theme=\"{}\" data-look-scheme=\"{}\"", look.theme, look.scheme)), "{name}");
        assert!(html.contains("<div class=\"page-layout page-layout--auth\"><main class=\"page-main\"><section class=\"page-section page-section--welcome\""), "{name} is in the sign-in layout");
        assert!(html.contains(&format!("<img class=\"page-mark\" src=\"{mark}\" alt=\"{}\"", look.mark_alt)), "{name} opens with the mark");
        assert_eq!(html.matches("<h1 ").count(), 1, "{name} has one title");
        for stylesheet in &look.stylesheets {
            assert!(html.contains(&format!("<link rel=\"stylesheet\" href=\"{stylesheet}\"/>")), "{name} loads the look's faces");
        }
    }
}

fn classes(html: &str) -> BTreeSet<String> {
    html.split(" class=\"").skip(1).flat_map(|attribute| attribute.split('"').next().unwrap_or("").split_whitespace().map(str::to_string).collect::<Vec<_>>()).collect()
}

/// Every class a page uses is one the look's stylesheet styles or one old trillion's shell wrote, so a page that drifts
/// to a class of its own fails.
#[test]
fn every_class_an_engine_page_uses_is_one_the_look_styles_or_the_old_shell_wrote() {
    let look = pages::look();
    let sheet = format!("{}{}{}", look.sections_css, look.browse_css, look.work_css);
    let fixture = old_pages();
    let old: BTreeSet<String> = fixture["cases"].as_array().expect("cases").iter().flat_map(|case| classes(case["html"].as_str().unwrap_or(""))).collect();
    let mut off_look = BTreeSet::new();
    for (name, html) in engine_pages() {
        for class in classes(&html) {
            if !sheet.contains(&format!(".{class}")) && !old.contains(&class) {
                off_look.insert(format!("{name}: {class}"));
            }
        }
    }
    assert!(off_look.is_empty(), "classes neither the look styles nor the old shell wrote: {off_look:?}");
}

#[test]
fn every_inline_script_on_an_engine_page_is_allowed_by_the_policy() {
    let sources = pages::script_sources();
    for (name, html) in engine_pages() {
        for script in html.split("<script>").skip(1).map(|rest| rest.split("</script>").next().unwrap_or("")) {
            let hash = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, digest::digest(&digest::SHA256, script.as_bytes()));
            assert!(sources.contains(&format!("'sha256-{hash}'")), "{name}: a script the policy does not allow");
        }
        assert!(!html.contains("<script src="), "{name} loads no script file");
    }
}

/// The literal half (old scripts/check-one-look.mjs over parts/screen-look/one-look-rules.json): no engine source writes
/// a colour, a face, a corner or a stylesheet of its own. The look is the product's DATA.
#[test]
fn no_engine_source_writes_a_look() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut found = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("src") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("rs") || path.ends_with("shell_tests.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("source");
            let file = path.strip_prefix(&root).unwrap_or(&path).display().to_string();
            for (number, line) in text.lines().enumerate() {
                let compact: String = line.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_lowercase();
                let declares = |property: &str| compact.contains(&format!("{property}:#")) || compact.contains(&format!("{property}:rgb")) || compact.contains(&format!("{property}:hsl"));
                let colour = ["color", "background", "border", "fill", "stroke", "outline"].iter().any(|property| declares(property));
                let face = compact.contains("font-family:") || compact.contains("font:16px") || compact.contains("font:inherit");
                let corner = compact.contains("border-radius:");
                // The shell writes the look's own sheet into `<style>` (shell.rs `document`); nothing else opens one.
                let sheet = compact.contains("<style") && !file.ends_with("sign_in/shell.rs");
                if colour || face || corner || sheet {
                    found.push(format!("src/{file}:{}: {}", number + 1, line.trim()));
                }
            }
        }
    }
    assert!(found.is_empty(), "a look written in engine source:\n{}", found.join("\n"));
}

#[test]
fn a_bare_look_draws_the_markup_without_a_look() {
    let page = Page { title: "t".into(), layout: Some("auth".into()), sections: vec![Section { heading: Some("h".into()), heading_level: Some(1), ..Default::default() }], ..Default::default() };
    let html = document(&Look::bare(), &page);
    assert!(html.contains("<h1 class=\"page-heading\">h</h1>"));
    assert!(!html.contains(":root{"));
}

