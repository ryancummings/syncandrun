# Garmin music-watch compatibility

SyncAndRun exports non-DRM MP3 files with ID3 tags and M3U8 playlists. Garmin
[lists both formats for music watches](https://support.garmin.com/en-US/?faq=JyNEOTsZaR3KMXqej3oQp5).
Garmin also [lists devices that use USB MTP](https://support.garmin.com/en-US/?faq=CZqibgTHMb0dAYEaj2UiU7).
These are separate capabilities: an MTP device is not necessarily a music watch,
and a music-capable model may have variants without onboard music.
Garmin [says watches with music storage use MTP over USB](https://support.garmin.com/fr-CH/?faq=zUa4z1zKNn39o6JiqZDHNA&productID=621922&tab=topics),
but the watch must be in its transfer mode and another application cannot own
its MTP connection at the same time.

| Watch family | Garmin evidence for personal audio | SyncAndRun status |
| --- | --- | --- |
| Forerunner 955 Solar | [Personal audio in Garmin Express](https://www8.garmin.com/manuals/webhelp/GUID-9D99A9D4-467A-4F1A-A0EA-023184FEA3DD/EN-AU/GUID-CD4439DF-46FF-4279-A8D5-8DA61C87A4EB.html) | Direct Linux MTP transfer, playlist indexing, and synthetic playback checked on firmware 2905. The owner also confirmed Mac-to-watch transfer and playback. See [validation](VALIDATION.md). |
| Forerunner 965 | [Personal audio and playlists](https://www8.garmin.com/manuals/webhelp/GUID-0221611A-992D-495E-8DED-1DD448F7A066/EN-GB/GUID-CD4439DF-46FF-4279-A8D5-8DA61C87A4EB.html) | Format documented; direct SyncAndRun transfer untested. |
| fēnix 8 | [Personal audio and playlists](https://www8.garmin.com/manuals/webhelp/GUID-EECCAC99-90D6-4AB1-9A3A-EC433D3365E2/EN-US/fenix_8_Series_OM_EN-US.pdf) | Format documented; direct SyncAndRun transfer untested. |
| Venu 3 series | [Personal audio and playlists](https://www8.garmin.com/manuals/webhelp/GUID-9CC4A873-E034-4A06-B2E0-636DCFE760EE/EN-US/GUID-CD4439DF-46FF-4279-A8D5-8DA61C87A4EB.html) | Format documented; direct SyncAndRun transfer untested. |
| vívoactive 5 | [Personal audio and playlists](https://www8.garmin.com/manuals/webhelp/GUID-5D183A14-BB43-4A9B-B441-5F824214CE40/EN-GB/vivoactive_5_OM_EN-US.pdf) | Format documented; direct SyncAndRun transfer untested. |

## Likely device fit from owner reports

These are leads for testing, not SyncAndRun device passes. An owner showing that
MP3 files transfer proves less than an indexed M3U8 playlist in the expected
order. Other people's firmware, MTP clients, and audio files may differ.

| Suspected fit | Evidence and remaining gap |
| --- | --- |
| **Likely:** Forerunner 245 Music | An [owner copied music through Linux GVfs MTP](https://www.reddit.com/r/Garmin/comments/shsh6o/linux_mtp_with_garmin_forerunner_245_music/); other MTP clients failed to write its `Music` folder. [Garmin documents personal MP3 transfer](https://www8.garmin.com/manuals/webhelp/forerunner245/EN-US/GUID-CD4439DF-46FF-4279-A8D5-8DA61C87A4EB.html). No report checks SyncAndRun's playlist object type or `0:/MUSIC/` paths. |
| **Likely:** Forerunner 965 | An [owner copied tagged MP3s with Fedora/KDE MTP and played them](https://www.reddit.com/r/GarminWatches/comments/1c0ox8k/linux_users_how_are_you_interacting_with_your/). Playlist indexing remains unreported. |
| **Likely:** Forerunner 170 Music | An [owner copied MP3s to `Music` from Arch/KDE and played them](https://www.reddit.com/r/GarminWatches/comments/1dhppxv/garmin_mp3_and_linux/). Confirm the exact **Music** edition; playlist indexing remains unreported. |
| **Promising with playlist-location caveat:** fēnix 7S Sapphire Solar | A [Garmin forum owner found M3U8 playlists became visible when placed under `Music`, rather than a separate `Playlists` folder](https://forums.garmin.com/outdoor-recreation/outdoor-recreation/f/fenix-7-series/324738/difficulty-loading-playlists-m3u8-on-fenix-7s-sapphire-solar). SyncAndRun already puts playlists under `Music`, but this does not verify its path syntax or object type. |
| **Uncertain:** Forerunner 265 | An [owner needed GVfs after other Linux MTP clients failed](https://www.reddit.com/r/GarminWatches/comments/1qmirz6/music_on_the_garmin_forerunner_without_garmin/). SyncAndRun uses unique run folders and checks immediate read-back, but a reconnect and on-watch check are essential. |
| **Uncertain for direct copy:** Venu 3 | An [owner saw manually copied files disappear after disconnection, while Garmin Express worked](https://www.reddit.com/r/GarminWatches/comments/1l32ka2/garmin_music/). Garmin documents personal music through Express. Treat direct MTP as unverified; Express remains the documented route. |

### Likely incompatible with this product's watch-music flow

The distinction is **onboard music storage**, not whether a watch can control
music playing on a phone. Do not send an export to a watch that only has phone
music controls.

| Watch | Reason |
| --- | --- |
| Forerunner 245 without **Music** | Garmin's [245/245 Music manual](https://www8.garmin.com/manuals/webhelp/forerunner245/EN-US/GUID-8702C05F-0915-455A-AABA-079D8374FCD8.html) assigns downloaded personal audio to the Music edition; the [plain 245's music control is for a connected phone](https://www8.garmin.com/manuals/webhelp/forerunner245/EN-US/GUID-D83E3D72-AF28-4388-BECE-AA6E3CB7BE4B.html). |
| Forerunner 165 without **Music** | [Garmin says music storage is available only on the 165 Music](https://www.garmin.com/en-US/newsroom/press-release/sports-fitness/light-up-your-run-with-the-garmin-forerunner-165-series-easy-to-use-gps-running-smartwatches-with-vibrant-amoled-displays/). |
| Forerunner 255/255S without **Music** | Garmin's [255 series manual](https://www8.garmin.com/manuals/webhelp/GUID-676967A0-1B23-4384-9BC9-76F3D643F1C8/EN-GB/GUID-8702C05F-0915-455A-AABA-079D8374FCD8.html) assigns downloaded personal audio to the music editions. Verify the exact edition before transfer. |
| Forerunner 55 | Its [manual describes control of music on a connected phone](https://www8.garmin.com/manuals/webhelp/GUID-3A791586-B59F-4B37-B9C5-5A41F8C6BE0B/EN-GB/GUID-1B4911D9-E2F6-44A1-90B7-5E7573B44D10.html), not storage and playback of personal audio on the watch. |

The table is a sample across product families, not a model allowlist. Check the
exact model and edition for **onboard personal audio** before using the export.
The folder export and Garmin Express route are the broadest documented path:
Garmin's manuals explicitly describe sending songs or playlists with Express.
Garmin does not document SyncAndRun's direct libmtp path, its MTP playlist object
type, or the `0:/MUSIC/` playlist references used by the direct transfer. Those
details were learned from one Forerunner 955 Solar. USB read-back confirms stored
bytes, but only browsing and playback on the watch confirm music indexing.

## Add a model to the checked list

Use synthetic audio and an isolated profile. Record the exact model, edition,
firmware, host OS, libmtp version, SyncAndRun commit, and transfer route. Never
publish real playlist names, media, credentials, or profile contents.

1. Confirm Garmin documents personal audio for the exact edition. On Linux,
   connect it and confirm SyncAndRun detects a writable storage with plausible
   free space. If several storages appear, record which contains `Music`.
2. Run `python3 scripts/watch-smoke.py --write-watch` with its synthetic music.
   Confirm MP3 and playlist USB read-back succeeds.
3. Disconnect cleanly, open **My Music** on the watch, and check both playlist
   names, entry order, repeated entries, and playback of every test tone.
4. Reconnect and check that the new folders appear only under the selected
   storage's `Music` folder. Check add mode retains existing music. Test replace
   mode only on a disposable music library you are willing to erase.
5. For a separate folder route, copy a synthetic folder export with an MTP app
   or send it through Garmin Express, then repeat the on-watch checks. Record
   these as separate results from direct transfer.

If a different model rewrites paths, reports a different music volume, or
ignores MTP playlist objects, preserve its observed files and firmware details
in a sanitized issue. Do not infer that another model passed from a successful
file upload or from Garmin's general format list.
