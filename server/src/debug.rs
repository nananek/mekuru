use crate::db::{chrono_now, Db};
use axum::{
    extract::{Multipart, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, Mutex};

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct RenderJob {
    pub id: String,
    pub points: serde_json::Value,
    pub width: u32,
    pub height: u32,
    pub dpr: f64,
}

pub struct BridgeState {
    pub render_queue: VecDeque<RenderJob>,
    pub pending_renders: HashMap<String, oneshot::Sender<Vec<u8>>>,
    pub last_poll: Option<Instant>,
}

impl BridgeState {
    pub fn new() -> Self {
        Self {
            render_queue: VecDeque::new(),
            pending_renders: HashMap::new(),
            last_poll: None,
        }
    }
}

impl Default for BridgeState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
pub struct DebugState {
    pub db: Db,
    pub bridge: Arc<Mutex<BridgeState>>,
}

impl DebugState {
    pub fn new(db: Db) -> Self {
        Self {
            db,
            bridge: Arc::new(Mutex::new(BridgeState::new())),
        }
    }
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
pub struct SaveStrokePayload {
    pub id: Option<String>,
    pub label: Option<String>,
    pub points: serde_json::Value,
    pub metadata: Option<serde_json::Value>,
    pub image_base64: Option<String>,
}

#[derive(Deserialize)]
pub struct RenderRequestPayload {
    pub points: serde_json::Value,
    pub label: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub dpr: Option<f64>,
    pub timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
pub struct RenderQuery {
    pub format: Option<String>,
}

#[derive(Deserialize)]
pub struct BridgeResponsePayload {
    pub id: String,
    pub image_base64: String,
}

// ---------------------------------------------------------------------------
// Stroke Storage & Inspection
// ---------------------------------------------------------------------------

/// Save a captured debug stroke (supports JSON payload)
pub async fn save_debug_stroke_json(
    State(state): State<DebugState>,
    Json(payload): Json<SaveStrokePayload>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let id = payload
        .id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono_now();

    let point_count = match &payload.points {
        serde_json::Value::Array(arr) => arr.len() as i64,
        _ => 0,
    };
    let points_str = payload.points.to_string();
    let meta_str = match &payload.metadata {
        Some(m) => m.to_string(),
        None => "{}".to_string(),
    };

    let image_bytes = payload
        .image_base64
        .as_deref()
        .and_then(decode_base64_data_url);

    state
        .db
        .save_debug_stroke(
            &id,
            payload.label.as_deref(),
            &now,
            point_count,
            &points_str,
            &meta_str,
            image_bytes.as_deref(),
            image_bytes.as_deref(),
        )
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(serde_json::json!({
        "success": true,
        "id": id,
        "point_count": point_count,
        "has_image": image_bytes.is_some()
    })))
}

/// Save a captured debug stroke via Multipart (for direct binary PNG upload)
pub async fn save_debug_stroke_multipart(
    State(state): State<DebugState>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono_now();

    let mut label: Option<String> = None;
    let mut points_str = "[]".to_string();
    let mut meta_str = "{}".to_string();
    let mut point_count: i64 = 0;
    let mut image_bytes: Option<Vec<u8>> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "label" {
            label = field.text().await.ok();
        } else if name == "points" {
            if let Ok(text) = field.text().await {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(arr) = val.as_array() {
                        point_count = arr.len() as i64;
                    }
                }
                points_str = text;
            }
        } else if name == "metadata" {
            if let Ok(text) = field.text().await {
                meta_str = text;
            }
        } else if name == "image" {
            if let Ok(bytes) = field.bytes().await {
                image_bytes = Some(bytes.to_vec());
            }
        }
    }

    state
        .db
        .save_debug_stroke(
            &id,
            label.as_deref(),
            &now,
            point_count,
            &points_str,
            &meta_str,
            image_bytes.as_deref(),
            image_bytes.as_deref(),
        )
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(serde_json::json!({
        "success": true,
        "id": id,
        "point_count": point_count,
        "has_image": image_bytes.is_some()
    })))
}

/// List recent debug strokes
pub async fn list_debug_strokes(
    State(state): State<DebugState>,
    Query(query): Query<ListQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let limit = query.limit.unwrap_or(30).min(100);
    let list = state
        .db
        .list_debug_strokes(limit)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(serde_json::json!({
        "count": list.len(),
        "strokes": list
    })))
}

/// Get latest debug stroke (including points array and image url)
pub async fn get_latest_debug_stroke(
    State(state): State<DebugState>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let stroke = state
        .db
        .get_latest_debug_stroke()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                "No debug strokes recorded yet".to_string(),
            )
        })?;

    let points: serde_json::Value =
        serde_json::from_str(&stroke.points_json).unwrap_or(serde_json::json!([]));
    let metadata: serde_json::Value =
        serde_json::from_str(&stroke.metadata_json).unwrap_or(serde_json::json!({}));

    Ok(Json(serde_json::json!({
        "id": stroke.id,
        "label": stroke.label,
        "created_at": stroke.created_at,
        "point_count": stroke.point_count,
        "has_image": stroke.has_image,
        "image_url": format!("/api/debug/strokes/{}/image", stroke.id),
        "points": points,
        "metadata": metadata
    })))
}

/// Get detailed debug stroke by ID
pub async fn get_debug_stroke(
    State(state): State<DebugState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let stroke = state
        .db
        .get_debug_stroke(&id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Debug stroke not found".to_string()))?;

    let points: serde_json::Value =
        serde_json::from_str(&stroke.points_json).unwrap_or(serde_json::json!([]));
    let metadata: serde_json::Value =
        serde_json::from_str(&stroke.metadata_json).unwrap_or(serde_json::json!({}));

    Ok(Json(serde_json::json!({
        "id": stroke.id,
        "label": stroke.label,
        "created_at": stroke.created_at,
        "point_count": stroke.point_count,
        "has_image": stroke.has_image,
        "image_url": format!("/api/debug/strokes/{}/image", stroke.id),
        "points": points,
        "metadata": metadata
    })))
}

/// Get PNG image for a debug stroke
pub async fn get_debug_stroke_image(
    State(state): State<DebugState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let img = state
        .db
        .get_debug_stroke_image(&id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                "No image found for this stroke".to_string(),
            )
        })?;

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, "image/png".parse().unwrap());
    headers.insert(
        header::CACHE_CONTROL,
        "no-cache, no-store, must-revalidate".parse().unwrap(),
    );

    Ok((headers, img))
}

/// Clear all debug strokes
pub async fn clear_debug_strokes(
    State(state): State<DebugState>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let deleted = state
        .db
        .clear_debug_strokes()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(serde_json::json!({
        "success": true,
        "deleted_count": deleted
    })))
}

// ---------------------------------------------------------------------------
// Standard Test Presets
// ---------------------------------------------------------------------------

/// Returns preset test strokes for evaluation
pub async fn get_debug_presets() -> impl IntoResponse {
    let presets = serde_json::json!({
        "tilt_flat_shading": {
            "name": "Flat Tilt Shading (~11° tilt)",
            "description": "Dense horizontal shading stroke with flat pencil tilt (altitude 0.20 rad) to evaluate dotted line banding elimination.",
            "points": generate_tilt_flat_stroke()
        },
        "tilt_angle_transition": {
            "name": "Tilt Angle Transition (Vertical to Flat)",
            "description": "Gradual pen tilt transition from normal writing angle (0.80 rad) down to broad shading (0.15 rad).",
            "points": generate_tilt_transition_stroke()
        },
        "pressure_ramp_line": {
            "name": "Pressure Ramp Line (0.05 to 1.0)",
            "description": "Straight stroke with pressure ramping up smoothly from very light feathering to maximum force.",
            "points": generate_pressure_ramp_stroke()
        },
        "smooth_s_curve": {
            "name": "Smooth S-Curve (Bezier Curvature)",
            "description": "Curving stroke across the canvas to verify subpixel antialiasing and absence of staircase jaggies.",
            "points": generate_s_curve_stroke()
        },
        "rapid_flick": {
            "name": "Rapid Flick Stroke (Coalesced Events)",
            "description": "Simulates quick pencil gesture with rapid acceleration and release feathering.",
            "points": generate_fast_flick_stroke()
        },
        "hatching_grid": {
            "name": "Hatching Cross Lines",
            "description": "Multiple overlapping strokes to verify graphite multiply composite blending and depth accumulation.",
            "points": generate_hatching_stroke()
        }
    });

    Json(presets)
}

// ---------------------------------------------------------------------------
// Live Bridge & Remote Rendering
// ---------------------------------------------------------------------------

/// Render arbitrary stroke through active browser bridge
pub async fn render_stroke(
    State(state): State<DebugState>,
    Query(query): Query<RenderQuery>,
    Json(payload): Json<RenderRequestPayload>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let job_id = uuid::Uuid::new_v4().to_string();
    let timeout_ms = payload.timeout_ms.unwrap_or(4000).min(10000);

    let job = RenderJob {
        id: job_id.clone(),
        points: payload.points.clone(),
        width: payload.width.unwrap_or(800),
        height: payload.height.unwrap_or(600),
        dpr: payload.dpr.unwrap_or(2.0),
    };

    let (tx, rx) = oneshot::channel::<Vec<u8>>();

    {
        let mut bridge = state.bridge.lock().await;

        // Check if a browser has polled recently (within last 8 seconds)
        let is_bridge_active = bridge
            .last_poll
            .is_some_and(|t| t.elapsed() < Duration::from_secs(8));

        if !is_bridge_active {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "No active browser bridge connected. Please open http://localhost:3000/debug.html or Mekuru with ?debug=1 in your browser to enable live rendering.".to_string(),
            ));
        }

        bridge.render_queue.push_back(job);
        bridge.pending_renders.insert(job_id.clone(), tx);
    }

    // Await render result from browser
    let render_result = tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await;

    match render_result {
        Ok(Ok(image_bytes)) => {
            let now = chrono_now();
            let point_count = payload
                .points
                .as_array()
                .map_or(0, |a| a.len() as i64);
            let label = payload.label.as_deref().unwrap_or("live_render");

            let _ = state.db.save_debug_stroke(
                &job_id,
                Some(label),
                &now,
                point_count,
                &payload.points.to_string(),
                &serde_json::json!({
                    "width": payload.width.unwrap_or(800),
                    "height": payload.height.unwrap_or(600),
                    "dpr": payload.dpr.unwrap_or(2.0)
                })
                .to_string(),
                Some(&image_bytes),
                Some(&image_bytes),
            );

            if query.format.as_deref() == Some("image") {
                let mut headers = HeaderMap::new();
                headers.insert(header::CONTENT_TYPE, "image/png".parse().unwrap());
                headers.insert(
                    header::CACHE_CONTROL,
                    "no-cache, no-store, must-revalidate".parse().unwrap(),
                );
                return Ok((headers, image_bytes).into_response());
            }

            Ok(Json(serde_json::json!({
                "success": true,
                "id": job_id,
                "image_url": format!("/api/debug/strokes/{}/image", job_id),
                "image_data_length": image_bytes.len()
            }))
            .into_response())
        }
        Ok(Err(_)) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "Rendering cancelled or bridge disconnected.".to_string(),
        )),
        Err(_) => {
            // Clean up timed out pending channel
            let mut bridge = state.bridge.lock().await;
            bridge.pending_renders.remove(&job_id);
            Err((
                StatusCode::GATEWAY_TIMEOUT,
                format!("Live rendering timed out after {}ms.", timeout_ms),
            ))
        }
    }
}

/// Browser polling endpoint for queued render jobs
pub async fn bridge_poll(State(state): State<DebugState>) -> impl IntoResponse {
    let mut bridge = state.bridge.lock().await;
    bridge.last_poll = Some(Instant::now());

    let job = bridge.render_queue.pop_front();
    Json(serde_json::json!({
        "job": job
    }))
}

/// Browser response endpoint for returning rendered PNG image
pub async fn bridge_response(
    State(state): State<DebugState>,
    Json(payload): Json<BridgeResponsePayload>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let mut bridge = state.bridge.lock().await;
    bridge.last_poll = Some(Instant::now());

    if let Some(tx) = bridge.pending_renders.remove(&payload.id) {
        if let Some(bytes) = decode_base64_data_url(&payload.image_base64) {
            let _ = tx.send(bytes);
            return Ok(Json(serde_json::json!({ "success": true })));
        } else {
            return Err((
                StatusCode::BAD_REQUEST,
                "Invalid image base64 format".to_string(),
            ));
        }
    }

    Ok(Json(serde_json::json!({
        "success": false,
        "reason": "No pending request with this ID"
    })))
}

/// Get debug server status and bridge state
pub async fn debug_status(State(state): State<DebugState>) -> impl IntoResponse {
    let bridge = state.bridge.lock().await;
    let is_connected = bridge
        .last_poll
        .is_some_and(|t| t.elapsed() < Duration::from_secs(8));

    let queue_len = bridge.render_queue.len();
    let pending_len = bridge.pending_renders.len();

    let stroke_count = state.db.list_debug_strokes(1).map_or(0, |s| s.len());

    Json(serde_json::json!({
        "status": "ready",
        "bridge_connected": is_connected,
        "queue_length": queue_len,
        "pending_renders": pending_len,
        "has_saved_strokes": stroke_count > 0
    }))
}

// ---------------------------------------------------------------------------
// Helpers & Preset Generators
// ---------------------------------------------------------------------------

fn decode_base64_data_url(data: &str) -> Option<Vec<u8>> {
    let b64_str = if let Some(idx) = data.find(',') {
        &data[idx + 1..]
    } else {
        data
    };
    decode_base64_custom(b64_str.trim())
}

fn decode_base64_custom(s: &str) -> Option<Vec<u8>> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0;

    for &b in bytes {
        let val = match b {
            b'A'..=b'Z' => (b - b'A') as u32,
            b'a'..=b'z' => (b - b'a' + 26) as u32,
            b'0'..=b'9' => (b - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' | b' ' => continue,
            _ => return None,
        };
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

fn generate_tilt_flat_stroke() -> serde_json::Value {
    let mut pts = Vec::new();
    let steps = 40;
    for i in 0..=steps {
        let t = i as f64 / steps as f64;
        let x = 150.0 + t * 450.0;
        let y = 250.0 + (t * 8.0).sin() * 12.0;
        pts.push(serde_json::json!({
            "x": x,
            "y": y,
            "pressure": 0.40,
            "altitudeAngle": 0.18,
            "azimuthAngle": 0.0,
            "pointerType": "pen"
        }));
    }
    serde_json::Value::Array(pts)
}

fn generate_tilt_transition_stroke() -> serde_json::Value {
    let mut pts = Vec::new();
    let steps = 50;
    for i in 0..=steps {
        let t = i as f64 / steps as f64;
        let x = 120.0 + t * 500.0;
        let y = 200.0 + t * 60.0;
        let altitude = 0.85 - t * 0.70; // 0.85 (upright) -> 0.15 (flat)
        pts.push(serde_json::json!({
            "x": x,
            "y": y,
            "pressure": 0.45,
            "altitudeAngle": altitude,
            "azimuthAngle": 0.0,
            "pointerType": "pen"
        }));
    }
    serde_json::Value::Array(pts)
}

fn generate_pressure_ramp_stroke() -> serde_json::Value {
    let mut pts = Vec::new();
    let steps = 45;
    for i in 0..=steps {
        let t = i as f64 / steps as f64;
        let x = 150.0 + t * 450.0;
        let y = 300.0;
        let pressure = 0.05 + t * 0.95;
        pts.push(serde_json::json!({
            "x": x,
            "y": y,
            "pressure": pressure,
            "altitudeAngle": 1.57,
            "azimuthAngle": 0.0,
            "pointerType": "pen"
        }));
    }
    serde_json::Value::Array(pts)
}

fn generate_s_curve_stroke() -> serde_json::Value {
    let mut pts = Vec::new();
    let steps = 60;
    for i in 0..=steps {
        let t = i as f64 / steps as f64;
        let x = 120.0 + t * 520.0;
        let y = 300.0 + (t * std::f64::consts::PI * 2.0).sin() * 120.0;
        let pressure = 0.35 + (t * std::f64::consts::PI).sin() * 0.45;
        pts.push(serde_json::json!({
            "x": x,
            "y": y,
            "pressure": pressure,
            "altitudeAngle": 1.57,
            "azimuthAngle": 0.0,
            "pointerType": "pen"
        }));
    }
    serde_json::Value::Array(pts)
}

fn generate_fast_flick_stroke() -> serde_json::Value {
    let mut pts = Vec::new();
    let steps = 25;
    for i in 0..=steps {
        let t = i as f64 / steps as f64;
        let ease_t = t * t; // rapid acceleration
        let x = 200.0 + ease_t * 400.0;
        let y = 400.0 - ease_t * 220.0;
        let pressure = (1.0 - t * 0.90) * 0.70;
        pts.push(serde_json::json!({
            "x": x,
            "y": y,
            "pressure": pressure,
            "altitudeAngle": 1.50,
            "azimuthAngle": 0.0,
            "pointerType": "pen"
        }));
    }
    serde_json::Value::Array(pts)
}

fn generate_hatching_stroke() -> serde_json::Value {
    let mut pts = Vec::new();
    for line in 0..6 {
        let y_base = 180.0 + (line as f64) * 40.0;
        for i in 0..=20 {
            let t = i as f64 / 20.0;
            pts.push(serde_json::json!({
                "x": 200.0 + t * 350.0,
                "y": y_base + t * 20.0,
                "pressure": 0.35,
                "altitudeAngle": 0.25,
                "azimuthAngle": 0.0,
                "pointerType": "pen"
            }));
        }
    }
    serde_json::Value::Array(pts)
}
