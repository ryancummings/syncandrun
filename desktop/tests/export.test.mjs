import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { exportMusic, estimateExport, readExportPlan } from "../export.mjs";

const fakeTrack = { id: "plex:track:1", title: "Test song", artist: "Test artist", album: "Test album", duration_seconds: 180 };
const fakePlan = [
  { id: "plex:playlist:1", title: "First list", tracks: [fakeTrack, fakeTrack] },
  { id: "plex:playlist:2", title: "Second list", tracks: [fakeTrack] }
];
const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(100)]);

function openAudio() { return { body: Readable.from([frame]) }; }

test("MTP export makes separate playlist folders with tagged MP3s and ordered relative entries", async (context) => {
  const destination = await mkdtemp(join(tmpdir(), "syncandrun-export-test-"));
  context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(destination, { recursive: true, force: true }); });
  const result = await exportMusic({ plan: fakePlan, bitrate: 320, route: "mtp", destination, openAudio });
  assert.equal(result.completed, 3);
  assert.equal(estimateExport(fakePlan, 320, "mtp").tracks, 3);
  for (const title of ["First list", "Second list"]) {
    const folder = join(result.path, title);
    const lines = (await readFile(join(folder, `${title}.m3u8`), "utf8")).trim().split("\n");
    assert.equal(lines.length, title === "First list" ? 2 : 1);
    for (const filename of lines) {
      assert.equal(filename.includes("/"), false);
      const data = await readFile(join(folder, filename));
      assert.equal(data.toString("ascii", 0, 3), "ID3");
      assert.ok(data.includes(Buffer.from("Test song", "utf16le")));
      assert.ok(data.includes(frame));
    }
  }
  assert.ok(!(await readdir(destination)).some((name) => name.endsWith(".incomplete")));
});

test("Music export stores shared tracks once and writes final file URLs", async (context) => {
  const destination = await mkdtemp(join(tmpdir(), "syncandrun-export-test-"));
  context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(destination, { recursive: true, force: true }); });
  const result = await exportMusic({ plan: fakePlan, bitrate: 192, route: "music", destination, openAudio });
  assert.equal(result.completed, 1);
  assert.equal((await readdir(join(result.path, "Tracks"))).length, 1);
  const xml = await readFile(join(result.path, "Import playlists.xml"), "utf8");
  assert.ok(xml.includes("file://"));
  assert.ok(!xml.includes(".incomplete"));
  for (const title of ["First list", "Second list"]) {
    const lines = (await readFile(join(result.path, `${title}.m3u8`), "utf8")).trim().split("\n");
    for (const line of lines.slice(1)) assert.ok((await stat(join(result.path, line))).isFile());
  }
});

test("plan only reads saved playlists and stored snapshot tracks", () => {
  const database = { prepare(sql) { return { get(id) {
    if (sql.includes("selected_playlist_ids")) return { selected_playlist_ids: '["plex:playlist:1"]' };
    if (sql.includes("playlist_snapshots")) return id === "plex:playlist:1" ? { title: "First list", ordered_track_ids: '["plex:track:1"]' } : undefined;
    if (sql.includes("track_metadata")) return id === "plex:track:1" ? fakeTrack : undefined;
  } }; } };
  assert.equal(readExportPlan(database, ["plex:playlist:1"])[0].tracks[0].title, "Test song");
  assert.throws(() => readExportPlan(database, ["plex:playlist:2"]), /Save the selected playlists/);
});

test("failed export leaves previous complete output intact", async (context) => {
  const destination = await mkdtemp(join(tmpdir(), "syncandrun-export-test-"));
  context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(destination, { recursive: true, force: true }); });
  const complete = await exportMusic({ plan: fakePlan.slice(0, 1), bitrate: 128, route: "mtp", destination, openAudio });
  let error;
  try {
    await exportMusic({ plan: fakePlan, bitrate: 128, route: "mtp", destination,
      openAudio: () => { throw new Error("Synthetic Plex failure"); } });
  } catch (cause) { error = cause; }
  assert.match(error.message, /Synthetic Plex failure/);
  assert.match(error.exportPath, /\.incomplete$/);
  assert.ok((await stat(complete.path)).isDirectory());
  assert.ok((await stat(error.exportPath)).isDirectory());
});
