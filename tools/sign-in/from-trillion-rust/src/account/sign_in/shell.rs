//! The page shell every sign-in page is drawn through: old trillion's `pageShellHtml`
//! (Trillion-X/trillion at 4ffa1dc4a2^, parts/ui/show/server-rendered-page/page-sections-html.mjs, now Trillion-X/trillion-apps
//! web/parts/ui/show/server-rendered-page/), ported one to one for the section parts the sign-in pages draw: a page
//! description (title, layout, sections) in, the same markup, classes and order out. Nothing here is a look: every
//! colour, face, size, rule and inline script the page wears is the product's `page_look` (`Look`, the launcher's
//! product settings, src/account_files/identity.rs), which the app ships from its own web/ shell. Every dynamic text is
//! escaped with the shell's one escape.
//!
//! Ported (old file:line at 4ffa1dc4a2^): `textOrNull` 41, `emphasisClass` 53, `safeHref` 61, `wordClass` 70, `workWords`
//! 76, `actionHtml` 83, `newTab` 118, `logoHtml` 125 (no mark is drawn on an action here), `imageHtml` 138, `chipsHtml`
//! 204, `choicesHtml` 295 (fields only: no page here offers round or tick choices), `fieldHtml` 357 (no file box),
//! `codeFieldHtml` 399, `dividerHtml` 429, `promptHtml` 436, `sentToHtml` 446, `metaHtml` 458, `itemHtml` 468, `markHtml`
//! 520, `sectionHtml` 553, `pageSectionsHtml` 610, `canonicalUrlFor` 619, `iconLinksHtml` 651, `shareMetaHtml` 676,
//! `lookHtml` 701, `themeColorHtml` 716 (the colour is the look's own `theme_color`), `metaDescriptionHtml` 725 and
//! `pageShellHtml` 748. Dropped, because no sign-in page draws them: illustrations, prose, media, views, people, cards,
//! pagination, steps, "more", the share row, dates, an aside, import maps and the close, more and picture scripts. A
//! description that names one of them does not read (`deny_unknown_fields`), so nothing is dropped silently.
//!
//! Added for the engine's own pages, each drawn only when a page sets it, so an old description draws byte for byte as
//! before: an action's `button` (a script button carrying `data-` values, as the old `close` button is a button) and
//! `app_address` (the authenticator address a phone opens), a
//! field's `autofocus` (a refused step focuses the box to fix), a section's `picture` (a picture this engine drew
//! itself, the authenticator QR) and the page's own `scripts`.

use serde::{de::{MapAccess, Visitor}, Deserialize, Deserializer, Serialize};
use std::fmt::Write as _;

use super::pages::escape;

/// Plain names in DATA order: a JSON object read as its pairs, so values are written in the order they were given.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub(crate) struct Pairs(pub Vec<(String, String)>);

impl<'de> Deserialize<'de> for Pairs {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Ordered;
        impl<'de> Visitor<'de> for Ordered {
            type Value = Pairs;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an object of plain values, or a list of [name, value] pairs")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Pairs, M::Error> {
                let mut out = Vec::new();
                while let Some((name, value)) = map.next_entry::<String, serde_json::Value>()? {
                    match value {
                        serde_json::Value::String(text) => out.push((name, text)),
                        serde_json::Value::Number(number) => out.push((name, number.to_string())),
                        // The shell writes only text and number values (`choicesHtml`, `actionHtml` `post`).
                        _ => {}
                    }
                }
                Ok(Pairs(out))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Pairs, A::Error> {
                let mut out = Vec::new();
                while let Some(pair) = seq.next_element::<(String, String)>()? {
                    out.push(pair);
                }
                Ok(Pairs(out))
            }
        }
        deserializer.deserialize_any(Ordered)
    }
}

/// The product's look (the product settings' `page_look`): what `htmlPage` gave every page (old src/html-page.mjs: the
/// language, theme, PAGE_LOOK, icons and share card) and the shell's own stylesheets and scripts, as DATA.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Look {
    #[serde(rename = "_what", default)]
    _what: String,
    pub language: String,
    pub theme: String,
    pub scheme: String,
    #[serde(default)]
    pub theme_color: Option<String>,
    #[serde(default)]
    pub stylesheets: Vec<String>,
    pub palette: Pairs,
    pub base_css: String,
    pub sections_css: String,
    pub browse_css: String,
    pub work_css: String,
    pub reveal_script: String,
    pub code_script: String,
    pub reveal_icons: String,
    #[serde(default)]
    pub icons: Vec<Icon>,
    #[serde(default)]
    pub share: Option<Share>,
    /// The words the brand mark is read aloud as (old src/pages.mjs LOGO `alt`).
    pub mark_alt: String,
    /// The page script every page loads (old `island.bundle_url`); none for the engine's pages.
    #[serde(default)]
    pub bundle_url: Option<String>,
    /// The folder the launcher installs the shell's static files in (`assets.json` names each file under it).
    #[serde(default)]
    pub static_root: Option<String>,
}

impl Look {
    /// No look: the shell's markup alone, for a launcher whose product settings carry no `page_look`.
    pub(crate) fn bare() -> Self {
        Look {
            _what: String::new(), language: "en".to_string(), theme: String::new(), scheme: "light".to_string(), theme_color: None,
            stylesheets: Vec::new(), palette: Pairs::default(), base_css: String::new(), sections_css: String::new(), browse_css: String::new(),
            work_css: String::new(), reveal_script: String::new(), code_script: String::new(), reveal_icons: String::new(), icons: Vec::new(),
            share: None, mark_alt: String::new(), bundle_url: None, static_root: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Icon {
    pub rel: String,
    pub href: String,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub sizes: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Share {
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub site_name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub image_alt: Option<String>,
    #[serde(default)]
    pub image_card: Option<String>,
}

/// One page: what old src/pages.mjs handed `htmlPage`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Page {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub meta_description: Option<String>,
    #[serde(default)]
    pub canonical_origin: Option<String>,
    #[serde(default)]
    pub canonical_path: Option<String>,
    #[serde(default)]
    pub layout: Option<String>,
    #[serde(default)]
    pub sections: Vec<Section>,
    /// The page's own inline scripts, after the shell's (added: the engine's passkey script).
    #[serde(skip)]
    pub scripts: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Section {
    #[serde(default)]
    pub step: Option<String>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub emphasis: Option<String>,
    #[serde(default)]
    pub mark: Option<Mark>,
    #[serde(default)]
    pub heading: Option<String>,
    #[serde(default)]
    pub heading_level: Option<u8>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub sent_to: Option<SentTo>,
    #[serde(default)]
    pub image: Option<Image>,
    /// A picture this engine drew itself (an SVG), never DATA from elsewhere (added).
    #[serde(skip)]
    pub picture: Option<Picture>,
    #[serde(default)]
    pub chips: Vec<Chip>,
    #[serde(default)]
    pub items: Vec<Item>,
    #[serde(default)]
    pub choices: Option<Choices>,
    #[serde(default)]
    pub divider: Option<String>,
    #[serde(default)]
    pub fields: Vec<Field>,
    #[serde(default)]
    pub actions: Vec<Action>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub prompt: Option<Prompt>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Mark {
    #[serde(default)]
    pub src: Option<String>,
    #[serde(default)]
    pub alt: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Image {
    #[serde(default)]
    pub src: Option<String>,
    #[serde(default)]
    pub alt: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct Picture {
    /// What the picture shows, read aloud.
    pub label: String,
    /// The SVG markup, made by this engine.
    pub svg: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SentTo {
    #[serde(default)]
    pub text: Option<String>,
    /// The address the code went to, drawn after the text (the old client filled it in).
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default)]
    pub change: Option<Link>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Link {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub href: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Prompt {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub action: Option<Link>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Chip {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub href: Option<String>,
    #[serde(default)]
    pub count: Option<f64>,
    #[serde(default)]
    pub selected: bool,
    #[serde(default)]
    pub new_tab: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Meta {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub tone: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Item {
    #[serde(default)]
    pub heading: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub meta: Option<Meta>,
    #[serde(default)]
    pub details: Vec<String>,
    #[serde(default)]
    pub fields: Vec<Field>,
    #[serde(default)]
    pub actions: Vec<Action>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Choices {
    #[serde(default)]
    pub href: Option<String>,
    #[serde(default)]
    pub values: Pairs,
    #[serde(default)]
    pub fields: Vec<Field>,
    #[serde(default)]
    pub submit: Option<Action>,
    /// Whether the section's own actions share the submit's row inside the form, as old src/pages.mjs draws a step
    /// that has one action row (the add-email step); otherwise they follow the form.
    #[serde(default)]
    pub actions_in_row: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Reveal {
    #[serde(default)]
    pub show: Option<String>,
    #[serde(default)]
    pub hide: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Field {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub lines: Option<i64>,
    #[serde(default)]
    pub max_length: Option<i64>,
    #[serde(default)]
    pub min_length: Option<i64>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub autocomplete: Option<String>,
    #[serde(default)]
    pub inputmode: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub label_action: Option<Link>,
    #[serde(default)]
    pub reveal: Option<Reveal>,
    #[serde(default)]
    pub hint: Option<String>,
    #[serde(default)]
    pub strength: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub length: Option<i64>,
    /// Focus this box when the page opens (added: a refused step focuses the box to fix).
    #[serde(skip)]
    pub autofocus: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Action {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub href: Option<String>,
    #[serde(default)]
    pub tone: Option<String>,
    #[serde(default)]
    pub post: Option<Pairs>,
    #[serde(default)]
    pub cooldown_seconds: Option<i64>,
    #[serde(default)]
    pub again_seconds: Option<i64>,
    #[serde(default)]
    pub skip: Option<String>,
    #[serde(default)]
    pub new_tab: bool,
    #[serde(default)]
    pub pending: Option<String>,
    #[serde(default)]
    pub done: Option<String>,
    /// A button the page's own script runs, with these `data-` values (added; a name with no value is written bare).
    #[serde(skip)]
    pub button: Option<Pairs>,
    /// An address this engine made that opens an app (`otpauth:`), not a web address (added; never DATA, and never a
    /// script, data or vbscript address).
    #[serde(skip)]
    pub app_address: bool,
}

impl Action {
    pub(crate) fn link(label: &str, href: &str, tone: Option<&str>) -> Self {
        Action { label: Some(label.to_string()), href: Some(href.to_string()), tone: tone.map(str::to_string), ..Default::default() }
    }
}

// --- the shell's own helpers (old page-sections-html.mjs 41-80) ---

fn text(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|text| !text.is_empty())
}

fn plain_word(word: &str) -> bool {
    let mut chars = word.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase()) && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn plain_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase()) && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn emphasis_class(value: &Option<String>) -> String {
    text(value).filter(|word| plain_word(word)).map(|word| format!(" page-section--{word}")).unwrap_or_default()
}

fn safe_href(value: &Option<String>) -> Option<&str> {
    let href = text(value)?;
    if href.starts_with('/') || href.starts_with('#') {
        return Some(href);
    }
    let lower = href.get(..8).unwrap_or(href).to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://")).then_some(href)
}

fn word_class(base: &str, value: &Option<String>) -> String {
    text(value).filter(|word| plain_word(word)).map(|word| format!(" {base}--{word}")).unwrap_or_default()
}

fn work_words(action: &Action) -> String {
    [("pending", &action.pending), ("done", &action.done)].iter()
        .filter_map(|(name, words)| text(words).map(|words| format!(" data-page-{name}=\"{}\"", escape(words))))
        .collect()
}

fn hidden_values(values: &Pairs) -> String {
    values.0.iter().filter(|(name, _)| plain_name(name))
        .map(|(name, value)| format!("<input type=\"hidden\" name=\"{}\" value=\"{}\"/>", escape(name), escape(value))).collect()
}

fn new_tab(wanted: bool, href: &str) -> &'static str {
    let lower = href.get(..8).unwrap_or(href).to_ascii_lowercase();
    if wanted && (lower.starts_with("http://") || lower.starts_with("https://")) { " target=\"_blank\" rel=\"noopener noreferrer\"" } else { "" }
}

fn action_html(action: &Action) -> String {
    let Some(label) = text(&action.label) else { return String::new() };
    let tone = word_class("page-action", &action.tone);
    if let Some(data) = &action.button {
        let values: String = data.0.iter().filter(|(name, _)| plain_word(name)).map(|(name, value)| {
            if value.is_empty() { format!(" data-{name}") } else { format!(" data-{name}=\"{}\"", escape(value)) }
        }).collect();
        return format!("<button class=\"page-action{tone}\" type=\"button\"{values}{}>{}</button>", work_words(action), escape(label));
    }
    let Some(href) = safe_href(&action.href).or_else(|| app_address(action)) else { return format!("<span class=\"page-action{tone}\">{}</span>", escape(label)) };
    if let Some(post) = action.post.as_ref().filter(|_| !href.starts_with('#')) {
        return format!(
            "<form class=\"page-action-form\" method=\"post\" action=\"{}\">{}<button class=\"page-action{tone}\" type=\"submit\"{}>{}</button></form>",
            escape(href), hidden_values(post), work_words(action), escape(label)
        );
    }
    let positive = |value: Option<i64>| value.filter(|seconds| *seconds > 0);
    let wait = positive(action.cooldown_seconds).map(|seconds| format!(" data-page-cooldown=\"{seconds}\"")).unwrap_or_default();
    let again = positive(action.again_seconds).map(|seconds| format!(" data-page-again=\"{seconds}\"")).unwrap_or_default();
    let skipped = text(&action.skip).filter(|skip| plain_word(skip)).map(|skip| format!(" data-page-skip=\"{skip}\"")).unwrap_or_default();
    format!("<a class=\"page-action{tone}\" href=\"{}\"{}{wait}{again}{skipped}{}>{}</a>", escape(href), new_tab(action.new_tab, href), work_words(action), escape(label))
}

/// An engine-made app address (`Action::app_address`): a plain scheme that is not one a browser runs or reads as data.
fn app_address(action: &Action) -> Option<&str> {
    let href = text(&action.href).filter(|_| action.app_address)?;
    let (scheme, _) = href.split_once(':')?;
    let plain = scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c));
    (plain && !["javascript", "data", "vbscript", "file"].contains(&scheme.to_ascii_lowercase().as_str())).then_some(href)
}

fn image_html(image: &Option<Image>, first: bool) -> String {
    let Some(image) = image else { return String::new() };
    let Some(src) = safe_href(&image.src).filter(|src| !src.starts_with('#')) else { return String::new() };
    format!("<img class=\"page-image\" src=\"{}\" alt=\"{}\"{} decoding=\"async\"/>", escape(src), escape(text(&image.alt).unwrap_or("")),
        if first { " fetchpriority=\"high\"" } else { " loading=\"lazy\"" })
}

fn picture_html(picture: &Option<Picture>) -> String {
    picture.as_ref().map(|picture| format!("<div class=\"page-image\" role=\"img\" aria-label=\"{}\">{}</div>", escape(&picture.label), picture.svg)).unwrap_or_default()
}

fn chips_html(chips: &[Chip]) -> String {
    let rows: String = chips.iter().map(|chip| {
        let (Some(label), Some(href)) = (text(&chip.label), safe_href(&chip.href)) else { return String::new() };
        let count = chip.count.filter(|count| count.is_finite()).map(|count| format!("<span class=\"page-chip-count\">{}</span>", escape(&number(count)))).unwrap_or_default();
        format!("<a class=\"page-chip{}\" href=\"{}\"{}{}>{}{count}</a>", if chip.selected { " page-chip--selected" } else { "" }, escape(href),
            new_tab(chip.new_tab, href), if chip.selected { " aria-current=\"page\"" } else { "" }, escape(label))
    }).collect();
    if rows.is_empty() { rows } else { format!("<nav class=\"page-chips\">{rows}</nav>") }
}

/// A number as JavaScript's `String(number)` writes a whole number.
fn number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 { format!("{}", value as i64) } else { value.to_string() }
}

/// The choices form. When `actions_in_row`, the submit button and the section's actions share one `page-actions` row
/// inside one block, so the form's grid gap does not separate them from the fields.
fn choices_html(choices: &Option<Choices>, look: &Look, actions: &str) -> String {
    let Some(choices) = choices else { return String::new() };
    let Some(href) = safe_href(&choices.href).filter(|href| !href.starts_with('#')) else { return String::new() };
    let Some(submit) = choices.submit.as_ref().and_then(|submit| text(&submit.label)) else { return String::new() };
    let fields: String = choices.fields.iter().map(|field| field_html(field, look)).collect();
    if fields.is_empty() {
        return String::new();
    }
    let submitted = choices.submit.as_ref().expect("a submit");
    let tone = word_class("page-action", &submitted.tone);
    let body = if !choices.actions_in_row {
        format!("<div class=\"page-fields\">{fields}</div><button class=\"page-action page-choices-send{tone}\" type=\"submit\"{}>{}</button>", work_words(submitted), escape(submit))
    } else {
        format!("<div><div class=\"page-fields\">{fields}</div><div class=\"page-actions\"><button class=\"page-action{tone}\" type=\"submit\"{}>{}</button>{actions}</div></div>", work_words(submitted), escape(submit))
    };
    format!("<form class=\"page-choices\" method=\"post\" action=\"{}\">{}{body}</form>", escape(href), hidden_values(&choices.values))
}

fn letters_only(value: &str, extra: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_lowercase() || extra.contains(c))
}

fn field_html(field: &Field, look: &Look) -> String {
    let (Some(label), Some(name)) = (text(&field.label), text(&field.name)) else { return String::new() };
    let kind = text(&field.kind).unwrap_or("text");
    if !plain_name(name) || !letters_only(kind, "") {
        return String::new();
    }
    let focus = if field.autofocus { " autofocus" } else { "" };
    if kind == "code" {
        return code_field_html(field, label, name, focus);
    }
    let id = format!("page-field-{name}");
    let lines = field.lines.filter(|lines| *lines > 1).map_or(1, |lines| lines.min(12));
    let most = field.max_length.filter(|n| *n > 0).map(|n| format!(" maxlength=\"{n}\"")).unwrap_or_default()
        + &field.min_length.filter(|n| *n > 0).map(|n| format!(" minlength=\"{n}\"")).unwrap_or_default()
        + if field.required { " required" } else { "" };
    let given = field.value.as_deref().unwrap_or("");
    let fill = text(&field.autocomplete).filter(|fill| letters_only(fill, " -")).map_or("off".to_string(), escape);
    let keys = text(&field.inputmode).filter(|keys| letters_only(keys, "")).map(|keys| format!(" inputmode=\"{}\"", escape(keys))).unwrap_or_default();
    let note = text(&field.hint);
    let named = format!("class=\"page-field-input\" id=\"{id}\" name=\"{name}\" autocomplete=\"{fill}\"{keys}{most}{}",
        text(&field.placeholder).map(|hint| format!(" placeholder=\"{}\"", escape(hint))).unwrap_or_default(), id = escape(&id), name = escape(name))
        + &note.map(|_| format!(" aria-describedby=\"{}-hint\"", escape(&id))).unwrap_or_default()
        + if field.strength { " data-page-strength" } else { "" }
        + focus;
    let label_html = format!("<label class=\"page-field-label\" for=\"{}\">{}</label>", escape(&id), escape(label));
    let top = match field.label_action.as_ref().map(|link| (text(&link.label), safe_href(&link.href))) {
        Some((Some(aside), Some(href))) => format!("<div class=\"page-field-top\">{label_html}<a class=\"page-field-link\" href=\"{}\">{}</a></div>", escape(href), escape(aside)),
        _ => label_html,
    };
    let boxed = if lines > 1 {
        format!("<textarea {named} rows=\"{lines}\">{}</textarea>", escape(given))
    } else {
        format!("<input {named} type=\"{}\"{}/>", escape(kind), if given.is_empty() { String::new() } else { format!(" value=\"{}\"", escape(given)) })
    };
    let reveal = field.reveal.as_ref().map(|reveal| (text(&reveal.show), text(&reveal.hide)));
    let revealed = match reveal {
        Some((Some(show), Some(hide))) if lines == 1 => format!(
            "<div class=\"page-field-box\">{boxed}<button class=\"page-field-reveal\" type=\"button\" data-page-reveal aria-controls=\"{id}\" aria-pressed=\"false\" aria-label=\"{show}\" data-show=\"{show}\" data-hide=\"{hide}\">{icons}</button></div>",
            id = escape(&id), show = escape(show), hide = escape(hide), icons = look.reveal_icons),
        _ => boxed,
    };
    format!("<div class=\"page-field\"{}>{top}{revealed}{}</div>", if field.hidden { " hidden" } else { "" },
        note.map(|note| format!("<p class=\"page-field-hint\" id=\"{}-hint\">{}</p>", escape(&id), escape(note))).unwrap_or_default())
}

fn code_field_html(field: &Field, label: &str, name: &str, focus: &str) -> String {
    let length = field.length.map_or(6, |length| length.clamp(4, 8));
    let id = format!("page-field-{name}");
    let boxes: String = (0..length).map(|index| format!(
        "<input class=\"page-code-box\" type=\"text\" inputmode=\"numeric\" pattern=\"[0-9]*\" autocomplete=\"{}\" aria-label=\"{}\"{}/>",
        if index == 0 { "one-time-code" } else { "off" }, escape(&format!("{label}, digit {} of {length}", index + 1)), if index == 0 { focus } else { "" })).collect();
    format!(
        "<div class=\"page-field page-field--code\"{}><span class=\"page-field-label page-field-label--unseen\" id=\"{id}-label\">{}</span><div class=\"page-code\" role=\"group\" aria-labelledby=\"{id}-label\" data-page-code>{boxes}<input type=\"hidden\" id=\"{id}\" name=\"{}\" value=\"\"/></div></div>",
        if field.hidden { " hidden" } else { "" }, escape(label), escape(name), id = escape(&id)
    )
}

fn divider_html(divider: &Option<String>) -> String {
    text(divider).map(|words| format!("<div class=\"page-divider\" role=\"separator\"><span class=\"page-divider-words\">{}</span></div>", escape(words))).unwrap_or_default()
}

fn prompt_html(prompt: &Option<Prompt>) -> String {
    let Some(prompt) = prompt else { return String::new() };
    let Some(action) = &prompt.action else { return String::new() };
    let (Some(label), Some(href)) = (text(&action.label), safe_href(&action.href)) else { return String::new() };
    format!("<p class=\"page-prompt\">{}<a class=\"page-prompt-link\" href=\"{}\">{}</a></p>", text(&prompt.text).map(|text| format!("{} ", escape(text))).unwrap_or_default(), escape(href), escape(label))
}

fn sent_to_html(sent_to: &Option<SentTo>) -> String {
    let Some(sent_to) = sent_to else { return String::new() };
    let Some(words) = text(&sent_to.text) else { return String::new() };
    let change = sent_to.change.as_ref().and_then(|change| Some((text(&change.label)?, safe_href(&change.href)?)))
        .map(|(label, href)| format!(" <a class=\"page-sent-to-change\" href=\"{}\">{}</a>", escape(href), escape(label))).unwrap_or_default();
    let address = text(&sent_to.address).map(|address| escape(address)).unwrap_or_default();
    format!("<p class=\"page-sent-to\">{} <strong class=\"page-sent-to-address\" data-page-sent-to>{address}</strong>{change}</p>", escape(words))
}

fn meta_html(meta: &Option<Meta>) -> String {
    let Some(meta) = meta else { return String::new() };
    let Some(label) = text(&meta.label) else { return String::new() };
    format!("<span class=\"page-item-meta{}\">{}</span>", text(&meta.tone).filter(|tone| plain_word(tone)).map(|tone| format!(" page-item-meta--{tone}")).unwrap_or_default(), escape(label))
}

fn item_html(item: &Item, level: u8, look: &Look) -> String {
    let heading = text(&item.heading);
    let body = text(&item.body);
    let meta = meta_html(&item.meta);
    let details: String = item.details.iter().map(|line| line.trim()).filter(|line| !line.is_empty())
        .map(|line| format!("<p class=\"page-item-detail\">{}</p>", escape(line))).collect();
    let fields: String = item.fields.iter().map(|field| field_html(field, look)).collect();
    let actions: String = item.actions.iter().map(action_html).collect();
    if heading.is_none() && body.is_none() && details.is_empty() {
        return String::new();
    }
    let top = if heading.is_some() || !meta.is_empty() {
        format!("<div class=\"page-item-top\">{}{meta}</div>", heading.map(|heading| format!("<h{level} class=\"page-item-heading\">{}</h{level}>", escape(heading))).unwrap_or_default())
    } else {
        String::new()
    };
    format!("<li class=\"page-item\">{top}{}{details}{}{}</li>",
        body.map(|body| format!("<p class=\"page-item-body\">{}</p>", escape(body))).unwrap_or_default(),
        if fields.is_empty() { String::new() } else { format!("<div class=\"page-fields\">{fields}</div>") },
        if actions.is_empty() { String::new() } else { format!("<div class=\"page-item-actions\">{actions}</div>") })
}

fn letters_of(value: &Option<String>) -> String {
    text(value).unwrap_or("").split_whitespace().take(2).filter_map(|word| word.chars().next()).collect::<String>().to_uppercase()
}

fn mark_html(mark: &Option<Mark>) -> String {
    let Some(mark) = mark else { return String::new() };
    if let Some(src) = safe_href(&mark.src).filter(|src| !src.starts_with('#')) {
        return format!("<img class=\"page-mark\" src=\"{}\" alt=\"{}\" width=\"64\" height=\"64\" decoding=\"async\"/>", escape(src), escape(text(&mark.alt).unwrap_or("")));
    }
    let letters = letters_of(&mark.name);
    if letters.is_empty() { letters } else { format!("<span class=\"page-mark page-mark--letters\" aria-hidden=\"true\">{}</span>", escape(&letters)) }
}

fn section_html(section: &Section, titled: bool, look: &Look) -> String {
    let heading = text(&section.heading);
    let body = text(&section.body);
    let status = section.status.as_deref().map(str::trim);
    let level: u8 = if section.heading_level == Some(1) && !titled { 1 } else { 2 };
    let under = if heading.is_some() { level + 1 } else { 2 };
    let items: String = section.items.iter().map(|item| item_html(item, under, look)).collect();
    let fields: String = section.fields.iter().map(|field| field_html(field, look)).collect();
    let actions: String = section.actions.iter().map(action_html).collect();
    let mut inner = String::new();
    inner += &mark_html(&section.mark);
    if let Some(heading) = heading {
        let _ = write!(inner, "<h{level} class=\"page-heading\">{}</h{level}>", escape(heading));
    }
    if let Some(body) = body {
        let _ = write!(inner, "<p class=\"page-body\">{}</p>", escape(body));
    }
    inner += &sent_to_html(&section.sent_to);
    inner += &image_html(&section.image, level == 1);
    inner += &picture_html(&section.picture);
    inner += &chips_html(&section.chips);
    if !items.is_empty() {
        let _ = write!(inner, "<ul class=\"page-items\">{items}</ul>");
    }
    let choice_form = choices_html(&section.choices, look, &actions);
    let actions_in_form = section.choices.as_ref().is_some_and(|choices| choices.actions_in_row) && !choice_form.is_empty();
    inner += &choice_form;
    inner += &divider_html(&section.divider);
    if !fields.is_empty() {
        let _ = write!(inner, "<div class=\"page-fields\">{fields}</div>");
    }
    if !actions.is_empty() && !actions_in_form {
        let _ = write!(inner, "<div class=\"page-actions\">{actions}</div>");
    }
    if let Some(status) = status {
        let _ = write!(inner, "<p class=\"page-status\" role=\"status\" aria-live=\"polite\">{}</p>", escape(status));
    }
    inner += &prompt_html(&section.prompt);
    if inner.is_empty() {
        return inner;
    }
    let stepped = text(&section.step).filter(|step| plain_word(step)).map(|step| format!(" data-page-step=\"{step}\"")).unwrap_or_default();
    format!("<section class=\"page-section{}\"{stepped}{}>{inner}</section>", emphasis_class(&section.emphasis), if section.hidden { " hidden" } else { "" })
}

fn sections_html(sections: &[Section], look: &Look) -> String {
    let mut titled = false;
    sections.iter().map(|section| {
        let html = section_html(section, titled, look);
        if section.heading_level == Some(1) && text(&section.heading).is_some() {
            titled = true;
        }
        html
    }).collect()
}

fn canonical_url(page: &Page) -> String {
    let Some(origin) = page.canonical_origin.as_deref() else { return String::new() };
    let path = page.canonical_path.as_deref().unwrap_or("/");
    let Some(host) = origin.strip_prefix("https://").map(|rest| rest.strip_suffix('/').unwrap_or(rest)) else { return String::new() };
    if host.is_empty() || host.contains(['/', '?', '#', '@']) || !path.starts_with('/') || path.starts_with("//") {
        return String::new();
    }
    match url::Url::parse(&format!("https://{host}/")) {
        Ok(url) => format!("{}{path}", url.origin().ascii_serialization()),
        Err(_) => String::new(),
    }
}

fn icon_links(icons: &[Icon]) -> String {
    icons.iter().filter_map(|icon| {
        let rel = icon.rel.trim();
        let href = safe_href(&Some(icon.href.clone()))?.to_string();
        if rel.is_empty() || !rel.starts_with(|c: char| c.is_ascii_lowercase()) || !rel.chars().all(|c| c.is_ascii_lowercase() || c == ' ' || c == '-') {
            return None;
        }
        let kind = text(&icon.kind).filter(|kind| {
            kind.split_once('/').is_some_and(|(a, b)| letters_only(a, "") && !b.is_empty() && b.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || ".+-".contains(c)))
        }).map(|kind| format!(" type=\"{}\"", escape(kind))).unwrap_or_default();
        let sizes = text(&icon.sizes).filter(|sizes| *sizes == "any" || sizes.split(' ').all(|size| {
            size.split_once('x').is_some_and(|(w, h)| !w.is_empty() && !h.is_empty() && w.chars().chain(h.chars()).all(|c| c.is_ascii_digit()))
        })).map(|sizes| format!(" sizes=\"{}\"", escape(sizes))).unwrap_or_default();
        Some(format!("<link rel=\"{}\" href=\"{}\"{kind}{sizes}/>", escape(rel), escape(&href)))
    }).collect()
}

fn share_meta(share: &Option<Share>) -> String {
    let Some(share) = share else { return String::new() };
    let web = |value: &Option<String>| value.as_deref().filter(|value| {
        let lower = value.get(..8).unwrap_or(value).to_ascii_lowercase();
        lower.starts_with("http://") || lower.starts_with("https://")
    }).map(str::to_string);
    let plain = |value: &Option<String>| text(value).map(str::to_string);
    let card = if web(&share.image).is_some() && share.image_card.as_deref() != Some("summary") { "summary_large_image" } else { "summary" };
    let rows = [
        ("property", "og:type", Some(plain(&share.kind).unwrap_or_else(|| "website".to_string()))),
        ("property", "og:site_name", plain(&share.site_name)),
        ("property", "og:title", plain(&share.title)),
        ("property", "og:description", plain(&share.description)),
        ("property", "og:url", web(&share.url)),
        ("property", "og:image", web(&share.image)),
        ("property", "og:image:alt", plain(&share.image_alt)),
        ("name", "twitter:card", Some(card.to_string())),
        ("name", "twitter:title", plain(&share.title)),
        ("name", "twitter:description", plain(&share.description)),
        ("name", "twitter:image", web(&share.image)),
    ];
    rows.iter().filter_map(|(kind, name, value)| value.as_ref().filter(|value| !value.is_empty()).map(|value| format!("<meta {kind}=\"{name}\" content=\"{}\"/>", escape(value)))).collect()
}

fn look_html(look: &Look) -> String {
    let entries: Vec<String> = look.palette.0.iter()
        .filter(|(name, value)| name.strip_prefix("--").is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
            && value.chars().count() <= 400 && !value.contains(['<', '>', '{', '}', ';', '\\']))
        .map(|(name, value)| format!("{name}:{value}")).collect();
    let links: String = look.stylesheets.iter().filter_map(|href| safe_href(&Some(href.clone())).filter(|href| !href.starts_with('#')).map(|href| format!("<link rel=\"stylesheet\" href=\"{}\"/>", escape(href)))).collect();
    links + &if entries.is_empty() { String::new() } else { format!("<style>:root{{{}}}</style>", entries.join(";")) }
}

fn meta_description(page: &Page) -> String {
    const LIMIT: usize = 160;
    let first = text(&page.meta_description).or_else(|| page.sections.iter().find_map(|section| text(&section.body))).unwrap_or("");
    let said = if first.chars().count() > LIMIT {
        let cut: String = first.chars().take(LIMIT).collect();
        // `.replace(/\s+\S*$/, '')`: drop the last, cut word and the space before it.
        let trimmed = match cut.rfind(char::is_whitespace) {
            Some(at) if !cut[at..].trim_start().contains(char::is_whitespace) => cut[..at].trim_end().to_string(),
            _ => cut,
        };
        format!("{trimmed}...")
    } else {
        first.to_string()
    };
    if said.is_empty() { said } else { format!("<meta name=\"description\" content=\"{}\"/>", escape(&said)) }
}

/// The whole document for `page` in `look` (old `pageShellHtml`).
pub(crate) fn document(look: &Look, page: &Page) -> String {
    let scheme = if look.scheme == "dark" { "dark" } else { "light" };
    let sections = sections_html(&page.sections, look);
    let canonical = canonical_url(page);
    let layout = word_class("page-layout", &page.layout);
    let content = if !layout.is_empty() {
        format!("<div class=\"page-layout{layout}\"><main class=\"page-main\">{sections}</main></div>")
    } else if !sections.is_empty() {
        format!("<main>{sections}</main>")
    } else {
        sections.clone()
    };
    let mut out = format!("<!doctype html><html lang=\"{}\" data-theme=\"{}\" data-look-scheme=\"{scheme}\"><head>", escape(&look.language), escape(&look.theme));
    out += "<meta charset=\"utf-8\"/><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>";
    let _ = write!(out, "<meta name=\"color-scheme\" content=\"{scheme}\"/>");
    if let Some(colour) = text(&look.theme_color) {
        let _ = write!(out, "<meta name=\"theme-color\" content=\"{}\"/>", escape(colour));
    }
    let _ = write!(out, "<title>{}</title>", escape(&page.title));
    out += &meta_description(page);
    if !canonical.is_empty() {
        let _ = write!(out, "<link rel=\"canonical\" href=\"{}\"/>", escape(&canonical));
    }
    out += &share_meta(&look.share);
    out += &icon_links(&look.icons);
    out += &look_html(look);
    let _ = write!(out, "<style>{}</style>", look.base_css);
    if !sections.is_empty() {
        let browse = if !layout.is_empty() || sections.contains("page-card") || sections.contains("page-chip") { look.browse_css.as_str() } else { "" };
        let _ = write!(out, "<style>{}{browse}{}</style>", look.sections_css, look.work_css);
    }
    let _ = write!(out, "</head><body><div id=\"root\">{content}</div>");
    for script in scripts(look, page, &sections) {
        let _ = write!(out, "<script>{script}</script>");
    }
    if let Some(bundle) = text(&look.bundle_url) {
        let _ = write!(out, "<script src=\"{}\" defer></script>", escape(bundle));
    }
    out + "</body></html>"
}

/// The inline scripts a page drawn from `sections` carries, in order: the shell's reveal and code scripts when it draws
/// what they run, then the page's own.
fn scripts<'a>(look: &'a Look, page: &'a Page, sections: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    if sections.contains("data-page-reveal") && !look.reveal_script.is_empty() {
        out.push(look.reveal_script.as_str());
    }
    if sections.contains("data-page-code") && !look.code_script.is_empty() {
        out.push(look.code_script.as_str());
    }
    out.extend(page.scripts.iter().map(String::as_str));
    out
}

/// Every inline script `look` may put on a page, for the page's content security policy.
pub(crate) fn look_scripts(look: &Look) -> [&str; 2] {
    [&look.reveal_script, &look.code_script]
}

#[cfg(test)]
#[path = "shell_tests.rs"]
mod tests;
