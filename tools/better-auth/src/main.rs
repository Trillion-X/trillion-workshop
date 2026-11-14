mod auth_schema;

use auth_schema::{AppAuthSchema, AppPluginSchema, create_auth_tables};
use better_auth::config::{BearerConfig, CookieOverride};
use better_auth::integrations::axum::AxumIntegration;
use better_auth::plugins::{EmailPasswordPlugin, JwtPlugin, PasskeyPlugin, SessionManagementPlugin};
use better_auth::seaorm::{Database, SeaOrmStore};
use better_auth::{AuthConfig, BetterAuth};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Deserialize)]
struct PasskeySettings {
    rp_id: String,
    rp_name: String,
    origin: String,
}

#[derive(Deserialize)]
struct Settings {
    port: u16,
    base_url: String,
    base_path: String,
    issuer: String,
    audience: String,
    database_path: String,
    session_cookie_name: String,
    passkey: PasskeySettings,
    trusted_origins: Vec<String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let settings_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/settings.json").to_string());
    let settings: Settings = serde_json::from_str(&std::fs::read_to_string(&settings_path)?)?;

    if let Some(folder) = std::path::Path::new(&settings.database_path).parent() {
        std::fs::create_dir_all(folder)?;
    }
    let database = Database::connect(format!("sqlite://{}?mode=rwc", settings.database_path)).await?;
    // The scaffold creates tables in an empty database; a database that already has them is left alone.
    let _ = create_auth_tables(&database).await;

    let mut config = AuthConfig::new(std::env::var("BETTER_AUTH_SECRET")?)
        .base_url(settings.base_url.as_str())
        .base_path(settings.base_path.as_str())
        .trusted_origins(settings.trusted_origins.clone());
    config.session.bearer = Some(BearerConfig::default());
    config.advanced.cookies = Some(HashMap::from([(
        "session_token".to_string(),
        CookieOverride {
            name: Some(settings.session_cookie_name.clone()),
            ..Default::default()
        },
    )]));

    let store = SeaOrmStore::<AppAuthSchema>::new(config.clone(), database)
        .with_plugin_schema::<AppPluginSchema>();
    let auth = Arc::new(
        BetterAuth::<AppAuthSchema>::new(config)
            .store(store)
            .plugin(EmailPasswordPlugin::new().enable_signup(true))
            .plugin(SessionManagementPlugin::new())
            .plugin(
                PasskeyPlugin::new()
                    .rp_id(settings.passkey.rp_id.as_str())
                    .rp_name(settings.passkey.rp_name.as_str())
                    .origin(settings.passkey.origin.as_str()),
            )
            .plugin(
                JwtPlugin::new()
                    .issuer(settings.issuer.clone())
                    .audience(settings.audience.as_str().into()),
            )
            .build()
            .await?,
    );

    let app = axum::Router::new()
        .nest(&settings.base_path, auth.clone().axum_router())
        .with_state(auth);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", settings.port)).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
