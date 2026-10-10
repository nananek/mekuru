mod auth;
mod db;
mod debug;
mod sketch;

use clap::{Parser, Subcommand};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use url::Url;
use webauthn_rs::WebauthnBuilder;

#[derive(Parser)]
#[command(name = "mekuru", about = "Mekuru Croquis PWA & Backend Server")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[arg(short, long, default_value = "3000", env = "PORT")]
    port: u16,

    #[arg(long, default_value = "0.0.0.0", env = "HOST")]
    host: String,

    #[arg(long, default_value = "./data/mekuru.db", env = "DATABASE_URL")]
    db: PathBuf,

    #[arg(long, default_value = "./dist", env = "STATIC_DIR")]
    static_dir: PathBuf,

    #[arg(long, default_value = "localhost", env = "RP_ID")]
    rp_id: String,

    #[arg(long, default_value = "http://localhost:3000", env = "RP_ORIGIN")]
    rp_origin: String,
}

#[derive(Subcommand)]
enum Commands {
    /// Starts the HTTP server (default)
    Serve {
        #[arg(short, long)]
        port: Option<u16>,
    },
    /// Resets all registered passkeys for a user via CLI
    ResetPasskey { username: String },
    /// Lists all registered users and their passkey counts
    ListUsers,
    /// Creates a user account in database
    CreateUser { username: String },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    let db_path = &cli.db;
    let database = db::Db::init(db_path)?;

    match cli.command {
        Some(Commands::ResetPasskey { username }) => {
            match database.reset_passkeys_for_user(&username) {
                Ok(count) => {
                    println!(
                        "ユーザー '{}' のパスキーをリセットしました（削除数: {}）。新しいパスキーを登録できます。",
                        username, count
                    );
                }
                Err(rusqlite::Error::QueryReturnedNoRows) => {
                    eprintln!("エラー: ユーザー '{}' が見つかりませんでした。", username);
                    std::process::exit(1);
                }
                Err(e) => {
                    eprintln!("エラー: パスキーのリセットに失敗しました: {}", e);
                    std::process::exit(1);
                }
            }
            return Ok(());
        }
        Some(Commands::ListUsers) => {
            let users = database.list_users()?;
            println!(
                "{:<36} {:<20} {:<10} {:<24}",
                "ID", "USERNAME", "PASSKEYS", "CREATED AT"
            );
            println!("{}", "-".repeat(95));
            for (u, pk_count) in users {
                println!(
                    "{:<36} {:<20} {:<10} {:<24}",
                    u.id, u.username, pk_count, u.created_at
                );
            }
            return Ok(());
        }
        Some(Commands::CreateUser { username }) => {
            let user = database.get_or_create_user(&username)?;
            println!(
                "ユーザーを作成しました: ID={}, Username={}",
                user.id, user.username
            );
            return Ok(());
        }
        Some(Commands::Serve { port }) => {
            let final_port = port.unwrap_or(cli.port);
            run_server(
                database,
                &cli.host,
                final_port,
                cli.static_dir,
                &cli.rp_id,
                &cli.rp_origin,
            )
            .await?;
        }
        None => {
            run_server(
                database,
                &cli.host,
                cli.port,
                cli.static_dir,
                &cli.rp_id,
                &cli.rp_origin,
            )
            .await?;
        }
    }

    Ok(())
}

async fn run_server(
    db: db::Db,
    host: &str,
    port: u16,
    static_dir: PathBuf,
    rp_id: &str,
    rp_origin: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let origin_url = Url::parse(rp_origin)?;
    let webauthn = WebauthnBuilder::new(rp_id, &origin_url)?
        .rp_name("Mekuru")
        .build()?;
    let webauthn = Arc::new(webauthn);

    let auth_state = auth::AuthState {
        db: db.clone(),
        webauthn,
    };

    let sketch_state = sketch::SketchState { db: db.clone() };

    let auth_router = axum::Router::new()
        .route("/register-start", axum::routing::post(auth::register_start))
        .route(
            "/register-finish",
            axum::routing::post(auth::register_finish),
        )
        .route("/login-start", axum::routing::post(auth::login_start))
        .route("/login-finish", axum::routing::post(auth::login_finish))
        .route("/me", axum::routing::get(auth::auth_me))
        .route("/logout", axum::routing::post(auth::auth_logout))
        .with_state(auth_state);

    let sketch_router = axum::Router::new()
        .route("/", axum::routing::get(sketch::list_sketches))
        .route("/", axum::routing::post(sketch::upload_sketch))
        .route("/{id}/image", axum::routing::get(sketch::get_sketch_image))
        .route(
            "/{id}/thumbnail",
            axum::routing::get(sketch::get_sketch_thumbnail),
        )
        .route("/{id}", axum::routing::delete(sketch::delete_sketch))
        .with_state(sketch_state);

    let debug_state = debug::DebugState::new(db.clone());
    let debug_router = axum::Router::new()
        .route(
            "/strokes",
            axum::routing::get(debug::list_debug_strokes)
                .post(debug::save_debug_stroke_json)
                .delete(debug::clear_debug_strokes),
        )
        .route(
            "/strokes/upload",
            axum::routing::post(debug::save_debug_stroke_multipart),
        )
        .route(
            "/strokes/latest",
            axum::routing::get(debug::get_latest_debug_stroke),
        )
        .route("/strokes/{id}", axum::routing::get(debug::get_debug_stroke))
        .route(
            "/strokes/{id}/image",
            axum::routing::get(debug::get_debug_stroke_image),
        )
        .route("/presets", axum::routing::get(debug::get_debug_presets))
        .route("/render", axum::routing::post(debug::render_stroke))
        .route("/bridge/poll", axum::routing::get(debug::bridge_poll))
        .route(
            "/bridge/response",
            axum::routing::post(debug::bridge_response),
        )
        .route("/status", axum::routing::get(debug::debug_status))
        .with_state(debug_state);

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let api_router = axum::Router::new()
        .nest("/auth", auth_router)
        .nest("/sketches", sketch_router)
        .nest("/debug", debug_router)
        .layer(cors);

    // Static SPA file serving
    let index_file = static_dir.join("index.html");
    let serve_dir = ServeDir::new(&static_dir).fallback(ServeFile::new(index_file));

    let app = axum::Router::new()
        .nest("/api", api_router)
        .fallback_service(serve_dir);

    let addr: SocketAddr = format!("{}:{}", host, port).parse()?;
    println!("Mekuru サーバーを起動しました: http://{}", addr);
    println!("WebAuthn RP ID: {}, RP Origin: {}", rp_id, rp_origin);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
