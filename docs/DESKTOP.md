# Use the desktop app

Open SyncAndRun and choose Plex, Jellyfin, or Local folder in the sidebar. For Plex, sign in through the browser. For Jellyfin, enter your server address, user name, and password. For Local folder, choose a folder with MP3 or FLAC files. The app saves each connection in a local profile for one owner.

Choose playlists on the Playlists page. Use the Transfer panel on the right to choose the destination and MP3 quality. Select Device to send music over USB. Connect your Garmin music watch in USB transfer mode, then wait for its name and free space to appear in the device card at the bottom of the sidebar. If another app uses the watch, close or unmount it and select Scan again.

Keep adds the playlists and keeps the music already on the watch. Replace sends and checks the new playlists first. It then removes recognized old music from the watch's `Music` folder. That removal cannot be undone and needs enough space for both sets of music during transfer. The Device content page lets you inspect or remove one item at a time.

Select Folder if you want to copy files with another MTP app. Choose a local music folder. Copy the exported playlist folders into the watch's `Music` folder, then eject the watch before you unplug it. A stopped export keeps an `.incomplete` folder and leaves the last complete export intact.

The Settings page can back up the local profile. The backup includes the database and encryption secret. Keep it private. See [the native guide](RUST.md#existing-profiles) for profile paths and CLI commands.
