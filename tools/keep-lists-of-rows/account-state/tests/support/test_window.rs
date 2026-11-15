// tests/support/test_window.rs
//
// Purpose: a browser window signed in to one account, for the library's own test modules (sign-in is the Better Auth
// Workshop tool since Nov 13 2026; the engine only checks its JWT, src/account/signed_in.rs). The window's token is a
// JWT naming the account's address, signed by the key only tests hold (`signed_in::test_token`); its session is the one
// `account::admit_browser_token` opens for it; and the account's door (`account_routes::SignIn`, in memory) is listed as
// open for the account's name, as a computer or the native host lists it, so `account::current_browser` admits the
// session.
//
// Included with `include!` by the library's test modules (under tests/drafts and tests/mcp_selected_records_write), so it
// holds only items and plain comments and names everything by its whole path.

/// A browser window signed in to the account named `user`, whose address is `owner` (a door without a key answers its
/// owner as its address).
struct TestWindow {
    /// The window's sign-in token (what the browser presents).
    token: String,
    /// The session id the token opened (the BLAKE3 hex of the token).
    session: String,
    _sign_in: std::sync::Arc<crate::account::account_routes::SignIn>,
    _registration: crate::account::account_routes::Registration,
}

impl TestWindow {
    /// Sign a window in to the account named `user` at the address `owner`.
    fn open(user: &str, owner: &str) -> Self {
        let token = crate::account::signed_in::test_token(owner);
        let session = crate::account::admit_browser_token(&token).expect("the test token is admitted");
        let storage: crate::account::rows::Shared = std::sync::Arc::new(crate::account::rows::Locked::new(
            crate::storage::memory::Memory::open("sign_in").expect("the rows schema opens"),
        ));
        let sign_in = std::sync::Arc::new(crate::account::account_routes::SignIn::new(storage, user, owner, None));
        let registration = crate::account::account_routes::register(&sign_in);
        Self { token, session, _sign_in: sign_in, _registration: registration }
    }
}
