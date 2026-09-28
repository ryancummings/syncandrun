use crate::{Playlist, Track};
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use anyhow::{Context, Result, bail, ensure};
use hkdf::Hkdf;
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::Sha256;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

// These are the historical migrations, including inert watch tables. Never renumber them.
const MIGRATIONS: [(&str, &str); 12] = [
    ("initial", include_str!("migrations/001_initial.sql")),
    (
        "initialize_manifest_revision",
        include_str!("migrations/002_initialize_manifest_revision.sql"),
    ),
    (
        "plex_setup_sessions",
        include_str!("migrations/003_plex_setup_sessions.sql"),
    ),
    (
        "browser_sessions",
        include_str!("migrations/004_browser_sessions.sql"),
    ),
    (
        "device_sync_results",
        include_str!("migrations/005_device_sync_results.sql"),
    ),
    (
        "sync_timings",
        include_str!("migrations/006_sync_timings.sql"),
    ),
    (
        "enable_artwork_manifest",
        include_str!("migrations/007_enable_artwork_manifest.sql"),
    ),
    (
        "device_management",
        include_str!("migrations/008_device_management.sql"),
    ),
    (
        "artwork_origin_fingerprint",
        include_str!("migrations/009_artwork_origin_fingerprint.sql"),
    ),
    (
        "owner_authorization",
        include_str!("migrations/010_owner_authorization.sql"),
    ),
    (
        "music_providers",
        include_str!("migrations/011_music_providers.sql"),
    ),
    (
        "local_folder",
        include_str!("migrations/012_local_folder.sql"),
    ),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Plex,
    Jellyfin,
    Local,
}
impl Provider {
    pub fn label(self) -> &'static str {
        match self {
            Self::Plex => "Plex",
            Self::Jellyfin => "Jellyfin",
            Self::Local => "Local folder",
        }
    }
    pub fn bitrates(self) -> &'static [u16] {
        match self {
            Self::Plex => &crate::BITRATES,
            Self::Jellyfin => &crate::BITRATES[..5],
            Self::Local => &crate::BITRATES,
        }
    }
    pub fn validate_bitrate(self, bitrate: u16) -> Result<()> {
        ensure!(crate::BITRATES.contains(&bitrate), "Invalid MP3 bitrate");
        ensure!(
            self.bitrates().contains(&bitrate),
            "Jellyfin supports MP3 exports up to 256 kbps; choose a lower bitrate"
        );
        Ok(())
    }
    fn stored(self) -> &'static str {
        match self {
            Self::Plex => "plex",
            Self::Jellyfin => "jellyfin",
            Self::Local => "local",
        }
    }
}

// Deliberately no Debug/Serialize: this type contains credentials.
pub struct JellyfinConnection {
    pub token: String,
    pub server_id: String,
    pub user_id: String,
    pub base_uri: String,
    pub library_id: String,
}

pub struct Profile {
    db: Connection,
    secret: String,
    pub root: PathBuf,
    _lock: std::fs::File,
}

// Deliberately no Debug/Serialize: this type contains credentials.
pub struct PlexConnection {
    pub token: String,
    pub account_token: Option<String>,
    pub server_id: String,
    pub base_uri: String,
    pub library_id: String,
}

pub fn default_path() -> Result<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")))
        .context("Set HOME or pass --profile")?;
    // Electron's package name determines its default userData folder.
    let legacy = config.join("syncandrun-desktop");
    let branded = config.join("SyncAndRun");
    if legacy.join("data/syncandrun.sqlite").exists()
        && branded.join("data/syncandrun.sqlite").exists()
    {
        bail!("Multiple existing profiles found; choose one with --profile");
    }
    Ok(if branded.join("data/syncandrun.sqlite").exists() {
        branded
    } else {
        legacy
    })
}

fn private_dir(path: &Path) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

impl Profile {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        private_dir(&root)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(root.join("native.lock"))?;
        fs2::FileExt::try_lock_exclusive(&lock)
            .context("This profile is in use by another native app or CLI operation")?;
        private_dir(&root.join("data"))?;
        let secret_path = root.join("secret");
        let db_path = root.join("data/syncandrun.sqlite");
        ensure!(
            !db_path.exists() || secret_path.exists(),
            "Existing database is missing its encryption secret; restore both from backup"
        );
        if !secret_path.exists() {
            let mut bytes = [0; 48];
            rand::thread_rng().fill_bytes(&mut bytes);
            let secret: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&secret_path)
            {
                Ok(mut f) => {
                    f.write_all(secret.as_bytes())?;
                    f.sync_all()?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.into()),
            }
        }
        let secret = fs::read_to_string(&secret_path)?; // Electron uses exact bytes, including whitespace.
        ensure!(secret.len() >= 32, "Profile encryption secret is invalid");
        fs::set_permissions(&secret_path, fs::Permissions::from_mode(0o600))?;
        let mut db = Connection::open(db_path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL);")?;
        let newest: u32 = db.query_row(
            "SELECT COALESCE(MAX(version),0) FROM schema_migrations",
            [],
            |r| r.get(0),
        )?;
        ensure!(newest <= 12, "Profile belongs to a newer app version");
        for (i, (name, sql)) in MIGRATIONS.iter().enumerate() {
            let version = i + 1;
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let applied: Option<String> = tx
                .query_row(
                    "SELECT name FROM schema_migrations WHERE version=?",
                    [version],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(applied) = applied {
                ensure!(applied == *name, "Profile migration name mismatch");
            } else {
                tx.execute_batch(sql)?;
                let now = chrono::Utc::now().to_rfc3339();
                tx.execute(
                    "INSERT INTO schema_migrations VALUES(?,?,?)",
                    params![version, name, now],
                )?;
                if version == 1 {
                    tx.execute(
                        "INSERT INTO installation VALUES(1,1,?,?,?)",
                        params![Uuid::new_v4().to_string(), now, now],
                    )?;
                    tx.execute("INSERT INTO settings(id,transcode_profile,selected_playlist_ids,updated_at) VALUES(1,'balanced','[]',?)", [&now])?;
                }
            }
            tx.commit()?;
        }
        Ok(Self {
            db,
            secret,
            root,
            _lock: lock,
        })
    }

    pub fn client_id(&self) -> Result<String> {
        Ok(self.db.query_row(
            "SELECT plex_client_identifier FROM installation WHERE id=1",
            [],
            |r| r.get(0),
        )?)
    }
    pub fn owner(&self) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row(
                "SELECT plex_user_id FROM installation_owner WHERE id=1",
                [],
                |r| r.get(0),
            )
            .optional()?)
    }
    pub fn connection(&self) -> Result<Option<PlexConnection>> {
        type Row = (
            Vec<u8>,
            Vec<u8>,
            Option<Vec<u8>>,
            Option<Vec<u8>>,
            String,
            String,
            String,
        );
        let row: Option<Row> = self.db.query_row("SELECT encrypted_token,token_nonce,encrypted_account_token,account_token_nonce,server_machine_id,server_base_uri,library_section_id FROM plex_connection WHERE id=1", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?;
        row.map(
            |(token, nonce, account, account_nonce, server_id, base_uri, library_id)| {
                Ok(PlexConnection {
                    token: decrypt(&token, &nonce, &self.secret)?,
                    account_token: match (account, account_nonce) {
                        (Some(a), Some(n)) => Some(decrypt(&a, &n, &self.secret)?),
                        (None, None) => None,
                        _ => bail!("Invalid encrypted account credential"),
                    },
                    server_id,
                    base_uri,
                    library_id,
                })
            },
        )
        .transpose()
    }

    /// The caller verifies the Plex account and server identity before saving.
    pub(crate) fn save_connection(
        &mut self,
        owner: &str,
        connection: &PlexConnection,
    ) -> Result<()> {
        let (token, nonce) = encrypt(&connection.token, &self.secret)?;
        let (account, account_nonce) = encrypt(
            connection
                .account_token
                .as_deref()
                .context("Account credential missing")?,
            &self.secret,
        )?;
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT plex_user_id FROM installation_owner WHERE id=1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        ensure!(
            existing.as_deref().is_none_or(|v| v == owner),
            "Sign in with the account that owns this profile"
        );
        let now = chrono::Utc::now().to_rfc3339();
        tx.execute(
            "INSERT OR IGNORE INTO installation_owner VALUES(1,?)",
            [owner],
        )?;
        tx.execute("INSERT INTO plex_connection(id,encrypted_token,token_nonce,encrypted_account_token,account_token_nonce,server_machine_id,server_base_uri,library_section_id,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET encrypted_token=excluded.encrypted_token,token_nonce=excluded.token_nonce,encrypted_account_token=excluded.encrypted_account_token,account_token_nonce=excluded.account_token_nonce,server_machine_id=excluded.server_machine_id,server_base_uri=excluded.server_base_uri,library_section_id=excluded.library_section_id,updated_at=excluded.updated_at", params![token,nonce,account,account_nonce,connection.server_id,connection.base_uri,connection.library_id,now,now])?;
        tx.execute(
            "UPDATE music_provider SET provider='plex',source_revision=? WHERE id=1",
            [Uuid::new_v4().to_string()],
        )?;
        // Old snapshots must not be used against a different server or library.
        tx.execute_batch("DELETE FROM playlist_snapshots; DELETE FROM track_metadata; UPDATE settings SET selected_playlist_ids='[]',manifest_revision=NULL WHERE id=1;")?;
        tx.commit()?;
        Ok(())
    }

    /// Changes whenever a connection is saved or the active source changes.
    pub fn source_revision(&self) -> Result<String> {
        Ok(self.db.query_row(
            "SELECT source_revision FROM music_provider WHERE id=1",
            [],
            |r| r.get(0),
        )?)
    }
    pub fn active_provider(&self) -> Result<Provider> {
        let value: String =
            self.db
                .query_row("SELECT provider FROM music_provider WHERE id=1", [], |r| {
                    r.get(0)
                })?;
        match value.as_str() {
            "plex" => Ok(Provider::Plex),
            "jellyfin" => Ok(Provider::Jellyfin),
            "local" => Ok(Provider::Local),
            _ => bail!("Invalid music provider"),
        }
    }
    pub fn has_saved_provider(&self, provider: Provider) -> Result<bool> {
        let query = match provider {
            Provider::Plex => "SELECT 1 FROM plex_connection WHERE id=1",
            Provider::Jellyfin => "SELECT 1 FROM jellyfin_connection WHERE id=1",
            Provider::Local => "SELECT 1 FROM local_folder WHERE id=1",
        };
        Ok(self
            .db
            .query_row(query, [], |row| row.get::<_, i64>(0))
            .optional()?
            .is_some())
    }
    pub fn set_active_provider(&mut self, provider: Provider) -> Result<()> {
        ensure!(
            match provider {
                Provider::Plex => self.connection()?.is_some(),
                Provider::Jellyfin => self.jellyfin_connection()?.is_some(),
                Provider::Local => self.local_folder()?.is_some(),
            },
            "Connect to this music provider first"
        );
        if self.active_provider()? == provider {
            return Ok(());
        }
        let tx = self.db.transaction()?;
        tx.execute(
            "UPDATE music_provider SET provider=?,source_revision=? WHERE id=1",
            params![provider.stored(), Uuid::new_v4().to_string()],
        )?;
        tx.execute_batch("DELETE FROM playlist_snapshots; DELETE FROM track_metadata; UPDATE settings SET selected_playlist_ids='[]',manifest_revision=NULL WHERE id=1;")?;
        tx.commit()?;
        Ok(())
    }
    pub fn local_folder(&self) -> Result<Option<PathBuf>> {
        let root: Option<String> = self
            .db
            .query_row("SELECT root FROM local_folder WHERE id=1", [], |r| r.get(0))
            .optional()?;
        Ok(root.map(PathBuf::from))
    }
    pub fn set_local_folder(&mut self, root: &Path) -> Result<()> {
        let root = root
            .canonicalize()
            .context("Choose an existing local music folder")?;
        ensure!(root.is_dir(), "Local music source must be a folder");
        let tx = self.db.transaction()?;
        tx.execute("INSERT INTO local_folder(id,root) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET root=excluded.root", [root.to_string_lossy().as_ref()])?;
        tx.execute(
            "UPDATE music_provider SET provider='local',source_revision=? WHERE id=1",
            [Uuid::new_v4().to_string()],
        )?;
        tx.execute_batch("DELETE FROM playlist_snapshots; DELETE FROM track_metadata; UPDATE settings SET selected_playlist_ids='[]',manifest_revision=NULL WHERE id=1;")?;
        tx.commit()?;
        Ok(())
    }
    pub fn jellyfin_connection(&self) -> Result<Option<JellyfinConnection>> {
        type Row = (Vec<u8>, Vec<u8>, String, String, String, String);
        let row: Option<Row> = self.db.query_row("SELECT encrypted_token,token_nonce,server_id,user_id,base_uri,library_id FROM jellyfin_connection WHERE id=1", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
        row.map(|(token, nonce, server_id, user_id, base_uri, library_id)| {
            Ok(JellyfinConnection {
                token: decrypt(&token, &nonce, &self.secret)?,
                server_id,
                user_id,
                base_uri,
                library_id,
            })
        })
        .transpose()
    }
    pub(crate) fn save_jellyfin_connection(
        &mut self,
        connection: &JellyfinConnection,
    ) -> Result<()> {
        let (token, nonce) = encrypt(&connection.token, &self.secret)?;
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let owner: Option<(String, String)> = tx
            .query_row(
                "SELECT server_id,user_id FROM jellyfin_connection WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        ensure!(
            owner.is_none_or(
                |(server, user)| server == connection.server_id && user == connection.user_id
            ),
            "Sign in with the Jellyfin server and account that own this profile"
        );
        tx.execute("INSERT INTO jellyfin_connection VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET encrypted_token=excluded.encrypted_token,token_nonce=excluded.token_nonce,base_uri=excluded.base_uri,library_id=excluded.library_id", params![token,nonce,connection.server_id,connection.user_id,connection.base_uri,connection.library_id])?;
        tx.execute(
            "UPDATE music_provider SET provider='jellyfin',source_revision=? WHERE id=1",
            [Uuid::new_v4().to_string()],
        )?;
        tx.execute_batch(" DELETE FROM playlist_snapshots; DELETE FROM track_metadata; UPDATE settings SET selected_playlist_ids='[]',manifest_revision=NULL WHERE id=1;")?;
        tx.commit()?;
        Ok(())
    }

    pub fn selected_ids(&self) -> Result<Vec<String>> {
        let ids: String = self.db.query_row(
            "SELECT selected_playlist_ids FROM settings WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        Ok(serde_json::from_str(&ids)?)
    }

    pub fn save_playlists(&mut self, playlists: &[Playlist]) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute_batch("DELETE FROM playlist_snapshots; DELETE FROM track_metadata;")?;
        let now = chrono::Utc::now().to_rfc3339();
        for playlist in playlists {
            for t in &playlist.tracks {
                tx.execute("INSERT OR REPLACE INTO track_metadata(track_id,rating_key,media_part_fingerprint,title,artist,album,duration_seconds,updated_at) VALUES(?,?,'native',?,?,?,?,?)", params![t.id,t.rating_key,t.title,t.artist,t.album,t.duration_seconds,now])?;
            }
            let ids: Vec<_> = playlist.tracks.iter().map(|t| &t.id).collect();
            tx.execute("INSERT INTO playlist_snapshots(playlist_id,title,ordered_track_ids,revision,updated_at) VALUES(?,?,?,'native',?)", params![playlist.id,playlist.title,serde_json::to_string(&ids)?,now])?;
        }
        let ids: Vec<_> = playlists.iter().map(|p| &p.id).collect();
        tx.execute("UPDATE settings SET selected_playlist_ids=?,manifest_revision=?,updated_at=? WHERE id=1", params![serde_json::to_string(&ids)?,Uuid::new_v4().to_string(),now])?;
        tx.commit()?;
        Ok(())
    }

    pub fn plan(&self, ids: &[String]) -> Result<Vec<Playlist>> {
        ensure!(
            !ids.is_empty() && ids.len() <= 500,
            "Choose between 1 and 500 playlists"
        );
        let selected = self.selected_ids()?;
        let mut seen = std::collections::HashSet::new();
        ids.iter().map(|id| {
            ensure!(selected.contains(id) && seen.insert(id), "Refresh the selected playlists first");
            let (title, ordered): (String,String) = self.db.query_row("SELECT title,ordered_track_ids FROM playlist_snapshots WHERE playlist_id=?", [id], |r| Ok((r.get(0)?,r.get(1)?)))?;
            let tracks: Vec<String> = serde_json::from_str(&ordered)?;
            ensure!(tracks.len() <= 10000, "Playlist exceeds 10000 tracks");
            let tracks = tracks.iter().map(|id| self.db.query_row("SELECT track_id,rating_key,title,artist,album,duration_seconds FROM track_metadata WHERE track_id=?", [id], |r| Ok(Track { id:r.get(0)?,rating_key:r.get(1)?,title:r.get(2)?,artist:r.get(3)?,album:r.get(4)?,duration_seconds:r.get(5)? }))).collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Playlist { id:id.clone(),title,tracks })
        }).collect()
    }

    pub fn backup(&self, destination: &Path) -> Result<PathBuf> {
        let target = destination.join(format!("SyncAndRun-backup-{}", Uuid::new_v4()));
        fs::DirBuilder::new().mode(0o700).create(&target)?;
        private_dir(&target.join("data"))?;
        self.db
            .backup("main", target.join("data/syncandrun.sqlite"), None)?;
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(target.join("secret"))?;
        f.write_all(self.secret.as_bytes())?;
        f.sync_all()?;
        if self.root.join("desktop.json").exists() {
            fs::copy(self.root.join("desktop.json"), target.join("desktop.json"))?;
        }
        Ok(target)
    }
}

fn cipher(secret: &str) -> Result<Aes256Gcm> {
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(b"syncandrun-for-garmin/v1"), secret.as_bytes())
        .expand(b"plex-token-encryption", &mut key)
        .map_err(|_| anyhow::anyhow!("Invalid encryption key"))?;
    Ok(Aes256Gcm::new_from_slice(&key).expect("32 byte key"))
}
fn encrypt(token: &str, secret: &str) -> Result<(Vec<u8>, Vec<u8>)> {
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce);
    let data = cipher(secret)?
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: token.as_bytes(),
                aad: b"plex-token",
            },
        )
        .map_err(|_| anyhow::anyhow!("Credential encryption failed"))?;
    Ok((data, nonce.to_vec()))
}
fn decrypt(token: &[u8], nonce: &[u8], secret: &str) -> Result<String> {
    ensure!(
        nonce.len() == 12 && token.len() > 16,
        "Invalid encrypted credential"
    );
    let data = cipher(secret)?
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: token,
                aad: b"plex-token",
            },
        )
        .map_err(|_| {
            anyhow::anyhow!("Cannot decrypt saved connection; restore its matching secret")
        })?;
    String::from_utf8(data).context("Invalid credential encoding")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::tempdir;

    fn synthetic_connection() -> PlexConnection {
        PlexConnection {
            token: "fake-server-token".into(),
            account_token: Some("fake-account-token".into()),
            server_id: "synthetic-server".into(),
            base_uri: "http://127.0.0.1:12345/".into(),
            library_id: "1".into(),
        }
    }
    #[test]
    fn jellyfin_owner_encryption_switching_and_reopen_preserve_plex() {
        let root = tempdir().unwrap();
        let mut profile = Profile::open(root.path()).unwrap();
        profile
            .save_connection("owner-1", &synthetic_connection())
            .unwrap();
        let mut jellyfin = JellyfinConnection {
            token: "fake-jellyfin-token".into(),
            server_id: "server".into(),
            user_id: "user".into(),
            base_uri: "http://127.0.0.1:1/jellyfin/".into(),
            library_id: "music".into(),
        };
        let plex_revision = profile.source_revision().unwrap();
        assert!(!plex_revision.is_empty());
        profile.save_jellyfin_connection(&jellyfin).unwrap();
        let jellyfin_revision = profile.source_revision().unwrap();
        assert_ne!(plex_revision, jellyfin_revision);
        let encrypted: Vec<u8> = profile
            .db
            .query_row("SELECT encrypted_token FROM jellyfin_connection", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(
            !encrypted
                .windows(jellyfin.token.len())
                .any(|v| v == jellyfin.token.as_bytes())
        );
        assert_eq!(
            profile.connection().unwrap().unwrap().token,
            "fake-server-token"
        );
        profile
            .save_playlists(&[Playlist {
                id: "jellyfin:playlist:one".into(),
                title: "Synthetic".into(),
                tracks: vec![],
            }])
            .unwrap();
        let stale_source = crate::provider::MusicSource::new(&profile).unwrap();
        profile.set_active_provider(Provider::Plex).unwrap();
        assert!(profile.selected_ids().unwrap().is_empty());
        assert!(
            stale_source
                .playlists(&profile, &std::sync::atomic::AtomicBool::new(false))
                .is_err()
        );
        jellyfin.user_id = "other-user".into();
        assert!(profile.save_jellyfin_connection(&jellyfin).is_err());
        jellyfin.user_id = "user".into();
        jellyfin.server_id = "other-server".into();
        assert!(profile.save_jellyfin_connection(&jellyfin).is_err());
        assert_eq!(profile.active_provider().unwrap(), Provider::Plex);
        profile.set_active_provider(Provider::Jellyfin).unwrap();
        let revision = profile.source_revision().unwrap();
        assert_ne!(revision, jellyfin_revision);
        profile.set_active_provider(Provider::Jellyfin).unwrap();
        assert_eq!(revision, profile.source_revision().unwrap());
        jellyfin.server_id = "server".into();
        jellyfin.library_id = "other-library".into();
        profile.save_jellyfin_connection(&jellyfin).unwrap();
        assert_ne!(revision, profile.source_revision().unwrap());
        profile.set_local_folder(root.path()).unwrap();
        assert_eq!(profile.active_provider().unwrap(), Provider::Local);
        assert!(profile.selected_ids().unwrap().is_empty());
        assert_eq!(
            profile.connection().unwrap().unwrap().token,
            "fake-server-token"
        );
        assert_eq!(
            profile.jellyfin_connection().unwrap().unwrap().token,
            "fake-jellyfin-token"
        );
        profile.set_active_provider(Provider::Jellyfin).unwrap();
        let revision = profile.source_revision().unwrap();
        drop(profile);
        let profile = Profile::open(root.path()).unwrap();
        assert_eq!(revision, profile.source_revision().unwrap());
        assert_eq!(profile.active_provider().unwrap(), Provider::Jellyfin);
        assert_eq!(
            profile.jellyfin_connection().unwrap().unwrap().token,
            "fake-jellyfin-token"
        );
        assert_eq!(profile.owner().unwrap().as_deref(), Some("owner-1"));
    }
    #[test]
    fn historical_sql_matches_the_original_migrations() {
        let original = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../companion/src/persistence/migrations");
        for (i, (name, sql)) in MIGRATIONS.iter().take(11).enumerate() {
            let source =
                fs::read_to_string(original.join(format!("{:03}_{name}.ts", i + 1))).unwrap();
            let original_sql = source
                .split("sql: `")
                .nth(1)
                .unwrap()
                .split('`')
                .next()
                .unwrap()
                .replace(
                    "${emptyManifestRevision}",
                    "e9fc5a5ceba1460d3467860d3bf6a25174754baf43785ad9cf3ec184ddc57c8a",
                );
            assert_eq!(sql.trim(), original_sql.trim());
        }
    }
    #[test]
    fn node_encrypted_connection_survives_upgrade_and_rust_roundtrip() {
        // All values here are synthetic. Node is the independent compatibility oracle.
        let fixture = Command::new("node").arg("-e").arg(r#"
          const c=require('node:crypto');
          const secret='synthetic-secret-with-48-characters-for-tests-only\n';
          const nonce=Buffer.alloc(12,7);
          const key=c.hkdfSync('sha256',Buffer.from(secret),Buffer.from('syncandrun-for-garmin/v1'),'plex-token-encryption',32);
          const cipher=c.createCipheriv('aes-256-gcm',key,nonce); cipher.setAAD(Buffer.from('plex-token'));
          const bytes=Buffer.concat([cipher.update('fake-server-token'),cipher.final(),cipher.getAuthTag()]);
          process.stdout.write(JSON.stringify({secret,nonce:[...nonce],bytes:[...bytes]}));
        "#).output().expect("Node required for legacy credential compatibility check");
        assert!(fixture.status.success());
        let fixture: serde_json::Value = serde_json::from_slice(&fixture.stdout).unwrap();
        let token: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
        let nonce: Vec<u8> = serde_json::from_value(fixture["nonce"].clone()).unwrap();
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("data")).unwrap();
        fs::write(
            root.path().join("secret"),
            fixture["secret"].as_str().unwrap(),
        )
        .unwrap();
        // Build a version-3 database, as the old runtime did, then migrate with Rust.
        let db = Connection::open(root.path().join("data/syncandrun.sqlite")).unwrap();
        db.execute_batch(
            "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT)",
        )
        .unwrap();
        for (i, (name, sql)) in MIGRATIONS.iter().take(3).enumerate() {
            db.execute_batch(sql).unwrap();
            db.execute(
                "INSERT INTO schema_migrations VALUES(?,?,'synthetic')",
                params![i + 1, name],
            )
            .unwrap();
            if i == 0 {
                db.execute_batch("INSERT INTO installation VALUES(1,1,'synthetic-client','now','now'); INSERT INTO settings(id,updated_at) VALUES(1,'now');").unwrap();
            }
        }
        db.execute("INSERT INTO plex_connection(id,encrypted_token,token_nonce,server_machine_id,server_base_uri,library_section_id,created_at,updated_at) VALUES(1,?,?,'synthetic-server','http://127.0.0.1:12345/','1','now','now')",params![token,nonce]).unwrap();
        drop(db);
        let mut profile = Profile::open(root.path()).unwrap();
        assert_eq!(profile.client_id().unwrap(), "synthetic-client");
        assert_eq!(
            profile.connection().unwrap().unwrap().token,
            "fake-server-token"
        );
        assert_eq!(
            profile
                .db
                .query_row("SELECT count(*) FROM schema_migrations", [], |r| r
                    .get::<_, u32>(0))
                .unwrap(),
            12
        );
        profile
            .save_connection("owner-1", &synthetic_connection())
            .unwrap();
        assert!(
            profile
                .save_connection("owner-2", &synthetic_connection())
                .is_err()
        );
        assert_eq!(profile.owner().unwrap().as_deref(), Some("owner-1"));
        let (bytes, nonce): (Vec<u8>, Vec<u8>) = profile
            .db
            .query_row(
                "SELECT encrypted_token,token_nonce FROM plex_connection",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let input = serde_json::json!({"secret":fixture["secret"],"nonce":nonce,"bytes":bytes});
        let mut child = Command::new("node").arg("-e").arg(r#"
          const fs=require('node:fs'),c=require('node:crypto'),v=JSON.parse(fs.readFileSync(0,'utf8'));
          const key=c.hkdfSync('sha256',Buffer.from(v.secret),Buffer.from('syncandrun-for-garmin/v1'),'plex-token-encryption',32);
          const data=Buffer.from(v.bytes),d=c.createDecipheriv('aes-256-gcm',key,Buffer.from(v.nonce));
          d.setAAD(Buffer.from('plex-token'));d.setAuthTag(data.subarray(-16));
          const token=Buffer.concat([d.update(data.subarray(0,-16)),d.final()]).toString();
          process.exit(token==='fake-server-token'?0:1);
        "#).stdin(std::process::Stdio::piped()).spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.to_string().as_bytes())
            .unwrap();
        assert!(child.wait().unwrap().success());
        let backup_dest = tempdir().unwrap();
        let backup = profile.backup(backup_dest.path()).unwrap();
        let restored = Profile::open(backup).unwrap();
        assert_eq!(
            restored
                .connection()
                .unwrap()
                .unwrap()
                .account_token
                .as_deref(),
            Some("fake-account-token")
        );
        assert_eq!(restored.owner().unwrap().as_deref(), Some("owner-1"));
    }
    #[test]
    fn refuses_lost_key_newer_schema_and_tampering() {
        let root = tempdir().unwrap();
        let profile = Profile::open(root.path()).unwrap();
        let (mut bytes, nonce) = encrypt("synthetic-token", &profile.secret).unwrap();
        bytes[0] ^= 1;
        assert!(decrypt(&bytes, &nonce, &profile.secret).is_err());
        profile
            .db
            .execute(
                "INSERT INTO schema_migrations VALUES(13,'future','now')",
                [],
            )
            .unwrap();
        drop(profile);
        assert!(Profile::open(root.path()).is_err());
        fs::remove_file(root.path().join("secret")).unwrap();
        assert!(Profile::open(root.path()).is_err());
        assert!(!root.path().join("secret").exists());
    }
    #[test]
    fn native_jobs_hold_an_exclusive_profile_lock() {
        let root = tempdir().unwrap();
        let profile = Profile::open(root.path()).unwrap();
        assert!(Profile::open(root.path()).is_err());
        drop(profile);
        assert!(Profile::open(root.path()).is_ok());
    }
    #[test]
    fn snapshots_preserve_repeated_entries_and_selection() {
        let root = tempdir().unwrap();
        let mut profile = Profile::open(root.path()).unwrap();
        let t = Track {
            id: "plex:track:1".into(),
            rating_key: "1".into(),
            title: "Synthetic".into(),
            artist: "Artist".into(),
            album: "Album".into(),
            duration_seconds: 60,
        };
        profile
            .save_playlists(&[Playlist {
                id: "plex:playlist:1".into(),
                title: "Synthetic".into(),
                tracks: vec![t.clone(), t],
            }])
            .unwrap();
        let ids = profile.selected_ids().unwrap();
        let plan = profile.plan(&ids).unwrap();
        assert_eq!(plan[0].tracks.len(), 2);
        assert!(profile.plan(&["unselected".into()]).is_err());
        assert!(profile.plan(&[ids[0].clone(), ids[0].clone()]).is_err());
    }
}
