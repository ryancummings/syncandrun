//! Dispatch music requests through the profile's selected provider.
use crate::{
    Playlist, Track,
    jellyfin::Jellyfin,
    local,
    plex::{LibraryOverview, PlaylistSummary, Plex},
    profile::{Profile, Provider},
};
use anyhow::{Context, Result, ensure};
use std::{io::Read, sync::atomic::AtomicBool};
#[derive(Clone)]
pub enum MusicSource {
    Plex(Plex),
    Jellyfin(Jellyfin),
    Local,
}
impl MusicSource {
    pub fn new(profile: &Profile) -> Result<Self> {
        Ok(match profile.active_provider()? {
            Provider::Plex => Self::Plex(Plex::new(profile)?),
            Provider::Jellyfin => Self::Jellyfin(Jellyfin::new(profile)?),
            Provider::Local => Self::Local,
        })
    }
    fn check(&self, profile: &Profile) -> Result<()> {
        ensure!(
            matches!(
                (self, profile.active_provider()?),
                (Self::Plex(_), Provider::Plex)
                    | (Self::Jellyfin(_), Provider::Jellyfin)
                    | (Self::Local, Provider::Local)
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
            Self::Local => local::summaries(
                &profile
                    .local_folder()?
                    .context("Choose a local music folder first")?,
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
            Self::Local => {
                let all = local::discover(
                    &profile
                        .local_folder()?
                        .context("Choose a local music folder first")?,
                    cancel,
                )?;
                let chosen: Vec<_> = all.into_iter().filter(|p| ids.contains(&p.id)).collect();
                ensure!(
                    chosen.len() == ids.len(),
                    "Local music changed; reload playlists"
                );
                profile.save_playlists(&chosen)?;
                Ok(chosen)
            }
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
            Self::Local => Ok(local::overview(
                &profile
                    .local_folder()?
                    .context("Choose a local music folder first")?,
            )),
        }
    }
    pub fn audio(&self, profile: &Profile, track: &Track, bitrate: u16) -> Result<Box<dyn Read>> {
        self.check(profile)?;
        match self {
            Self::Plex(p) => {
                ensure!(
                    track.id == format!("plex:track:{}", track.rating_key),
                    "Track belongs to a different music provider"
                );
                Ok(Box::new(p.audio(
                    &profile.connection()?.context("Sign in to Plex first")?,
                    track,
                    bitrate,
                )?))
            }
            Self::Jellyfin(p) => Ok(Box::new(
                p.audio(
                    &profile
                        .jellyfin_connection()?
                        .context("Sign in to Jellyfin first")?,
                    track,
                    bitrate,
                )?,
            )),
            Self::Local => local::audio(
                &profile
                    .local_folder()?
                    .context("Choose a local music folder first")?,
                track,
                bitrate,
            ),
        }
    }
}
