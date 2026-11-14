//! The set-password page (old src/pages.mjs `setPasswordPage`): a signed-in person sets a password for the account's
//! email, or changes one (asking for the current password first). Every word is the account's words row
//! (`pages::Words::set_password`). The page's own script writes how strong a new password is as it is typed (the rule
//! is old src/password-strength.mjs, its words are the hidden `strength` step) and stops a confirmation that differs
//! (the hidden `mismatch` step). Nothing is sent by the script.

use super::pages::{self, Words};
use super::shell::{self, Action, Choices, Field, Item, Link, Pairs, Section};
use super::ways::WaySettings;

/// The page's script, inline and allowed by its SHA-256 in the CSP (`pages::script_sources`).
pub(crate) const SCRIPT: &str = r##"(function () {
  "use strict";
  function said(step) {
    return Array.prototype.map.call(document.querySelectorAll('[data-page-step="' + step + '"] .page-item-body'),
      function (body) { return body.textContent; });
  }
  var strength = said("strength"), mismatch = said("mismatch")[0] || "";
  // The score of src/password-strength.mjs: 0 under the minimum, then one for each of 12 characters or more and for
  // three kinds of character (lower case, upper case, digits, others).
  function score(text, min) {
    if (text.length < min) return 0;
    var kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(function (kind) { return kind.test(text); }).length;
    return 1 + (text.length >= 12 ? 1 : 0) + (kinds >= 3 ? 1 : 0);
  }
  document.addEventListener("input", function (event) {
    var input = event.target;
    if (!input || !input.hasAttribute || !input.hasAttribute("data-page-strength")) return;
    var hint = document.getElementById(input.id + "-hint");
    if (hint) hint.textContent = (strength[score(input.value, input.minLength)] || "").split("{min}").join(String(input.minLength));
  });
  document.addEventListener("submit", function (event) {
    var form = event.target;
    var first = form.querySelector('input[name="password"]'), again = form.querySelector('input[name="password_again"]');
    if (!first || !again || again.value === first.value) return;
    event.preventDefault();
    var status = form.closest(".page-section").querySelector(".page-status");
    if (status) status.textContent = mismatch;
    again.focus();
  });
})();
"##;

/// The set-password page for `email`, served under `base`. `changing` asks for the current password first; `offered`
/// (where the person was going) is offered as a skip, and without it the page offers to cancel to the account.
pub(crate) fn page(w: &Words, ways: &WaySettings, base: &str, email: &str, changing: bool, offered: Option<&str>, status: Option<&str>) -> String {
    let s = &w.set_password;
    let min = i64::try_from(ways.chosen.min_length).unwrap_or(0);
    let fill = |text: &str| text.replace("{min}", &min.to_string());
    let reveal = || Some(shell::Reveal { show: some(&w.page.show_secret), hide: some(&w.page.hide_secret) });
    let (title, heading) = if changing {
        (&s.change_title, &s.change_title)
    } else {
        (&s.set_title, if offered.is_some() { &s.offered_title } else { &s.set_title })
    };
    let body = if changing { &s.change_body } else { &s.set_body };

    let mut fields = vec![Field {
        name: some("username"), label: some(&s.email), kind: some("email"), autocomplete: some("username"),
        value: some(email), hidden: true, ..Default::default()
    }];
    if changing {
        fields.push(Field {
            name: some("current_password"), label: some(&s.current_password), kind: some("password"), autocomplete: some("current-password"),
            required: true, reveal: reveal(),
            label_action: Some(Link { label: some(&w.page.forgot_password), href: some(&format!("{base}/sign-in/forgot-password")) }),
            ..Default::default()
        });
    }
    fields.push(Field {
        name: some("password"), label: some(&s.new_password), kind: some("password"), autocomplete: some("new-password"),
        placeholder: some(&fill(&s.new_password_placeholder)), hint: some(&fill(&s.new_password_hint)),
        min_length: Some(min), required: true, reveal: reveal(), strength: true, ..Default::default()
    });
    fields.push(Field {
        name: some("password_again"), label: some(&s.confirm_password), kind: some("password"), autocomplete: some("new-password"),
        min_length: Some(min), required: true, reveal: reveal(), ..Default::default()
    });

    let mut values = vec![("email".to_string(), email.to_string())];
    if let Some(next) = offered {
        values.push(("next".to_string(), next.to_string()));
    }
    let text = body.replace("{email}", email);
    let mut first = pages::welcome(pages::look(), heading, Some(&text));
    first.choices = Some(Choices {
        actions_in_row: false,
        href: some(&format!("{base}/sign-in/set-password")),
        values: Pairs(values),
        fields,
        submit: Some(Action { label: some(if changing { &s.change_button } else { &s.set_button }), ..Default::default() }),
    });
    first.actions = vec![match offered {
        Some(next) => Action { label: some(&s.skip), href: some(next), tone: some("link"), skip: some("password"), ..Default::default() },
        None => Action::link(&s.cancel, "/account", Some("link")),
    }];
    first.status = Some(status.unwrap_or_default().to_string());

    // The words the script says, kept as the page's own text in hidden steps; the script reads them from there.
    let said = |step: &str, texts: [&str; 4]| Section {
        step: some(step), hidden: true,
        items: texts.iter().map(|text| Item { body: some(text), ..Default::default() }).collect(),
        ..Default::default()
    };
    let strength = said("strength", [s.strength_short.as_str(), s.strength_fine.as_str(), s.strength_good.as_str(), s.strength_strong.as_str()]);
    let mismatch = Section {
        step: some("mismatch"), hidden: true,
        items: vec![Item { body: some(&s.not_the_same), ..Default::default() }],
        ..Default::default()
    };

    let mut page = pages::auth_page(title, vec![first, strength, mismatch]);
    page.meta_description = some(&s.meta_description).filter(|text| !text.is_empty());
    page.scripts.push(SCRIPT.to_string());
    pages::draw(&page)
}

/// A word as the optional field the shell takes.
fn some(text: &str) -> Option<String> {
    Some(text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::sign_in::ways;

    const EMAIL: &str = "person@example.test";

    /// Writes the rendered page to `target/set-password-dump/<name>.html` for the proof, and returns it.
    fn dump(name: &str, html: &str) -> String {
        let directory = concat!(env!("CARGO_MANIFEST_DIR"), "/target/set-password-dump");
        std::fs::create_dir_all(directory).expect("dump directory");
        std::fs::write(format!("{directory}/{name}.html"), html).expect("dump file");
        html.to_string()
    }

    /// The proof's state: a person who has no password yet, with the words of the shipped row. The rendered page is
    /// written to `target/set-password-dump/set-password-new.html` for the screenshot comparison with the old page.
    #[test]
    fn dump_the_set_a_password_page_as_it_renders() {
        let w = crate::account::sign_in::words_row::for_tests();
        let html = dump("set-password-new", &page(&w, &ways::for_tests(), "", EMAIL, false, None, None));
        assert!(html.contains("name=\"password\"") && html.contains("name=\"password_again\""));
        assert!(html.contains("href=\"/account\""));
    }

    #[test]
    fn set_a_password_page_offers_skip_and_no_current_password() {
        let w = crate::account::sign_in::words_row::for_tests();
        let html = dump("set-offered", &page(&w, &ways::for_tests(), "", EMAIL, false, Some("/buy/plan"), None));
        assert!(html.contains(&pages::escape(&w.set_password.set_title)));
        assert!(html.contains(&pages::escape(&w.set_password.offered_title)));
        assert!(html.contains("id=\"page-field-username\"") && html.contains("value=\"person@example.test\""));
        assert!(html.contains("name=\"next\" value=\"/buy/plan\""));
        assert!(html.contains(&pages::escape(&w.set_password.skip)));
        assert!(!html.contains("name=\"current_password\""));
        assert!(html.contains("name=\"password_again\"") && html.contains("data-page-strength"));
    }

    #[test]
    fn change_a_password_page_asks_for_the_current_password_and_cancels_to_the_account() {
        let w = crate::account::sign_in::words_row::for_tests();
        let html = dump("change", &page(&w, &ways::for_tests(), "/a/x", EMAIL, true, None, None));
        assert!(html.contains(&pages::escape(&w.set_password.change_title)));
        assert!(html.contains("name=\"current_password\"") && html.contains("href=\"/a/x/sign-in/forgot-password\""));
        assert!(html.contains("href=\"/account\""));
        assert!(html.contains("action=\"/a/x/sign-in/set-password\""));
    }

    #[test]
    fn the_page_script_is_inline_and_hashed_in_the_csp() {
        let w = crate::account::sign_in::words_row::for_tests();
        let html = page(&w, &ways::for_tests(), "", EMAIL, false, None, None);
        assert!(html.contains(&format!("<script>{SCRIPT}</script>")));
        assert!(pages::script_sources().contains(&pages::script_source(SCRIPT)));
    }

    /// A refused submit draws its message in the page's status, the way the old page did (src/pages.mjs `setPasswordPage`).
    #[test]
    fn a_refused_submit_draws_its_message_in_the_status() {
        let w = crate::account::sign_in::words_row::for_tests();
        let html = page(&w, &ways::for_tests(), "", EMAIL, false, None, Some(&w.set_password.not_the_same));
        assert!(html.contains(&w.set_password.not_the_same), "the refusal's words are drawn");
        assert!(page(&w, &ways::for_tests(), "", EMAIL, false, None, None).contains("page-status"), "the status element is always there");
    }

    #[test]
    fn the_strength_and_mismatch_words_are_the_row_words() {
        let w = crate::account::sign_in::words_row::for_tests();
        let html = page(&w, &ways::for_tests(), "", EMAIL, false, None, None);
        for text in [&w.set_password.strength_short, &w.set_password.strength_fine, &w.set_password.strength_good, &w.set_password.strength_strong] {
            assert!(html.contains(&pages::escape(text)), "{text}");
        }
        assert!(html.contains(&pages::escape(&w.set_password.not_the_same)));
    }
}
