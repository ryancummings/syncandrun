//! Jellyfin music API. Credentials are confined to headers and encrypted profile storage.
use crate::{
    Playlist, Track,
    plex::{LibraryOverview, PlaylistSummary},
    profile::{JellyfinConnection, Profile},
};
use anyhow::{Context, Result, ensure};
use reqwest::blocking::{Client, RequestBuilder, Response};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use url::Url;

#[derive(Clone, Debug)]
pub struct Library {
    pub id: String,
    pub title: String,
}
// Intentionally not Debug or Serialize: contains an access token.
pub struct JellyfinLogin {
    connection: JellyfinConnection,
    pub libraries: Vec<Library>,
    pub server_name: String,
}
#[derive(Clone)]
pub struct Jellyfin {
    http: Client,
    client_id: String,
}
fn invalid() -> anyhow::Error {
    anyhow::anyhow!("Jellyfin returned an invalid response")
}
fn text(v: &Value, field: &str) -> Result<String> {
    v[field]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(invalid)
}
fn key(s: &str) -> Result<()> {
    ensure!(
        !s.is_empty()
            && s.len() <= 128
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
        "Invalid Jellyfin item identifier"
    );
    Ok(())
}
fn base(s: &str) -> Result<Url> {
    ensure!(
        s.starts_with("http://") || s.starts_with("https://"),
        "Start the Jellyfin server address with http:// or https://"
    );
    let mut u = Url::parse(s).map_err(|_| anyhow::anyhow!("Enter a valid Jellyfin server URL"))?;
    ensure!(
        ["http", "https"].contains(&u.scheme())
            && u.host_str().is_some()
            && u.username().is_empty()
            && u.password().is_none()
            && u.query().is_none()
            && u.fragment().is_none(),
        "Invalid Jellyfin server address"
    );
    if !u.path().ends_with('/') {
        u.set_path(&format!("{}/", u.path()));
    }
    Ok(u)
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    ensure!(!cancel.load(Ordering::Relaxed), "Operation cancelled");
    Ok(())
}
impl Jellyfin {
    pub fn new(profile: &Profile) -> Result<Self> {
        Ok(Self {
            http: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(20))
                .build()?,
            client_id: profile.client_id()?,
        })
    }
    fn request(
        &self,
        method: reqwest::Method,
        url: Url,
        token: Option<&str>,
    ) -> Result<RequestBuilder> {
        // Reject header injection, including quoted authentication parameter injection.
        ensure!(
            self.client_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-'),
            "Invalid profile client identifier"
        );
        let auth = format!(
            "MediaBrowser Client=\"SyncAndRun\", Device=\"Desktop\", DeviceId=\"{}\", Version=\"{}\"",
            self.client_id,
            env!("CARGO_PKG_VERSION")
        );
        let mut r = self
            .http
            .request(method, url)
            .header("Authorization", auth)
            .header("Accept", "application/json");
        if let Some(token) = token {
            let mut value = reqwest::header::HeaderValue::from_str(token).map_err(|_| invalid())?;
            value.set_sensitive(true);
            r = r.header("X-Emby-Token", value);
        }
        Ok(r)
    }
    fn json(&self, r: RequestBuilder) -> Result<Value> {
        let response = r
            .send()
            .map_err(|_| anyhow::anyhow!("Cannot reach Jellyfin"))?;
        ensure!(
            response.status().is_success(),
            "Jellyfin request failed (HTTP {})",
            response.status().as_u16()
        );
        let mut bytes = Vec::new();
        response
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid())?;
        ensure!(
            bytes.len() <= 16 * 1024 * 1024,
            "Jellyfin response is too large"
        );
        serde_json::from_slice(&bytes).map_err(|_| invalid())
    }
    fn get(&self, url: Url, token: &str) -> Result<Value> {
        self.json(self.request(reqwest::Method::GET, url, Some(token))?)
    }
    pub fn authenticate(
        &self,
        base_uri: &str,
        username: &str,
        password: &str,
        cancel: &AtomicBool,
    ) -> Result<JellyfinLogin> {
        cancelled(cancel)?;
        ensure!(!username.trim().is_empty(), "Enter your Jellyfin username");
        let base = base(base_uri)?;
        let info = self.json(self.request(
            reqwest::Method::GET,
            base.join("System/Info/Public")?,
            None,
        )?)?;
        let server_id = text(&info, "Id")?;
        key(&server_id)?;
        cancelled(cancel)?;
        let auth = self.json(
            self.request(
                reqwest::Method::POST,
                base.join("Users/AuthenticateByName")?,
                None,
            )?
            .json(&serde_json::json!({"Username":username,"Pw":password})),
        )?;
        ensure!(
            text(&auth, "ServerId")? == server_id,
            "Connected Jellyfin server changed"
        );
        let user_id = text(&auth["User"], "Id")?;
        key(&user_id)?;
        let token = text(&auth, "AccessToken")?;
        cancelled(cancel)?;
        let libraries = self.libraries(&base, &user_id, &token, cancel)?;
        ensure!(
            !libraries.is_empty(),
            "No Jellyfin music libraries are available to this account"
        );
        Ok(JellyfinLogin {
            connection: JellyfinConnection {
                token,
                server_id,
                user_id,
                base_uri: base.to_string(),
                library_id: String::new(),
            },
            libraries,
            server_name: info["ServerName"].as_str().unwrap_or("Jellyfin").into(),
        })
    }
    fn libraries(
        &self,
        base: &Url,
        user: &str,
        token: &str,
        cancel: &AtomicBool,
    ) -> Result<Vec<Library>> {
        key(user)?;
        let mut url = base.join(&format!("Users/{user}/Views"))?;
        url.query_pairs_mut()
            .append_pair("IncludeExternalContent", "false");
        cancelled(cancel)?;
        let data = self.get(url, token)?;
        data["Items"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .filter(|v| v["CollectionType"] == "music")
            .map(|v| {
                let id = text(v, "Id")?;
                key(&id)?;
                Ok(Library {
                    id,
                    title: text(v, "Name")?,
                })
            })
            .collect()
    }
    pub fn connect(
        &self,
        profile: &mut Profile,
        login: &JellyfinLogin,
        library_id: &str,
    ) -> Result<()> {
        ensure!(
            login.libraries.iter().any(|l| l.id == library_id),
            "Choose an available music library"
        );
        let c = &login.connection;
        profile.save_jellyfin_connection(&JellyfinConnection {
            token: c.token.clone(),
            server_id: c.server_id.clone(),
            user_id: c.user_id.clone(),
            base_uri: c.base_uri.clone(),
            library_id: library_id.into(),
        })
    }
    fn verify(&self, c: &JellyfinConnection) -> Result<Url> {
        key(&c.user_id)?;
        key(&c.library_id)?;
        let base = base(&c.base_uri)?;
        let info = self.get(base.join("System/Info/Public")?, &c.token)?;
        ensure!(
            text(&info, "Id")? == c.server_id,
            "Connected Jellyfin server changed"
        );
        let user = self.get(base.join("Users/Me")?, &c.token)?;
        ensure!(
            text(&user, "Id")? == c.user_id,
            "Connected Jellyfin account changed"
        );
        Ok(base)
    }
    fn pages(&self, url: Url, token: &str, cancel: &AtomicBool) -> Result<Vec<Value>> {
        let mut items = Vec::new();
        let mut expected = None;
        loop {
            cancelled(cancel)?;
            let mut page_url = url.clone();
            page_url
                .query_pairs_mut()
                .append_pair("StartIndex", &items.len().to_string())
                .append_pair("Limit", "100")
                .append_pair("EnableTotalRecordCount", "true")
                .append_pair("EnableImages", "false")
                .append_pair("EnableUserData", "false");
            let page = self.get(page_url, token)?;
            let total = page["TotalRecordCount"].as_u64().ok_or_else(invalid)? as usize;
            let batch = page["Items"].as_array().ok_or_else(invalid)?;
            ensure!(
                total <= 10000
                    && expected.is_none_or(|n| n == total)
                    && page["StartIndex"]
                        .as_u64()
                        .is_none_or(|n| n as usize == items.len()),
                "Invalid or oversized Jellyfin collection"
            );
            expected = Some(total);
            ensure!(
                items.len() + batch.len() <= total && (items.len() == total || !batch.is_empty()),
                "Jellyfin returned an incomplete collection"
            );
            items.extend(batch.iter().cloned());
            if items.len() == total {
                return Ok(items);
            }
        }
    }
    pub fn playlists(
        &self,
        c: &JellyfinConnection,
        cancel: &AtomicBool,
    ) -> Result<Vec<PlaylistSummary>> {
        cancelled(cancel)?;
        let base = self.verify(c)?;
        let mut url = base.join("Items")?;
        url.query_pairs_mut()
            .append_pair("UserId", &c.user_id)
            .append_pair("IncludeItemTypes", "Playlist")
            .append_pair("Recursive", "true")
            .append_pair("Fields", "ChildCount");
        self.pages(url, &c.token, cancel)?
            .into_iter()
            .filter(|v| v["Type"] == "Playlist" && v["MediaType"] == "Audio")
            .map(|v| {
                let id = text(&v, "Id")?;
                key(&id)?;
                Ok(PlaylistSummary {
                    id: format!("jellyfin:playlist:{id}"),
                    title: text(&v, "Name")?,
                    track_count: v["ChildCount"].as_u64().unwrap_or(0),
                    duration_seconds: v["RunTimeTicks"].as_u64().unwrap_or(0) / 10_000_000,
                })
            })
            .collect()
    }
    pub fn library_overview(&self, c: &JellyfinConnection) -> Result<LibraryOverview> {
        let base = self.verify(c)?;
        let info = self.get(base.join("System/Info/Public")?, &c.token)?;
        let libraries = self.libraries(&base, &c.user_id, &c.token, &AtomicBool::new(false))?;
        let library = libraries
            .iter()
            .find(|l| l.id == c.library_id)
            .context("Saved Jellyfin music library is unavailable")?;
        let mut url = base.join("Items")?;
        url.query_pairs_mut()
            .append_pair("UserId", &c.user_id)
            .append_pair("ParentId", &c.library_id)
            .append_pair("Recursive", "true")
            .append_pair("IncludeItemTypes", "Audio")
            .append_pair("Limit", "0")
            .append_pair("EnableTotalRecordCount", "true");
        let count = self.get(url, &c.token)?;
        Ok(LibraryOverview {
            server_name: info["ServerName"].as_str().map(str::to_owned),
            server_version: info["Version"].as_str().map(str::to_owned),
            library_name: Some(library.title.clone()),
            library_tracks: count["TotalRecordCount"].as_u64(),
        })
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
        let c = profile
            .jellyfin_connection()?
            .context("Sign in to Jellyfin first")?;
        let summaries = self.playlists(&c, cancel)?;
        let base = base(&c.base_uri)?;
        let mut seen = HashSet::new();
        let mut membership = HashMap::new();
        let mut plan = Vec::new();
        for id in ids {
            cancelled(cancel)?;
            ensure!(seen.insert(id), "Duplicate playlist selection");
            let summary = summaries
                .iter()
                .find(|p| &p.id == id)
                .context("A selected playlist is unavailable")?;
            let playlist_id = id
                .strip_prefix("jellyfin:playlist:")
                .context("Invalid Jellyfin playlist identifier")?;
            key(playlist_id)?;
            let mut url = base.join(&format!("Playlists/{playlist_id}/Items"))?;
            url.query_pairs_mut()
                .append_pair("UserId", &c.user_id)
                .append_pair("Fields", "ParentId");
            let mut tracks = Vec::new();
            for item in self.pages(url, &c.token, cancel)? {
                cancelled(cancel)?;
                if item["Type"] != "Audio" {
                    continue;
                }
                let item_id = text(&item, "Id")?;
                key(&item_id)?;
                let included = if let Some(included) = membership.get(&item_id) {
                    *included
                } else {
                    let mut url = base.join(&format!("Items/{item_id}/Ancestors"))?;
                    url.query_pairs_mut().append_pair("UserId", &c.user_id);
                    let ancestors = self.get(url, &c.token)?;
                    let included = ancestors
                        .as_array()
                        .ok_or_else(invalid)?
                        .iter()
                        .any(|a| a["Id"].as_str() == Some(&c.library_id));
                    membership.insert(item_id.clone(), included);
                    included
                };
                if !included {
                    continue;
                }
                tracks.push(Track {
                    id: format!("jellyfin:track:{item_id}"),
                    rating_key: item_id,
                    title: item["Name"].as_str().unwrap_or("").into(),
                    artist: item["Artists"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(" / ")
                        })
                        .unwrap_or_default(),
                    album: item["Album"].as_str().unwrap_or("").into(),
                    duration_seconds: item["RunTimeTicks"]
                        .as_u64()
                        .unwrap_or(0)
                        .saturating_add(5_000_000)
                        / 10_000_000,
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
    pub fn audio(&self, c: &JellyfinConnection, track: &Track, bitrate: u16) -> Result<Response> {
        crate::profile::Provider::Jellyfin.validate_bitrate(bitrate)?;
        key(&track.rating_key)?;
        ensure!(
            track.id == format!("jellyfin:track:{}", track.rating_key),
            "Track belongs to a different music provider"
        );
        let mut url = self
            .verify(c)?
            .join(&format!("Audio/{}/stream.mp3", track.rating_key))?;
        url.query_pairs_mut()
            .append_pair("UserId", &c.user_id)
            .append_pair("DeviceId", &self.client_id)
            .append_pair("PlaySessionId", &uuid::Uuid::new_v4().to_string())
            .append_pair("Static", "false")
            .append_pair("AudioCodec", "mp3")
            .append_pair("AudioBitRate", &(u32::from(bitrate) * 1000).to_string())
            .append_pair("AudioChannels", "2")
            .append_pair("AudioSampleRate", "44100")
            .append_pair("EnableAutoStreamCopy", "false")
            .append_pair("AllowAudioStreamCopy", "false")
            .append_pair("EnableAudioVbrEncoding", "false");
        let response = self
            .request(reqwest::Method::GET, url, Some(&c.token))?
            .header("Accept", "audio/mpeg")
            .timeout(Duration::from_secs(1800))
            .send()
            .map_err(|_| anyhow::anyhow!("Cannot open Jellyfin audio stream"))?;
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
            "Jellyfin did not return MP3 audio"
        );
        Ok(response)
    }
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
    type Handler = Box<dyn FnOnce(&str, &str) -> (u16, String, Vec<u8>) + Send>;
    fn fake(handlers: Vec<Handler>) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/jellyfin", listener.local_addr().unwrap());
        let task = thread::spawn(move || {
            for handler in handlers {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut headers = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    headers.push_str(&line);
                }
                let len = headers
                    .lines()
                    .find_map(|l| {
                        l.to_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|n| n.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                let mut body = vec![0; len];
                reader.read_exact(&mut body).unwrap();
                let (status, extra, body) = handler(&headers, &String::from_utf8(body).unwrap());
                write!(socket,"HTTP/1.1 {status} Test\r\nConnection: close\r\nContent-Length: {}\r\n{extra}\r\n",body.len()).unwrap();
                socket.write_all(&body).unwrap();
            }
        });
        (url, task)
    }
    fn json(v: Value) -> (u16, String, Vec<u8>) {
        (
            200,
            "Content-Type: application/json\r\n".into(),
            v.to_string().into_bytes(),
        )
    }
    fn response(v: Value) -> Handler {
        Box::new(move |_, _| json(v))
    }
    fn identity() -> Vec<Handler> {
        vec![
            response(serde_json::json!({"Id":"server"})),
            response(serde_json::json!({"Id":"user"})),
        ]
    }
    fn connection(base_uri: String) -> JellyfinConnection {
        JellyfinConnection {
            base_uri,
            token: "fake-token".into(),
            server_id: "server".into(),
            user_id: "user".into(),
            library_id: "music".into(),
        }
    }
    #[test]
    fn authentication_preserves_base_path_and_keeps_password_only_in_body() {
        let root = tempdir().unwrap();
        let mut profile = Profile::open(root.path()).unwrap();
        let (url, server) = fake(vec![
            Box::new(|r, _| {
                assert!(r.starts_with("GET /jellyfin/System/Info/Public "));
                json(serde_json::json!({"Id":"server","ServerName":"Synthetic"}))
            }),
            Box::new(|r, b| {
                assert!(r.starts_with("POST /jellyfin/Users/AuthenticateByName "));
                assert!(!r.contains("fake-password"));
                assert!(r.contains("MediaBrowser Client="));
                let b: Value = serde_json::from_str(b).unwrap();
                assert_eq!(b["Pw"], "fake-password");
                json(
                    serde_json::json!({"ServerId":"server","User":{"Id":"user"},"AccessToken":"fake-token"}),
                )
            }),
            Box::new(|r, _| {
                assert!(r.starts_with("GET /jellyfin/Users/user/Views?"));
                assert!(r.to_lowercase().contains("x-emby-token: fake-token"));
                json(
                    serde_json::json!({"Items":[{"Id":"music","Name":"Music","CollectionType":"music"},{"Id":"films","Name":"Films","CollectionType":"movies"}]}),
                )
            }),
        ]);
        let client = Jellyfin::new(&profile).unwrap();
        let login = client
            .authenticate(&url, "synthetic", "fake-password", &AtomicBool::new(false))
            .unwrap();
        assert_eq!(login.libraries.len(), 1);
        assert!(client.connect(&mut profile, &login, "films").is_err());
        client.connect(&mut profile, &login, "music").unwrap();
        assert_eq!(
            profile.active_provider().unwrap(),
            crate::profile::Provider::Jellyfin
        );
        server.join().unwrap();
    }
    #[test]
    fn paginated_refresh_preserves_repeats_order_and_library_scope_then_dispatches_mp3() {
        let root = tempdir().unwrap();
        let mut profile = Profile::open(root.path()).unwrap();
        let mut handlers = identity();
        handlers.push(response(serde_json::json!({"Items":[{"Id":"list","Name":"Synthetic","Type":"Playlist","MediaType":"Audio","ChildCount":4}],"TotalRecordCount":1,"StartIndex":0})));
        let track = serde_json::json!({"Id":"one","Type":"Audio","Name":"One","Artists":["Artist"],"Album":"Album","RunTimeTicks":610000000});
        let track2 = track.clone();
        handlers.push(Box::new(move|r,_|{assert!(r.contains("StartIndex=0"));json(serde_json::json!({"Items":[track,{"Id":"outside","Type":"Audio","Name":"Other"}],"TotalRecordCount":4,"StartIndex":0}))}));
        handlers.push(Box::new(move|r,_|{assert!(r.contains("StartIndex=2"));json(serde_json::json!({"Items":[track2,{"Id":"two","Type":"Audio","Name":"Two"}],"TotalRecordCount":4,"StartIndex":2}))}));
        handlers.push(response(serde_json::json!([{"Id":"music"}])));
        handlers.push(response(serde_json::json!([{"Id":"other-library"}])));
        handlers.push(response(serde_json::json!([{"Id":"music"}])));
        handlers.extend(identity());
        handlers.push(Box::new(|r, _| {
            let first = r.lines().next().unwrap();
            assert!(first.starts_with("GET /jellyfin/Audio/one/stream.mp3?"));
            assert!(!first.contains("fake-token"));
            assert!(r.to_lowercase().contains("x-emby-token: fake-token"));
            for value in [
                "AudioBitRate=192000",
                "Static=false",
                "AudioCodec=mp3",
                "EnableAutoStreamCopy=false",
                "AllowAudioStreamCopy=false",
                "EnableAudioVbrEncoding=false",
            ] {
                assert!(first.contains(value));
            }
            (
                200,
                "Content-Type: audio/mpeg\r\n".into(),
                vec![0xff, 0xfb, 0x90, 0],
            )
        }));
        let (url, server) = fake(handlers);
        profile.save_jellyfin_connection(&connection(url)).unwrap();
        let source = crate::provider::MusicSource::new(&profile).unwrap();
        let ids = vec!["jellyfin:playlist:list".into()];
        let plan = source
            .refresh(&mut profile, &ids, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(
            plan[0]
                .tracks
                .iter()
                .map(|t| t.rating_key.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "one", "two"]
        );
        assert_eq!(profile.plan(&ids).unwrap()[0].tracks.len(), 3);
        assert_eq!(plan[0].tracks[0].duration_seconds, 61);
        let mut bytes = Vec::new();
        source
            .audio(&profile, &plan[0].tracks[0], 192)
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes[0], 0xff);
        server.join().unwrap();
    }
    #[test]
    fn different_exports_have_unique_transcode_sessions() {
        let root = tempdir().unwrap();
        let profile = Profile::open(root.path()).unwrap();
        let sessions = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut handlers = Vec::new();
        for bitrate in [64, 96] {
            handlers.extend(identity());
            let sessions = sessions.clone();
            handlers.push(Box::new(move |request, _| {
                let path = request
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap();
                let url = Url::parse(&format!("http://localhost{path}")).unwrap();
                let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
                assert_eq!(query["AudioBitRate"], (bitrate * 1000).to_string());
                uuid::Uuid::parse_str(&query["PlaySessionId"]).unwrap();
                sessions
                    .lock()
                    .unwrap()
                    .push(query["PlaySessionId"].clone());
                (
                    200,
                    "Content-Type: audio/mpeg\r\n".into(),
                    vec![0xff, 0xfb, 0x90, 0],
                )
            }));
        }
        let (url, server) = fake(handlers);
        let client = Jellyfin::new(&profile).unwrap();
        let track = Track {
            id: "jellyfin:track:one".into(),
            rating_key: "one".into(),
            title: "Synthetic".into(),
            artist: String::new(),
            album: String::new(),
            duration_seconds: 1,
        };
        let connection = connection(url);
        let error = client
            .audio(&connection, &track, 320)
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("256 kbps"));
        assert!(crate::profile::Provider::Plex.validate_bitrate(320).is_ok());
        assert!(
            crate::profile::Provider::Jellyfin
                .validate_bitrate(65)
                .is_err()
        );
        for bitrate in [64, 96] {
            client.audio(&connection, &track, bitrate).unwrap();
        }
        server.join().unwrap();
        let sessions = sessions.lock().unwrap();
        assert_ne!(sessions[0], sessions[1]);
    }

    #[test]
    fn failures_are_redacted_and_redirects_pagination_cancellation_identity_are_rejected() {
        let root = tempdir().unwrap();
        let profile = Profile::open(root.path()).unwrap();
        let client = Jellyfin::new(&profile).unwrap();
        let (url, server) = fake(vec![Box::new(|_, _| {
            (
                302,
                "Location: http://127.0.0.1:1/leaked\r\n".into(),
                b"fake-token fake-password".to_vec(),
            )
        })]);
        let error = client
            .authenticate(&url, "user", "fake-password", &AtomicBool::new(false))
            .err()
            .unwrap()
            .to_string();
        assert!(!error.contains("fake-"));
        assert!(error.contains("302"));
        server.join().unwrap();
        let (url, server) = fake(vec![response(
            serde_json::json!({"TotalRecordCount":2,"Items":[],"StartIndex":0}),
        )]);
        assert!(
            client
                .pages(base(&url).unwrap(), "fake-token", &AtomicBool::new(false))
                .is_err()
        );
        server.join().unwrap();
        assert!(
            client
                .authenticate(
                    "http://127.0.0.1:1",
                    "user",
                    "secret",
                    &AtomicBool::new(true)
                )
                .is_err()
        );
        let (url, server) = fake(vec![response(serde_json::json!({"Id":"different-server"}))]);
        assert!(client.verify(&connection(url)).is_err());
        server.join().unwrap();
        for invalid in [
            "192.168.1.20:8096",
            "music.example.org/jellyfin",
            "file:///tmp/test",
            "https://user:password@example.com",
            "https://example.com/?api_key=secret",
        ] {
            assert!(base(invalid).is_err());
        }
        assert!(
            base("192.168.1.20:8096")
                .unwrap_err()
                .to_string()
                .contains("http:// or https://")
        );
        assert!(base("http://192.168.1.20:8096").is_ok());
    }
}
