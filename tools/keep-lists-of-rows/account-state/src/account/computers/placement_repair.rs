//! The owner's local repair of the account's computers row, for an account whose only named computer no longer answers
//! and whose computer that holds the account key is not named at all. It is an operator's command run on the computer
//! that holds the account key (never a public or relay route): it names only the one computer the operator proves is this
//! engine, and it changes the row in three signed revisions, each one `edit` checks (`one_voter_step`,
//! `first_voter_alone`):
//!  1. the computers that keep a copy and may answer become this computer alone (the voters stay);
//!  2. this computer becomes a voter beside the voter that no longer answers;
//!  3. the voter that no longer answers leaves, so this computer is the only voter.
//! Each step is one edit made from the row as it is read then. Every step writes one audit line with its cause.

use super::{edit, read, AccountKey, Change, ComputersRow, Refused, Subject};
use crate::account::rows::store::{Row, Store};

/// The cause an audit line names for each applied step.
pub(crate) const CAUSE: &str = "placement_repair_by_local_key";

/// Why a row is not this repair's case.
#[derive(Debug)]
pub(crate) enum Refusal {
    /// The row does not name exactly one voter other than this computer, nor this computer alone.
    NeedsOneNamedVoter(crate::refusal_cause::Cause),
}

/// The three changes that name `this` alone (keeper, answering and voter), from the row as it reads now. Refused unless the
/// row names exactly one voter that is not `this`, or `this` alone already: any other row is not this repair's case.
pub(crate) fn steps(current: &ComputersRow, this: &str) -> Result<Vec<Change>, Refusal> {
    let expected = current.revision;
    let alone = |voters: Vec<String>| Change {
        pursuit: None,
        expected_revision: expected,
        copy_keepers: vec![this.to_owned()],
        may_answer: vec![this.to_owned()],
        voters,
    };
    match current.voters.as_slice() {
        [only] if only == this => Ok(vec![alone(vec![this.to_owned()])]),
        // This computer beside the one voter that no longer answers: that voter leaves (the last step).
        [first, second] if (first == this) != (second == this) => Ok(vec![alone(vec![this.to_owned()])]),
        [dead] => Ok(vec![
            Change { voters: current.voters.clone(), ..alone(current.voters.clone()) },
            alone(vec![dead.clone(), this.to_owned()]),
            alone(vec![this.to_owned()]),
        ]),
        _ => Err(crate::cause!(Refusal::NeedsOneNamedVoter)),
    }
}

/// Apply the steps to the account's row (`subject`, the account's own), signed with `key`, naming `this`. Each step is read
/// from the row as it is then; the revision it sends is the one just read. Answers the revisions written.
pub(crate) fn apply(store: &Store<'_>, account: &str, subject: &Subject, key: &AccountKey, this: &str)
    -> Result<Vec<Row<ComputersRow>>, Refused> {
    // The place is a hosting place: it takes the kind its config names before it is named as answering (`answer_allowed`).
    super::ensure_kind(store, account, this, &super::settings().host_kinds.default_places_kind)?;
    let mut written = Vec::new();
    loop {
        let now = read(store, account, subject)?;
        let current = now.as_ref().map(|row| row.value.clone()).ok_or(crate::cause!(Refused::Invalid))?;
        if current.copy_keepers == [this.to_owned()] && current.may_answer == [this.to_owned()] && current.voters == [this.to_owned()] {
            return Ok(written);
        }
        let plan = steps(&current, this).map_err(|_| crate::cause!(Refused::Invalid))?;
        let Some(next) = plan.into_iter().find(|step| !already(&current, step)) else { return Ok(written) };
        let row = edit(store, account, subject, &next, key, &serde_json::Value::Null)?;
        crate::quiet_eprintln!("placement-repair event=applied cause={CAUSE} revision={} voters={} answering={}",
            row.value.revision, row.value.voters.len(), row.value.may_answer.len());
        written.push(row);
    }
}

/// Whether `current` already is what `step` would name.
fn already(current: &ComputersRow, step: &Change) -> bool {
    current.copy_keepers == step.copy_keepers && current.may_answer == step.may_answer && current.voters == step.voters
}

#[cfg(test)]
mod tests {
    use super::*;

    const THIS: &str = "829cd49b2a105d216b16e219c021df76cce7771eb58f2c02516e3f5dbd3b289c";
    const DEAD: &str = "af761ea6af57ec39f5705d62d782c3a433013a2badf54123c4acf94957dd554c";

    fn row(keepers: &[&str], answering: &[&str], voters: &[&str], revision: u64) -> ComputersRow {
        let list = |names: &[&str]| names.iter().map(|name| name.to_string()).collect::<Vec<_>>();
        ComputersRow {
            account: "a".repeat(64),
            pursuit: None,
            revision,
            copy_keepers: list(keepers),
            may_answer: list(answering),
            voters: list(voters),
            signature: String::new(),
        }
    }

    /// The rules the owner's edit checks for one step from `before`, as `edit` checks them.
    fn passes_the_rules(before: &ComputersRow, step: &Change) -> bool {
        let one_step = super::super::one_voter_step(&before.voters, &step.voters);
        let alone = super::super::first_voter_alone(&before.voters, &before.may_answer, &step.voters);
        let writers = !super::super::two_writers(&step.may_answer, &step.voters);
        one_step && alone && writers && !step.copy_keepers.is_empty()
    }

    #[test]
    fn a_row_naming_one_dead_voter_takes_three_steps_each_allowed_by_the_rules_and_ends_with_this_computer_alone() {
        let before = row(&[DEAD], &[DEAD], &[DEAD], 9);
        let plan = steps(&before, THIS).expect("one named voter that is not this computer");
        assert_eq!(plan.len(), 3);
        let mut from = before.clone();
        for step in &plan {
            assert!(passes_the_rules(&from, step), "each step passes the rules: {step:?}");
            from = ComputersRow { copy_keepers: step.copy_keepers.clone(), may_answer: step.may_answer.clone(),
                voters: step.voters.clone(), ..from };
        }
        assert_eq!(from.voters, vec![THIS.to_owned()]);
        assert_eq!(from.may_answer, vec![THIS.to_owned()]);
        assert_eq!(from.copy_keepers, vec![THIS.to_owned()]);
    }

    #[test]
    fn a_row_with_this_computer_beside_the_dead_voter_takes_the_last_step_and_nothing_else() {
        let beside = row(&[THIS], &[THIS], &[DEAD, THIS], 11);
        let plan = steps(&beside, THIS).expect("this computer beside the one dead voter");
        assert_eq!(plan.len(), 1);
        assert!(passes_the_rules(&beside, &plan[0]), "the dead voter leaves in one step");
        assert_eq!(plan[0].voters, vec![THIS.to_owned()]);
    }

    #[test]
    fn a_row_already_naming_this_computer_alone_needs_one_step_and_no_other_row_is_repaired() {
        assert_eq!(steps(&row(&[THIS], &[THIS], &[THIS], 3), THIS).expect("already this computer").len(), 1);
        assert!(steps(&row(&[DEAD, THIS], &[DEAD], &[DEAD, "b".repeat(64).as_str()], 3), THIS).is_err());
        assert!(steps(&row(&[DEAD], &[DEAD], &[], 3), THIS).is_err(), "no named voter is not this repair's case");
    }
}
