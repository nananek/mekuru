use crate::db::{Db, User};
use axum::{
    extract::{Json, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use webauthn_rs::prelude::*;
use webauthn_rs_core::proto::ResidentKeyRequirement;

#[derive(Clone)]
pub struct AuthState {
    pub db: Db,
    pub webauthn: Arc<Webauthn>,
}

#[derive(Deserialize)]
pub struct RegisterStartRequest {
    pub username: String,
}

#[derive(Serialize)]
pub struct RegisterStartResponse {
    pub challenge_id: String,
    pub options: CreationChallengeResponse,
}

#[derive(Deserialize)]
pub struct RegisterFinishRequest {
    pub challenge_id: String,
    #[serde(flatten)]
    pub credential: RegisterPublicKeyCredential,
}

#[derive(Deserialize)]
pub struct LoginStartRequest {
    pub username: Option<String>,
}

#[derive(Serialize)]
pub struct LoginStartResponse {
    pub challenge_id: String,
    pub options: RequestChallengeResponse,
}

#[derive(Deserialize)]
pub struct LoginFinishRequest {
    pub challenge_id: String,
    #[serde(flatten)]
    pub credential: PublicKeyCredential,
}

#[derive(Serialize)]
pub struct AuthMeResponse {
    pub user_id: String,
    pub username: String,
}

pub fn extract_session_token(headers: &HeaderMap) -> Option<String> {
    if let Some(auth) = headers.get("authorization")
        && let Ok(val) = auth.to_str()
        && let Some(token) = val.strip_prefix("Bearer ")
    {
        return Some(token.trim().to_string());
    }
    // Also check Cookie header
    if let Some(cookie) = headers.get("cookie")
        && let Ok(cookie_str) = cookie.to_str()
    {
        for part in cookie_str.split(';') {
            let part = part.trim();
            if let Some(token) = part.strip_prefix("mekuru_session=") {
                return Some(token.trim().to_string());
            }
        }
    }
    None
}

/// Session user for endpoints that need authorization.
/// Returns `None` when the request carries no (or an expired) session.
pub(crate) fn session_user(headers: &HeaderMap, db: &Db) -> Option<User> {
    let token = extract_session_token(headers)?;
    db.get_session_user(&token).unwrap_or(None)
}

pub async fn register_start(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(payload): Json<RegisterStartRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let username = payload.username.trim();
    if username.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "ユーザー名を入力してください".into(),
        ));
    }

    // Accounts are provisioned via CLI (`create-user`). Never create them
    // from the network: otherwise anyone could squat usernames.
    let user = state
        .db
        .get_user_by_username(username)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB error: {}", e),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "ユーザーが存在しません。管理者に作成を依頼してください".to_string(),
            )
        })?;

    let user_id = uuid::Uuid::parse_str(&user.id).unwrap_or_else(|_| uuid::Uuid::new_v4());

    // Exclude existing credentials for this user
    let existing_passkeys_raw = state.db.get_passkeys_for_user(&user.id).unwrap_or_default();
    let exclude_credentials = existing_passkeys_raw
        .into_iter()
        .filter_map(|json| serde_json::from_str::<Passkey>(&json).ok())
        .map(|pk| pk.cred_id().clone())
        .collect::<Vec<_>>();

    // Adding a key to an account that already has keys requires a live
    // session for that same account. A keyless account (fresh CLI user or
    // right after `reset-passkey`) is open for first enrollment; losing all
    // keys is recovered the same way (CLI reset, then enroll again).
    if !exclude_credentials.is_empty() {
        match session_user(&headers, &state.db) {
            Some(u) if u.id == user.id => {}
            _ => {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    "追加登録にはログインが必要です。先にパスキーでログインしてください".into(),
                ));
            }
        }
    }

    let (mut creation_challenge, reg_state) = state
        .webauthn
        .start_passkey_registration(
            user_id,
            &user.username,
            &user.username,
            Some(exclude_credentials),
        )
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("WebAuthn error: {:?}", e),
            )
        })?;

    // webauthn-rs requests `residentKey: discouraged` here, which makes
    // providers (e.g. Bitwarden) create server-side (non-discoverable)
    // credentials. Those can never appear in usernameless login, so force
    // client-side discoverable credentials. The stored registration state
    // is unaffected (finish does not re-check this flag).
    if let Some(sel) = creation_challenge
        .public_key
        .authenticator_selection
        .as_mut()
    {
        sel.resident_key = Some(ResidentKeyRequirement::Required);
        sel.require_resident_key = true;
    }

    let challenge_id = uuid::Uuid::new_v4().to_string();
    let reg_json = serde_json::to_string(&reg_state).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("JSON error: {}", e),
        )
    })?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    state
        .db
        .save_challenge(&challenge_id, &reg_json, Some(&user.id), now + 300)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB error: {}", e),
            )
        })?;

    Ok(Json(RegisterStartResponse {
        challenge_id,
        options: creation_challenge,
    }))
}

pub async fn register_finish(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(payload): Json<RegisterFinishRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let (reg_json, user_id) = state
        .db
        .get_and_delete_challenge(&payload.challenge_id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB error: {}", e),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "Challenge expired or invalid".to_string(),
            )
        })?;

    let user_id =
        user_id.ok_or_else(|| (StatusCode::BAD_REQUEST, "Missing user_id".to_string()))?;

    // Re-check the enrollment gate here: whoever finishes second (a race
    // against a concurrent enrollment, or a forged finish call) must hold
    // a session once the account already has keys.
    let existing = state.db.get_passkeys_for_user(&user_id).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("DB error: {}", e),
        )
    })?;
    if !existing.is_empty() {
        match session_user(&headers, &state.db) {
            Some(u) if u.id == user_id => {}
            _ => {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    "追加登録にはログインが必要です。先にパスキーでログインしてください".into(),
                ));
            }
        }
    }

    let reg_state: PasskeyRegistration = serde_json::from_str(&reg_json).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Malformed reg_state: {}", e),
        )
    })?;

    let passkey = state
        .webauthn
        .finish_passkey_registration(&payload.credential, &reg_state)
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                format!("WebAuthn registration failed: {:?}", e),
            )
        })?;

    let cred_id_b64 = serde_json::to_value(passkey.cred_id())
        .map(|v| v.as_str().unwrap_or("").to_string())
        .unwrap_or_default();

    let passkey_json = serde_json::to_string(&passkey).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("JSON error: {}", e),
        )
    })?;

    state
        .db
        .save_passkey(&user_id, &cred_id_b64, &passkey_json)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB error: {}", e),
            )
        })?;

    // Create session
    let token = state.db.create_session(&user_id, 30 * 86400).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Session error: {}", e),
        )
    })?;

    let user = state.db.get_user_by_id(&user_id).unwrap().unwrap();

    let mut headers = HeaderMap::new();
    headers.insert(
        "Set-Cookie",
        format!(
            "mekuru_session={}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000",
            token
        )
        .parse()
        .unwrap(),
    );

    Ok((
        headers,
        Json(serde_json::json!({
            "success": true,
            "user_id": user.id,
            "username": user.username,
            "token": token
        })),
    ))
}

pub async fn login_start(
    State(state): State<AuthState>,
    Json(payload): Json<LoginStartRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let mut passkeys: Vec<Passkey> = Vec::new();
    let mut target_user_id: Option<String> = None;

    if let Some(username) = payload.username {
        let username = username.trim();
        if !username.is_empty() {
            // Read-only: login must never create users (that would let
            // anyone mint accounts by attempting a login).
            let user = state
                .db
                .get_user_by_username(username)
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("DB error: {}", e),
                    )
                })?
                .ok_or_else(|| {
                    (
                        StatusCode::BAD_REQUEST,
                        "ユーザーが存在しません".to_string(),
                    )
                })?;
            target_user_id = Some(user.id.clone());
            let list = state.db.get_passkeys_for_user(&user.id).unwrap_or_default();
            for json in list {
                if let Ok(pk) = serde_json::from_str::<Passkey>(&json) {
                    passkeys.push(pk);
                }
            }
        }
    }

    let (rc, auth_state) = state
        .webauthn
        .start_passkey_authentication(&passkeys)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("WebAuthn error: {:?}", e),
            )
        })?;

    let challenge_id = uuid::Uuid::new_v4().to_string();
    let auth_json = serde_json::to_string(&auth_state).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("JSON error: {}", e),
        )
    })?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    state
        .db
        .save_challenge(
            &challenge_id,
            &auth_json,
            target_user_id.as_deref(),
            now + 300,
        )
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB error: {}", e),
            )
        })?;

    Ok(Json(LoginStartResponse {
        challenge_id,
        options: rc,
    }))
}

pub async fn login_finish(
    State(state): State<AuthState>,
    Json(payload): Json<LoginFinishRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let (auth_json, maybe_user_id) = state
        .db
        .get_and_delete_challenge(&payload.challenge_id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB error: {}", e),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "Challenge expired or invalid".to_string(),
            )
        })?;

    let auth_state: PasskeyAuthentication = serde_json::from_str(&auth_json).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Malformed auth_state: {}", e),
        )
    })?;

    let cred_id_b64 = payload.credential.id.clone();
    let user: User = if let Some((u, _)) = state
        .db
        .find_user_by_credential_id(&cred_id_b64)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB error: {}", e),
            )
        })? {
        u
    } else if let Some(uid) = maybe_user_id {
        state.db.get_user_by_id(&uid).unwrap().unwrap()
    } else {
        return Err((
            StatusCode::BAD_REQUEST,
            "No passkey registered for this credential".into(),
        ));
    };

    let auth_res = state
        .webauthn
        .finish_passkey_authentication(&payload.credential, &auth_state)
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                format!("WebAuthn login failed: {:?}", e),
            )
        })?;

    // Create session
    let token = state.db.create_session(&user.id, 30 * 86400).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Session error: {}", e),
        )
    })?;

    let mut headers = HeaderMap::new();
    headers.insert(
        "Set-Cookie",
        format!(
            "mekuru_session={}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000",
            token
        )
        .parse()
        .unwrap(),
    );

    Ok((
        headers,
        Json(serde_json::json!({
            "success": true,
            "user_id": user.id,
            "username": user.username,
            "token": token,
            "counter": auth_res.counter()
        })),
    ))
}

pub async fn auth_me(
    State(state): State<AuthState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let token = extract_session_token(&headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Not logged in".to_string()))?;

    let user = state
        .db
        .get_session_user(&token)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB error: {}", e),
            )
        })?
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Session expired".to_string()))?;

    Ok(Json(AuthMeResponse {
        user_id: user.id,
        username: user.username,
    }))
}

pub async fn auth_logout(
    State(state): State<AuthState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if let Some(token) = extract_session_token(&headers) {
        let _ = state.db.delete_session(&token);
    }

    let mut headers = HeaderMap::new();
    headers.insert(
        "Set-Cookie",
        "mekuru_session=; Path=/; HttpOnly; Max-Age=0"
            .parse()
            .unwrap(),
    );

    Ok((headers, Json(serde_json::json!({ "success": true }))))
}
