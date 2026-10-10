use rusqlite::{Connection, Result, params};
use std::path::Path;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct User {
    pub id: String,
    pub username: String,
    pub created_at: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct SketchMeta {
    pub id: i64,
    pub user_id: Option<String>,
    pub timer_duration_sec: i64,
    pub created_at: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct DebugStrokeMeta {
    pub id: String,
    pub label: Option<String>,
    pub created_at: String,
    pub point_count: i64,
    pub metadata_json: String,
    pub has_image: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct DebugStrokeDetail {
    pub id: String,
    pub label: Option<String>,
    pub created_at: String,
    pub point_count: i64,
    pub points_json: String,
    pub metadata_json: String,
    pub has_image: bool,
}

impl Db {
    pub fn init<P: AsRef<Path>>(path: P) -> Result<Self> {
        let parent = path.as_ref().parent();
        if let Some(p) = parent
            && !p.as_os_str().is_empty()
        {
            let _ = std::fs::create_dir_all(p);
        }

        let conn = Connection::open(path)?;

        // Pragmas for performance
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;

        // Tables
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS passkeys (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                credential_id TEXT NOT NULL,
                passkey_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS auth_challenges (
                challenge_id TEXT PRIMARY KEY,
                challenge_data TEXT NOT NULL,
                user_id TEXT,
                expires_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS sketches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT,
                timer_duration_sec INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                image_data BLOB NOT NULL,
                thumbnail_data BLOB NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS debug_strokes (
                id TEXT PRIMARY KEY,
                label TEXT,
                created_at TEXT NOT NULL,
                point_count INTEGER NOT NULL,
                points_json TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                image_data BLOB,
                thumbnail_data BLOB
            );",
        )?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    // --- User management ---
    pub fn get_or_create_user(&self, username: &str) -> Result<User> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT id, username, created_at FROM users WHERE username = ?1")?;
        let mut rows = stmt.query(params![username])?;

        if let Some(row) = rows.next()? {
            return Ok(User {
                id: row.get(0)?,
                username: row.get(1)?,
                created_at: row.get(2)?,
            });
        }

        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono_now();
        conn.execute(
            "INSERT INTO users (id, username, created_at) VALUES (?1, ?2, ?3)",
            params![&id, username, &now],
        )?;

        Ok(User {
            id,
            username: username.to_string(),
            created_at: now,
        })
    }

    pub fn get_user_by_id(&self, user_id: &str) -> Result<Option<User>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, username, created_at FROM users WHERE id = ?1")?;
        let mut rows = stmt.query(params![user_id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(User {
                id: row.get(0)?,
                username: row.get(1)?,
                created_at: row.get(2)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// Read-only lookup by username. HTTP handlers must use this instead of
    /// `get_or_create_user`: accounts are provisioned via CLI, never from
    /// the network (otherwise anyone could squat usernames).
    pub fn get_user_by_username(&self, username: &str) -> Result<Option<User>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT id, username, created_at FROM users WHERE username = ?1")?;
        let mut rows = stmt.query(params![username])?;
        if let Some(row) = rows.next()? {
            Ok(Some(User {
                id: row.get(0)?,
                username: row.get(1)?,
                created_at: row.get(2)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn list_users(&self) -> Result<Vec<(User, usize)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT u.id, u.username, u.created_at, COUNT(p.id)
             FROM users u
             LEFT JOIN passkeys p ON u.id = p.user_id
             GROUP BY u.id
             ORDER BY u.created_at DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            let user = User {
                id: row.get(0)?,
                username: row.get(1)?,
                created_at: row.get(2)?,
            };
            let count: i64 = row.get(3)?;
            Ok((user, count as usize))
        })?;

        let mut res = Vec::new();
        for r in rows {
            res.push(r?);
        }
        Ok(res)
    }

    // --- Passkey reset (CLI) ---
    pub fn reset_passkeys_for_user(&self, username: &str) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM users WHERE username = ?1")?;
        let mut rows = stmt.query(params![username])?;

        if let Some(row) = rows.next()? {
            let user_id: String = row.get(0)?;
            let deleted =
                conn.execute("DELETE FROM passkeys WHERE user_id = ?1", params![user_id])?;
            // Also invalidate any sessions for this user
            let _ = conn.execute("DELETE FROM sessions WHERE user_id = ?1", params![user_id]);
            Ok(deleted)
        } else {
            Err(rusqlite::Error::QueryReturnedNoRows)
        }
    }

    // --- Passkeys ---
    pub fn save_passkey(&self, user_id: &str, cred_id: &str, passkey_json: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono_now();
        conn.execute(
            "INSERT INTO passkeys (id, user_id, credential_id, passkey_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, user_id, cred_id, passkey_json, now],
        )?;
        Ok(())
    }

    pub fn get_passkeys_for_user(&self, user_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT passkey_json FROM passkeys WHERE user_id = ?1")?;
        let rows = stmt.query_map(params![user_id], |row| row.get(0))?;
        let mut res = Vec::new();
        for r in rows {
            res.push(r?);
        }
        Ok(res)
    }

    pub fn find_user_by_credential_id(&self, cred_id: &str) -> Result<Option<(User, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT u.id, u.username, u.created_at, p.passkey_json
             FROM users u
             JOIN passkeys p ON u.id = p.user_id
             WHERE p.credential_id = ?1",
        )?;
        let mut rows = stmt.query(params![cred_id])?;
        if let Some(row) = rows.next()? {
            let user = User {
                id: row.get(0)?,
                username: row.get(1)?,
                created_at: row.get(2)?,
            };
            let passkey_json: String = row.get(3)?;
            Ok(Some((user, passkey_json)))
        } else {
            Ok(None)
        }
    }

    // --- Challenges ---
    pub fn save_challenge(
        &self,
        challenge_id: &str,
        challenge_data: &str,
        user_id: Option<&str>,
        expires_at: i64,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO auth_challenges (challenge_id, challenge_data, user_id, expires_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![challenge_id, challenge_data, user_id, expires_at],
        )?;
        Ok(())
    }

    pub fn get_and_delete_challenge(
        &self,
        challenge_id: &str,
    ) -> Result<Option<(String, Option<String>)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT challenge_data, user_id, expires_at FROM auth_challenges WHERE challenge_id = ?1",
        )?;
        let mut rows = stmt.query(params![challenge_id])?;
        if let Some(row) = rows.next()? {
            let data: String = row.get(0)?;
            let user_id: Option<String> = row.get(1)?;
            let expires_at: i64 = row.get(2)?;
            let _ = conn.execute(
                "DELETE FROM auth_challenges WHERE challenge_id = ?1",
                params![challenge_id],
            );

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64;

            if now <= expires_at {
                Ok(Some((data, user_id)))
            } else {
                Ok(None) // expired
            }
        } else {
            Ok(None)
        }
    }

    // --- Sessions ---
    pub fn create_session(&self, user_id: &str, ttl_secs: u64) -> Result<String> {
        let conn = self.conn.lock().unwrap();
        let token = uuid::Uuid::new_v4().to_string();
        let expires_at = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + ttl_secs) as i64;

        conn.execute(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES (?1, ?2, ?3)",
            params![token, user_id, expires_at],
        )?;
        Ok(token)
    }

    pub fn get_session_user(&self, token: &str) -> Result<Option<User>> {
        let conn = self.conn.lock().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let mut stmt = conn.prepare(
            "SELECT u.id, u.username, u.created_at
             FROM users u
             JOIN sessions s ON u.id = s.user_id
             WHERE s.token = ?1 AND s.expires_at > ?2",
        )?;
        let mut rows = stmt.query(params![token, now])?;
        if let Some(row) = rows.next()? {
            Ok(Some(User {
                id: row.get(0)?,
                username: row.get(1)?,
                created_at: row.get(2)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn delete_session(&self, token: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE token = ?1", params![token])?;
        Ok(())
    }

    // --- Sketches ---
    pub fn save_sketch(
        &self,
        user_id: Option<&str>,
        timer_duration_sec: i64,
        created_at: &str,
        image_data: &[u8],
        thumbnail_data: &[u8],
    ) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sketches (user_id, timer_duration_sec, created_at, image_data, thumbnail_data)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![user_id, timer_duration_sec, created_at, image_data, thumbnail_data],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn list_sketches(&self, user_id: Option<&str>) -> Result<Vec<SketchMeta>> {
        let conn = self.conn.lock().unwrap();
        let mut res = Vec::new();
        if let Some(uid) = user_id {
            let mut stmt = conn.prepare("SELECT id, user_id, timer_duration_sec, created_at FROM sketches WHERE user_id = ?1 ORDER BY created_at DESC")?;
            let mut rows = stmt.query(params![uid])?;
            while let Some(row) = rows.next()? {
                res.push(SketchMeta {
                    id: row.get(0)?,
                    user_id: row.get(1)?,
                    timer_duration_sec: row.get(2)?,
                    created_at: row.get(3)?,
                });
            }
        } else {
            let mut stmt = conn.prepare("SELECT id, user_id, timer_duration_sec, created_at FROM sketches ORDER BY created_at DESC")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                res.push(SketchMeta {
                    id: row.get(0)?,
                    user_id: row.get(1)?,
                    timer_duration_sec: row.get(2)?,
                    created_at: row.get(3)?,
                });
            }
        }
        Ok(res)
    }

    pub fn get_sketch_image(&self, id: i64) -> Result<Option<Vec<u8>>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT image_data FROM sketches WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn get_sketch_thumbnail(&self, id: i64) -> Result<Option<Vec<u8>>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT thumbnail_data FROM sketches WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn delete_sketch(&self, id: i64) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let deleted = conn.execute("DELETE FROM sketches WHERE id = ?1", params![id])?;
        Ok(deleted > 0)
    }

    /// Existing sketch id for (user, created_at), for idempotent re-uploads.
    pub fn find_sketch_by_time(&self, user_id: &str, created_at: &str) -> Result<Option<i64>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT id FROM sketches WHERE user_id = ?1 AND created_at = ?2 LIMIT 1")?;
        let mut rows = stmt.query(params![user_id, created_at])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    /// Owner of a sketch for authorization checks.
    /// `Ok(None)` = no such sketch; `Ok(Some(uid))` with `uid == None` =
    /// legacy anonymous row (created before login was required).
    pub fn get_sketch_owner(&self, id: i64) -> Result<Option<Option<String>>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT user_id FROM sketches WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    // --- Debug Strokes ---
    pub fn save_debug_stroke(
        &self,
        id: &str,
        label: Option<&str>,
        created_at: &str,
        point_count: i64,
        points_json: &str,
        metadata_json: &str,
        image_data: Option<&[u8]>,
        thumbnail_data: Option<&[u8]>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO debug_strokes (
                id, label, created_at, point_count, points_json, metadata_json, image_data, thumbnail_data
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                label,
                created_at,
                point_count,
                points_json,
                metadata_json,
                image_data,
                thumbnail_data,
            ],
        )?;
        Ok(())
    }

    pub fn list_debug_strokes(&self, limit: usize) -> Result<Vec<DebugStrokeMeta>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, label, created_at, point_count, metadata_json, (image_data IS NOT NULL) AS has_image
             FROM debug_strokes
             ORDER BY created_at DESC
             LIMIT ?1",
        )?;
        let mut rows = stmt.query(params![limit as i64])?;
        let mut res = Vec::new();
        while let Some(row) = rows.next()? {
            res.push(DebugStrokeMeta {
                id: row.get(0)?,
                label: row.get(1)?,
                created_at: row.get(2)?,
                point_count: row.get(3)?,
                metadata_json: row.get(4)?,
                has_image: row.get::<_, i64>(5)? != 0,
            });
        }
        Ok(res)
    }

    pub fn get_debug_stroke(&self, id: &str) -> Result<Option<DebugStrokeDetail>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, label, created_at, point_count, points_json, metadata_json, (image_data IS NOT NULL) AS has_image
             FROM debug_strokes
             WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(DebugStrokeDetail {
                id: row.get(0)?,
                label: row.get(1)?,
                created_at: row.get(2)?,
                point_count: row.get(3)?,
                points_json: row.get(4)?,
                metadata_json: row.get(5)?,
                has_image: row.get::<_, i64>(6)? != 0,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn get_latest_debug_stroke(&self) -> Result<Option<DebugStrokeDetail>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, label, created_at, point_count, points_json, metadata_json, (image_data IS NOT NULL) AS has_image
             FROM debug_strokes
             ORDER BY created_at DESC
             LIMIT 1",
        )?;
        let mut rows = stmt.query([])?;
        if let Some(row) = rows.next()? {
            Ok(Some(DebugStrokeDetail {
                id: row.get(0)?,
                label: row.get(1)?,
                created_at: row.get(2)?,
                point_count: row.get(3)?,
                points_json: row.get(4)?,
                metadata_json: row.get(5)?,
                has_image: row.get::<_, i64>(6)? != 0,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn get_debug_stroke_image(&self, id: &str) -> Result<Option<Vec<u8>>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT image_data FROM debug_strokes WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(row.get(0)?)
        } else {
            Ok(None)
        }
    }

    pub fn clear_debug_strokes(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let count = conn.execute("DELETE FROM debug_strokes", [])?;
        Ok(count)
    }
}

pub fn chrono_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    // Return standard ISO format
    chrono_from_secs(now)
}

fn chrono_from_secs(secs: u64) -> String {
    let days = secs / 86400;
    let rem_secs = secs % 86400;
    let hours = rem_secs / 3600;
    let mins = (rem_secs % 3600) / 60;
    let s = rem_secs % 60;

    // Approximate date for human readability
    let mut year = 1970;
    let mut d = days;
    loop {
        let leap = if (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0) {
            1
        } else {
            0
        };
        let days_in_year = 365 + leap;
        if d >= days_in_year {
            d -= days_in_year;
            year += 1;
        } else {
            break;
        }
    }
    let leap = if (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0) {
        1
    } else {
        0
    };
    let month_days = [31, 28 + leap, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1;
    for &md in &month_days {
        if d >= md {
            d -= md;
            month += 1;
        } else {
            break;
        }
    }
    let day = d + 1;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, mins, s
    )
}
