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
| Forerunner 955 Solar | [Personal audio in Garmin Express](https://www8.garmin.com/manuals/webhelp/GUID-9D99A9D4-467A-4F1A-A0EA-023184FEA3DD/EN-AU/GUID-CD4439DF-46FF-4279-A8D5-8DA61C87A4EB.html) | Direct Linux MTP transfer, playlist indexing, and synthetic playback checked on firmware 2905. See [validation](VALIDATION.md). |
| Forerunner 965 | [Personal audio and playlists](https://www8.garmin.com/manuals/webhelp/GUID-0221611A-992D-495E-8DED-1DD448F7A066/EN-GB/GUID-CD4439DF-46FF-4279-A8D5-8DA61C87A4EB.html) | Format documented; direct SyncAndRun transfer untested. |
| fēnix 8 | [Personal audio and playlists](https://www8.garmin.com/manuals/webhelp/GUID-EECCAC99-90D6-4AB1-9A3A-EC433D3365E2/EN-US/fenix_8_Series_OM_EN-US.pdf) | Format documented; direct SyncAndRun transfer untested. |
| Venu 3 series | [Personal audio and playlists](https://www8.garmin.com/manuals/webhelp/GUID-9CC4A873-E034-4A06-B2E0-636DCFE760EE/EN-US/GUID-CD4439DF-46FF-4279-A8D5-8DA61C87A4EB.html) | Format documented; direct SyncAndRun transfer untested. |
| vívoactive 5 | [Personal audio and playlists](https://www8.garmin.com/manuals/webhelp/GUID-5D183A14-BB43-4A9B-B441-5F824214CE40/EN-GB/vivoactive_5_OM_EN-US.pdf) | Format documented; direct SyncAndRun transfer untested. |

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
