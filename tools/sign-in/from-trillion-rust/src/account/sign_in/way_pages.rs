//! The pages of the ways to sign in besides passkeys (`ways.rs`), drawn from their DATA rows: a way's sign-in page,
//! the account's Sign-in & security page, a way's add or change page, and the pages that show something once (backup
//! codes, a personal key, a passkey link). Plain HTML forms that post to this origin; no script. Every word is
//! the account's words row (`words_row.rs`, `ways`); every dynamic text is escaped. A refused step draws its page again with its words and focuses
//! the field or button that comes next.

use super::pages::{self, Words};
use super::shell::{Action, Choices, Field, Item, Link, Meta, Pairs, Picture, Reveal, Section};
use super::ways::{self, Proof, Refused, Typed, WaySettings, WayRow, CODE_FIELD, CURRENT_SECRET_FIELD, KEY_NAME_FIELD, NEW_SECRET_FIELD};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The words of the ways (the account's words row, `ways`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WayWords {
    #[serde(rename = "_what", default, skip_serializing_if = "String::is_empty")]
    _what: String,
    pub rows: BTreeMap<String, RowWords>,
    pub fields: BTreeMap<String, String>,
    pub names_refused: BTreeMap<String, String>,
    pub messages: Messages,
    pub send_code: String,
    pub send_again: String,
    pub code_sent: String,
    pub confirm_sent: String,
    pub not_sent: String,
    /// Optional for old account-owned words rows; absent copy uses the existing generic unavailable words.
    #[serde(default)]
    pub delivery_unknown: Option<String>,
    /// Optional for old account-owned words rows: absent, the add-email page answers `sign_in_words_missing`.
    #[serde(default)]
    pub add_email: Option<AddEmailWords>,
    pub too_many: String,
    pub too_short: String,
    pub too_long: String,
    pub current_wrong: String,
    pub setup_ended: String,
    pub needs_first: String,
    pub needed_by: String,
    pub last_way_in: String,
    pub sign_in_again: String,
    pub not_this_session: String,
    pub no_request: String,
    pub other_ways: String,
    pub code_way: String,
    pub back_to_sign_in: String,
    /// The password reset's words (old src/pages.mjs `forgotPasswordPage`, src/passwords.json). A row written before
    /// they existed reads the old copy.
    #[serde(default = "ResetWords::old")]
    pub reset: ResetWords,
    #[serde(rename = "continue")]
    pub go_on: String,
    pub listed_left: String,
    pub listed_last: String,
    pub timed_scan: String,
    pub timed_key: String,
    pub timed_picture: String,
    pub security_title: String,
    pub security_ways: String,
    pub security_on: String,
    pub security_off: String,
    pub security_left: String,
    pub passkeys_label: String,
    pub passkeys_count: String,
    pub passkey_add_here: String,
    pub passkey_link_button: String,
    pub passkey_link_reveal: String,
    pub waiting_count: String,
    pub withdraw_button: String,
    pub withdrawn: String,
    pub keys_label: String,
    pub keys_none: String,
    pub sign_out: String,
}

/// One way's own words.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RowWords {
    pub label: String,
    pub about: String,
    pub sign_in_title: String,
    /// The heading of the step where the code is typed (old src/pages.mjs `codeStep` 'Check your email'). Empty
    /// draws `sign_in_title`.
    #[serde(default)]
    pub code_heading: String,
    /// The line before the address the code went to (old `codeStep` 'Sent to'). Empty draws no line.
    #[serde(default)]
    pub sent_to: String,
    /// The link beside that address back to the first step (old `codeStep` 'Change email').
    #[serde(default)]
    pub change_sent_to: String,
    /// The label of each other way's link on this way's page, by that way's name (old src/pages.mjs phoneSignInPage's
    /// "Use email instead"). A way without its own label here draws its `link`, or its title.
    #[serde(default)]
    pub recover_labels: BTreeMap<String, String>,
    /// The sign-in page's body when it differs from `about` (old src/pages.mjs `emailSignInPage` body); it takes
    /// `{digits}` and `{minutes}` from the code settings. Empty draws `about`.
    #[serde(default)]
    pub sign_in_body: String,
    /// The first step's button when it differs from the ways' `send_code`. Empty uses `send_code`.
    #[serde(default)]
    pub send_button: String,
    /// The link to this way from another way's page when it differs from `sign_in_title`. Empty uses `sign_in_title`.
    #[serde(default)]
    pub link: String,
    pub sign_in_button: String,
    pub add_title: String,
    pub add_button: String,
    pub change_title: String,
    pub change_button: String,
    pub remove_button: String,
    pub added: String,
    pub changed: String,
    pub removed: String,
    pub wrong: String,
    /// The heading above the links to the other ways. Empty draws no heading (old email-code page).
    #[serde(default)]
    pub recover: String,
}

/// The password reset's words (old src/pages.mjs `forgotPasswordPage`; src/passwords.json `reset_done`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResetWords {
    pub title: String,
    pub new_password: String,
    pub hint: String,
    pub button: String,
    pub done: String,
}

impl ResetWords {
    /// The old copy, for a row written before these words.
    fn old() -> Self {
        Self {
            title: "Reset your password".to_string(),
            new_password: "New password".to_string(),
            hint: "At least 8 characters".to_string(),
            button: "Set new password".to_string(),
            done: "Your new password is set. Opening Trillion…".to_string(),
        }
    }
}

/// The words of the add-email page (old src/pages.mjs `addEmailPage`): its `body` takes `{minutes}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AddEmailWords {
    pub title: String,
    pub body: String,
    pub send_button: String,
    pub finish_button: String,
    pub not_now: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Messages {
    pub sign_in: Message,
    pub confirm: Message,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub subject: String,
    pub text: String,
}

/// The words of `way`. A page is drawn only with words that cover the account's ways row (`Words::covers`, checked
/// where the routes read both rows), so every way it names has its words.
pub(crate) fn row_words<'w>(w: &'w Words, way: &str) -> &'w RowWords {
    w.ways.rows.get(way).expect("the words row covers the ways row (Words::covers)")
}

/// `text` with each `{name}` in `values` filled, then escaped as a whole.
pub(crate) fn said(text: &str, values: &[(&str, &str)]) -> String {
    let mut filled = text.to_string();
    for (name, value) in values {
        filled = filled.replace(&format!("{{{name}}}"), value);
    }
    filled
}

fn url_part(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

/// The address of `way`'s sign-in page, carrying where to go after it (`routes::way_in`).
pub(crate) fn sign_in_address(base: &str, way: &str) -> String {
    super::routes::way_in(base, "/sign-in/way", &[("way", way)])
}

/// The words for a refused step of `way`.
pub(crate) fn refused_words(all: &Words, ways: &WaySettings, refused: &Refused, way: &WayRow) -> String {
    let words = &all.ways;
    let label = |way: &str| row_words(all, way).label.clone();
    match refused {
        Refused::Wrong(_) => row_words(all, &way.way).wrong.clone(),
        Refused::TooMany(minutes, _) => said(&words.too_many, &[("minutes", &minutes.to_string())]),
        Refused::NotSent(_) => words.not_sent.clone(),
        Refused::DeliveryUnknown(_) => words.delivery_unknown.clone().unwrap_or_else(|| all.unavailable.clone()),
        Refused::Limited(says, _) if !says.trim().is_empty() => says.clone(),
        Refused::Limited(_, _) => words.not_sent.clone(),
        Refused::NotAName(_) => way.named.as_deref().and_then(|kind| words.names_refused.get(kind)).cloned()
            .unwrap_or_else(|| row_words(all, &way.way).wrong.clone()),
        Refused::TooShort(_) => said(&words.too_short, &[("count", &ways.chosen.min_length.to_string())]),
        Refused::TooLong(_) => said(&words.too_long, &[("count", &ways.chosen.max_length.to_string())]),
        Refused::CurrentWrong(_) => words.current_wrong.clone(),
        Refused::SetupEnded(_) => words.setup_ended.clone(),
        Refused::NeedsFirst(other, _) => said(&words.needs_first, &[("way", &label(other))]),
        Refused::NeededBy(other, _) => said(&words.needed_by, &[("way", &label(other))]),
        Refused::LastWayIn(_) => words.last_way_in.clone(),
        Refused::NotFresh(_) => words.sign_in_again.clone(),
        Refused::NotThisSession(_) => words.not_this_session.clone(),
        Refused::NoRequest(_) => words.no_request.clone(),
        Refused::HeldWhileWaiting(_) => all.operations.held_while_waiting.clone(),
        Refused::NeedsKnownPasskey(_) => all.operations.needs_known_passkey.clone(),
        Refused::Unknown(_) | Refused::Missing(_) | Refused::WordsMissing(_) | Refused::Storage(_) => all.unavailable.clone(),
    }
}

/// The code way: directly under every passkey button that signs in, so no page depends on a passkey working (old
/// src/pages.mjs `authForm` 205: "Email me a code", `tone: 'link'`), named by the email-code way's own button.
pub(crate) fn code_way(w: &Words, ways: &WaySettings, base: &str) -> Option<Action> {
    // Not offered: nothing sends its codes.
    ways.row(&ways.code_way)?;
    Some(Action::link(&row_words(w, &ways.code_way).send_button, &sign_in_address(base, &ways.code_way), Some("link")))
}

/// The text code way, when texts go out (old src/pages.mjs `authForm` 'Text me a code', drawn only when `smsReady`).
/// Not offered: no tool sends texts.
pub(crate) fn text_way(w: &Words, ways: &WaySettings, base: &str) -> Option<Action> {
    let row = ways.rows.iter().find(|row| row.channel.as_deref() == Some("text"))?;
    let words = row_words(w, &row.way);
    let label = if words.send_button.is_empty() { &words.sign_in_title } else { &words.send_button };
    Some(Action::link(label, &sign_in_address(base, &row.way), Some("link")))
}

/// Every way to sign in, each a link to its page (old src/pages.mjs `emphasis: 'fine'` links, 444, 553, 586). A way that opens an AI-app
/// connection is listed only while one waits (`connecting`). It names no way the account holds, so it says nothing
/// about the account.
pub(crate) fn other_ways(w: &Words, ways: &WaySettings, base: &str, connecting: bool, except: &[&str]) -> Vec<Action> {
    ways.rows.iter()
        .filter(|row| !except.contains(&row.way.as_str()) && (connecting || row.opens == ways::Opens::Session))
        .map(|row| Action::link(&row_words(w, &row.way).sign_in_title, &sign_in_address(base, &row.way), Some("link")))
        .collect()
}

/// The way the sign-in page asks for first, as the old page asked email and password (old src/pages.mjs `authForm`
/// 205): the account's chosen secret, when it signs in alone, as a form that posts to its way.
pub(crate) fn first_form(w: &Words, ways: &WaySettings, base: &str, next: &str) -> Option<(String, Choices)> {
    let row = ways.rows.iter().find(|row| row.proof == Proof::Chosen && row.alone && row.opens == ways::Opens::Session)?;
    let kept = Typed::default();
    let form = Form { words: w, ways, base, next, request: None, kept: &kept, message: None, focus: None };
    let mut fields = vec![];
    fields.extend(name_field(&form, row));
    let mut secret = proof_field(&form, row);
    secret.label_action = Some(Link { label: Some(w.page.forgot_password.clone()), href: Some(sign_in_address(base, &row.way)) });
    fields.push(secret);
    let choices = Choices {actions_in_row: false, 
        href: Some(format!("{base}/sign-in/way")),
        values: carried(row, &form),
        fields,
        submit: Some(Action { label: Some(row_words(w, &row.way).sign_in_button.clone()), ..Default::default() }),
    };
    Some((row.way.clone(), choices))
}

/// What a way's page keeps between its steps, and how it answers a refusal.
pub(crate) struct Form<'a> {
    /// The account's words (they cover its ways).
    pub words: &'a Words,
    /// The account's ways.
    pub ways: &'a WaySettings,
    pub base: &'a str,
    pub next: &'a str,
    /// The AI-app connection waiting for this sign-in, when there is one.
    pub request: Option<&'a str>,
    /// Typed values that are not secrets, to draw again (a name).
    pub kept: &'a Typed,
    /// What happened at the last step: a refusal, or a code sent.
    pub message: Option<String>,
    /// The field or button to focus.
    pub focus: Option<&'a str>,
}

/// One box (old `fieldHtml`). `kind` is the input type; a name's value is drawn again, a secret's never.
fn field(form: &Form<'_>, name: &str, label: &str, kind: &str, autocomplete: &str, keep: bool) -> Field {
    let value = if keep { form.kept.get(name).cloned() } else { None };
    let secret = kind == "password";
    let words = &form.words.page;
    Field {
        name: Some(name.to_string()),
        label: Some(label.to_string()),
        kind: Some(kind.to_string()),
        autocomplete: Some(autocomplete.to_string()),
        required: true,
        value,
        // The eye that shows a typed secret (old src/pages.mjs REVEAL).
        reveal: secret.then(|| Reveal { show: Some(words.show_secret.clone()), hide: Some(words.hide_secret.clone()) }),
        autofocus: form.focus == Some(name),
        ..Default::default()
    }
}

/// A code typed one digit per box (old `kind: 'code'`, src/pages.mjs `codeStep` 253), `digits` long.
fn code_field(form: &Form<'_>, digits: usize) -> Field {
    Field {
        name: Some(CODE_FIELD.to_string()),
        label: Some(field_label(form, CODE_FIELD)),
        kind: Some("code".to_string()),
        length: i64::try_from(digits).ok(),
        autofocus: form.focus == Some(CODE_FIELD),
        ..Default::default()
    }
}

fn field_label(form: &Form<'_>, name: &str) -> String {
    form.words.ways.fields.get(name).cloned().unwrap_or_default()
}

/// The box a way's name is typed in, as its names shape draws it (old src/pages.mjs `emailField`, `phoneField`): no
/// autofocus, and required only where the shape says so.
fn name_field(form: &Form<'_>, way: &WayRow) -> Option<Field> {
    let kind = way.named.as_deref()?;
    let shape = form.ways.names.get(kind)?;
    let field = ways::name_field_of(form.ways, kind)?;
    let text = |value: &str| (!value.is_empty()).then(|| value.to_string());
    Some(Field {
        name: Some(field.clone()),
        label: Some(field_label(form, kind)),
        kind: Some(shape.input.clone()),
        autocomplete: Some(shape.autocomplete.clone()),
        inputmode: text(&shape.inputmode),
        placeholder: text(&shape.placeholder),
        required: shape.required,
        value: form.kept.get(&field).cloned(),
        ..Default::default()
    })
}

/// The box a sign-in types `way`'s proof in (old src/pages.mjs: the password box in `authForm` 205, `codeStep` 253, the
/// backup code box in `backupCodePage` 590).
fn proof_field(form: &Form<'_>, way: &WayRow) -> Field {
    let name = way.proof.field();
    match way.proof {
        Proof::Chosen => field(form, name, &field_label(form, name), "password", "current-password", false),
        Proof::Key => field(form, name, &field_label(form, name), "password", "off", false),
        Proof::Sent => code_field(form, form.ways.code.digits),
        Proof::Timed => code_field(form, form.ways.timed.digits as usize),
        Proof::Listed => {
            let listed = &form.ways.listed;
            let most = (listed.groups * (listed.group_length + 1)).saturating_sub(1) as i64;
            Field { max_length: Some(most), ..field(form, name, &field_label(form, name), "text", "one-time-code", false) }
        }
    }
}

/// The plain values every form of `way` carries.
fn carried(way: &WayRow, form: &Form<'_>) -> Pairs {
    let mut values = vec![("way".to_string(), way.way.clone())];
    if let Some(request) = form.request {
        values.push(("request".to_string(), request.to_string()));
    }
    Pairs(values)
}

/// The links offered when `way` cannot be used (its `recover_with` rows), and back to the sign-in page (old
/// src/pages.mjs fine links: BACK_TO_SIGN_IN 420 and the other ways).
fn recovering(way: &WayRow, form: &Form<'_>) -> Section {
    let mut links: Vec<Action> = way.recover_with.iter()
        .map(|other| {
            let words = row_words(form.words, other);
            let own = row_words(form.words, &way.way);
            let label = match own.recover_labels.get(other).filter(|label| !label.is_empty()) {
                Some(label) => label,
                None if words.link.is_empty() => &words.sign_in_title,
                None => &words.link,
            };
            Action::link(label, &sign_in_address(form.base, other), Some("link"))
        })
        .collect();
    links.insert(0, Action::link(&form.words.ways.back_to_sign_in, &super::routes::sign_in_address(form.base), Some("link")));
    pages::fine(None, Some(&row_words(form.words, &way.way).recover), links)
}

fn submit(label: &str) -> Option<Action> {
    Some(Action { label: Some(label.to_string()), ..Default::default() })
}

/// A way's sign-in page (old src/pages.mjs `emailSignInPage` 423, `phoneSignInPage` 462,
/// `authenticatorSignInPage` 535, `backupCodePage` 590). A sent way first asks where to send (`sent_to` None),
/// then for the code; every other way asks for its name and proof at once. The fields of the way's `also` ways are
/// asked with the proof.
pub(crate) fn sign_in(way: &WayRow, sent_to: Option<&str>, form: &Form<'_>) -> String {
    let words = row_words(form.words, &way.way);
    let action = format!("{}/sign-in/way", form.base);
    let send_action = format!("{}/sign-in/way/send", form.base);
    let also: Vec<Field> = way.also.iter().filter_map(|also| form.ways.row(also)).map(|also| proof_field(form, also)).collect();
    let mut first = pages::welcome(pages::look(), &words.sign_in_title, Some(&words.about));
    match (way.proof, sent_to) {
        (Proof::Sent, None) => {
            first.step = Some("ask".to_string());
            let minutes = form.ways.code.seconds.div_ceil(60).to_string();
            if !words.sign_in_body.is_empty() {
                first.body = Some(said(&words.sign_in_body, &[("digits", &form.ways.code.digits.to_string()), ("minutes", &minutes)]));
            }
            let send = if words.send_button.is_empty() { &form.words.ways.send_code } else { &words.send_button };
            first.choices = Some(Choices { actions_in_row: true, href: Some(send_action), values: carried(way, form), fields: name_field(form, way).into_iter().collect(),
                submit: submit(send) });
        }
        (Proof::Sent, Some(name)) => {
            first.step = Some("code".to_string());
            let mut values = carried(way, form);
            if let Some(kind) = way.named.as_deref() {
                values.0.push((ways::name_field_of(form.ways, kind).unwrap_or_else(|| kind.to_string()), name.to_string()));
            }
            let mut fields = vec![proof_field(form, way)];
            fields.extend(also);
            first.choices = Some(Choices { actions_in_row: true, href: Some(action), values: values.clone(), fields, submit: submit(&words.sign_in_button) });
            first.actions = vec![Action { post: Some(values), ..Action::link(&form.words.ways.send_again, &send_action, Some("link")) }];
            // The code's message is its body on this step, as the old client put it there after sending.
            first.heading = Some(if words.code_heading.is_empty() { words.sign_in_title.clone() } else { words.code_heading.clone() });
            if let Some(message) = form.message.clone() {
                first.body = Some(message);
            }
            if !words.sent_to.is_empty() {
                first.sent_to = Some(super::shell::SentTo {
                    text: Some(words.sent_to.clone()),
                    address: Some(name.to_string()),
                    change: Some(Link { label: Some(words.change_sent_to.clone()), href: Some(sign_in_address(form.base, &way.way)) }),
                });
            }
        }
        _ => {
            let mut fields: Vec<Field> = name_field(form, way).into_iter().collect();
            fields.push(proof_field(form, way));
            fields.extend(also);
            first.choices = Some(Choices { actions_in_row: false, href: Some(action), values: carried(way, form), fields, submit: submit(&words.sign_in_button) });
        }
    }
    first.status = Some(if way.proof == Proof::Sent && sent_to.is_some() { String::new() } else { form.message.clone().unwrap_or_default() });
    pages::draw(&pages::auth_page(&words.sign_in_title, vec![first, recovering(way, form)]))
}

/// The password reset's first step (old src/pages.mjs `forgotPasswordPage`, ask): its email box and Email me a code,
/// then Back to sign in. `status` says why a send was refused. None when no code way is offered.
pub(crate) fn reset_ask(w: &Words, ways: &WaySettings, base: &str, next: &str, status: Option<&str>) -> Option<String> {
    let way = ways.row(&ways.code_way)?;
    let kept = Typed::default();
    let form = Form { words: w, ways, base, next, request: None, kept: &kept, message: None, focus: None };
    let words = row_words(w, &way.way);
    let minutes = ways.code.seconds.div_ceil(60).to_string();
    let body = said(&words.sign_in_body, &[("digits", &ways.code.digits.to_string()), ("minutes", &minutes)]);
    let mut first = pages::welcome(pages::look(), &w.ways.reset.title, Some(&body));
    let send = if words.send_button.is_empty() { &w.ways.send_code } else { &words.send_button };
    let mut values = carried(way, &form);
    values.0.push(("reset".to_string(), "1".to_string()));
    first.choices = Some(Choices { actions_in_row: true, href: Some(format!("{base}/sign-in/way/send")), values, fields: name_field(&form, way).into_iter().collect(), submit: submit(send) });
    first.status = Some(status.unwrap_or_default().to_string());
    let back = pages::fine(None, None, vec![Action::link(&w.ways.back_to_sign_in, &super::routes::sign_in_address(base), Some("link"))]);
    Some(pages::draw(&pages::auth_page(&w.ways.reset.title, vec![first, back])))
}

/// The password reset's second step (old src/pages.mjs `forgotPasswordPage`, code step): the code the email carried, the
/// new password, and Set new password, with Send a new code and Back to sign in. `message` is the code's sent message, or
/// why the last try was refused; `focus` is the box to start on.
pub(crate) fn reset_code(w: &Words, ways: &WaySettings, base: &str, next: &str, name: &str, message: &str, focus: Option<&str>) -> Option<String> {
    let way = ways.row(&ways.code_way)?;
    let words = row_words(w, &way.way);
    let kept = Typed::default();
    let form = Form { words: w, ways, base, next, request: None, kept: &kept, message: None, focus };
    let mut values = carried(way, &form);
    values.0.push(("reset".to_string(), "1".to_string()));
    if let Some(kind) = way.named.as_deref() {
        values.0.push((ways::name_field_of(ways, kind).unwrap_or_else(|| kind.to_string()), name.to_string()));
    }
    let password = Field { placeholder: Some(w.ways.reset.hint.clone()), ..field(&form, ways::NEW_SECRET_FIELD, &w.ways.reset.new_password, "password", "new-password", false) };
    let heading = if words.code_heading.is_empty() { &words.sign_in_title } else { &words.code_heading };
    let mut first = pages::welcome(pages::look(), heading, Some(message));
    first.status = Some(String::new());
    first.choices = Some(Choices { actions_in_row: true, href: Some(format!("{base}/sign-in/way")), values: values.clone(), fields: vec![code_field(&form, ways.code.digits), password], submit: submit(&w.ways.reset.button) });
    first.actions = vec![Action { post: Some(values), ..Action::link(&w.ways.send_again, &format!("{base}/sign-in/way/send"), Some("link")) }];
    if !words.sent_to.is_empty() {
        first.sent_to = Some(super::shell::SentTo {
            text: Some(words.sent_to.clone()),
            address: Some(name.to_string()),
            change: Some(Link { label: Some(words.change_sent_to.clone()), href: Some(sign_in_address(base, &way.way)) }),
        });
    }
    let back = pages::fine(None, None, vec![Action::link(&w.ways.back_to_sign_in, &super::routes::sign_in_address(base), Some("link"))]);
    Some(pages::draw(&pages::auth_page(&w.ways.reset.title, vec![first, back])))
}

/// A page that says one thing and goes on.
pub(crate) fn notice(w: &Words, text: &str, go_to: &str) -> String {
    let mut first = pages::welcome(pages::look(), &w.sign_in_title, None);
    first.status = Some(text.to_string());
    first.actions = vec![Action::link(&w.ways.go_on, go_to, None)];
    pages::draw(&pages::auth_page(&w.sign_in_title, vec![first]))
}

/// A page showing `items` once (backup codes, a key, a link), with what to do with them, and the way back.
pub(crate) fn shown_once(w: &Words, title: &str, intro: &str, items: &[String], back: &str) -> String {
    let mut first = pages::welcome(pages::look(), title, None);
    first.status = Some(intro.to_string());
    first.items = items.iter().map(|item| Item { heading: Some(item.clone()), ..Default::default() }).collect();
    first.actions = vec![Action::link(&w.ways.go_on, back, None)];
    pages::draw(&pages::auth_page(title, vec![first]))
}

/// What the account's Sign-in & security page shows.
pub(crate) struct Security<'a> {
    /// The account's words (they cover its ways).
    pub words: &'a Words,
    /// The account's ways.
    pub ways: &'a WaySettings,
    pub base: &'a str,
    pub passkeys: usize,
    /// Each way the account holds, by its name in the rows: its name and, for a listed way, how many codes are left.
    pub held: BTreeMap<String, (Option<String>, Option<usize>)>,
    /// Each personal key: its id, name and last characters.
    pub keys: Vec<(String, String, String)>,
    /// How many passkey links, challenges and codes wait to be used (`routes::waiting`).
    pub waiting: usize,
    pub message: Option<String>,
}

fn post(label: &str, action: &str, values: Vec<(&str, &str)>, quiet: bool) -> Action {
    Action {
        post: Some(Pairs(values.into_iter().map(|(name, value)| (name.to_string(), value.to_string())).collect())),
        ..Action::link(label, action, quiet.then_some("quiet"))
    }
}

/// The account's Sign-in & security page: its passkeys, every way with its state, and its personal keys, each with
/// what can be done with it (old: the account page's Sign-in & security, drawn in the workspace; here in the page shell,
/// one section of items per kind).
pub(crate) fn security(view: &Security<'_>) -> String {
    let words = &view.words.ways;
    let manage = format!("{}/sign-in/security/way", view.base);
    let mut first = pages::welcome(pages::look(), &words.security_title, None);
    first.status = view.message.clone();
    let mut passkey_actions = vec![
        Action::link(&words.passkey_add_here, &format!("{}/sign-in/add-passkey", view.base), None),
        post(&words.passkey_link_button, &format!("{}/sign-in/passkey-link", view.base), vec![], true),
    ];
    let mut passkey_details = vec![];
    if view.waiting > 0 {
        passkey_details.push(said(&words.waiting_count, &[("count", &view.waiting.to_string())]));
        passkey_actions.push(post(&words.withdraw_button, &format!("{}/sign-in/withdraw", view.base), vec![], true));
    }
    let passkeys = Item {
        heading: Some(words.passkeys_label.clone()),
        body: Some(said(&words.passkeys_count, &[("count", &view.passkeys.to_string())])),
        details: passkey_details,
        actions: passkey_actions,
        ..Default::default()
    };
    let ways_items: Vec<Item> = view.ways.rows.iter().filter(|row| row.proof != Proof::Key).map(|row| {
        let own = row_words(view.words, &row.way);
        let held = view.held.get(&row.way);
        let state = match held {
            Some((Some(name), _)) => format!("{}: {}", words.security_on, name),
            Some((None, Some(left))) => format!("{}: {}", words.security_on, said(&words.security_left, &[("left", &left.to_string())])),
            Some((None, None)) => words.security_on.clone(),
            None => words.security_off.clone(),
        };
        let change = format!("{manage}?way={}", url_part(&row.way));
        let mut actions = vec![Action::link(if held.is_some() { &own.change_title } else { &own.add_title }, &change, None)];
        if held.is_some() {
            actions.push(post(&own.remove_button, &manage, vec![("way", &row.way), ("step", "remove")], true));
        }
        Item { heading: Some(own.label.clone()), body: Some(own.about.clone()), meta: Some(Meta { label: Some(state), tone: None }), actions, ..Default::default() }
    }).collect();
    let mut sections = vec![first, Section { items: vec![passkeys], ..Default::default() },
        Section { heading: Some(words.security_ways.clone()), items: ways_items, ..Default::default() }];
    if let Some(row) = view.ways.rows.iter().find(|row| row.proof == Proof::Key) {
        let own = row_words(view.words, &row.way);
        let keys: Vec<Item> = view.keys.iter().map(|(id, name, ending)| Item {
            heading: Some(format!("{name} …{ending}")),
            actions: vec![post(&own.remove_button, &manage, vec![("way", &row.way), ("step", "remove"), ("id", id)], true)],
            ..Default::default()
        }).collect();
        sections.push(Section {
            heading: Some(words.keys_label.clone()),
            body: Some(if keys.is_empty() { format!("{} {}", own.about, words.keys_none) } else { own.about.clone() }),
            items: keys,
            actions: vec![Action::link(&own.add_title, &format!("{manage}?way={}", url_part(&row.way)), None)],
            ..Default::default()
        });
    }
    sections.push(pages::fine(None, None, vec![post(&words.sign_out, &format!("{}/sign-out", view.base), vec![], true)]));
    pages::draw(&pages::auth_page(&words.security_title, sections))
}

/// Where an add or change of a way stands.
pub(crate) enum Step<'a> {
    /// Nothing asked yet.
    Start,
    /// A code went to this name; the code is asked next.
    CodeSent(&'a str),
    /// Delivery is uncertain, but the possibly delivered code remains valid and may be entered.
    DeliveryUnknown(&'a str),
    /// A timed secret waits for its first code: its key and the address an app opens.
    Timed { key: &'a str, address: &'a str },
}

/// The address an authenticator app opens, as a QR picture it can scan, drawn in the page (no request leaves it, so the
/// secret in the address stays in this page). An address too long for a QR code draws nothing; the link and the key
/// under it still work.
fn scan_picture(w: &Words, address: &str) -> Option<Picture> {
    let code = qrcode::QrCode::new(address.as_bytes()).ok()?;
    // One path of horizontal runs of dark modules, inside the standard four-module quiet zone. A module-per-square drawing
    // is several times larger, and the whole page must stay under the page limit.
    let width = code.width();
    let colors = code.to_colors();
    let quiet = 4;
    let mut path = String::new();
    for (y, row) in colors.chunks(width).enumerate() {
        let mut x = 0;
        while x < width {
            if row[x] != qrcode::Color::Dark {
                x += 1;
                continue;
            }
            let start = x;
            while x < width && row[x] == qrcode::Color::Dark {
                x += 1;
            }
            path.push_str(&format!("M{} {}h{}v1h-{}z", start + quiet, y + quiet, x - start, x - start));
        }
    }
    let size = width + 2 * quiet;
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="200" height="200" shape-rendering="crispEdges"><rect width="{size}" height="{size}" fill="#fff"/><path d="{path}" fill="#000"/></svg>"##
    );
    Some(Picture { label: w.ways.timed_picture.clone(), svg })
}

/// A way's add or change page, for a signed-in person whose session may change ways (old src/pages.mjs
/// `setPasswordPage` 504, `authenticatorSetupPage` 559, `addEmailPage` 612, `addPhonePage` 470).
pub(crate) fn setup(way: &WayRow, held: bool, recovering: bool, step: &Step<'_>, form: &Form<'_>) -> String {
    let own = row_words(form.words, &way.way);
    let (title, go) = if held { (&own.change_title, &own.change_button) } else { (&own.add_title, &own.add_button) };
    let action = format!("{}/sign-in/security/way", form.base);
    let mut values = vec![("way".to_string(), way.way.clone())];
    let mut first = pages::welcome(pages::look(), title, Some(&own.about));
    let step_value = |name: &str| ("step".to_string(), name.to_string());
    let mut items = vec![];
    let fields: Vec<Field> = match (way.proof, step) {
        (Proof::Chosen, _) => {
            values.push(step_value("add"));
            let mut fields: Vec<Field> = name_field(form, way).into_iter().collect();
            if held && way.change_needs_current && !recovering {
                fields.push(field(form, CURRENT_SECRET_FIELD, &field_label(form, CURRENT_SECRET_FIELD), "password", "current-password", false));
            }
            fields.push(Field { min_length: i64::try_from(form.ways.chosen.min_length).ok(),
                ..field(form, NEW_SECRET_FIELD, &field_label(form, NEW_SECRET_FIELD), "password", "new-password", false) });
            fields
        }
        (Proof::Sent, Step::CodeSent(name)) => {
            values.push(step_value("confirm"));
            first.body = Some(said(&form.words.ways.confirm_sent, &[("name", name), ("digits", &form.ways.code.digits.to_string()),
                ("minutes", &form.ways.code.seconds.div_ceil(60).to_string())]));
            vec![code_field(form, form.ways.code.digits)]
        }
        (Proof::Sent, Step::DeliveryUnknown(_name)) => {
            values.push(step_value("confirm"));
            vec![code_field(form, form.ways.code.digits)]
        }
        (Proof::Sent, _) => {
            values.push(step_value("add"));
            name_field(form, way).into_iter().collect()
        }
        (Proof::Timed, Step::Timed { key, address }) => {
            values.push(step_value("confirm"));
            first.body = Some(form.words.ways.timed_scan.clone());
            first.picture = scan_picture(form.words, address);
            items.push(Item { heading: Some(form.words.ways.timed_key.clone()), body: Some(ways::in_groups(key)), ..Default::default() });
            // The same address as a link, for an app on this device.
            first.actions.push(Action { app_address: true, ..Action::link(address, address, Some("link")) });
            vec![code_field(form, form.ways.timed.digits as usize)]
        }
        (Proof::Timed | Proof::Listed, _) => {
            values.push(step_value("add"));
            vec![]
        }
        (Proof::Key, _) => {
            values.push(step_value("add"));
            vec![field(form, KEY_NAME_FIELD, &field_label(form, KEY_NAME_FIELD), "text", "off", true)]
        }
    };
    first.items = items;
    if fields.is_empty() {
        // Nothing to type: the step is one press (old `actions` with `post`).
        first.actions = vec![Action { post: Some(Pairs(values)), ..Action::link(go, &action, None) }];
    } else {
        first.choices = Some(Choices { actions_in_row: false, href: Some(action), values: Pairs(values), fields, submit: submit(go) });
    }
    first.status = Some(form.message.clone().unwrap_or_default());
    first.actions.push(Action::link(&form.words.ways.security_title, &format!("{}/sign-in/security", form.base), Some("link")));
    pages::draw(&pages::auth_page(title, vec![first]))
}

/// Signed in: the email this account signs in with by a code, confirmed by a code sent to it, or not now (old
/// src/pages.mjs `addEmailPage` 612). One step posts `step` to the same address: `add` sends the code, `confirm` checks it.
pub(crate) fn add_email(way: &WayRow, words: &AddEmailWords, step: &Step<'_>, form: &Form<'_>) -> String {
    let minutes = form.ways.code.seconds.div_ceil(60).to_string();
    let body = said(&words.body, &[("minutes", &minutes)]);
    let mut first = pages::welcome(pages::look(), &words.title, Some(&body));
    let (fields, go, step_name) = match step {
        Step::CodeSent(name) => {
            first.body = Some(said(&form.words.ways.confirm_sent, &[("name", name), ("digits", &form.ways.code.digits.to_string()), ("minutes", &minutes)]));
            (vec![code_field(form, form.ways.code.digits)], &words.finish_button, "confirm")
        }
        Step::DeliveryUnknown(_) => (vec![code_field(form, form.ways.code.digits)], &words.finish_button, "confirm"),
        Step::Start | Step::Timed { .. } => (name_field(form, way).into_iter().collect::<Vec<Field>>(), &words.send_button, "add"),
    };
    let action = format!("{}/sign-in/add-email", form.base);
    let values = vec![("step".to_string(), step_name.to_string())];
    first.choices = Some(Choices { href: Some(action), values: Pairs(values), fields, submit: submit(go), actions_in_row: true });
    first.status = Some(form.message.clone().unwrap_or_default());
    first.actions.push(Action::link(&words.not_now, form.next, Some("link")));
    pages::draw(&pages::auth_page(&words.title, vec![first]))
}

/// The field a refused step of `way` focuses: the one to fix, else the button that comes next.
pub(crate) fn focus_for<'a>(refused: &Refused, way: &'a WayRow, adding: bool) -> &'a str {
    match refused {
        Refused::NotAName(_) => way.named.as_deref().unwrap_or("go"),
        Refused::Wrong(_) if adding => CODE_FIELD,
        Refused::Wrong(_) => way.proof.field(),
        Refused::CurrentWrong(_) => CURRENT_SECRET_FIELD,
        Refused::TooShort(_) | Refused::TooLong(_) => NEW_SECRET_FIELD,
        Refused::NotSent(_) | Refused::Limited(_, _) | Refused::SetupEnded(_) => "send",
        Refused::DeliveryUnknown(_) => CODE_FIELD,
        _ => "go",
    }
}

#[cfg(test)]
#[path = "way_pages_tests.rs"]
mod tests;
