//! Which resource owner answers an operation address. The original `@own-records` composition owns the installed
//! Workshop, Account files and computer-grant methods, so those addresses route to the same account owner as its
//! records. Every other address keeps its own route.
//!
//! The reach an operation needs is not decided here: the rights gate (`rights_gate`) and the account routes' sign-in
//! scopes (the signed-in scopes, src/account/signed_in/settings.json) decide it.

/// The admitted resource owner of an operation address. A Workshop, account files
/// or computer-grant method declared by this installed product belongs to the
/// same selected account as its records. No request-supplied alias, input
/// field or unknown method can create that relationship. Independently
/// addressed resources retain their exact original route.
pub fn route_resource<'a>(resource_address: &'a str, operation: &str) -> &'a str {
    if resource_address == "@own-records" {
        return resource_address;
    }
    // The door's own sign-in operations are the same account's.
    if resource_address == crate::account::account_routes::operations().resource {
        return "@own-records";
    }
    let workshop = crate::tool_runs::tools::shipped().is_ok_and(|owner|
        owner.answers(resource_address, operation));
    let files = crate::account_files::account_routes::AccountFilesDoor::shipped()
        .is_some_and(|owner| owner.answers(resource_address, operation));
    let computer = crate::tool_runs::tools::computer::shipped()
        .is_ok_and(|owner| owner.answers(resource_address, operation));
    if workshop || files || computer { "@own-records" } else { resource_address }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_installed_methods_are_mounted_on_the_account_owner() {
        assert_eq!(route_resource("@workshop-tools", "tools:list"), "@own-records");
        assert_eq!(route_resource("@workshop-tools", "invented:method"), "@workshop-tools");
        assert_eq!(route_resource("@invented", "tools:list"), "@invented");
        assert_eq!(route_resource("project:independent", "transaction"), "project:independent");
    }
}
