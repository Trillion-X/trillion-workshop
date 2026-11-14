//! How many calls one sign-in makes, counted as each call is admitted, before any work runs (ported from old trillion
//! src/sign-in-calls.mjs). A personal key, an AI app's grant or a browser session may make at most its tier's `limit`
//! calls in `period_seconds` (`settings.json` `calls`); a caller past it is refused `too_many_calls` with when to ask
//! again, and nothing it asked for runs, so one AI that runs away cannot keep the account's computer busy for its other
//! AIs.
//!
//! Invariants (old src/sign-in-calls.mjs:10-15):
//! - The count is by sign-in (`Principal::sign_in`), never by address, so one AI on a shared network never slows another.
//! - A call is counted with no storage write: the count lives in this computer's memory (the old Worker's rate limiting
//!   binding, :14, kept the count where the call arrived; here every call arrives at the account routes). A restart
//!   forgets every count, which only admits.
//! - Which tier is DATA: the first rule whose `when` all hold (old :24-28 `callsTier`).
//!
//! Dropped from the old file, and why:
//! - the plan tier (old src/sign-in-calls.json:4 and :10, `holds: access:decision-kept`) and `planMarks` (:31): a plan is
//!   a product feature (PRINCIPLES 5), so no rule reads one;
//! - the host binding names and their store ids and `signInCallsBindings` (:72-73): host plumbing (PRINCIPLES 2);
//! - `callsWords` (:66-70): a screen's words, a tool's (PRINCIPLES 5); `used` answers the number it showed.

use super::Principal;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Mutex;

/// What signed in (old src/sign-in-calls.mjs:22 `callerOfProps`): a personal key, an AI app's grant, or the account
/// itself through a browser session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CallerKind {
    Key,
    App,
    Account,
}

impl CallerKind {
    /// The kind of `principal`, read from how it signed in (`key:`, `grant:` or `session:`).
    pub(crate) fn of(principal: &Principal) -> CallerKind {
        if principal.sign_in.starts_with(super::oauth::GRANT_SIGN_IN) {
            CallerKind::App
        } else if principal.sign_in.starts_with(super::sessions::SESSION_SIGN_IN) {
            CallerKind::Account
        } else {
            CallerKind::Key
        }
    }
}

/// One tier: at most `limit` calls in `period_seconds`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Tier {
    pub id: String,
    pub limit: u64,
    pub period_seconds: u64,
}

/// When a rule holds: what signed in, and (for an app) the ways its grant was approved by that keep it off the rule.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct When {
    pub caller: Option<Vec<CallerKind>>,
    pub approved_by_not: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Rule {
    #[serde(default)]
    pub when: When,
    pub tier: String,
}

/// `settings.json` `calls`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CallSettings {
    pub tiers: Vec<Tier>,
    pub rules: Vec<Rule>,
    pub retry_after_seconds: u64,
    /// The most sign-ins one computer counts at once (old :46 `makeCallCounter(now, most = 2000)`).
    pub most_counted: usize,
}

impl CallSettings {
    /// Every rule names a tier, the last rule always holds, and every number is in range.
    pub(crate) fn valid(&self) -> bool {
        self.rules.iter().all(|rule| self.tiers.iter().any(|tier| tier.id == rule.tier))
            && self.rules.last().is_some_and(|rule| rule.when == When::default())
            && self.tiers.iter().all(|tier| tier.limit >= 1 && (1..=86_400).contains(&tier.period_seconds))
            && (1..=3600).contains(&self.retry_after_seconds)
            && self.most_counted >= 1
    }

    /// The tier the first matching rule picks (old :25-28 `callsTier`). `approved_by` is the way an app's grant was
    /// approved by, when the grant recorded one.
    pub(crate) fn tier(&self, caller: CallerKind, approved_by: Option<&str>) -> &Tier {
        let holds = |when: &When| {
            when.caller.as_ref().is_none_or(|kinds| kinds.contains(&caller))
                && when.approved_by_not.as_ref().is_none_or(|stronger| approved_by.is_none_or(|way| !stronger.iter().any(|kept| kept == way)))
        };
        let rule = self.rules.iter().find(|rule| holds(&rule.when)).unwrap_or_else(|| self.rules.last().expect("a valid rule list"));
        self.tiers.iter().find(|tier| tier.id == rule.tier).expect("a valid rule names a tier")
    }
}

/// The refusal code of a call past its tier's limit; the HTTP routes answer it 429 with Retry-After.
pub(crate) const REFUSAL_CODE: &str = "sign_in_too_many_calls";

/// A call refused for too many calls lately: its tier, and how long to wait before asking again.
#[derive(Clone, Debug)]
pub(crate) struct TooMany {
    cause: crate::refusal_cause::Cause,
    pub limit: u64,
    pub period_seconds: u64,
    pub retry_after_seconds: u64,
}

impl PartialEq for TooMany {
    fn eq(&self, other: &Self) -> bool {
        self.limit == other.limit && self.period_seconds == other.period_seconds
            && self.retry_after_seconds == other.retry_after_seconds
    }
}
impl Eq for TooMany {}
crate::impl_caused!(TooMany);

impl TooMany {
    pub(crate) fn cause(&self) -> crate::refusal_cause::Cause { self.cause.clone() }
    /// The words a refused call answers (the account's words row, `operations.too_many_calls`, old :40).
    pub(crate) fn words(&self, words: &super::known::OperationWords) -> String {
        super::known::said(&words.too_many_calls,
            &[("limit", &self.limit.to_string()), ("seconds", &self.period_seconds.to_string())])
    }
}

/// One sign-in's count in its current window.
#[derive(Clone, Copy, Debug)]
struct Held {
    window_at: u64,
    count: u64,
}

/// The calls each sign-in made lately, counted in this computer's memory as each is admitted (nothing written; old
/// :46-64 `makeCallCounter`, with the binding's fixed window of :34-43 `tooManyCalls`).
#[derive(Debug, Default)]
pub(crate) struct Counter {
    counts: Mutex<HashMap<String, Held>>,
}

impl Counter {
    /// Count one call of `sign_in` at `now_ms` under `tier`; refused, and not counted, once the tier's limit was reached
    /// in the current window.
    pub(crate) fn note(&self, sign_in: &str, tier: &Tier, settings: &CallSettings, now_ms: u64) -> Result<(), TooMany> {
        let period = tier.period_seconds.saturating_mul(1000);
        let Ok(mut counts) = self.counts.lock() else { return Ok(()) };
        if let Some(held) = counts.get_mut(sign_in) {
            if now_ms.saturating_sub(held.window_at) < period {
                if held.count >= tier.limit {
                    return Err(TooMany { cause: crate::cause!(sign_in calls_limit), limit: tier.limit, period_seconds: tier.period_seconds, retry_after_seconds: settings.retry_after_seconds });
                }
                held.count += 1;
                return Ok(());
            }
            *held = Held { window_at: now_ms, count: 1 };
            return Ok(());
        }
        if counts.len() >= settings.most_counted {
            // The oldest window goes first (old :53, the first key in insertion order).
            counts.retain(|_, held| now_ms.saturating_sub(held.window_at) < period);
            if counts.len() >= settings.most_counted {
                if let Some(oldest) = counts.iter().min_by_key(|(_, held)| held.window_at).map(|(name, _)| name.clone()) {
                    counts.remove(&oldest);
                }
            }
        }
        counts.insert(sign_in.to_string(), Held { window_at: now_ms, count: 1 });
        Ok(())
    }

    /// How many calls `sign_in` made in its current window, or 0 when its window has passed (old :57-60 `lastMinute`).
    pub(crate) fn used(&self, sign_in: &str, tier: &Tier, now_ms: u64) -> u64 {
        let period = tier.period_seconds.saturating_mul(1000);
        self.counts.lock().ok()
            .and_then(|counts| counts.get(sign_in).copied())
            .filter(|held| now_ms.saturating_sub(held.window_at) < period)
            .map_or(0, |held| held.count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> CallSettings {
        super::super::settings().calls.clone()
    }

    fn principal(sign_in: &str, client: Option<&str>) -> Principal {
        Principal { account: "acct".into(), sign_in: sign_in.into(), client_id: client.map(str::to_string), scopes: vec![], expires_at_ms: 0 }
    }

    #[test]
    fn an_app_approved_by_a_weaker_way_gets_the_weaker_tier_and_everything_else_the_standard_one() {
        let settings = settings();
        assert_eq!(CallerKind::of(&principal("grant:g", Some("c"))), CallerKind::App);
        assert_eq!(CallerKind::of(&principal("key:k", None)), CallerKind::Key);
        assert_eq!(CallerKind::of(&principal("session:s", None)), CallerKind::Account);
        assert_eq!(settings.tier(CallerKind::App, Some("email-code")).id, "weaker");
        assert_eq!(settings.tier(CallerKind::App, None).id, "weaker", "a grant that recorded no approval is the weaker one");
        assert_eq!(settings.tier(CallerKind::App, Some("passkey")).id, "standard");
        assert_eq!(settings.tier(CallerKind::Key, Some("email-code")).id, "standard");
        assert_eq!(settings.tier(CallerKind::Account, None).id, "standard");
    }

    #[test]
    fn a_sign_in_past_its_limit_is_refused_until_its_window_passes_and_others_are_not_slowed() {
        let settings = settings();
        let tier = Tier { id: "t".into(), limit: 3, period_seconds: 60 };
        let counter = Counter::default();
        for _ in 0..3 {
            counter.note("key:a", &tier, &settings, 1_000).unwrap();
        }
        let refused = counter.note("key:a", &tier, &settings, 2_000).unwrap_err();
        assert_eq!(refused, TooMany { cause: crate::cause!(sign_in calls_limit), limit: 3, period_seconds: 60, retry_after_seconds: settings.retry_after_seconds });
        assert_eq!(refused.cause().file(), "src/account/sign_in/calls.rs");
        assert_eq!(refused.cause().condition(), "sign_in calls_limit");
        assert!(!refused.cause().id().contains("key:a"));
        assert!(refused.words(&crate::account::sign_in::words_row::for_tests().operations).contains('3') && refused.words(&crate::account::sign_in::words_row::for_tests().operations).contains("60"));
        assert_eq!(counter.used("key:a", &tier, 2_000), 3, "a refused call is not counted");
        counter.note("key:b", &tier, &settings, 2_000).expect("another sign-in is counted apart");
        // Recovery: once the window has passed, the sign-in calls again.
        counter.note("key:a", &tier, &settings, 61_000).expect("a new window");
        assert_eq!(counter.used("key:a", &tier, 61_000), 1);
        assert_eq!(counter.used("key:a", &tier, 200_000), 0);
    }

    #[test]
    fn the_counter_holds_at_most_its_most_and_forgets_the_oldest_first() {
        let mut settings = settings();
        settings.most_counted = 2;
        let tier = Tier { id: "t".into(), limit: 1, period_seconds: 60 };
        let counter = Counter::default();
        counter.note("a", &tier, &settings, 1).unwrap();
        counter.note("b", &tier, &settings, 2).unwrap();
        counter.note("c", &tier, &settings, 3).unwrap();
        assert_eq!(counter.used("a", &tier, 3), 0, "the oldest is forgotten");
        assert!(counter.note("b", &tier, &settings, 4).is_err() && counter.note("c", &tier, &settings, 4).is_err());
    }

    #[test]
    fn a_rule_list_without_a_default_or_naming_no_tier_is_refused() {
        let mut settings = settings();
        assert!(settings.valid());
        settings.rules.pop();
        assert!(!settings.valid(), "no default rule");
        let mut settings = super::super::settings().calls.clone();
        settings.rules[0].tier = "nothing".into();
        assert!(!settings.valid());
    }
}
