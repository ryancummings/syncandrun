# Use SyncAndRun

Open the desktop app and sign in with Plex. Choose the server and music library if asked. Check the playlists you want, choose how you will move them to the watch, choose MP3 quality, and choose a save folder. Press **Create music folder**. When the app says **Files ready**, open the folder and follow the transfer instruction shown on screen.

Each export gets a new dated folder. A stopped export stays in a folder ending `.incomplete`; a previous complete folder is left alone. SyncAndRun does not automatically copy to a watch.

For **MTP app**, copy the playlist folders inside the export into the watch's Music folder. On Linux, open the watch in Files, then open Internal Storage → Music and copy the folders there. Eject the watch before unplugging it. A personal Forerunner 955 recognized two such folders as playlists when copied with OpenMTP on Mac. A Linux copy of 20 MP3s at 320 kbps passed byte-for-byte checks. With a plain M3U8 playlist, the playlist appeared on the watch and a track played. For **Garmin Express** on Windows, open the watch's Music page, use My Music to browse to the saved local folder, and send the selected content. Garmin says its scanner needs files on the computer's local disk. For **Music + Express** on Mac or **iTunes + Express** on Windows, add the Tracks folder to the music library first, import `Import playlists.xml`, then use Express to send the playlists. Apple says imported playlists contain only tracks already in the library. Garmin Express does not run on Linux.

The app stores its database and encrypted Plex credential in the user's Electron app data directory. Use **Back up app data** in the menu to copy the database and its secret together; keep that backup private. The app does not install a daemon or auto updater. Closing its window quits the service. It cannot read free space on the watch yet, so check space before copying.

See [transfer sources and limitations](../README.md#move-music-to-a-watch) and [validation](VALIDATION.md).
