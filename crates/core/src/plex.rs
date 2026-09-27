use crate::{
    Playlist, Track,
    profile::{PlexConnection, Profile},
};
use anyhow::{Context, Result, bail, ensure};
use reqwest::blocking::{Client, RequestBuilder, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::Read,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use url::Url;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub name: String,
    pub client_identifier: String,
    #[serde(default)]
    access_token: Option<String>,
    provides: String,
    connections: Vec<Endpoint>,
}
#[derive(Clone, Deserialize)]
struct Endpoint {
    uri: String,
    local: bool,
    relay: bool,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Library {
    pub key: String,
    pub title: String,
    #[serde(rename = "type")]
    kind: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct PlaylistSummary {
    pub id: String,
    pub title: String,
    pub track_count: u64,
    pub duration_seconds: u64,
}

// Account tokens and setup links are never serializable or included in errors.
pub struct Login {
    account_token: String,
    user_id: String,
    pub servers: Vec<Server>,
}
pub struct ServerChoice {
    pub server: Server,
    pub libraries: Vec<Library>,
    uri: String,
}

#[derive(Clone)]
pub struct Plex {
    http: Client,
    client_id: String,
    origin: Url,
}

fn bad_response() -> anyhow::Error {
    anyhow::anyhow!("Plex returned an invalid response")
}
fn text(v: &Value, key: &str) -> Result<String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(bad_response)
}
fn key(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._~-".contains(&b)),
        "Invalid Plex item identifier"
    );
    Ok(())
}
fn origin(value: &str) -> Result<Url> {
    let u = Url::parse(value).map_err(|_| bad_response())?;
    ensure!(
        ["https", "http"].contains(&u.scheme())
            && u.username().is_empty()
            && u.password().is_none()
            && u.query().is_none()
            && u.fragment().is_none()
            && u.path() == "/",
        "Invalid Plex server address"
    );
    Ok(u)
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    ensure!(!cancel.load(Ordering::Relaxed), "Operation cancelled");
    Ok(())
}

impl Plex {
    pub fn new(profile: &Profile) -> Result<Self> {
        Ok(Self {
            http: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(20))
                .build()?,
            client_id: profile.client_id()?,
            origin: Url::parse("https://plex.tv")?,
        })
    }
    fn request(&self, method: reqwest::Method, url: Url, token: Option<&str>) -> RequestBuilder {
        let r = self
            .http
            .request(method, url)
            .header("Accept", "application/json")
            .header("X-Plex-Product", "SyncAndRun")
            .header("X-Plex-Version", env!("CARGO_PKG_VERSION"))
            .header("X-Plex-Client-Identifier", &self.client_id);
        if let Some(token) = token {
            r.header("X-Plex-Token", token)
        } else {
            r
        }
    }
    fn json(&self, request: RequestBuilder) -> Result<Value> {
        let response = request
            .send()
            .map_err(|_| anyhow::anyhow!("Cannot reach Plex"))?;
        ensure!(
            response.status().is_success(),
            "Plex request failed (HTTP {})",
            response.status().as_u16()
        );
        let mut bytes = Vec::new();
        response
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| bad_response())?;
        ensure!(
            bytes.len() <= 16 * 1024 * 1024,
            "Plex response is too large"
        );
        serde_json::from_slice(&bytes).map_err(|_| bad_response())
    }
    fn get(&self, url: Url, token: &str) -> Result<Value> {
        self.json(self.request(reqwest::Method::GET, url, Some(token)))
    }
    fn user(&self, token: &str) -> Result<String> {
        let user = self.get(self.origin.join("/api/v2/user")?, token)?;
        match &user["id"] {
            Value::String(s) if !s.is_empty() => Ok(s.clone()),
            Value::Number(n) => Ok(n.to_string()),
            _ => Err(bad_response()),
        }
    }
    pub fn login(
        &self,
        profile: &Profile,
        cancel: &AtomicBool,
        open_browser: impl FnOnce(&str) -> Result<()>,
    ) -> Result<Login> {
        let mut url = self.origin.join("/api/v2/pins")?;
        url.query_pairs_mut().append_pair("strong", "true");
        let pin = self.json(self.request(reqwest::Method::POST, url, None))?;
        let id = pin["id"].as_u64().context("Invalid Plex PIN")?;
        let code = text(&pin, "code")?;
        ensure!(
            text(&pin, "clientIdentifier")? == self.client_id,
            "Plex PIN client mismatch"
        );
        let seconds = pin["expiresIn"].as_u64().unwrap_or(300).min(600);
        let mut auth = Url::parse("https://app.plex.tv/auth")?;
        let params = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("clientID", &self.client_id)
            .append_pair("code", &code)
            .append_pair("context[device][product]", "SyncAndRun")
            .finish();
        auth.set_fragment(Some(&format!("?{params}")));
        open_browser(auth.as_str())?;
        let deadline = Instant::now() + Duration::from_secs(seconds);
        let token = loop {
            cancelled(cancel)?;
            ensure!(Instant::now() < deadline, "Plex sign-in expired; try again");
            let mut url = self.origin.join(&format!("/api/v2/pins/{id}"))?;
            url.query_pairs_mut().append_pair("code", &code);
            let response = self.json(self.request(reqwest::Method::GET, url, None))?;
            ensure!(
                response["id"].as_u64() == Some(id)
                    && text(&response, "code")? == code
                    && text(&response, "clientIdentifier")? == self.client_id,
                "Plex PIN mismatch"
            );
            if let Some(token) = response["authToken"].as_str().filter(|s| !s.is_empty()) {
                break token.to_owned();
            }
            for _ in 0..10 {
                cancelled(cancel)?;
                std::thread::sleep(Duration::from_millis(200));
            }
        };
        let user_id = self.user(&token)?;
        if let Some(owner) = profile.owner()? {
            ensure!(
                owner == user_id,
                "Sign in with the account that owns this profile"
            );
        } else if let Some(connection) = profile.connection()? {
            let previous = connection.account_token.as_deref().context("Legacy profile lacks an account credential; use its original app to establish ownership")?;
            ensure!(
                self.user(previous)? == user_id,
                "Sign in with the account that owns this profile"
            );
        }
        let mut url = self.origin.join("/api/v2/resources")?;
        url.query_pairs_mut().append_pair("includeHttps", "1");
        let mut servers: Vec<Server> =
            serde_json::from_value(self.get(url, &token)?).map_err(|_| bad_response())?;
        servers.retain(|s| {
            s.provides.split(',').any(|v| v == "server")
                && s.access_token.as_ref().is_some_and(|t| !t.is_empty())
        });
        ensure!(
            !servers.is_empty(),
            "No Plex servers are available to this account"
        );
        Ok(Login {
            account_token: token,
            user_id,
            servers,
        })
    }
    pub fn discover(&self, server: &Server, cancel: &AtomicBool) -> Result<ServerChoice> {
        let token = server
            .access_token
            .as_deref()
            .context("Plex server credential missing")?;
        let mut connections = server.connections.clone();
        connections.sort_by_key(|e| (e.relay, !e.local, !e.uri.starts_with("https:")));
        for endpoint in connections {
            cancelled(cancel)?;
            let Ok(url) = origin(&endpoint.uri) else {
                continue;
            };
            let Ok(identity) = self.get(url.join("/identity")?, token) else {
                continue;
            };
            if identity["MediaContainer"]["machineIdentifier"].as_str()
                != Some(&server.client_identifier)
                || identity["MediaContainer"]["claimed"].as_bool() != Some(true)
            {
                continue;
            }
            let data = self.get(url.join("/library/sections")?, token)?;
            let mut libraries: Vec<Library> =
                serde_json::from_value(data["MediaContainer"]["Directory"].clone())
                    .map_err(|_| bad_response())?;
            libraries.retain(|l| l.kind == "artist");
            return Ok(ServerChoice {
                server: server.clone(),
                libraries,
                uri: url.to_string(),
            });
        }
        bail!("Cannot reach the selected Plex server")
    }
    pub fn connect(
        &self,
        profile: &mut Profile,
        login: &Login,
        choice: &ServerChoice,
        library: &str,
    ) -> Result<()> {
        ensure!(
            login
                .servers
                .iter()
                .any(|s| s.client_identifier == choice.server.client_identifier),
            "Server was not discovered for this account"
        );
        ensure!(
            choice.libraries.iter().any(|l| l.key == library),
            "Choose an available music library"
        );
        profile.save_connection(
            &login.user_id,
            &PlexConnection {
                token: choice
                    .server
                    .access_token
                    .clone()
                    .context("Plex server credential missing")?,
                account_token: Some(login.account_token.clone()),
                server_id: choice.server.client_identifier.clone(),
                base_uri: choice.uri.clone(),
                library_id: library.to_owned(),
            },
        )
    }
    fn pages(&self, mut url: Url, token: &str, cancel: &AtomicBool) -> Result<Vec<Value>> {
        let mut items = Vec::new();
        url.set_fragment(None);
        loop {
            cancelled(cancel)?;
            let data = self.json(
                self.request(reqwest::Method::GET, url.clone(), Some(token))
                    .header("X-Plex-Container-Start", items.len())
                    .header("X-Plex-Container-Size", 100),
            )?;
            let page = &data["MediaContainer"];
            let batch = page["Metadata"].as_array().cloned().unwrap_or_default();
            let total = page["totalSize"].as_u64().ok_or_else(bad_response)? as usize;
            ensure!(
                page["offset"].as_u64().unwrap_or(0) as usize == items.len()
                    && page["size"].as_u64() == Some(batch.len() as u64)
                    && total <= 10000,
                "Invalid or oversized Plex collection"
            );
            let empty = batch.is_empty();
            items.extend(batch);
            ensure!(
                items.len() <= 10000 && items.len() <= total,
                "Invalid Plex pagination"
            );
            if items.len() == total {
                return Ok(items);
            }
            ensure!(!empty, "Plex returned an incomplete collection");
        }
    }
    pub fn playlists(
        &self,
        connection: &PlexConnection,
        cancel: &AtomicBool,
    ) -> Result<Vec<PlaylistSummary>> {
        let mut url = origin(&connection.base_uri)?.join("/playlists")?;
        url.query_pairs_mut().append_pair("playlistType", "audio");
        self.pages(url, &connection.token, cancel)?
            .into_iter()
            .filter(|p| p["playlistType"] == "audio")
            .map(|p| {
                let id = text(&p, "ratingKey")?;
                key(&id)?;
                Ok(PlaylistSummary {
                    id: format!("plex:playlist:{id}"),
                    title: text(&p, "title")?,
                    track_count: p["leafCount"].as_u64().unwrap_or(0),
                    duration_seconds: p["duration"].as_u64().unwrap_or(0) / 1000,
                })
            })
            .collect()
    }
    pub fn refresh(
        &self,
        profile: &mut Profile,
        ids: &[String],
        cancel: &AtomicBool,
    ) -> Result<Vec<Playlist>> {
        ensure!(
            !ids.is_empty() && ids.len() <= 500,
            "Choose between 1 and 500 playlists"
        );
        let connection = profile.connection()?.context("Sign in to Plex first")?;
        let summaries = self.playlists(&connection, cancel)?;
        let mut plan = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for id in ids {
            cancelled(cancel)?;
            ensure!(seen.insert(id), "Duplicate playlist selection");
            let summary = summaries
                .iter()
                .find(|p| &p.id == id)
                .context("A selected playlist is unavailable")?;
            ensure!(
                summary.track_count <= 10000,
                "Playlist exceeds 10000 tracks"
            );
            let rating_key = id
                .strip_prefix("plex:playlist:")
                .context("Invalid playlist identifier")?;
            key(rating_key)?;
            let url =
                origin(&connection.base_uri)?.join(&format!("/playlists/{rating_key}/items"))?;
            let mut tracks = Vec::new();
            for t in self.pages(url, &connection.token, cancel)? {
                if t["type"] != "track" {
                    continue;
                }
                let section = match &t["librarySectionID"] {
                    Value::String(v) => v.clone(),
                    Value::Number(v) => v.to_string(),
                    _ => continue,
                };
                if section != connection.library_id {
                    continue;
                }
                let rating_key = text(&t, "ratingKey")?;
                key(&rating_key)?;
                tracks.push(Track {
                    id: format!("plex:track:{rating_key}"),
                    rating_key,
                    title: t["title"].as_str().unwrap_or("").to_owned(),
                    artist: t["grandparentTitle"].as_str().unwrap_or("").to_owned(),
                    album: t["parentTitle"].as_str().unwrap_or("").to_owned(),
                    duration_seconds: (t["duration"].as_u64().unwrap_or(0) + 500) / 1000,
                });
            }
            plan.push(Playlist {
                id: id.clone(),
                title: summary.title.clone(),
                tracks,
            });
        }
        cancelled(cancel)?;
        profile.save_playlists(&plan)?;
        Ok(plan)
    }
    pub fn audio(
        &self,
        connection: &PlexConnection,
        track: &Track,
        bitrate: u16,
    ) -> Result<Response> {
        ensure!(crate::BITRATES.contains(&bitrate), "Invalid MP3 bitrate");
        key(&track.rating_key)?;
        let mut url =
            origin(&connection.base_uri)?.join("/music/:/transcode/universal/start.mp3")?;
        url.query_pairs_mut()
            .append_pair("path", &format!("/library/metadata/{}", track.rating_key))
            .append_pair("protocol", "http")
            .append_pair("mediaIndex", "0")
            .append_pair("partIndex", "0")
            .append_pair("directPlay", "0")
            .append_pair("directStream", "0")
            .append_pair("directStreamAudio", "0")
            .append_pair("audioChannelCount", "2")
            .append_pair("musicBitrate", &bitrate.to_string())
            .append_pair("transcodeSessionId", &uuid::Uuid::new_v4().to_string());
        let response = self.request(reqwest::Method::GET,url,Some(&connection.token)).header("Accept","audio/mpeg").header("X-Plex-Client-Profile-Name","Generic").header("X-Plex-Client-Profile-Extra","add-transcode-target(type=musicProfile&context=streaming&protocol=http&container=mp3&audioCodec=mp3)").timeout(Duration::from_secs(1800)).send().map_err(|_| anyhow::anyhow!("Cannot open Plex audio stream"))?;
        ensure!(
            response.status().is_success()
                && response
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|v| v
                        .split(';')
                        .next()
                        .unwrap_or("")
                        .trim()
                        .eq_ignore_ascii_case("audio/mpeg")),
            "Plex did not return MP3 audio"
        );
        Ok(response)
    }
}

pub fn open_browser(url: &str) -> Result<()> {
    // Do not print the link or a command containing it on failure.
    open::that_detached(url).map_err(|_| {
        anyhow::anyhow!("Could not open the browser; configure your desktop default browser")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        thread,
    };
    use tempfile::tempdir;
    type Handler = Box<dyn FnOnce(&str) -> (u16, String, Vec<u8>) + Send>;
    fn fake(handlers: Vec<Handler>) -> (Url, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let task = thread::spawn(move || {
            for handler in handlers {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    request.push_str(&line);
                }
                let (status, headers, body) = handler(&request);
                write!(socket,"HTTP/1.1 {status} Test\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n",body.len()).unwrap();
                socket.write_all(&body).unwrap();
            }
        });
        (url, task)
    }
    fn json(value: Value) -> (u16, String, Vec<u8>) {
        (
            200,
            "Content-Type: application/json\r\n".into(),
            value.to_string().into_bytes(),
        )
    }
    fn connection(url: &Url) -> PlexConnection {
        PlexConnection {
            token: "fake-token".into(),
            account_token: Some("fake-account".into()),
            server_id: "fake-server".into(),
            base_uri: url.to_string(),
            library_id: "1".into(),
        }
    }
    #[test]
    fn paginated_refresh_filters_library_and_audio_uses_headers() {
        let root = tempdir().unwrap();
        let mut profile = Profile::open(root.path()).unwrap();
        let (url, server) = fake(vec![
            Box::new(|r| {
                assert!(r.starts_with("GET /playlists?playlistType=audio "));
                assert!(r.to_lowercase().contains("x-plex-token: fake-token"));
                json(
                    serde_json::json!({"MediaContainer":{"offset":0,"size":1,"totalSize":1,"Metadata":[{"ratingKey":"10","playlistType":"audio","title":"Synthetic list","leafCount":3}]}}),
                )
            }),
            Box::new(|r| {
                assert!(r.contains("/playlists/10/items"));
                json(
                    serde_json::json!({"MediaContainer":{"offset":0,"size":2,"totalSize":3,"Metadata":[{"ratingKey":"1","type":"track","librarySectionID":1,"title":"Fake track","duration":1234},{"ratingKey":"2","type":"track","librarySectionID":9}]}}),
                )
            }),
            Box::new(|r| {
                assert!(r.to_lowercase().contains("x-plex-container-start: 2"));
                json(
                    serde_json::json!({"MediaContainer":{"offset":2,"size":1,"totalSize":3,"Metadata":[{"ratingKey":"1","type":"track","librarySectionID":"1","title":"Fake track","duration":1234}]}}),
                )
            }),
            Box::new(|r| {
                let first = r.lines().next().unwrap();
                assert!(first.contains("musicBitrate=320"));
                assert!(!first.contains("fake-token"));
                assert!(r.to_lowercase().contains("x-plex-client-profile-extra:"));
                (
                    200,
                    "Content-Type: audio/mpeg\r\n".into(),
                    vec![255, 251, 144, 0, 0, 0, 0, 0, 0, 0],
                )
            }),
        ]);
        profile
            .save_connection("fake-owner", &connection(&url))
            .unwrap();
        let plex = Plex::new(&profile).unwrap();
        let plan = plex
            .refresh(
                &mut profile,
                &["plex:playlist:10".into()],
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(plan[0].tracks.len(), 2);
        assert_eq!(plan[0].tracks[0].id, plan[0].tracks[1].id);
        let mut audio = plex
            .audio(&connection(&url), &plan[0].tracks[0], 320)
            .unwrap();
        let mut bytes = Vec::new();
        audio.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes.len(), 10);
        server.join().unwrap();
    }
    #[test]
    fn malformed_pagination_and_redirects_are_rejected_without_leaking_credentials() {
        let root = tempdir().unwrap();
        let profile = Profile::open(root.path()).unwrap();
        let plex = Plex::new(&profile).unwrap();
        let (url, server) = fake(vec![Box::new(|_| {
            json(serde_json::json!({"MediaContainer":{"offset":5,"size":0,"totalSize":2}}))
        })]);
        assert!(
            plex.playlists(&connection(&url), &AtomicBool::new(false))
                .is_err()
        );
        server.join().unwrap();
        let (url, server) = fake(vec![Box::new(|_| {
            (302, "Location: http://127.0.0.1:9/steal\r\n".into(), vec![])
        })]);
        let error = plex
            .playlists(&connection(&url), &AtomicBool::new(false))
            .unwrap_err()
            .to_string();
        assert!(!error.contains("fake-token"));
        assert!(error.contains("302"));
        server.join().unwrap();
    }
    #[test]
    fn login_refuses_a_different_owner() {
        let root = tempdir().unwrap();
        let mut profile = Profile::open(root.path()).unwrap();
        profile
            .save_connection(
                "original-owner",
                &connection(&Url::parse("http://127.0.0.1:9/").unwrap()),
            )
            .unwrap();
        let client = profile.client_id().unwrap();
        let client2 = client.clone();
        let (url, server) = fake(vec![
            Box::new(move |_| {
                json(
                    serde_json::json!({"id":1,"code":"fake-code","clientIdentifier":client,"expiresIn":300}),
                )
            }),
            Box::new(move |_| {
                json(
                    serde_json::json!({"id":1,"code":"fake-code","clientIdentifier":client2,"authToken":"fake-account"}),
                )
            }),
            Box::new(|_| json(serde_json::json!({"id":"different-owner"}))),
        ]);
        let mut plex = Plex::new(&profile).unwrap();
        plex.origin = url;
        assert!(
            plex.login(&profile, &AtomicBool::new(false), |url| {
                assert!(url.starts_with("https://app.plex.tv/auth#"));
                Ok(())
            })
            .is_err()
        );
        assert_eq!(profile.owner().unwrap().as_deref(), Some("original-owner"));
        server.join().unwrap();
    }
    #[test]
    fn first_login_discovers_and_saves_an_encrypted_single_owner_connection() {
        let root = tempdir().unwrap();
        let mut profile = Profile::open(root.path()).unwrap();
        let client = profile.client_id().unwrap();
        let client2 = client.clone();
        let (server_url, media_server) = fake(vec![
            Box::new(|_| {
                json(
                    serde_json::json!({"MediaContainer":{"machineIdentifier":"fake-server","claimed":true}}),
                )
            }),
            Box::new(|_| {
                json(
                    serde_json::json!({"MediaContainer":{"Directory":[{"key":"1","title":"Synthetic music","type":"artist"},{"key":"2","title":"Synthetic films","type":"movie"}]}}),
                )
            }),
        ]);
        let uri = server_url.to_string();
        let (url, account_server) = fake(vec![
            Box::new(move |_| {
                json(
                    serde_json::json!({"id":1,"code":"fake-code","clientIdentifier":client,"expiresIn":300}),
                )
            }),
            Box::new(move |_| {
                json(
                    serde_json::json!({"id":1,"code":"fake-code","clientIdentifier":client2,"authToken":"fake-account"}),
                )
            }),
            Box::new(|_| json(serde_json::json!({"id":"fake-owner"}))),
            Box::new(move |_| {
                json(
                    serde_json::json!([{"name":"Synthetic server","clientIdentifier":"fake-server","accessToken":"fake-token","provides":"server","connections":[{"uri":uri,"local":true,"relay":false}]}]),
                )
            }),
        ]);
        let mut plex = Plex::new(&profile).unwrap();
        plex.origin = url;
        let cancel = AtomicBool::new(false);
        let login = plex.login(&profile, &cancel, |_| Ok(())).unwrap();
        let choice = plex.discover(&login.servers[0], &cancel).unwrap();
        assert_eq!(choice.libraries.len(), 1);
        assert!(plex.connect(&mut profile, &login, &choice, "2").is_err());
        plex.connect(&mut profile, &login, &choice, "1").unwrap();
        assert_eq!(profile.owner().unwrap().as_deref(), Some("fake-owner"));
        let connection = profile.connection().unwrap().unwrap();
        assert_eq!(connection.token, "fake-token");
        assert_eq!(connection.account_token.as_deref(), Some("fake-account"));
        account_server.join().unwrap();
        media_server.join().unwrap();
    }
    #[test]
    fn discovery_rejects_server_identity_mismatch() {
        let root = tempdir().unwrap();
        let profile = Profile::open(root.path()).unwrap();
        let (url, server_task) = fake(vec![Box::new(|_| {
            json(
                serde_json::json!({"MediaContainer":{"machineIdentifier":"wrong-server","claimed":true}}),
            )
        })]);
        let server = Server {
            name: "Fake".into(),
            client_identifier: "expected-server".into(),
            access_token: Some("fake-token".into()),
            provides: "server".into(),
            connections: vec![Endpoint {
                uri: url.to_string(),
                local: true,
                relay: false,
            }],
        };
        assert!(
            Plex::new(&profile)
                .unwrap()
                .discover(&server, &AtomicBool::new(false))
                .is_err()
        );
        server_task.join().unwrap();
    }
}
