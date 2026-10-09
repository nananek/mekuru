use crate::auth::extract_session_token;
use crate::db::Db;
use axum::{
    Json,
    extract::{Multipart, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};

#[derive(Clone)]
pub struct SketchState {
    pub db: Db,
}

pub async fn upload_sketch(
    State(state): State<SketchState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let current_user = if let Some(token) = extract_session_token(&headers) {
        state.db.get_session_user(&token).unwrap_or(None)
    } else {
        None
    };

    let user_id = current_user.map(|u| u.id);

    let mut timer_duration_sec: i64 = 0;
    let mut created_at: Option<String> = None;
    let mut image_data: Option<Vec<u8>> = None;
    let mut thumbnail_data: Option<Vec<u8>> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Multipart error: {}", e)))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "timerDurationSec" {
            let text = field
                .text()
                .await
                .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
            timer_duration_sec = text.parse().unwrap_or(0);
        } else if name == "createdAt" {
            let text = field
                .text()
                .await
                .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
            created_at = Some(text);
        } else if name == "image" {
            let bytes = field
                .bytes()
                .await
                .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
            image_data = Some(bytes.to_vec());
        } else if name == "thumbnail" {
            let bytes = field
                .bytes()
                .await
                .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
            thumbnail_data = Some(bytes.to_vec());
        }
    }

    let image =
        image_data.ok_or_else(|| (StatusCode::BAD_REQUEST, "Missing image file".to_string()))?;
    let thumb = thumbnail_data.unwrap_or_else(|| image.clone()); // fallback
    let date_str = created_at.unwrap_or_else(chrono_now);

    let sketch_id = state
        .db
        .save_sketch(
            user_id.as_deref(),
            timer_duration_sec,
            &date_str,
            &image,
            &thumb,
        )
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB error: {}", e),
            )
        })?;

    Ok(Json(serde_json::json!({
        "success": true,
        "id": sketch_id
    })))
}

pub async fn list_sketches(
    State(state): State<SketchState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let current_user = if let Some(token) = extract_session_token(&headers) {
        state.db.get_session_user(&token).unwrap_or(None)
    } else {
        None
    };

    let user_id = current_user.map(|u| u.id);
    let list = state.db.list_sketches(user_id.as_deref()).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("DB error: {}", e),
        )
    })?;

    Ok(Json(list))
}

pub async fn get_sketch_image(
    State(state): State<SketchState>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let img = state
        .db
        .get_sketch_image(id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB error: {}", e),
            )
        })?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Sketch not found".to_string()))?;

    Ok((
        [
            (header::CONTENT_TYPE, "image/webp"),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        img,
    ))
}

pub async fn get_sketch_thumbnail(
    State(state): State<SketchState>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let thumb = state
        .db
        .get_sketch_thumbnail(id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB error: {}", e),
            )
        })?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Thumbnail not found".to_string()))?;

    Ok((
        [
            (header::CONTENT_TYPE, "image/webp"),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        thumb,
    ))
}

pub async fn delete_sketch(
    State(state): State<SketchState>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let deleted = state.db.delete_sketch(id).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("DB error: {}", e),
        )
    })?;

    if deleted {
        Ok(Json(serde_json::json!({ "success": true })))
    } else {
        Err((StatusCode::NOT_FOUND, "Sketch not found".to_string()))
    }
}

fn chrono_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    format!("{}-01-01T00:00:00Z", 1970 + now / 31536000)
}
