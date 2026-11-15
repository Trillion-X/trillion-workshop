// src/native_entry/computer/unit_state.rs
//
// Purpose: read this computer's own service unit as systemd reports it (`systemctl show`), for the report it posts each
// tick (`OwnReport::unit`). A place reads its own unit, so a restart loop is seen by its peers without a person or an
// operator machine watching. The engine reports the state only; a budget and any alert are decided by the owner of
// alerts (email-index-rows, D14), not here.
//
// Non-Negotiable Invariants:
// - The unit name is passed as one argument, never through a shell.
// - A read that fails (no systemctl, an unknown unit, unreadable output) answers None, and the report goes out without a
//   unit: an absent state is never a healthy one.

use crate::account::computers::copy_rule::UnitState;
use std::process::Command;

/// The unit's state now, or None when systemd does not answer for it.
pub fn read(unit: &str) -> Option<UnitState> {
    let output = Command::new("systemctl")
        .args(["show", "-p", "ActiveState", "-p", "SubState", "-p", "NRestarts", "--", unit])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse(&String::from_utf8_lossy(&output.stdout))
}

/// The state from `systemctl show` output (`Key=value` lines). None unless all three keys are there and the count is a number.
pub fn parse(text: &str) -> Option<UnitState> {
    let value = |key: &str| {
        text.lines().find_map(|line| line.strip_prefix(key).and_then(|rest| rest.strip_prefix('=')))
    };
    Some(UnitState {
        active: value("ActiveState")?.to_owned(),
        sub: value("SubState")?.to_owned(),
        restarts: value("NRestarts")?.parse().ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_unit_state_parses_from_systemd_show_and_refuses_a_missing_key() {
        let text = "ActiveState=activating\nSubState=auto-restart\nNRestarts=8849\n";
        assert_eq!(parse(text), Some(UnitState { active: "activating".into(), sub: "auto-restart".into(), restarts: 8849 }));
        assert_eq!(parse("ActiveState=active\nSubState=running\n"), None, "no restart count is not a healthy unit");
        assert_eq!(parse("ActiveState=active\nSubState=running\nNRestarts=many\n"), None);
    }
}
