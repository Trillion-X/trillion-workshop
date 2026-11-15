//! A first sign-up is already a sign-in: its initial session must route a fresh browser back to that account.
use super::*;

#[test]
fn a_fresh_signup_routes_the_browser_root_before_any_later_sign_in() {
    let parent = fs::canonicalize(std::env::temp_dir()).unwrap();
    let dir = tempfile::tempdir_in(parent).unwrap();
    let config = computer_config(&dir.path().join("fresh-signup"), &shared_computer_key());
    create(&config);
    let computer = Arc::new(Computer::start(read_config(&config).unwrap()).unwrap());
    let app = computer.app();
    let executor = two_threads();
    let forwarder = Arc::new(Gateway::with_computers(FORWARDER_HOST, std::sync::Arc::new(trillion_local::storage::time_source::RealClock)))
        .http_route_table()
        .unwrap();
    for (number, next) in [None, Some("/buy/offer%3Asynthetic?from=signup")]
        .into_iter()
        .enumerate()
    {
        let (status, options) = listener(
            &executor,
            &app,
            Method::POST,
            "/sign-up/options",
            Some(ORIGIN),
            Some(&json!({})),
        );
        assert_eq!(status, StatusCode::OK, "{options}");
        let options: Value = serde_json::from_str(&options).unwrap();
        let mut answer = Authenticator::new(70 + number as u8).registration(
            options["options"]["challenge"].as_str().unwrap(),
            "Synthetic signup",
        );
        if let Some(next) = next {
            answer["next"] = json!(next);
        }
        let request = Request::builder()
            .method(Method::POST)
            .uri("/sign-up/finish")
            .header(header::HOST, "computer.test")
            .header(header::ORIGIN, ORIGIN)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(answer.to_string()))
            .unwrap();
        let (cookies, done) = executor.block_on(async {
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let cookies: Vec<String> = response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .map(|value| value.to_str().unwrap().to_owned())
                .collect();
            let done: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap())
                    .unwrap();
            (cookies, done)
        });
        let address = done["address"].as_str().unwrap();
        if let Some(next) = next {
            assert_eq!(done["next"], format!("/a/{address}{next}"));
        } else {
            // With no plan, the finish lands on the new account's own address, where a signed-in browser is home.
            assert_eq!(done["next"], format!("/a/{address}/"));
        }
        // The window session cookie is expired in the same answer (ad9adeb16), so a browser never holds two session cookies.
        assert!(cookies.iter().any(|cookie| cookie.starts_with("nm_session=") && cookie.contains("Max-Age=0")), "{cookies:?}");
        let cookies: Vec<String> = cookies.into_iter().filter(|cookie| !cookie.starts_with("nm_session=")).collect();
        assert_eq!(
            cookies.len(),
            2,
            "the first session and public hint are both issued"
        );
        let hint = cookies
            .iter()
            .find(|cookie| cookie.starts_with("__Host-account-address="))
            .unwrap();
        assert!(hint.starts_with(&format!("__Host-account-address={address};")));
        assert!(
            hint.contains("Path=/;")
                && hint.contains("Secure;")
                && hint.contains("HttpOnly;")
                && hint.contains("SameSite=Lax;")
        );
        assert!(!hint.contains("Domain="));
        let max_age = |cookie: &str| {
            cookie
                .split(';')
                .find_map(|part| part.trim().strip_prefix("Max-Age="))
                .unwrap()
                .to_owned()
        };
        let session = cookies
            .iter()
            .find(|cookie| !cookie.starts_with("__Host-account-address="))
            .unwrap();
        assert_eq!(max_age(hint), max_age(session));
        let cookie = cookies
            .iter()
            .map(|cookie| cookie.split(';').next().unwrap())
            .collect::<Vec<_>>()
            .join("; ");
        // No later sign-in ceremony supplies or repairs these cookies.
        let security = format!("/a/{address}/sign-in/security");
        let (status, _) = listener_with(
            &executor,
            &app,
            Method::GET,
            &security,
            &[(header::COOKIE.as_str(), &cookie)],
            None,
        );
        assert_eq!(
            status,
            StatusCode::OK,
            "the sign-up session works for its own account"
        );
        let hint_pair = hint.split(';').next().unwrap();
        let (status, _) = listener_with(
            &executor,
            &app,
            Method::GET,
            &security,
            &[(header::COOKIE.as_str(), hint_pair)],
            None,
        );
        assert_eq!(
            status,
            StatusCode::SEE_OTHER,
            "the hint alone grants no session"
        );
        executor.block_on(async {
            for method in [Method::GET, Method::HEAD] {
                let request = Request::builder()
                    .method(method)
                    .uri("/")
                    .header(header::HOST, FORWARDER_HOST)
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .unwrap();
                let response = forwarder.clone().oneshot(request).await.unwrap();
                assert_eq!(response.status(), StatusCode::SEE_OTHER);
                assert_eq!(
                    response.headers()[header::LOCATION],
                    format!("/a/{address}/")
                );
            }
            // The account's own address answers a browser, signed in or not, with its Sign-in & security page (which asks
            // one with no session to sign in), never 404, while its engine carries no workspace.
            for cookie in [Some(cookie.as_str()), None] {
                let mut request = Request::builder().method(Method::GET).uri(format!("/a/{address}/")).header(header::HOST, "computer.test");
                if let Some(cookie) = cookie {
                    request = request.header(header::COOKIE, cookie);
                }
                let response = app.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
                assert_eq!(response.status(), StatusCode::SEE_OTHER);
                assert_eq!(response.headers()[header::LOCATION], format!("/a/{address}/sign-in/security"));
            }
        });
        // Home: once the account's engine carries a workspace, the account's own address (and `/a/<address>/?query`)
        // opens it for a browser with a session; the hint alone, another account's session and no session still go to
        // the Sign-in & security page.
        computer.accounts().into_iter().find(|account| account.address() == address).unwrap()
            .set_home(axum::Router::new().route("/", axum::routing::get(|| async { "synthetic workspace home" })));
        let home = format!("/a/{address}/");
        let (status, body) = listener_with(&executor, &app, Method::GET, &home, &[(header::COOKIE.as_str(), &cookie)], None);
        assert_eq!((status, body.as_str()), (StatusCode::OK, "synthetic workspace home"), "a session opens Home");
        let (status, body) = listener_with(&executor, &app, Method::GET, &format!("{home}?x=1"), &[(header::COOKIE.as_str(), &cookie)], None);
        assert_eq!((status, body.as_str()), (StatusCode::OK, "synthetic workspace home"), "a query keeps the page");
        for cookie in [Some(hint_pair), None] {
            let headers: Vec<(&str, &str)> = cookie.map(|cookie| (header::COOKIE.as_str(), cookie)).into_iter().collect();
            let (status, _) = listener_with(&executor, &app, Method::GET, &home, &headers, None);
            assert_eq!(status, StatusCode::SEE_OTHER, "no session: sign in first");
        }
        let (status, _) = listener(
            &executor,
            &app,
            Method::POST,
            "/sign-up/finish",
            Some(ORIGIN),
            Some(&answer),
        );
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "the ceremony remains one-use"
        );
    }
}
