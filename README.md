# Local Video Server

An Express-based local video library that:

- Scans `Videos/` recursively and builds `data/library.json`.
- Treats top-level files as standalone videos.
- Treats folders as shows/playlists.
- Supports either:
  - `Videos/Show/E01.mp4` → one-season show
  - `Videos/Show/S1/E01.mp4`, `S2/E01.mp4` → multi-season show
- Gives every video a persistent unique watch ID.
- Generates WebP cover thumbnails only when a card or player requests one.
- Generates scrubber preview strips only when the player timeline is used.
- Uses a dedicated thumbnail worker. Other application modules do not manipulate `thumbnailProcess.json`.
- Uses one FFmpeg thumbnail job by default so playback stays responsive on a
  low-power host. Set `THUMBNAIL_CONCURRENCY` if the host has spare CPU.
- Streams videos with HTTP range support.
- Normalizes uploaded videos to MP4 (H.264 video + AAC audio) and songs to
  MP3, so browser playback does not depend on source codecs such as E-AC-3.
- Lets each owner detect existing video codecs in My space; incompatible files
  are archived under `Old/` and replaced with browser-safe MP4/H.264/AAC output.
- Provides `/watch?v=VIDEO_ID`.
- Provides a YouTube-inspired responsive interface with:
  - Home
  - expandable library sidebar
  - standalone videos
  - show/season playlists
  - next/back
  - play/pause
  - volume/mute
  - seek bar
  - theater mode
  - fullscreen
  - collapsible playlist panel
  - chronological "Other videos" list

## Requirements

- Node.js 18+
- Bundled `ffmpeg/ffmpeg.exe` and `ffmpeg/ffprobe.exe` (included with this project)

Check:

```bash
node --version
ffmpeg\\ffmpeg.exe -version
```

## Install

```bash
npm install
npm start
```

## Windows startup service

To start the server automatically when Windows starts, and restart it after a
crash, open PowerShell as Administrator in this folder and run:

```powershell
.\scripts\install-startup-service.ps1
```

This creates a Windows Task Scheduler service named `K Streamer Server`. Its
watchdog starts `src/server.js` again after it exits. To remove it later:

```powershell
.\scripts\uninstall-startup-service.ps1
```

Windows requires an administrator to register a task that starts before sign-in.
If you prefer a no-admin setup, run `scripts\\install-logon-watchdog.ps1` instead;
it starts the same watchdog automatically when you sign in.

Open:

```text
http://localhost:8080
```

For LAN access, open the machine's LAN IP, for example:

```text
http://192.168.8.111:8080
```

## HTTPS

The server automatically uses HTTPS if both files exist:

```text
certs/server.key
certs/server.crt
```

Then it serves:

```text
https://192.168.8.111:8080
```

You can generate a self-signed certificate for a private LAN. Browsers will warn about a self-signed certificate until you trust it.

## Folder layout

Example:

```text
Videos/
├── Movie.mp4
├── Another Video.mkv
├── Breaking Bad/
│   ├── S1/
│   │   ├── E01.mp4
│   │   ├── E02.mp4
│   │   └── E03.mp4
│   └── S2/
│       ├── E01.mp4
│       └── E02.mp4
└── One Season Show/
    ├── E01.mp4
    ├── E02.mp4
    └── E03.mp4
```

A folder containing media files directly is interpreted as a one-season show. A folder containing season directories is interpreted as a multi-season show.

Episode ordering prefers the numeric value in `E01`, `E02`, etc. If a file has no episode number, filename sorting is used.

## Architecture

`src/library.js`
- Owns the library structure.
- Scans files.
- Preserves IDs between scans.
- Determines show/season/episode relationships.

`src/thumbnailQueue.js`
- The ONLY module that owns `thumbnailProcess.json`.
- Maintains an in-memory queue and persists state atomically.
- Prevents duplicate work.
- Queues only client-requested work, with player preview strips ahead of cover
  art requests.
- Marks jobs running, completed, failed, and removes completed jobs.

`src/server.js`
- Express routes.
- Video range streaming.
- API.
- Static frontend.

`public/`
- YouTube-like UI.

## Concurrency guarantees

The thumbnail worker is intentionally isolated from the rest of the application.

A job is identified by the persistent video ID. Before spawning FFmpeg, the worker records the job as `processing`. State is written atomically using a temporary JSON file followed by rename.

A job is not queued twice in the same process. On startup, stale `processing` entries are reset to pending because a Node process cannot still be processing a job after it has exited.

Thumbnail generation is skipped once the required generated files already exist. A rescan only refreshes the library index; it never starts a thumbnail sweep.

FFmpeg is invoked with `spawn()` rather than a shell, so video paths are passed as arguments instead of being interpolated into a command string.

The server does not expose `thumbnailProcess.json`.

## API

```text
GET /api/library
GET /api/videos
GET /api/video/:id
GET /api/playlist/:id
GET /api/thumbnail-status
GET /api/devices
POST /api/devices/:id/command
POST /api/devices/:id/name
POST /api/console
POST /api/thumbnails/:id
POST /api/previews/:id
GET /watch?v=<id>
GET /stream/<id>
GET /thumbnails/<filename>
```

## Updating the library

The scanner runs at startup and can also be triggered with:

```text
POST /api/rescan
```

The frontend has a refresh button in the sidebar.

## Device console

Every open home or watch page registers itself with the server and stays live
while it is open. The server terminal accepts these commands:

```text
/device list
/device all video-pause
/device 192.168.8.120 register-name Lounge-TV
/device TV send-message "Movie starts in five minutes"
/device TV video-play
/device TV video-toggle-play
/device TV video-skip-forward-10
/device TV video-volume-value 35
/device TV video-f-screen
/device TV video-theater-mode
/device TV video-next
/device TV video-previous
/device TV video-mini-player
/device TV video-skip-intro
/device TV video-skip-outro
/device TV video-autoplay off
/device TV video-play-VIDEO_ID
/device TV page-/watch?v=VIDEO_ID
/device TV sidebar-open
/device TV scroll-page 500
/device TV playlist-button-click-up
/device TV playlist-button-click-down
/device TV playlist-button-click
/device TV page-button-click-up
/device TV page-button-click-down
/device TV move-cursor 320,180
/device TV move-cursor "#menuBtn"
/reload TV
/device TV refresh-styles
/reload
/devices
/help
/restart
```

Names are stored by the server and sent back to the device, which remembers
its own name in browser storage. `all` sends a command to every connected
device. `move-cursor` displays an in-page remote pointer at coordinates or at
the centre of a CSS selector; browsers do not permit websites to move the
operating-system mouse cursor. `/devices` is shorthand for `/device list`,
`/help` lists the commands, and `/restart` restarts the server (the Windows
watchdog starts it again).

### Browser remote (`/remote`)

`/remote` is the same console in the browser, with a graphical remote on top:

- Every connected screen is listed with an icon for its kind - TV, phone,
tablet or computer - from its user agent, plus its address, the page it is on
and what it is playing.
- Selecting a screen shows buttons for the commands that page supports:
playback and volume on `/watch`, music controls on `/listen`, navigation,
`move-cursor`, reload and style refresh everywhere, a message toast, and
device renaming.
- The console below accepts the same `/device`, `/reload`, `/devices` and
`/help` commands as the terminal. `/restart` works there for admins only.

`/reload` refreshes every active client by default (or the named client) and
restores a watch page's timestamp, volume, playback speed, and play/pause
state once metadata loads. A full browser reload necessarily reconnects the
stream briefly. Use `refresh-styles` when only CSS changed: it reloads all
stylesheets without touching the video stream.

## Chess

`/chess` is a two-player chess page. It signs in with the same accounts as the
rest of the site - there is no separate username or password - and keeps a
win/loss/draw record per account in `data/chessStats.json`. Games against the
bot are not counted.

Live games use a WebSocket at `/chess/ws` on the same server (so it follows the
HTTP/HTTPS setting automatically). The lobby lists the accounts that have the
chess page open right now, and an invitation can only be sent to one of them.

Invites arrive as notifications that do not disappear on their own: the invited
player keeps an Accept / Decline card until they answer it or dismiss it, and
the sender keeps an "Invite sent" card with a Cancel button until it is answered
or cancelled. "Find an opponent" matches with whoever is waiting there, and a
game code can still be typed into "Join game" (or `?g=<code>` in the URL) to get
back into a game.

The bot is a UCI Stockfish build. Put the executable in `tools/` (see
`tools/README.md`) or point `STOCKFISH_PATH` at it; the server logs which engine
it picked. Without one, playing another person still works and starting a bot
game explains that the engine is missing.

## Notes

Browser video support depends on the browser's codecs. MP4/H.264/AAC is the safest choice. MKV files can be served, but browser playback may not support every codec/container combination.

The application never deletes video files or thumbnails automatically.
"# K.Streamer" 
"# K.Streamer" 
