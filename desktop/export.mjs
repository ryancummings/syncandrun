import { createWriteStream } from "node:fs";
import { mkdir, open, rename, stat, statfs, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const bitrates = [64, 96, 128, 192, 256, 320];
export const routes = ["mtp", "express", "music"];

export function readExportPlan(database, playlistIds) {
  if (!Array.isArray(playlistIds) || playlistIds.length === 0 || playlistIds.length > 500 ||
      new Set(playlistIds).size !== playlistIds.length || playlistIds.some((id) => typeof id !== "string")) {
    throw new Error("Choose at least one playlist.");
  }
  const selected = JSON.parse(database.prepare("SELECT selected_playlist_ids FROM settings WHERE id = 1").get().selected_playlist_ids);
  if (playlistIds.some((id) => !selected.includes(id))) throw new Error("Save the selected playlists before exporting.");
  const getPlaylist = database.prepare("SELECT title, ordered_track_ids FROM playlist_snapshots WHERE playlist_id = ?");
  const getTrack = database.prepare("SELECT title, artist, album, duration_seconds FROM track_metadata WHERE track_id = ?");
  return playlistIds.map((id) => {
    const row = getPlaylist.get(id);
    if (!row) throw new Error("A playlist is not ready. Refresh your Plex playlists and try again.");
    const trackIds = JSON.parse(row.ordered_track_ids);
    if (!Array.isArray(trackIds) || trackIds.length > 10000) throw new Error("A playlist has too many tracks.");
    return {
      id,
      title: row.title,
      tracks: trackIds.map((trackId) => {
        const track = getTrack.get(trackId);
        if (!track) throw new Error("A track is unavailable. Refresh your Plex playlists and try again.");
        return { id: trackId, ...track };
      })
    };
  });
}

export function estimateExport(plan, bitrate, route) {
  const tracks = route === "mtp" ? plan.flatMap((playlist) => playlist.tracks) :
    [...new Map(plan.flatMap((playlist) => playlist.tracks).map((track) => [track.id, track])).values()];
  return {
    tracks: tracks.length,
    bytes: Math.ceil(tracks.reduce((seconds, track) => seconds + track.duration_seconds, 0) * bitrate * 1000 / 8 * 1.03)
  };
}

function safeName(value) {
  const clean = String(value).normalize("NFC").replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/[. ]+$/g, "").trim();
  const name = clean.slice(0, 80) || "Music";
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name) ? `_${name}` : name;
}

function shortId(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function uniqueName(base, used) {
  let name = base;
  for (let index = 2; used.has(name.toLowerCase()); index++) name = `${base} ${index}`;
  used.add(name.toLowerCase());
  return name;
}

function id3Tag(track) {
  const frame = (id, value) => {
    // ID3v2.3 text frames use UTF-16 (encoding 1), which older Garmin players read.
    const payload = Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(String(value), "utf16le")]);
    const header = Buffer.alloc(10);
    header.write(id, 0, 4, "ascii");
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };
  const body = Buffer.concat([
    frame("TIT2", track.title), frame("TPE1", track.artist), frame("TALB", track.album)
  ]);
  const header = Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00", "binary");
  let size = body.length;
  for (let index = 9; index >= 6; index--) { header[index] = size & 0x7f; size >>= 7; }
  return Buffer.concat([header, body]);
}

async function* withoutSourceTag(source) {
  let buffer = Buffer.alloc(0);
  let decided = false;
  let skip = 0;
  for await (const chunk of source) {
    buffer = Buffer.concat([buffer, chunk]);
    if (!decided && buffer.length >= 10) {
      decided = true;
      if (buffer.toString("ascii", 0, 3) === "ID3") {
        skip = 10 + ((buffer[6] & 0x7f) << 21) + ((buffer[7] & 0x7f) << 14) + ((buffer[8] & 0x7f) << 7) + (buffer[9] & 0x7f);
        if (buffer[5] & 0x10) skip += 10;
      }
    }
    if (!decided) continue;
    if (skip > 0) {
      const consumed = Math.min(skip, buffer.length);
      skip -= consumed;
      buffer = buffer.subarray(consumed);
    }
    if (buffer.length) { yield buffer; buffer = Buffer.alloc(0); }
  }
  if (!decided || skip > 0) throw new Error("Plex returned an incomplete MP3.");
}

async function writeTrack(path, track, stream) {
  const temp = `${path}.part`;
  const handle = await open(temp, "wx");
  try {
    await handle.writeFile(id3Tag(track));
  } finally { await handle.close(); }
  try {
    await pipeline(Readable.from(withoutSourceTag(stream)), createWriteStream(temp, { flags: "a" }));
    const head = await open(temp, "r");
    try {
      const header = Buffer.alloc(10);
      await head.read(header, 0, 10, 0);
      const tagSize = 10 + ((header[6] & 0x7f) << 21) + ((header[7] & 0x7f) << 14) + ((header[8] & 0x7f) << 7) + (header[9] & 0x7f);
      const info = await stat(temp);
      const audio = Buffer.alloc(2);
      await head.read(audio, 0, 2, tagSize);
      if (info.size < tagSize + 4 || audio[0] !== 0xff || (audio[1] & 0xe0) !== 0xe0) {
        throw new Error("Plex returned audio that is not a valid MP3.");
      }
    } finally { await head.close(); }
    await rename(temp, path);
  } catch (error) {
    const { rm } = await import("node:fs/promises");
    await rm(temp, { force: true });
    throw error;
  }
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function musicXml(plan, locations) {
  let index = 0;
  const ids = new Map();
  const tracks = [];
  for (const playlist of plan) for (const track of playlist.tracks) {
    if (ids.has(track.id)) continue;
    const id = ++index;
    ids.set(track.id, id);
    tracks.push(`<key>${id}</key><dict><key>Track ID</key><integer>${id}</integer><key>Name</key><string>${xml(track.title)}</string><key>Artist</key><string>${xml(track.artist)}</string><key>Album</key><string>${xml(track.album)}</string><key>Location</key><string>${xml(pathToFileURL(locations.get(track.id)).href)}</string></dict>`);
  }
  const playlists = plan.map((playlist, number) => `<dict><key>Name</key><string>${xml(playlist.title)}</string><key>Playlist ID</key><integer>${number + 1}</integer><key>Playlist Items</key><array>${playlist.tracks.map((track) => `<dict><key>Track ID</key><integer>${ids.get(track.id)}</integer></dict>`).join("")}</array></dict>`);
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Major Version</key><integer>1</integer><key>Minor Version</key><integer>1</integer><key>Tracks</key><dict>${tracks.join("")}</dict><key>Playlists</key><array>${playlists.join("")}</array></dict></plist>\n`;
}

export async function exportMusic({ plan, bitrate, route, destination, openAudio, onProgress = () => {} }) {
  if (!bitrates.includes(bitrate) || !routes.includes(route)) throw new Error("Choose a valid quality and transfer method.");
  if (!plan.length) throw new Error("Choose at least one playlist.");
  const disk = await statfs(destination);
  if (estimateExport(plan, bitrate, route).bytes > disk.bavail * disk.bsize) {
    throw new Error("The save folder does not have enough free space for this export.");
  }
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const root = join(destination, `SyncAndRun ${stamp}.incomplete`);
  const finished = root.slice(0, -".incomplete".length);
  await mkdir(root, { recursive: false });
  const expected = estimateExport(plan, bitrate, route).tracks;
  let completed = 0;
  const locations = new Map();
  const usedFolders = new Set();
  const usedShared = new Set();
  try {
    if (route !== "mtp") await mkdir(join(root, "Tracks"));
    for (const playlist of plan) {
      const folderName = uniqueName(safeName(playlist.title), usedFolders);
      const folder = route === "mtp" ? join(root, folderName) : root;
      if (route === "mtp") await mkdir(folder);
      const lines = ["#EXTM3U"];
      const usedFiles = new Set();
      for (const track of playlist.tracks) {
        let path;
        if (route === "mtp") {
          const base = `${safeName(track.artist)} - ${safeName(track.title)} ${shortId(track.id)}`;
          const filename = `${uniqueName(base, usedFiles)}.mp3`;
          path = join(folder, filename);
          const audio = await openAudio(track.id, bitrate);
          await writeTrack(path, track, audio.body);
          completed++;
          onProgress({ completed, expected, title: track.title });
          lines.push(filename);
        } else {
          path = locations.get(track.id);
          if (!path) {
            const base = `${safeName(track.artist)} - ${safeName(track.title)} ${shortId(track.id)}`;
            path = join(root, "Tracks", `${uniqueName(base, usedShared)}.mp3`);
            const audio = await openAudio(track.id, bitrate);
            await writeTrack(path, track, audio.body);
            locations.set(track.id, path);
            completed++;
            onProgress({ completed, expected, title: track.title });
          }
          lines.push(relative(root, path).split("\\").join("/"));
        }
      }
      const playlistPath = route === "mtp" ? join(folder, `${folderName}.m3u8`) : join(root, `${folderName}.m3u8`);
      await writeFile(playlistPath, lines.join("\n") + "\n", { flag: "wx" });
    }
    if (route === "music") {
      // Music/iTunes includes only tracks already added to its library.
      const finalLocations = new Map([...locations].map(([id, path]) => [id, join(finished, relative(root, path))]));
      await writeFile(join(root, "Import playlists.xml"), musicXml(plan, finalLocations), { flag: "wx" });
    }
    await rename(root, finished);
    return { path: finished, completed, route };
  } catch (error) {
    error.exportPath = root;
    throw error;
  }
}
