use axum::{
    extract::{Json, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use webauthn_rs::prelude::*;
use crate::db::{Db, User};

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
    if let Some(auth) = headers.get("authorization") {
        if let Ok(val) = auth.to_str() {
            if let Some(token) = val.strip_prefix("Bearer ") {
                return Some(token.trim().to_string());
            }
        }
    }
    // Also check Cookie header
    if let Some(cookie) = headers.get("cookie") {
        if let Ok(cookie_str) = cookie.to_str() {
            for part in cookie_str.split(';') {
                let part = part.trim();
                if let Some(token) = part.strip_prefix("mekuru_session=") {
                    return Some(token.trim().to_string());
                }
            }
        }
    }
    None
}

pub async fn register_start(
    State(state): State<AuthState>,
    Json(payload): Json<RegisterStartRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let username = payload.username.trim();
    if username.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "ユーザー名を入力してください".into()));
    }

    let user = state.db.get_or_create_user(username).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e))
    })?;

    let user_id = uuid::Uuid::parse_str(&user.id).unwrap_or_else(|_| uuid::Uuid::new_v4());

    // Exclude existing credentials for this user
    let existing_passkeys_raw = state.db.get_passkeys_for_user(&user.id).unwrap_or_default();
    let exclude_credentials = existing_passkeys_raw
        .into_iter()
        .filter_map(|json| serde_json::from_str::<Passkey>(&json).ok())
        .map(|pk| pk.cred_id().clone())
        .collect();

    let (creation_challenge, reg_state) = state
        .webauthn
        .start_passkey_registration(user_id, &user.username, &user.username, Some(exclude_credentials))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("WebAuthn error: {:?}", e)))?;

    let challenge_id = uuid::Uuid::new_v4().to_string();
    let reg_json = serde_json::to_string(&reg_state).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("JSON error: {}", e))
    })?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    state
        .db
        .save_challenge(&challenge_id, &reg_json, Some(&user.id), now + 300)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?;

    Ok(Json(RegisterStartResponse {
        challenge_id,
        options: creation_challenge,
    }))
}

pub async fn register_finish(
    State(state): State<AuthState>,
    Json(payload): Json<RegisterFinishRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let (reg_json, user_id) = state
        .db
        .get_and_delete_challenge(&payload.challenge_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "Challenge expired or invalid".to_string()))?;

    let user_id = user_id.ok_or_else(|| (StatusCode::BAD_REQUEST, "Missing user_id".to_string()))?;

    let reg_state: PasskeyRegistration = serde_json::from_str(&reg_json)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Malformed reg_state: {}", e)))?;

    let passkey = state
        .webauthn
        .finish_passkey_registration(&payload.credential, &reg_state)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("WebAuthn registration failed: {:?}", e)))?;

    let cred_id_b64 = serde_json::to_value(passkey.cred_id())
        .map(|v| v.as_str().unwrap_or("").to_string())
        .unwrap_or_default();

    let passkey_json = serde_json::to_string(&passkey)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("JSON error: {}", e)))?;

    state
        .db
        .save_passkey(&user_id, &cred_id_b64, &passkey_json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?;

    // Create session
    let token = state.db.create_session(&user_id, 30 * 86400).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("Session error: {}", e))
    })?;

    let user = state.db.get_user_by_id(&user_id).unwrap().unwrap();

    let mut headers = HeaderMap::new();
    headers.insert(
        "Set-Cookie",
        format!("mekuru_session={}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000", token)
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
            if let Ok(user) = state.db.get_or_create_user(username) {
                target_user_id = Some(user.id.clone());
                let list = state.db.get_passkeys_for_user(&user.id).unwrap_or_default();
                for json in list {
                    if let Ok(pk) = serde_json::from_str::<Passkey>(&json) {
                        passkeys.push(pk);
                    }
                }
            }
        }
    }

    let (rc, auth_state) = state
        .webauthn
        .start_passkey_authentication(&passkeys)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("WebAuthn error: {:?}", e)))?;

    let challenge_id = uuid::Uuid::new_v4().to_string();
    let auth_json = serde_json::to_string(&auth_state).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("JSON error: {}", e))
    })?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    state
        .db
        .save_challenge(&challenge_id, &auth_json, target_user_id.as_deref(), now + 300)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?;

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
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "Challenge expired or invalid".to_string()))?;

    let auth_state: PasskeyAuthentication = serde_json::from_str(&auth_json)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Malformed auth_state: {}", e)))?;

    let cred_id_b64 = payload.credential.id.clone();
    let user: User = if let Some((u, _)) = state
        .db
        .find_user_by_credential_id(&cred_id_b64)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?
    {
        u
    } else if let Some(uid) = maybe_user_id {
        state.db.get_user_by_id(&uid).unwrap().unwrap()
    } else {
        return Err((StatusCode::BAD_REQUEST, "No passkey registered for this credential".into()));
    };

    let auth_res = state
        .webauthn
        .finish_passkey_authentication(&payload.credential, &auth_state)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("WebAuthn login failed: {:?}", e)))?;

    // Create session
    let token = state.db.create_session(&user.id, 30 * 86400).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("Session error: {}", e))
    })?;

    let mut headers = HeaderMap::new();
    headers.insert(
        "Set-Cookie",
        format!("mekuru_session={}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000", token)
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
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?
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
        "mekuru_session=; Path=/; HttpOnly; Max-Age=0".parse().unwrap(),
    );

    Ok((headers, Json(serde_json::json!({ "success": true }))))
}
