# Cozy-Fi Privacy Notice

Last updated: August 23, 2026

Cozy-Fi is a local desktop application. It does not operate a Cozy-Fi server and does not sell or share personal data.

When you connect Spotify, the app requests access needed to display your profile, saved library, playlists, top and recently played music, playback state, and queue, and to control playback, modify your saved library, and create playlists. Those requests go directly from the Electron main process to Spotify.

The app stores your Spotify Developer Client ID and playback-mode preference in Electron's local user-data directory. Theme/font preferences and any custom palettes you create stay in the app's local browser storage. It stores the Web API refresh token only when genuine operating-system credential encryption is available; otherwise the refresh token remains memory-only for that run. On Linux, Cozy-Fi rejects Electron's insecure `basic_text` fallback and requires an unlocked Secret Service or KWallet-compatible keyring before it persists that token. Short-lived access tokens remain outside the renderer and browser local storage and are not passed to the playback child process.

On first use, the local playback engine performs its own interactive Spotify authorization with only the `streaming` scope. Librespot writes the resulting reusable player credential under Cozy-Fi's per-user application-data directory so playback can start later without Spotify or a browser open. Librespot does not encrypt this cache file itself. Cozy-Fi deletes it when you select **DISCONNECT**.

Cozy-Fi temporarily holds Spotify metadata and artwork in memory while the app is open. It does not create a separate analytics database or transmit that information to the project author.

Select **DISCONNECT** in Settings to delete the locally retained Spotify refresh token and local-player credential, stop playback, and stop further Spotify requests. You may also revoke access from your Spotify account/app settings.

If you fork or redistribute Cozy-Fi, you are responsible for updating this notice with your contact information and accurately describing any changes to data handling.
