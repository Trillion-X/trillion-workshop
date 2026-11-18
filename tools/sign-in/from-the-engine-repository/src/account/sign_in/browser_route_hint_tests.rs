//! Real sign-in responses carry both cookies; a route hint never authenticates a browser.
use crate::account::sign_in::{
    self,
    routes::{routes, Supplies},
    sessions,
    store::{Family, Store},
    tokens::blake3_hex,
};
use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    response::Response,
    Router,
};
use std::sync::Arc;
use tower::ServiceExt;

const ADDRESS: &str = "555-0100abcdef555-0100abcdef555-0100abcdef555-0100abcdef";
const ORIGIN: &str = "https://door.test";

fn door() -> (Router, Arc<dyn crate::storage::Storage + Send + Sync>) {
    door_with_base("")
}

fn door_with_base(base: &str) -> (Router, Arc<dyn crate::storage::Storage + Send + Sync>) {
    let storage: Arc<dyn crate::storage::Storage + Send + Sync> =
        Arc::new(sign_in::Locked::new(sign_in::lists::test_memory()));
    let router = routes(Supplies {
        storage: storage.clone(),
        account: "owner".into(),
        address: ADDRESS.into(),
        origin: ORIGIN.into(),
        base: base.into(),
        sender: None,
    });
    (router, storage)
}

async fn send(router: &Router, request: Request<Body>) -> Response {
    router.clone().oneshot(request).await.unwrap()
}

fn cookies(response: &Response) -> Vec<&str> {
    response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap())
        .collect()
}

fn check_sign_in(response: &Response) -> String {
    let cookies = cookies(response);
    assert_eq!(
        cookies.len(),
        3,
        "the session, the expired window cookie and the public route hint are separate headers"
    );
    assert!(cookies[1].starts_with("nm_session=") && cookies[1].contains("Max-Age=0"), "{cookies:?}");
    let hint = super::for_session(ADDRESS, cookies[0]).unwrap();
    assert_eq!(cookies[2], hint);
    cookies[0].split(';').next().unwrap().to_owned()
}

#[tokio::test]
async fn a_passkey_link_finish_preserves_both_cookies() {
    use serde_json::json;
    use sign_in::passkeys::tests::{registration, Authenticator};
    let origin = sign_in::passkeys::tests::ORIGIN;
    let storage: Arc<dyn crate::storage::Storage + Send + Sync> =
        Arc::new(sign_in::Locked::new(sign_in::lists::test_memory()));
    let router = routes(Supplies {
        storage: storage.clone(),
        account: "owner".into(),
        address: ADDRESS.into(),
        origin: origin.into(),
        base: String::new(),
        sender: None,
    });
    let link = sign_in::routes::passkey_link(&Store::new(&*storage), "owner", origin).unwrap();
    let code = link.split("?link=").nth(1).unwrap();
    let post = |path: &str, value: &serde_json::Value| {
        Request::builder()
            .method("POST")
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(value.to_string()))
            .unwrap()
    };
    let response = send(
        &router,
        post(
            "/passkey/options",
            &json!({"purpose":"register", "code":code}),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let options: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap(),
    )
    .unwrap();
    let auth = Authenticator::ec(9);
    let mut body = registration(&auth, options["challenge"].as_str().unwrap());
    body["purpose"] = json!("register");
    body["code"] = json!(code);
    let response = send(&router, post("/passkey/finish", &body)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = check_sign_in(&response);
    assert_eq!(
        sessions::current(&Store::new(&*storage), Some(&cookie))
            .unwrap()
            .unwrap()
            .account,
        "owner"
    );
}

#[tokio::test]
async fn a_password_way_preserves_both_cookies_and_the_account_session() {
    use sign_in::ways;
    let (router, storage) = door();
    let store = Store::new(&*storage);
    ways::set(&store, "owner", 0, ways::for_tests()).unwrap();
    let fresh = sessions::start(&store, "owner", "passkey").unwrap();
    let fresh = fresh.split(';').next().unwrap();
    let post = |path: &str, cookie: Option<&str>, fields: &[(&str, &str)]| {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(fields.iter().copied())
            .finish();
        let mut request = Request::builder()
            .method("POST")
            .uri(path)
            .header(header::ORIGIN, ORIGIN)
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        request.body(Body::from(body)).unwrap()
    };
    let saved = send(
        &router,
        post(
            "/sign-in/security/way",
            Some(fresh),
            &[
                ("way", "password"),
                ("step", "add"),
                ("sign_in_email", "person@example.test"),
                ("new_password", "synthetic test password"),
            ],
        ),
    )
    .await;
    assert_eq!(saved.status(), StatusCode::OK);
    let response = send(
        &router,
        post(
            "/sign-in/way",
            None,
            &[
                ("way", "password"),
                ("sign_in_email", "person@example.test"),
                ("password", "synthetic test password"),
                ("next", "/"),
            ],
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let cookie = check_sign_in(&response);
    assert_eq!(
        sessions::current(&store, Some(&cookie))
            .unwrap()
            .unwrap()
            .account,
        "owner"
    );
}

#[tokio::test]
async fn a_one_use_web_link_preserves_the_session_and_public_hint() {
    let (router, storage) = door();
    let store = Store::new(&*storage);
    let (link, _) =
        sessions::web_link(&store, "owner", ORIGIN, "", Some("/sign-in/security")).unwrap();
    let path = link.strip_prefix(ORIGIN).unwrap();
    let response = send(
        &router,
        Request::builder().uri(path).body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(response.headers()[header::LOCATION], "/sign-in/security");
    let cookie = check_sign_in(&response);
    assert_eq!(
        sessions::current(&store, Some(&cookie))
            .unwrap()
            .unwrap()
            .account,
        "owner"
    );
    let replay = send(
        &router,
        Request::builder().uri(path).body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert!(cookies(&replay).is_empty());
}

#[tokio::test]
async fn a_hint_does_not_authorize_and_sign_out_clears_it_without_a_live_session() {
    let base = format!("/a/{ADDRESS}");
    let (router, storage) = door_with_base(&base);
    let store = Store::new(&*storage);
    sign_in::ways::set(&store, "owner", 0, sign_in::ways::for_tests()).unwrap();
    let hint = super::for_session(ADDRESS, "session=unused; Max-Age=900")
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let other = sessions::start(&store, "someone-else", "passkey")
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let expired = sessions::start(&store, "owner", "passkey")
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let secret = expired.split_once('=').unwrap().1;
    let mut row = store
        .get::<sessions::Session>(Family::Sessions, &blake3_hex(secret))
        .unwrap()
        .unwrap();
    row.expires_at = 1;
    store.put(Family::Sessions, &row).unwrap();
    for cookie in [
        hint.clone(),
        format!("{hint}; {other}"),
        format!("{hint}; {expired}"),
    ] {
        let response = send(
            &router,
            Request::builder()
                .uri("/sign-in/security")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert!(response.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .eq(&format!("{base}/sign-in")));
    }
    for cookie in [None, Some(format!("{hint}; {expired}"))] {
        let mut request = Request::builder()
            .method("POST")
            .uri("/sign-out")
            .header(header::ORIGIN, ORIGIN);
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        let response = send(&router, request.body(Body::empty()).unwrap()).await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        let cookies = cookies(&response);
        assert_eq!(cookies.len(), 2);
        assert!(cookies.iter().all(|cookie| cookie.contains("Max-Age=0")));
        assert_eq!(cookies[1], super::clearing());
    }
}
