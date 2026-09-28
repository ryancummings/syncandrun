//! Dispatch music requests through the profile's selected provider.
use crate::{
    Playlist, Track,
    jellyfin::Jellyfin,
    plex::{LibraryOverview, PlaylistSummary, Plex},
    profile::{Profile, Provider},
};
use anyhow::{Context, Result, ensure};
use reqwest::blocking::Response;
use std::sync::atomic::AtomicBool;
#[derive(Clone)]
pub enum MusicSource {
    Plex(Plex),
    Jellyfin(Jellyfin),
}
impl MusicSource {
    pub fn new(profile: &Profile) -> Result<Self> {
        Ok(match profile.active_provider()? {
            Provider::Plex => Self::Plex(Plex::new(profile)?),
            Provider::Jellyfin => Self::Jellyfin(Jellyfin::new(profile)?),
        })
    }
    fn check(&self, profile: &Profile) -> Result<()> {
        ensure!(
            matches!(
                (self, profile.active_provider()?),
                (Self::Plex(_), Provider::Plex) | (Self::Jellyfin(_), Provider::Jellyfin)
            ),
            "Music provider changed; reload before continuing"
        );
        Ok(())
    }
    pub fn playlists(
        &self,
        profile: &Profile,
        cancel: &AtomicBool,
    ) -> Result<Vec<PlaylistSummary>> {
        self.check(profile)?;
        match self {
            Self::Plex(p) => p.playlists(
                &profile.connection()?.context("Sign in to Plex first")?,
                cancel,
            ),
            Self::Jellyfin(p) => p.playlists(
                &profile
                    .jellyfin_connection()?
                    .context("Sign in to Jellyfin first")?,
                cancel,
            ),
        }
    }
    pub fn refresh(
        &self,
        profile: &mut Profile,
        ids: &[String],
        cancel: &AtomicBool,
    ) -> Result<Vec<Playlist>> {
        self.check(profile)?;
        match self {
            Self::Plex(p) => p.refresh(profile, ids, cancel),
            Self::Jellyfin(p) => p.refresh(profile, ids, cancel),
        }
    }
    pub fn library_overview(&self, profile: &Profile) -> Result<LibraryOverview> {
        self.check(profile)?;
        match self {
            Self::Plex(p) => {
                p.library_overview(&profile.connection()?.context("Sign in to Plex first")?)
            }
            Self::Jellyfin(p) => p.library_overview(
                &profile
                    .jellyfin_connection()?
                    .context("Sign in to Jellyfin first")?,
            ),
        }
    }
    pub fn audio(&self, profile: &Profile, track: &Track, bitrate: u16) -> Result<Response> {
        self.check(profile)?;
        match self {
            Self::Plex(p) => {
                ensure!(
                    track.id == format!("plex:track:{}", track.rating_key),
                    "Track belongs to a different music provider"
                );
                p.audio(
                    &profile.connection()?.context("Sign in to Plex first")?,
                    track,
                    bitrate,
                )
            }
            Self::Jellyfin(p) => p.audio(
                &profile
                    .jellyfin_connection()?
                    .context("Sign in to Jellyfin first")?,
                track,
                bitrate,
            ),
        }
    }
}
