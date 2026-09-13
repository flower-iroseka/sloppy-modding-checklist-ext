# Sloppy Modding Checklist

**English** | [中文](README.zh.md)

Collect everything that needs checking on a beatmap into one list, on osu!'s beatmap discussion pages.

Use it before applying for BN to work out what still needs looking at on a map, so nothing gets missed; day to day it also works as an ordinary modding checklist — write down what you find, one line at a time, and improve your modding.

The list is sorted along two axes:

- **Scope**: **General** is a problem with the map as a whole (overall volume, timing); **Individual** is a problem with one specific object (the placement of a single note).
- **Source**: **Internal** is a problem you raised yourself; **External** is one someone else raised.

Put the two together and you get four cells.

The idea comes from Electoz's [Advanced Modding Guide](https://electoz.s-ul.eu/N7Y53Jaj) (19 April 2020). This extension turns that list into a browser tool: one click to fill in, and it syncs across devices.

---

## Install

Building needs Node 18+. Use Chrome or Edge.

```bash
npm install
npm run build          # output lands in dist/
```

Then in the browser:

1. Open `chrome://extensions` and turn on "Developer mode" in the top right;
2. Click "Load unpacked" and pick the **`dist/`** directory (not the repository root).

After changing code, rebuild and click "Reload" once on the extensions page.

---

## Usage

### 1. Adding entries on a discussion page

Open any beatmap discussion page (`https://osu.ppy.sh/beatmapsets/<id>/discussion*`). Every post gets a "＋ Add to Checklist" button next to it; clicking it puts that change on the list.

To see the list, click the floating button in the bottom left corner to open the Checklist page.

### 2. Checking the stats

Click the extension icon in the browser toolbar and a popup opens showing the list's stats: how many entries are in each of the four categories, and how many in total. To change the contents, click "Open the Checklist page" at the bottom of the popup.

### 3. Tidying entries on the Checklist page

The page is split into four cells along the two axes above, and the entries in each cell are laid out as cards. A card can be dragged by the `⋮⋮` handle on its left:

- **Dragging inside one cell**: changes the order of the entries in that cell;
- **Dragging into another cell**: changes that entry's scope and source (General to Individual, say);
- **Keyboard shortcut**: press `Tab` to select the `⋮⋮` handle on the left of a card, press `Space` to pick the card up, use the arrow keys to move it to the target position, then press `Space` to drop it; press `Esc` to cancel the drag.

A card has three icons in its top right corner: edit, add a note, delete. Deleting asks for confirmation.

### 4. Changing the UI language

Open the Checklist page and switch to the "Settings" tab at the top. The first field is a language dropdown with three choices: **Match browser** (the default), **中文**, **English**. A change takes effect immediately, with nothing to save, and every page of the extension follows.

Each language's name is written in that language (the English UI has a "中文" entry too), so even after the UI turns into a language you cannot read, you can still recognize "中文" in that list and switch back.

With "Match browser", only the **primary language** is looked at: `zh-CN`, `zh-TW` and `zh` all count as Chinese, `en-*` as English, and anything else falls back to English.

---

## Sync (optional)

Data is stored on this machine by default.

Sync goes two ways. **Upload** writes the local list to the remote; **pull** brings the remote list back to this machine. "Remote" here means the file at the sync target you picked. Once sync is enabled and a sync method chosen, the list is stored as a single file named `modding-checklist.json`, and every device syncs the same one.

**Only one sync method can be used at a time.** Pick it from the "Sync target" dropdown in Settings:

- **Local sync folder (no signup)** — the default. Install the cloud drive's desktop client first (Dropbox, Nutstore and others all provide one); it mounts a directory in your cloud drive as a local folder on the computer, and you pick that folder in Settings. The extension writes files into the folder and the client handles uploading to the cloud. The cost is that the client has to be running on the computer, and when things get uploaded is up to it. The browser occasionally takes the folder permission back, and Settings will then ask you to click "Re-authorize" once.
- **WebDAV** — fill in the server address and account details yourself (Nutstore, Nextcloud and others all offer WebDAV). The server address is yours to fill in, and clicking "Save and test connection" asks the browser for permission to reach that server.
- **Dropbox** — you need to register an application in the Dropbox console yourself (there's a step-by-step guide below).

### Dropbox registration guide

Register at: [Dropbox App Console](https://www.dropbox.com/developers/apps) (`https://www.dropbox.com/developers/apps`)

1. Create app → choose Scoped access → pick the **App folder** type.
2. Under "Permissions", tick files.content.read, files.content.write and files.metadata.read. **You must then click Submit at the bottom of the page**; ticking without submitting counts as not configured.
3. Under "OAuth 2" → Redirect URIs, paste the address shown below.
4. Paste the App key into the client_id field (the App secret is not needed).

The address to paste in step 3 is the one shown in the "Redirect URL" field in Settings, with a "Copy" button next to it. It looks like this, and **must match the one registered in the console character for character** (including the trailing slash):

```
https://<extension ID>.chromiumapp.org/
```

Files live under `/Apps/<app name>/`, so nothing else in the Dropbox account is touched.

When the authorization page errors out, the extension cannot read the error text. The usual ones are:

- The authorization page shows **"No scope requested can be granted for this app"**: those three scopes are not ticked under "Permissions", or they are ticked but you **did not click Submit** (the easiest one to miss). After fixing it you must authorize again; an old token does not pick up new permissions.
- The authorization page shows the redirect_uri is not whitelisted: the Redirect URIs on the "OAuth 2" page do not match the address in Settings (a trailing slash, or http vs https, counts as a mismatch).
- The authorization page shows the app is unavailable / the client_id is invalid: the App key is wrong, or the app has been disabled in the App Console.

### When sync runs

- **Auto-upload** (off by default): once on, every local change is uploaded **30 seconds** later, plus a pull once an hour.
- **Pull when the extension opens** (off by default): pulls once when the Checklist page opens, and skips it if a pull happened within the last ten minutes.

Both switches are in Settings.

### Handling conflicts

When both devices have changed things and the remote has an update from another device, the extension asks before overwriting. The "Conflict strategy" in Settings decides when it asks:

| Option | Meaning |
| --- | --- |
| Newest timestamp wins | Default. When both sides have updates, `updatedAt` decides; the newer one is used |
| Local wins | Always use the local copy and overwrite the remote |
| Remote wins | Always use the remote copy and overwrite the local one |
| Always ask | Confirm before every change |

With "Always ask", or when the extension cannot tell which side is newer, Settings shows a conflict panel offering three options: keep local / take remote / merge both. **A backup is taken automatically before overwriting the remote** (the five most recent are kept, for the local copy and the remote separately).

---

## Where the data lives, and privacy

- **The list** is stored in the browser's `chrome.storage.local`. Manual backups, switching browsers and switching machines all go through export / import in the "Data" panel in Settings — that is a single JSON file.
- **The Dropbox token** is stored in the same `storage.local`, and **never goes into the exported JSON**.
- **client_id / client_secret** are only used inside the extension's service worker to exchange for a token; the page code never gets hold of the credentials, nor the token.
- The extension sends requests to **only** these domains. The WebDAV server address is yours to fill in, so its domain is requested separately the first time you save.
- There is no telemetry, and nothing else receives your data: the author has no server.

```
https://osu.ppy.sh/*
https://www.dropbox.com/*
https://api.dropboxapi.com/*
https://content.dropboxapi.com/*
```

(`https://osu.ppy.sh/*` is the content script reading posts; the other three are Dropbox's: the authorization page, the RPC API, and file upload/download.)

---

## Development

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run build          # clean, then build the pages and the content script separately
npm run icons          # regenerate public/icons/* (normally not needed)
```

`npm run build` runs two builds in order: the pages first (app / popup / background), then the content script.

They are split in two because the content script has two constraints: it has to be a single JS file that the browser executes as a plain script (no `import` inside), and the two stylesheets injected into the shadow root are inlined into that file as strings, because a shadow root cannot load an external stylesheet.

Either build can also be run on its own:

```bash
npm run build:pages      # pages only
npm run build:content    # content script only
```

`build:pages` wipes the whole `dist/` first, so after running it alone, run `build:content` again.

Real-browser checks use the smoke scripts under `scripts/`: they drive a real Chrome loaded with `dist/` over CDP, one file per milestone (`smoke-m1.mjs` … `smoke-m9.mjs`).

---

## License and credits

[MIT License](LICENSE), by flower-iroseka.

This extension was generated by DeepSeek V4 vibe coding.

It is a convenience tool built on the basic ideas of Electoz's [Advanced Modding Guide](https://electoz.s-ul.eu/N7Y53Jaj) (19 April 2020), and is for personal entertainment only. Electoz's osu! profile is [here](https://osu.ppy.sh/users/6485263).

---

This extension is not affiliated with osu!.
