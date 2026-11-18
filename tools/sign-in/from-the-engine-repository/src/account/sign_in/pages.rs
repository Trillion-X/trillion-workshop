//! The sign-in pages: plain HTML rendered here, every word from the account's words row (`words_row.rs`),
//! one small hand-written passkey script inline (browsers offer passkeys only
//! to page scripts). No external asset, no build step, no framework. Every
//! dynamic text is HTML-escaped, and dynamic values reach the script only as
//! `data-` attributes, never as text inside the script. Pages: sign-in,
//! connect (consent for an AI app), add a passkey (from a one-use link, or
//! signed in), and short notices.

use base64::{engine::general_purpose::STANDARD, Engine};
use ring::digest;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use super::shell::{self, Action, Field, Link, Look, Page, Pairs, Prompt, Section};
use super::set_password;
use super::ways::WaySettings;

/// Every word the sign-in pages, its ways and its operations say: the account's own words row (`words_row.rs`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Words {
    #[serde(rename = "_what", default, skip_serializing_if = "String::is_empty")]
    _what: String,
    pub sign_in_title: String,
    sign_in_button: String,
    connect_title: String,
    connect_body: String,
    connect_allow: String,
    connect_deny: String,
    add_passkey_title: String,
    add_passkey_body: String,
    add_passkey_body_signed_in: String,
    add_passkey_name: String,
    add_passkey_placeholder: String,
    add_passkey_button: String,
    pub offer_passkey_title: String,
    offer_passkey_body: String,
    offer_passkey_button: String,
    not_now: String,
    failed: String,
    no_passkey: String,
    refused: String,
    pub unavailable: String,
    sign_up_title: String,
    sign_up_body: String,
    sign_up_button: String,
    sign_up_done: String,
    sign_up_closed: String,
    /// The words of the sign-up form and its code step (old src/pages.mjs `authForm` signUp and `codeStep`).
    #[serde(default)]
    pub sign_up_form: SignUpForm,
    /// The name of the key the app that runs this engine holds for itself (src/account/account_routes.rs).
    pub host_key_name: String,
    /// The name a new account's passkey is registered under (src/account/sign_in/passkeys.rs `sign_up_options`).
    pub passkey_user_name: String,
    /// The words of the other ways to sign in (src/account/sign_in/way_pages.rs).
    pub ways: super::way_pages::WayWords,
    /// The words the sign-in's own operations answer with (src/account/sign_in/known.rs, calls.rs).
    pub operations: super::known::OperationWords,
    /// The words of the page shell's own parts (`shell.rs`): the "or" line and a secret box's eye. A row without them
    /// draws neither.
    #[serde(default)]
    pub page: PageWords,
    /// The words of the set-password page (`set_password.rs`); a row without them draws empty words.
    #[serde(default)]
    pub set_password: SetPasswordWords,
    /// The words of the page that asks the person to approve an offered change with a passkey (`approve.rs`); a row
    /// without them draws empty words.
    #[serde(default)]
    pub approve: ApproveWords,
}

/// The approve page's words (`approve.rs`). `{tool}` and `{capability}` are filled in with the offer's own tool and
/// capability; nothing else is.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApproveWords {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub holds: String,
    #[serde(default)]
    pub why: String,
    #[serde(default)]
    pub button: String,
    #[serde(default)]
    pub done: String,
    #[serde(default)]
    pub failed: String,
    #[serde(default)]
    pub gone: String,
    #[serde(default)]
    pub no_passkey: String,
}

/// The sign-up form's words: its fields, its buttons, its code step and the refusals it can show. A row without them
/// draws empty labels and refuses with empty words.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignUpForm {
    #[serde(default)]
    pub given_name: String,
    #[serde(default)]
    pub family_name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub email_placeholder: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub password_hint: String,
    #[serde(default)]
    pub submit: String,
    #[serde(default)]
    pub email_code: String,
    #[serde(default)]
    pub code_title: String,
    /// The code step's body; `{email}` is the address the code went to.
    #[serde(default)]
    pub code_body: String,
    #[serde(default)]
    pub code_label: String,
    #[serde(default)]
    pub code_submit: String,
    #[serde(default)]
    pub code_again: String,
    #[serde(default)]
    pub name_required: String,
    #[serde(default)]
    pub email_invalid: String,
    #[serde(default)]
    pub password_short: String,
    #[serde(default)]
    pub code_unavailable: String,
    #[serde(default)]
    pub code_unsent: String,
    #[serde(default)]
    pub code_limited: String,
    #[serde(default)]
    pub code_failed: String,
    #[serde(default)]
    pub code_expired: String,
    #[serde(default)]
    pub email_taken: String,
    #[serde(default)]
    pub closed_full: String,
}

fn forgot_password_default() -> String {
    "Forgot password?".to_string()
}

/// The words the old page shell's parts say (old src/pages.mjs `authForm` `divider: 'or'` 232 and REVEAL 188).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageWords {
    /// Between the form and the other ways in.
    #[serde(default)]
    pub or: String,
    /// The link beside the password box's label on the sign-in page (old src/pages.mjs `authForm` "Forgot password?").
    /// A row written before it existed reads the same words.
    #[serde(default = "forgot_password_default")]
    pub forgot_password: String,
    /// What a secret box's eye button says while the secret is hidden, and while it shows.
    #[serde(default)]
    pub show_secret: String,
    #[serde(default)]
    pub hide_secret: String,
    /// The page's meta description (old src/pages.mjs `signInPage`); a row without it sets none.
    #[serde(default)]
    pub meta_description: String,
    /// The prompts between the two pages: a sign-up page's link to signing in, a sign-in page's link to signing up.
    #[serde(default)]
    pub have_account: String,
    #[serde(default)]
    pub sign_in_link: String,
    #[serde(default)]
    pub no_account: String,
    #[serde(default)]
    pub sign_up_link: String,
    /// The fine print under a sign-in page (old src/pages.mjs `FINE_PRINT`): its two links.
    #[serde(default)]
    pub what_we_keep: String,
    #[serde(default)]
    pub terms: String,
}

/// The set-password page's words (old src/pages.mjs `setPasswordPage`, src/passwords.json `strength` and `words`). The
/// `{email}` and `{min}` marks are filled in; a row without them draws empty words.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetPasswordWords {
    #[serde(default)]
    pub set_title: String,
    #[serde(default)]
    pub change_title: String,
    #[serde(default)]
    pub offered_title: String,
    #[serde(default)]
    pub meta_description: String,
    #[serde(default)]
    pub set_body: String,
    #[serde(default)]
    pub change_body: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub current_password: String,
    #[serde(default)]
    pub new_password: String,
    #[serde(default)]
    pub new_password_placeholder: String,
    #[serde(default)]
    pub new_password_hint: String,
    #[serde(default)]
    pub confirm_password: String,
    #[serde(default)]
    pub set_button: String,
    #[serde(default)]
    pub change_button: String,
    #[serde(default)]
    pub skip: String,
    #[serde(default)]
    pub cancel: String,
    /// How strong a new password reads as it is typed, by score (`{min}` is the least length).
    #[serde(default)]
    pub strength_short: String,
    #[serde(default)]
    pub strength_fine: String,
    #[serde(default)]
    pub strength_good: String,
    #[serde(default)]
    pub strength_strong: String,
    #[serde(default)]
    pub not_the_same: String,
}


/// The passkey script. It reads its purpose, link code, next path and failure
/// text from the button's `data-` attributes, and a new passkey's name from the page. Its SHA-256 goes into the CSP.
const SCRIPT: &str = concat!(r##"(function () {
  "use strict";
  var button = document.querySelector("[data-passkey]");
  if (!button) return;
  var base = button.getAttribute("data-base") || "";
  var message = document.querySelector(".page-status");
"##, include_str!("passkey_bytes.js"), r##"  function revive(options) {
    options.challenge = fromB64(options.challenge);
    if (options.user) options.user.id = fromB64(options.user.id);
    ["allowCredentials", "excludeCredentials"].forEach(function (key) {
      (options[key] || []).forEach(function (credential) { credential.id = fromB64(credential.id); });
    });
    return options;
  }
  function post(path, body) {
    return fetch(base + path, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    }).then(function (reply) {
      if (!reply.ok) throw new Error("status " + reply.status);
      return reply.json();
    });
  }
  function signIn() {
    return post("/passkey/options", { purpose: "sign-in" }).then(function (options) {
      return navigator.credentials.get({ publicKey: revive(options) });
    }).then(function (credential) {
      var r = credential.response;
      return post("/passkey/finish", {
        purpose: "sign-in", id: credential.id, rawId: toB64(credential.rawId), type: credential.type,
        response: {
          clientDataJSON: toB64(r.clientDataJSON), authenticatorData: toB64(r.authenticatorData),
          signature: toB64(r.signature), userHandle: toB64(r.userHandle)
        }
      });
    });
  }
  function addPasskey(code) {
    var link = code ? { code: code } : {};
    var name = document.getElementById("page-field-passkey-name").value;
    return post("/passkey/options", Object.assign({ purpose: "register" }, link)).then(function (options) {
      return navigator.credentials.create({ publicKey: revive(options) });
    }).then(function (credential) {
      var r = credential.response;
      return post("/passkey/finish", Object.assign({
        purpose: "register", name: name, id: credential.id, rawId: toB64(credential.rawId), type: credential.type,
        response: {
          clientDataJSON: toB64(r.clientDataJSON), authenticatorData: toB64(r.getAuthenticatorData()),
          publicKey: toB64(r.getPublicKey()), publicKeyAlgorithm: r.getPublicKeyAlgorithm()
        }
      }, link));
    });
  }
  function signUp() {
    var name = document.getElementById("page-field-email").value;
    var plan = button.getAttribute("data-next");
    return post("/sign-up/options", {}).then(function (answer) {
      return navigator.credentials.create({ publicKey: revive(answer.options) }).then(function (credential) {
        var r = credential.response;
        return post("/sign-up/finish", {
          next: plan || undefined,
          name: name, id: credential.id, rawId: toB64(credential.rawId), type: credential.type,
          response: {
            clientDataJSON: toB64(r.clientDataJSON), authenticatorData: toB64(r.getAuthenticatorData()),
            publicKey: toB64(r.getPublicKey()), publicKeyAlgorithm: r.getPublicKeyAlgorithm()
          }
        });
      });
    });
  }
  button.addEventListener("click", function () {
    var purpose = button.getAttribute("data-purpose");
    var step = purpose === "sign-up" ? signUp()
      : purpose === "register" ? addPasskey(button.getAttribute("data-code")) : signIn();
    button.disabled = true;
    message.textContent = "";
    step.then(function (done) {
      if (purpose === "sign-up") {
        if (done.next) { location.assign(done.next); return; }
        button.hidden = true;
        message.textContent = button.getAttribute("data-done").replace("{address}", done.address);
        return;
      }
      location.assign(button.getAttribute("data-next") || "/");
    }).catch(function () {
      button.disabled = false;
      message.textContent = button.getAttribute("data-failed");
    });
  });
})();
"##);

/// Escape text for an HTML text node or a double-quoted attribute.
pub(crate) fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
/// A word with `{client}` replaced by the escaped client name. The word's
/// own text is escaped too; the client name is never re-scanned.
fn fill(template: &str, client: &str) -> String {
    template.split("{client}").map(escape).collect::<Vec<_>>().join(&escape(client))
}

/// The base64 SHA-256 of the passkey script, for `script-src 'sha256-...'`.
#[cfg(test)]
pub(crate) fn script_hash() -> String {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| STANDARD.encode(digest::digest(&digest::SHA256, SCRIPT.as_bytes()))).clone()
}

/// One inline script as a CSP source: its SHA-256.
pub(crate) fn script_source(script: &str) -> String {
    format!("'sha256-{}'", STANDARD.encode(digest::digest(&digest::SHA256, script.as_bytes())))
}

/// Every inline script a sign-in page may carry, as CSP sources: the passkey script and the look's shell scripts, each
/// by its SHA-256.
pub(crate) fn script_sources() -> String {
    static SOURCES: OnceLock<String> = OnceLock::new();
    SOURCES.get_or_init(|| {
        [SCRIPT, set_password::SCRIPT, super::approve::SCRIPT].into_iter().chain(shell::look_scripts(look()).into_iter().filter(|script| !script.is_empty()))
            .map(script_source).collect::<Vec<_>>().join(" ")
    }).clone()
}

/// The product's look (`shell::Look`): the launcher's product settings `page_look`, read once. A launcher that writes none
/// gets pages with the shell's markup and no look at all (`Look::bare`), never a look written here.
pub(crate) fn look() -> &'static Look {
    static LOOK: OnceLock<Look> = OnceLock::new();
    LOOK.get_or_init(|| {
        crate::account_files::identity::section(LOOK_SECTION).ok().flatten()
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_else(Look::bare)
    })
}

/// The product settings section that holds the look (src/account_files/identity.json `sections`).
pub(crate) const LOOK_SECTION: &str = "page_look";

/// The brand mark every sign-in page opens with (old src/pages.mjs LOGO): the product's `brand_mark_path`, read aloud
/// as the look's `mark_alt`.
fn mark(look: &Look) -> Option<shell::Mark> {
    let path = crate::account_files::identity::identity().ok()?.brand_mark_path.clone();
    Some(shell::Mark { src: Some(path), alt: Some(look.mark_alt.clone()), name: None })
}

/// A page in the sign-in layout (old src/pages.mjs `authPage`: `layout: 'auth'`), at the product's own address.
pub(crate) fn auth_page(title: &str, sections: Vec<Section>) -> Page {
    let origin = crate::account_files::identity::identity().ok().map(|identity| format!("https://{}", identity.app_host));
    Page { title: title.to_string(), canonical_origin: origin, layout: Some("auth".to_string()), sections, ..Default::default() }
}

/// The opening section of a sign-in page (old `emphasis: 'welcome', mark: LOGO, heading_level: 1`).
pub(crate) fn welcome(look: &Look, heading: &str, body: Option<&str>) -> Section {
    Section {
        emphasis: Some("welcome".to_string()),
        mark: mark(look),
        heading: Some(heading.to_string()),
        heading_level: Some(1),
        body: body.map(str::to_string),
        ..Default::default()
    }
}

/// The fine print under a sign-in page (old src/pages.mjs `FINE_PRINT`): what we keep, and the terms. A row without
/// its words draws no link rather than an empty one.
fn fine_print(w: &Words) -> Section {
    let mut links = Vec::new();
    if !w.page.what_we_keep.is_empty() {
        links.push(Action::link(&w.page.what_we_keep, "/privacy", Some("link")));
    }
    if !w.page.terms.is_empty() {
        links.push(Action::link(&w.page.terms, "/terms", Some("link")));
    }
    fine(None, None, links)
}

/// The page's meta description, when its words have one.
fn meta_of(w: &Words) -> Option<String> {
    Some(w.page.meta_description.clone()).filter(|text| !text.is_empty())
}

/// The quiet links under a page (old `emphasis: 'fine'`).
pub(crate) fn fine(heading: Option<&str>, body: Option<&str>, actions: Vec<Action>) -> Section {
    Section { emphasis: Some("fine".to_string()), heading: heading.map(str::to_string), body: body.map(str::to_string), actions, ..Default::default() }
}

/// `page` as HTML in the product's look.
pub(crate) fn draw(page: &Page) -> String {
    shell::document(look(), page)
}

/// The passkey button: a page action the passkey script runs, its purpose, link code, next path and failure words as
/// `data-` values. Directly under every passkey button that is not a step of someone already signed in (adding a
/// passkey without a link) goes the code way (`way_pages::code_way`), so no page depends on a passkey working. An
/// account with no ways row (`ways` None) has none.
#[allow(clippy::too_many_arguments)]
fn passkey_actions(w: &Words, purpose: &str, code: Option<&str>, next: &str, label: &str, base: &str, ways: Option<&WaySettings>, quiet: bool) -> Vec<Action> {
    let mut data = vec![("passkey".to_string(), String::new()), ("purpose".to_string(), purpose.to_string())];
    if let Some(code) = code {
        data.push(("code".to_string(), code.to_string()));
    }
    data.extend([("base".to_string(), base.to_string()), ("next".to_string(), next.to_string()), ("failed".to_string(), w.failed.clone())]);
    let button = Action { label: Some(label.to_string()), tone: quiet.then(|| "quiet".to_string()), button: Some(Pairs(data)), ..Default::default() };
    let mut actions = vec![button];
    // Only the sign-in button has a code way under it: the passkey link and the new-device page draw none (old src/pages.mjs signInPage addPasskey, newDevicePage).
    if let Some(ways) = ways.filter(|_| purpose == "sign-in") {
        actions.extend(super::way_pages::code_way(w, ways, base));
    }
    actions
}

/// The sign-in page of the account whose door is served under `base` (old src/pages.mjs `signInPage` 327, returning,
/// with `authForm` 205). `next` is where to go after signing in (a same-origin path). The account's own chosen
/// secret (its password way, when it signs in alone) is asked first, as the old page asked email and password; the
/// passkey and the code way come after the "or" line; every other way is listed under it. `connecting` (an AI-app
/// connection waits for this sign-in) adds the ways that approve one.
pub(crate) fn sign_in(w: &Words, next: &str, base: &str, connecting: bool, ways: Option<&WaySettings>) -> String {
    let look = look();
    let mut first = welcome(look, &w.sign_in_title, None);
    let chosen = ways.and_then(|ways| super::way_pages::first_form(w, ways, base, next));
    let first_way = chosen.as_ref().map(|(way, _)| way.clone());
    if let Some((_, choices)) = chosen {
        first.choices = Some(choices);
        first.divider = Some(w.page.or.clone());
    }
    first.actions = passkey_actions(w, "sign-in", None, next, &w.sign_in_button, base, ways, first_way.is_some());
    first.actions.extend(ways.and_then(|ways| super::way_pages::text_way(w, ways, base)));
    first.status = Some(String::new());
    if !w.page.no_account.is_empty() {
        first.prompt = Some(Prompt {
            text: Some(w.page.no_account.clone()),
            action: Some(Link { label: Some(w.page.sign_up_link.clone()), href: Some("/sign-up".to_string()) }),
        });
    }
    let mut sections = vec![first];
    // The other ways, each drawn once: the form's own, the code way and the text way above, and the code way's
    // recovery links on its own page. An AI-app connection waiting for this sign-in also gets the note about passkeys.
    let others = ways.map(|ways| {
        let recovery = ways.row(&ways.code_way).map(|row| row.recover_with.clone()).unwrap_or_default();
        let text = ways.rows.iter().filter(|row| row.channel.as_deref() == Some("text")).map(|row| row.way.clone());
        let above: Vec<String> = first_way.iter().cloned().chain([ways.code_way.clone()]).chain(recovery).chain(text).collect();
        let above: Vec<&str> = above.iter().map(String::as_str).collect();
        super::way_pages::other_ways(w, ways, base, connecting, &above)
    }).unwrap_or_default();
    if connecting || !others.is_empty() {
        sections.push(fine(None, connecting.then_some(w.no_passkey.as_str()), others));
    }
    sections.push(fine_print(w));
    let mut page = auth_page(&w.sign_in_title, sections);
    page.meta_description = meta_of(w);
    page.scripts.push(SCRIPT.to_string());
    draw(&page)
}

/// The consent page for a pending AI-app request (old src/pages.mjs `signInPage` connecting and signed in, 346-366:
/// "Connect", then the quieter way out). Each answer is its own post, as the old page's actions were.
pub(crate) fn connect(w: &Words, request_id: &str, client_name: &str, base: &str) -> String {
    let look = look();
    // The shell escapes every word it draws, so the client's name is put in plain here (`said`, never scanned again).
    let title = super::way_pages::said(&w.connect_title, &[("client", client_name)]);
    let mut first = welcome(look, &title, Some(&super::way_pages::said(&w.connect_body, &[("client", client_name)])));
    let action = format!("{base}/authorize/decide");
    let answer = |label: &str, allow: &str, tone: Option<&str>| Action {
        post: Some(Pairs(vec![("request".to_string(), request_id.to_string()), ("allow".to_string(), allow.to_string())])),
        ..Action::link(label, &action, tone)
    };
    first.actions = vec![answer(&w.connect_allow, "yes", None), answer(&w.connect_deny, "no", Some("quiet"))];
    draw(&auth_page(&title, vec![first]))
}

/// The box a new passkey's name is typed in (old src/pages.mjs 340: `passkey_name`, capped at the 100 characters the
/// server checks).
fn passkey_name(w: &Words) -> Field {
    Field {
        name: Some("passkey-name".to_string()),
        label: Some(w.add_passkey_name.clone()),
        placeholder: Some(w.add_passkey_placeholder.clone()),
        autocomplete: Some("name".to_string()),
        max_length: Some(100),
        required: true,
        ..Default::default()
    }
}

/// The add-a-passkey page (old src/pages.mjs `signInPage` addPasskey, 329-345). With `link`, the one-use passkey link's
/// code; without it, the page of a signed-in person adding another passkey on this device.
pub(crate) fn add_passkey(w: &Words, link: Option<&str>, base: &str, ways: Option<&WaySettings>) -> String {
    let intro = if link.is_some() { &w.add_passkey_body } else { &w.add_passkey_body_signed_in };
    let mut first = welcome(look(), &w.add_passkey_title, Some(intro));
    first.fields = vec![passkey_name(w)];
    first.actions = passkey_actions(w, "register", link, &format!("{base}/"), &w.add_passkey_button, base, ways, false);
    first.status = Some(String::new());
    let mut page = auth_page(&w.add_passkey_title, vec![first]);
    page.scripts.push(SCRIPT.to_string());
    draw(&page)
}

/// The page a person sees after signing in with the code way on a browser (old src/pages.mjs `newDevicePage`, 640):
/// make a passkey on this device for next time, or go on to `next` without one.
pub(crate) fn offer_passkey(w: &Words, next: &str, base: &str) -> String {
    let mut first = welcome(look(), &w.offer_passkey_title, Some(&w.offer_passkey_body));
    first.fields = vec![passkey_name(w)];
    first.actions = passkey_actions(w, "register", None, next, &w.offer_passkey_button, base, None, false);
    first.actions.push(Action { skip: Some("passkey".to_string()), ..Action::link(&w.not_now, next, Some("link")) });
    first.status = Some(String::new());
    let mut page = auth_page(&w.offer_passkey_title, vec![first]);
    page.scripts.push(SCRIPT.to_string());
    draw(&page)
}

/// The sign-up page of a computer that takes new accounts (old src/pages.mjs `authForm` signUp, 205): the first name,
/// last name, email and password form, the "or" line, then the passkey button and the email-code link. The form posts to
/// `/sign-up/password`, which mails a code; the passkey posts to `/sign-up/options` and `/sign-up/finish`, and the finish
/// opens the `next` it answers (the plan the visitor clicked) or the new address. `next` is the plan path the page was
/// opened for (`/sign-up?next=`), already checked by the caller, and is carried in the passkey button's `data-next`.
pub(crate) fn sign_up(w: &Words, next: Option<&str>) -> String {
    sign_up_page(w, None, ("", "", ""), next)
}

/// The sign-up form again, with the refusal `status` and the fields the person typed (a secret is never drawn again).
pub(crate) fn sign_up_form(w: &Words, status: Option<&str>, given: &str, family: &str, email: &str, next: Option<&str>) -> String {
    sign_up_page(w, status, (given, family, email), next)
}

fn sign_up_page(w: &Words, status: Option<&str>, typed: (&str, &str, &str), next: Option<&str>) -> String {
    let f = &w.sign_up_form;
    let (given, family, email) = typed;
    let kept = |value: &str| Some(value.to_string()).filter(|value| !value.is_empty());
    let mut first = welcome(look(), &w.sign_up_title, Some(&w.sign_up_body));
    first.choices = Some(super::shell::Choices {actions_in_row: false, 
        href: Some("/sign-up/password".to_string()),
        values: Pairs(vec![]),
        fields: vec![
            Field { name: Some("given_name".to_string()), label: Some(f.given_name.clone()), autocomplete: Some("given-name".to_string()), required: true, value: kept(given), ..Default::default() },
            Field { name: Some("family_name".to_string()), label: Some(f.family_name.clone()), autocomplete: Some("family-name".to_string()), required: true, value: kept(family), ..Default::default() },
            Field { name: Some("email".to_string()), label: Some(f.email.clone()), kind: Some("email".to_string()), autocomplete: Some("username".to_string()), inputmode: Some("email".to_string()), placeholder: Some(f.email_placeholder.clone()), required: true, value: kept(email), ..Default::default() },
            Field {
                name: Some("password".to_string()),
                label: Some(f.password.clone()),
                kind: Some("password".to_string()),
                autocomplete: Some("new-password".to_string()),
                placeholder: Some(f.password_hint.clone()),
                required: true,
                reveal: Some(super::shell::Reveal { show: Some(w.page.show_secret.clone()), hide: Some(w.page.hide_secret.clone()) }),
                ..Default::default()
            },
        ],
        submit: Some(Action { label: Some(f.submit.clone()), ..Default::default() }),
    });
    first.divider = Some(w.page.or.clone());
    first.status = Some(status.unwrap_or("").to_string());
    if !w.page.have_account.is_empty() {
        first.prompt = Some(Prompt {
            text: Some(w.page.have_account.clone()),
            action: Some(Link { label: Some(w.page.sign_in_link.clone()), href: Some("/sign-in".to_string()) }),
        });
    }
    let mut data = vec![("passkey".to_string(), String::new()), ("purpose".to_string(), "sign-up".to_string())];
    if let Some(next) = next {
        data.push(("next".to_string(), next.to_string()));
    }
    data.extend([("failed".to_string(), w.failed.clone()), ("done".to_string(), w.sign_up_done.clone())]);
    // The passkey is named by the email box (old src/client/passkey.mjs: the passkey name, else the email).
    first.actions = vec![
        Action { label: Some(w.sign_up_button.clone()), tone: Some("quiet".to_string()), button: Some(Pairs(data)), ..Default::default() },
        Action::link(&f.email_code, "/sign-in/email", Some("link")),
    ];
    let mut page = auth_page(&w.sign_up_title, vec![first, fine_print(w)]);
    page.meta_description = meta_of(w);
    page.scripts.push(SCRIPT.to_string());
    draw(&page)
}

/// The root sign-in page of a computer (`/sign-in`, no account named): the email box that names the account. Its submit
/// posts to `/sign-in`, and `values` (the `next` step and the sign-in request, if any) come back with it. `status` is the
/// refusal to show, `email` what the person typed. The title is the product's; every other word is the engine's own
/// (`root`, words.json), because a product settings row written before this page existed has no words for it.
pub(crate) fn root_sign_in(w: &Words, root: &crate::forwarder::root_issuer::Words, status: Option<&str>, email: &str, values: &[(String, String)]) -> String {
    let mut first = welcome(look(), &w.sign_in_title, None);
    first.choices = Some(super::shell::Choices { actions_in_row: false,
        href: Some("/sign-in".to_string()),
        values: Pairs(values.to_vec()),
        fields: vec![Field { name: Some("email".to_string()), label: Some(root.email.clone()), kind: Some("email".to_string()), autocomplete: Some("username".to_string()),
            inputmode: Some("email".to_string()), placeholder: Some(root.email_placeholder.clone()), required: true, autofocus: true,
            value: Some(email.to_string()).filter(|value| !value.is_empty()), ..Default::default() }],
        submit: Some(Action { label: Some(root.next.clone()), ..Default::default() }),
    });
    first.status = Some(status.unwrap_or("").to_string());
    first.prompt = Some(Prompt {
        text: Some(root.no_account.clone()),
        action: Some(Link { label: Some(root.sign_up.clone()), href: Some("/sign-up".to_string()) }),
    });
    let mut page = auth_page(&w.sign_in_title, vec![first, fine_print(w)]);
    page.meta_description = meta_of(w);
    draw(&page)
}

/// The code step of a password sign-up (old src/pages.mjs `codeStep`): six digits, the pending id carried as a hidden
/// value, and a way to start again. `email` is the address the code went to.
pub(crate) fn sign_up_code(w: &Words, pending: &str, email: &str, status: Option<&str>) -> String {
    let f = &w.sign_up_form;
    let mut first = welcome(look(), &f.code_title, Some(&f.code_body.replace("{email}", email)));
    first.choices = Some(super::shell::Choices {actions_in_row: false, 
        href: Some("/sign-up/code".to_string()),
        values: Pairs(vec![("pending".to_string(), pending.to_string())]),
        fields: vec![Field { name: Some("code".to_string()), label: Some(f.code_label.clone()), autocomplete: Some("one-time-code".to_string()), inputmode: Some("numeric".to_string()), length: Some(6), required: true, ..Default::default() }],
        submit: Some(Action { label: Some(f.code_submit.clone()), ..Default::default() }),
    });
    first.status = Some(status.unwrap_or("").to_string());
    let again = fine(None, None, vec![Action::link(&f.code_again, "/sign-up", Some("link"))]);
    let mut page = auth_page(&f.code_title, vec![first, again, fine_print(w)]);
    page.meta_description = meta_of(w);
    page.scripts.push(SCRIPT.to_string());
    draw(&page)
}

/// A short answer that is not a page to act on.
pub(crate) enum Notice {
    Refused,
    Unavailable,
    /// A computer that does not take new accounts.
    SignUpClosed,
}

/// A plain notice page with the sign-in title and one explanation (old src/pages.mjs `phoneUnavailablePage`, 448).
pub(crate) fn notice(w: &Words, which: Notice) -> String {
    let text = match which {
        Notice::Refused => &w.refused,
        Notice::Unavailable => &w.unavailable,
        Notice::SignUpClosed => &w.sign_up_closed,
    };
    notice_text(w, text)
}

/// A plain notice page with the sign-in title and `text` (a refusal's own words, such as a sign-up form's).
pub(crate) fn notice_text(w: &Words, text: &str) -> String {
    draw(&auth_page(&w.sign_in_title, vec![welcome(look(), &w.sign_in_title, Some(text))]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words() -> Words {
        crate::account::sign_in::words_row::for_tests()
    }

    const HOSTILE: &str = "<script>alert(1)</script>\"'&";

    fn script_of(html: &str) -> &str {
        let start = html.find("<script>").expect("script") + "<script>".len();
        let end = html[start..].find("</script>").expect("script end") + start;
        &html[start..end]
    }

    #[test]
    fn escape_covers_the_five_characters() {
        assert_eq!(escape("<script>\"'&"), "&lt;script&gt;&quot;&#39;&amp;");
        assert_eq!(escape("plain text"), "plain text");
        assert_eq!(escape(""), "");
    }

    #[test]
    fn fill_escapes_the_client_and_keeps_the_words_text() {
        assert_eq!(fill("Connect {client} to Trillion", "A & B"), "Connect A &amp; B to Trillion");
        assert_eq!(fill("{client} may", "{client}"), "{client} may");
    }

    #[test]
    fn sign_in_page_has_its_title_and_one_script() {
        let html = sign_in(&words(), "/home", "", false, None);
        assert!(html.contains(&escape(&words().sign_in_title)));
        assert!(html.contains("name=\"viewport\""));
        assert_eq!(html.matches("<script").count(), 1);
        assert!(html.contains("data-purpose=\"sign-in\""));
        assert!(html.contains("data-next=\"/home\""));
    }

    #[test]
    fn sign_in_page_escapes_next() {
        let html = sign_in(&words(), "/x\" onmouseover=\"alert(1)", "", false, None);
        assert!(!html.contains("\" onmouseover"));
        assert!(html.contains("data-next=\"/x&quot; onmouseover=&quot;alert(1)\""));
    }

    #[test]
    fn connect_page_has_its_title_and_no_raw_client_name() {
        let html = connect(&words(), "req123", HOSTILE, "");
        assert!(html.contains(&fill(&words().connect_title, HOSTILE)));
        assert!(!html.contains("<script>alert"));
        assert_eq!(html.matches("<script").count(), 0);
        assert!(html.contains("action=\"/authorize/decide\""));
        assert!(html.contains("name=\"request\" value=\"req123\""));
        assert!(html.contains("value=\"yes\"") && html.contains("value=\"no\""));
    }

    #[test]
    fn add_passkey_page_carries_the_link_as_data_only() {
        let html = add_passkey(&words(), Some("abc-_123"), "", None);
        assert!(html.contains("data-code=\"abc-_123\""));
        assert!(html.contains("data-purpose=\"register\""));
        let hostile = add_passkey(&words(), Some("x\"><script>alert(1)</script>"), "", None);
        assert_eq!(hostile.matches("<script").count(), 1);
    }

    #[test]
    fn add_passkey_page_shows_its_words_and_the_name_field() {
        let w = words();
        let linked = add_passkey(&words(), Some("abc"), "", None);
        for text in [&w.add_passkey_title, &w.add_passkey_body, &w.add_passkey_name, &w.add_passkey_placeholder, &w.add_passkey_button] {
            assert!(linked.contains(&escape(text)), "{text}");
        }
        assert!(linked.contains("id=\"page-field-passkey-name\"") && linked.contains("placeholder=\"Your name or email\""));
        let signed_in = add_passkey(&words(), None, "", None);
        assert!(signed_in.contains(&escape(&w.add_passkey_body_signed_in)));
        assert!(!signed_in.contains("data-code="));
        assert!(!signed_in.contains(&escape(&w.add_passkey_body)));
    }

    #[test]
    fn notices_say_their_word_and_escape() {
        assert!(notice(&words(), Notice::Refused).contains(&escape(&words().refused)));
        assert!(notice(&words(), Notice::Unavailable).contains(&escape(&words().unavailable)));
        assert_eq!(notice(&words(), Notice::Refused).matches("<script").count(), 0);
    }

    #[test]
    fn script_hash_is_stable_and_matches_the_inline_script() {
        assert_eq!(script_hash(), script_hash());
        let decoded = STANDARD.decode(script_hash()).expect("base64");
        assert_eq!(decoded.len(), 32);
        let page = sign_in(&words(), "/", "", false, None);
        let inline = digest::digest(&digest::SHA256, script_of(&page).as_bytes());
        assert_eq!(STANDARD.encode(inline), script_hash());
        assert!(!SCRIPT.contains("</script"));
    }

    #[test]
    fn sign_up_form_shows_its_refusal_and_keeps_the_typed_names_and_email_only() {
        let w = words();
        let html = sign_up_form(&w, Some(&w.sign_up_form.name_required), "Ada", "", "person@example.test", Some("/buy/plan"));
        assert!(html.contains(&escape(&w.sign_up_form.name_required)));
        assert!(html.contains("value=\"Ada\"") && html.contains("value=\"person@example.test\""));
        assert!(!html.contains("type=\"password\" name=\"password\" value="));
        assert!(!html.contains("name=\"next\""), "the return path is held in a cookie, never a form field");
    }

    #[test]
    fn sign_up_code_step_carries_the_pending_id_and_the_sent_to_address() {
        let w = words();
        let html = sign_up_code(&w, "pending-7", "person@example.test", None);
        assert!(html.contains("name=\"pending\" value=\"pending-7\""));
        assert!(html.contains(&escape(&w.sign_up_form.code_title)));
        assert!(html.contains("person@example.test"));
        assert!(!html.contains("{email}"));
    }

    #[test]
    fn a_row_written_before_the_forgot_link_reads_its_words() {
        let mut before = serde_json::to_value(&words().page).unwrap();
        before.as_object_mut().unwrap().remove("forgot_password");
        let page: PageWords = serde_json::from_value(before).unwrap();
        assert_eq!(page.forgot_password, "Forgot password?");
    }

    #[test]
    fn every_word_loads() {
        let w = words();
        for text in [&w.sign_in_title, &w.sign_in_button, &w.connect_title, &w.connect_body, &w.connect_allow,
            &w.connect_deny, &w.add_passkey_title, &w.add_passkey_body, &w.add_passkey_body_signed_in, &w.add_passkey_name,
            &w.add_passkey_placeholder, &w.add_passkey_button, &w.offer_passkey_title, &w.offer_passkey_body, &w.offer_passkey_button,
            &w.not_now, &w.failed, &w.no_passkey, &w.refused, &w.unavailable] {
            assert!(!text.is_empty());
        }
    }
}
