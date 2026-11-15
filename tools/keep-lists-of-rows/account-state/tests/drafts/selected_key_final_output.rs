// Controls for the retained-key final output callback.
//
// Mount as a child of the existing `mcp_personal_key::tests` module. These
// tests exercise only key custody and callback ordering; they do not claim
// an output permit or a workspace-source readback.

use super::*;

#[test]
fn final_callback_can_release_after_same_owner_key_check_without_late_reads() {
    let shared_owner = owner(false);
    let key = format!("nm_{}", "a".repeat(64));
    let mut locked = shared_owner.lock().unwrap();
    let mut verified = verified_personal_key(&mut *locked, key.as_bytes()).unwrap();
    let mut output_released = false;
    let mut reads_at_release = None;

    let result = verified.with_current_claims_for_final_output(|source, claims, check| {
        assert_eq!(
            claims.sign_in,
            format!("key:{}", SecretNativeKey::parse(&key)?.identity())
        );
        check(source)?;
        reads_at_release = Some(source.reads);
        output_released = true;
        Ok("protected-output")
    });

    assert_eq!(result.unwrap(), "protected-output");
    assert!(output_released);
    assert_eq!(Some(4), reads_at_release);
    assert_eq!(locked.reads, reads_at_release.unwrap());
}

#[test]
fn key_withdrawn_before_final_same_owner_check_refuses_output_callback() {
    let shared_owner = owner(false);
    let key = format!("nm_{}", "a".repeat(64));
    let mut locked = shared_owner.lock().unwrap();
    let mut verified = verified_personal_key(&mut *locked, key.as_bytes()).unwrap();
    let mut output_released = false;

    let result = verified.with_current_claims_for_final_output(|source, _, check| {
        // Model a key withdrawal after the method's entry check but before its
        // final output check. The supplied same-owner check must see it.
        source.record = None;
        check(source)?;
        output_released = true;
        Ok("protected-output")
    });

    assert!(matches!(result.err(), Some(AccountError::KeyWithdrawn(_))));
    assert!(!output_released);
}
