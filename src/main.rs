use axum::{
    Json, Router,
    extract::{
        Path, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse},
    routing::{get, post},
};
use futures_util::StreamExt;
use jsonwebtoken::{EncodingKey, Header, encode};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

type App = Arc<Server>;
struct Server {
    inner: Mutex<Inner>,
    sfu: Sfu,
    origin: String,
}
struct Inner {
    db: Connection,
    leases: HashMap<String, HashMap<String, String>>,
}
struct Sfu {
    api: String,
    public: String,
    key: String,
    secret: String,
    http: reqwest::Client,
}
#[derive(Clone, Debug)]
struct Broadcast {
    id: String,
    owner: String,
    generation: i64,
    ended: bool,
}
impl Broadcast {
    fn room(&self) -> String {
        format!("{}-{}", self.id, self.generation)
    }
}
fn secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn database(path: &str) -> rusqlite::Result<Connection> {
    let db = Connection::open(path)?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS broadcasts(id TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, ended INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS cleanup(room TEXT PRIMARY KEY);")?;
    Ok(db)
}
fn load(db: &Connection, id: &str) -> rusqlite::Result<Option<Broadcast>> {
    db.query_row(
        "SELECT id,owner,generation,ended FROM broadcasts WHERE id=?",
        [id],
        |r| {
            Ok(Broadcast {
                id: r.get(0)?,
                owner: r.get(1)?,
                generation: r.get(2)?,
                ended: r.get(3)?,
            })
        },
    )
    .optional()
}
fn reserve(
    leases: &mut HashMap<String, String>,
    owner: bool,
    session: &str,
) -> Result<String, &'static str> {
    let identity = if owner {
        if leases.contains_key("presenter") {
            return Err("Presenter already open in another window. Close it and retry.");
        }
        "presenter".into()
    } else {
        (0..10)
            .map(|n| format!("viewer-{n}"))
            .find(|id| !leases.contains_key(id))
            .ok_or("Broadcast is full (10 viewers). Retrying…")?
    };
    leases.insert(identity.clone(), session.into());
    Ok(identity)
}
impl Sfu {
    fn token(&self, identity: &str, grant: Value) -> String {
        encode(
            &Header::default(),
            &json!({"iss":self.key,"sub":identity,"nbf":now()-5,"exp":now()+60,"video":grant}),
            &EncodingKey::from_secret(self.secret.as_bytes()),
        )
        .expect("JWT encoding")
    }
    fn join_token(&self, b: &Broadcast, identity: &str) -> String {
        let publisher = identity == "presenter";
        self.token(identity, json!({"roomJoin":true,"room":b.room(),"canPublish":publisher,"canSubscribe":!publisher,"canPublishData":false,"canUpdateOwnMetadata":false,"canPublishSources":if publisher { vec!["screen_share", "screen_share_audio"] } else { vec![] }}))
    }
    async fn rpc(&self, method: &str, room: &str, body: Value) -> Result<Value, String> {
        let token = self.token(
            "app",
            json!({"roomCreate":true,"roomAdmin":true,"room":room}),
        );
        let response = self
            .http
            .post(format!("{}/twirp/livekit.RoomService/{method}", self.api))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|e| e.to_string())?;
        if status.is_success() || value["code"] == "not_found" {
            Ok(value)
        } else {
            Err(format!("SFU {method}: {status}"))
        }
    }
    async fn join(&self, b: &Broadcast, identity: &str) -> Result<Value, String> {
        self.rpc("CreateRoom", &b.room(), json!({"name":b.room(),"max_participants":11,"min_playout_delay":0,"max_playout_delay":100})).await?;
        Ok(
            json!({"type":"media","generation":b.generation,"url":self.public,"token":self.join_token(b,identity)}),
        )
    }
}
async fn create(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, StatusCode> {
    if headers.get("origin").and_then(|v| v.to_str().ok()) != Some(&app.origin) {
        return Err(StatusCode::FORBIDDEN);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let owner = secret();
    app.inner
        .lock()
        .await
        .db
        .execute(
            "INSERT INTO broadcasts(id,owner) VALUES (?,?)",
            params![id, hash(&owner)],
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(
        json!({"id":id,"owner":owner,"watchUrl":format!("{}/watch/{id}",app.origin)}),
    ))
}
async fn upgrade(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> axum::response::Response {
    if headers.get("origin").and_then(|v| v.to_str().ok()) != Some(&app.origin) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if uuid::Uuid::parse_str(&id).is_err() {
        return StatusCode::NOT_FOUND.into_response();
    }
    ws.max_message_size(4096)
        .max_frame_size(4096)
        .on_upgrade(move |socket| session(socket, app, id))
}
async fn send(socket: &mut WebSocket, value: Value) -> bool {
    matches!(
        tokio::time::timeout(
            Duration::from_secs(5),
            socket.send(Message::Text(value.to_string().into()))
        )
        .await,
        Ok(Ok(()))
    )
}
async fn session(mut socket: WebSocket, app: App, id: String) {
    let Some(Ok(Message::Text(hello))) =
        tokio::time::timeout(Duration::from_secs(10), socket.next())
            .await
            .ok()
            .flatten()
    else {
        return;
    };
    let Ok(hello) = serde_json::from_str::<Value>(&hello) else {
        return;
    };
    let session = secret();
    let identity = {
        let mut inner = app.inner.lock().await;
        let Ok(Some(b)) = load(&inner.db, &id) else {
            send(&mut socket, json!({"type":"unavailable"})).await;
            return;
        };
        let owner = hello.get("owner").and_then(Value::as_str);
        if owner.is_some_and(|s| hash(s) != b.owner) {
            send(&mut socket, json!({"type":"unauthorized"})).await;
            return;
        }
        match reserve(
            inner.leases.entry(id.clone()).or_default(),
            owner.is_some(),
            &session,
        ) {
            Ok(identity) => identity,
            Err(message) => {
                send(&mut socket, json!({"type":"capacity","message":message})).await;
                return;
            }
        }
    };
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    let mut last_message = tokio::time::Instant::now();
    let mut media_room: Option<String> = None;
    loop {
        let command = tokio::select! {
            _ = tick.tick() => {
                if last_message.elapsed() > Duration::from_secs(35) { break; }
                let inner = app.inner.lock().await;
                let Ok(Some(b)) = load(&inner.db,&id) else { break; };
                if !send(&mut socket,json!({"type":"state","ended":b.ended,"generation":b.generation})).await { break; }
                continue;
            }
            msg = socket.next() => match msg {
                Some(Ok(Message::Text(text))) => { last_message = tokio::time::Instant::now(); serde_json::from_str::<Value>(&text).unwrap_or(Value::Null) },
                Some(Ok(Message::Pong(_) | Message::Ping(_))) => { last_message = tokio::time::Instant::now(); continue; },
                _ => break,
            }
        };
        let mut inner = app.inner.lock().await;
        let Ok(Some(mut b)) = load(&inner.db, &id) else {
            break;
        };
        let result: Result<Value, String> = async {
            match command["type"].as_str().unwrap_or("") {
                "ping" => Ok(json!({"type":"pong"})),
                "start" if identity == "presenter" => {
                    if b.ended {
                        inner
                            .db
                            .execute(
                                "UPDATE broadcasts SET ended=0,generation=generation+1 WHERE id=?",
                                [&id],
                            )
                            .map_err(|e| e.to_string())?;
                        b.ended = false;
                        b.generation += 1;
                    }
                    media_room = Some(b.room());
                    app.sfu.join(&b, &identity).await
                }
                "connect" if identity != "presenter" && !b.ended => {
                    media_room = Some(b.room());
                    app.sfu.join(&b, &identity).await
                }
                "stop" if identity == "presenter" => {
                    {
                        let tx = inner.db.transaction().map_err(|e| e.to_string())?;
                        tx.execute("UPDATE broadcasts SET ended=1 WHERE id=?", [&id])
                            .map_err(|e| e.to_string())?;
                        tx.execute("INSERT OR IGNORE INTO cleanup(room) VALUES (?)", [b.room()])
                            .map_err(|e| e.to_string())?;
                        tx.commit().map_err(|e| e.to_string())?;
                    }
                    // Durable cleanup is retried even if the SFU is temporarily offline.
                    let _ = app
                        .sfu
                        .rpc("DeleteRoom", &b.room(), json!({"room":b.room()}))
                        .await;
                    Ok(json!({"type":"stopped"}))
                }
                _ => Ok(json!({"type":"state","ended":b.ended,"generation":b.generation})),
            }
        }
        .await;
        let reply = result.unwrap_or_else(|e| {
            eprintln!("{e}");
            json!({"type":"error","message":"Media server unavailable. Reconnecting…"})
        });
        if !send(&mut socket, reply).await {
            break;
        }
    }
    // Keep the slot reserved until the old media participant has been removed.
    let mut inner = app.inner.lock().await;
    if let Some(room) = media_room {
        let _ = app
            .sfu
            .rpc(
                "RemoveParticipant",
                &room,
                json!({"room":room,"identity":identity}),
            )
            .await;
    }
    if let Some(leases) = inner.leases.get_mut(&id) {
        if leases.get(&identity) == Some(&session) {
            leases.remove(&identity);
        }
        if leases.is_empty() {
            inner.leases.remove(&id);
        }
    }
}
async fn cleanup(app: App) {
    loop {
        tokio::time::sleep(Duration::from_secs(10)).await;
        let rooms: Vec<String> = {
            let inner = app.inner.lock().await;
            inner
                .db
                .prepare("SELECT room FROM cleanup")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .filter_map(Result::ok)
                .collect()
        };
        for room in rooms {
            // Self-hosted LiveKit does not revoke already issued JWTs on removal.
            // Retain stopped-generation tombstones, including across app restarts.
            let _ = app.sfu.rpc("DeleteRoom", &room, json!({"room":room})).await;
        }
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let env = |key: &str, default: &str| std::env::var(key).unwrap_or_else(|_| default.into());
    let secret = std::env::var("LIVEKIT_API_SECRET").map_err(|_| "Set LIVEKIT_API_SECRET")?;
    if secret.len() < 32 {
        return Err("LIVEKIT_API_SECRET must contain at least 32 characters".into());
    }
    let app = Arc::new(Server {
        inner: Mutex::new(Inner {
            db: database(&env("DATABASE_PATH", "broadcasts.db"))?,
            leases: HashMap::new(),
        }),
        origin: env("PUBLIC_ORIGIN", "http://localhost:8787")
            .trim_end_matches('/')
            .into(),
        sfu: Sfu {
            api: env("LIVEKIT_API_URL", "http://localhost:7880"),
            public: env("LIVEKIT_PUBLIC_URL", "ws://localhost:7880"),
            key: env("LIVEKIT_API_KEY", "devkey"),
            secret,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()?,
        },
    });
    tokio::spawn(cleanup(app.clone()));
    let csp: axum::http::HeaderValue = format!("default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' {} {}; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'", app.sfu.public, app.sfu.public.replacen("ws", "http", 1)).parse()?;
    let router = Router::new()
        .route(
            "/",
            get(|| async { Html(include_str!("../web/index.html")) }),
        )
        .route(
            "/watch/{id}",
            get(|| async { Html(include_str!("../web/index.html")) }),
        )
        .route(
            "/app.js",
            get(|| async {
                (
                    [("content-type", "text/javascript")],
                    include_str!("../web/dist/app.js"),
                )
            }),
        )
        .route(
            "/style.css",
            get(|| async {
                (
                    [("content-type", "text/css")],
                    include_str!("../web/style.css"),
                )
            }),
        )
        .route("/health", get(|| async { "ok" }))
        .route("/api/broadcasts", post(create))
        .route("/ws/{id}", get(upgrade))
        .layer(axum::middleware::map_response(
            move |mut response: axum::response::Response| {
                let csp = csp.clone();
                async move {
                    let h = response.headers_mut();
                    h.insert("cache-control", "no-store".parse().unwrap());
                    h.insert("referrer-policy", "no-referrer".parse().unwrap());
                    h.insert("x-content-type-options", "nosniff".parse().unwrap());
                    h.insert(
                        "permissions-policy",
                        "microphone=(), camera=()".parse().unwrap(),
                    );
                    h.insert("content-security-policy", csp);
                    response
                }
            },
        ))
        .with_state(app);
    let bind = env("BIND", "127.0.0.1:8787");
    println!("Screen Share listening on {bind}");
    axum::serve(tokio::net::TcpListener::bind(bind).await?, router).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capacity_reserves_exactly_ten_viewers_and_one_presenter() {
        let mut leases = HashMap::new();
        for _ in 0..10 {
            assert!(reserve(&mut leases, false, "session").is_ok());
        }
        assert!(reserve(&mut leases, false, "eleven").is_err());
        assert_eq!(reserve(&mut leases, true, "owner").unwrap(), "presenter");
        assert!(reserve(&mut leases, true, "other").is_err());
        leases.remove("viewer-3");
        assert_eq!(
            reserve(&mut leases, false, "replacement").unwrap(),
            "viewer-3"
        );
    }
    #[test]
    fn ownership_and_end_state_survive_restart() {
        let path = std::env::temp_dir().join(format!("{}.db", secret()));
        {
            let db = database(path.to_str().unwrap()).unwrap();
            db.execute(
                "INSERT INTO broadcasts VALUES ('test',?,7,1)",
                [hash("private-owner")],
            )
            .unwrap();
        }
        {
            let db = database(path.to_str().unwrap()).unwrap();
            let b = load(&db, "test").unwrap().unwrap();
            assert!(b.ended);
            assert_eq!(b.generation, 7);
            assert_eq!(b.owner, hash("private-owner"));
            assert_ne!(b.owner, hash("test"));
            assert!(load(&db, "missing").unwrap().is_none());
        }
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn viewer_tokens_cannot_publish_or_administer() {
        use jsonwebtoken::{DecodingKey, Validation, decode};
        let sfu = Sfu {
            api: String::new(),
            public: String::new(),
            key: "test".into(),
            secret: secret(),
            http: reqwest::Client::new(),
        };
        let b = Broadcast {
            id: "test".into(),
            owner: hash("owner"),
            generation: 2,
            ended: false,
        };
        let token = sfu.join_token(&b, "viewer-0");
        let claims = decode::<Value>(
            &token,
            &DecodingKey::from_secret(sfu.secret.as_bytes()),
            &Validation::default(),
        )
        .unwrap()
        .claims;
        assert_eq!(claims["video"]["canPublish"], false);
        assert_eq!(claims["video"]["canSubscribe"], true);
        assert!(claims["video"].get("roomAdmin").is_none());
        assert_eq!(claims["video"]["room"], "test-2");
        let token = sfu.join_token(&b, "presenter");
        let claims = decode::<Value>(
            &token,
            &DecodingKey::from_secret(sfu.secret.as_bytes()),
            &Validation::default(),
        )
        .unwrap()
        .claims;
        assert_eq!(
            claims["video"]["canPublishSources"],
            json!(["screen_share", "screen_share_audio"])
        );
        assert_eq!(claims["video"]["canSubscribe"], false);
    }
}
