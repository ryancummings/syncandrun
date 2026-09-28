//! Shared local profile, Plex client and export engine. No HTTP listener is started.
pub mod device;
pub mod export;
pub mod plex;
pub mod profile;

use serde::{Deserialize, Serialize};

pub const BITRATES: [u16; 6] = [64, 96, 128, 192, 256, 320];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Track {
    pub id: String,
    pub rating_key: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_seconds: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Playlist {
    pub id: String,
    pub title: String,
    pub tracks: Vec<Track>,
}
