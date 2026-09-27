# Validation

Automated checks cover TypeScript, Plex sign-in and ownership, playlist snapshots, desktop UI flow, MP3 export layout, and failed-export isolation. Build and launch the native package on each target operating system before describing it as supported. Use an empty isolated profile for launch checks and record the source commit, artifact hash, OS, and result.

The Linux package has built and launched with a ready loopback service. Native macOS and Windows package launches remain unverified. A previous two-folder export copied with OpenMTP appeared as playlists on a personal Forerunner 955. On Linux, the 320 kbps export copied 20 MP3s through GVfs MTP and every file matched the source byte for byte. The watch discarded an extended M3U8 file with an `#EXTM3U` header; a plain relative-path M3U8 survived, was rewritten by the watch to device paths, appeared under its exported title, and played a track. This confirms one Linux playlist transfer and playback at 320 kbps. It does not verify every track, playlist order, other bitrates, or the Music/iTunes and Express routes.

For physical acceptance, using only music the owner authorizes for testing:

1. Export two playlists at 192 kbps and copy their folders into the Forerunner 955 Music folder with OpenMTP. Check names, order, repeated entries, tags, and playback.
2. Repeat at 320 kbps. Garmin documents MP3 support but the cited format list does not set a maximum bitrate for this watch.
3. Check an interrupted export and a playlist with shared tracks. Confirm an earlier complete export still works.
4. On macOS, add Tracks to Music, import the XML, and confirm Express sees and sends both playlists.
5. On Windows, check Express's local-folder scanner and the iTunes XML route. On Linux, check direct MTP transfer with the target watch.
6. Compare the app's size estimate with actual output and the watch's available space. The app cannot inspect watch storage yet.

Record model, firmware, transfer method, app/OS versions, commit, and result without posting private playlist names, media, tokens, or profile data. Do not claim a route or bitrate has been accepted by hardware until it has been tested.
