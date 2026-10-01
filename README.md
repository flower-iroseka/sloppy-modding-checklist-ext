# Sloppy Modding Checklist

**English** | [中文](README.zh.md)

Collects what is worth checking on a beatmap into one list, on osu!'s beatmap discussion pages.

Use it before applying for BN to go through what is worth checking on a map. It also works as a general modding checklist.

The list is sorted along two axes:

- **Scope**: **General** is a problem with the map as a whole (overall volume, timing); **Individual** is a problem with one specific object (the placement of a single note).
- **Source**: **Internal** is a problem you raised yourself; **External** is one someone else raised.

Put the two together and you get four cells.

Individual entries also carry a **difficulty**: Easy, Normal, Hard, Insane or Expert. Most mods only apply to one tier, so this says which one the entry is about. It's filled in for you when you add an entry from a discussion page.

The idea comes from Electoz's [Advanced Modding Guide](https://electoz.s-ul.eu/N7Y53Jaj) (19 April 2020). This extension implements that list as a browser extension, and can sync it across devices.

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

After changing code, rebuild and click "Reload" on the extensions page. Changes under `src/content/` are the exception: Chrome keeps the content script from the previous load, so restart the browser instead.

---

## Usage

### 1. Adding entries on a discussion page

Open any beatmap discussion page (`https://osu.ppy.sh/beatmapsets/<id>/discussion*`). Every post gets an "+ Add to Checklist" button next to it, which adds an entry for that post.

To see the list, click the floating button in the bottom left corner to open the Checklist page.

When the page is about one specific difficulty, the entry's difficulty is filled in from that difficulty's name (matched against the [osu! wiki's naming tables](https://osu.ppy.sh/wiki/en/Ranking_criteria/Difficulty_naming), including the naming schemes borrowed from other rhythm games), or from its star rating when the name isn't one the wiki lists. You can change it in the dialog, or clear it by clicking the selected tier again.

### 2. Checking the stats

Click the extension icon in the browser toolbar and a popup opens showing the list's stats: how many entries are in each of the four categories, and how many in total. To change the contents, click "Open the Checklist page" at the bottom of the popup.

### 3. Tidying entries on the Checklist page

The page is split into four cells along the two axes above, and the entries in each cell are laid out as cards. A card can be dragged by the `⋮⋮` handle on its left:

- **Dragging inside one cell**: changes the order of the entries in that cell;
- **Dragging into another cell**: changes that entry's scope and source (General to Individual, say);
- **Keyboard shortcut**: press `Tab` to select the `⋮⋮` handle on the left of a card, press `Space` to pick the card up, use the arrow keys to move it to the target position, then press `Space` to drop it; press `Esc` to cancel the drag.

A card has two icon buttons in its top right corner: edit and delete. The note button sits at the right end of the row below, next to the links. Deleting asks for confirmation: the first click turns the button into "Confirm", and a second click within three seconds deletes the entry.

An Individual card with a difficulty shows it next to the summary, with a small bar in osu!'s colour for that tier. A card with no tier shows nothing. General cards never show one: moving an entry over to the General column hides its marker without throwing the value away, so moving it back brings the marker back.

### 4. Changing the UI language

Open the Checklist page and switch to the "Settings" tab at the top. The first field is a language dropdown with three choices: **Match browser** (the default), **中文**, **English**. A change takes effect immediately, with nothing to save, and every page of the extension follows.

Each language's name is written in that language (the English UI has a "中文" entry too), so even after the UI turns into a language you cannot read, you can still recognize "中文" in that list and switch back.

With "Match browser", only the **primary language** is looked at: `zh-CN`, `zh-TW` and `zh` all count as Chinese, `en-*` as English, and anything else falls back to English.

---

## Sync (optional)

Data is stored on this machine by default.

Sync goes two ways. **Upload** writes the local list to the remote; **import** brings the remote list back to this machine. "Remote" here means the file at the sync target you picked. Once sync is enabled and a sync method chosen, the list is stored as a single file named `modding-checklist.json`, and every device syncs the same one.

**Only one sync method can be used at a time.** Pick it from the "Sync target" dropdown in Settings:

- **Local sync folder (no signup)** — the default. Install the cloud drive's desktop client first (Dropbox, Nutstore and others all provide one); it mounts a directory in your cloud drive as a local folder on the computer, and you pick that folder in Settings. The extension writes files into the folder and the client handles uploading to the cloud. The client has to be running on the computer, and when things get uploaded is up to it. The browser takes the folder permission back after a while, and Settings will then ask you to click "Re-authorize" once.
- **WebDAV** — fill in the server address and account details (Nutstore, Nextcloud and others all offer WebDAV). Clicking "Save and test connection" asks the browser for permission to reach that server.
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

- **Auto-upload (upload after changes, import once an hour)**, off by default: once on, every local change is uploaded **30 seconds** later, and an import runs once an hour.
- **Import when the extension opens**, off by default: imports once when the background service worker starts — on browser start, and on extension install, update or reload. It is skipped if a sync succeeded within the last ten minutes.

Both switches are in Settings. The second one only takes effect while Auto-upload is on; with Auto-upload off, it does nothing.

### Handling conflicts

Each copy carries an `updatedAt` timestamp, and the extension goes by it.

On an **import** (a manual import, the hourly import, or an import when the extension opens):

- the remote is newer → the remote copy is taken;
- the local copy is newer → the local copy is kept;
- the timestamps are equal but the content differs → the conflict strategy decides.

On a **push** ("Upload now", or an automatic upload):

- the remote is newer → the extension asks before overwriting, unless the strategy is "Local wins";
- otherwise → the remote is overwritten with the local copy.

The "Conflict strategy" in Settings decides only the two cases left open above — an import with equal timestamps, and a push with a newer remote:

| Option | Meaning |
| --- | --- |
| Newest timestamp wins | Default. On an import with equal timestamps, take the remote copy |
| Local wins | On an import with equal timestamps, keep the local copy; on a push, overwrite a newer remote without asking |
| Remote wins | On an import with equal timestamps, take the remote copy |
| Always ask | On an import with equal timestamps, ask which side to take |

When the extension asks, Settings shows a conflict panel. An import conflict offers three choices: "Keep local", "Take remote" and "Merge both". A push conflict offers two: "Overwrite with local anyway" or "Cancel". **A backup is taken automatically before the remote is overwritten** (the five most recent are kept, for the local copy and the remote separately).

---

## Where the data lives, and privacy

- **The list** is stored in the browser's `chrome.storage.local`. Manual backups, switching browsers and switching machines all go through export / import in the "Data" panel in Settings — that is a single JSON file.
- **The Dropbox token** is stored in the same `storage.local`, and **never goes into the exported JSON**. Only the service worker reads it; the pages are told whether a connection exists, not the token itself.
- **client_id / client_secret** are entered on the Settings page and saved in `storage.local` with the rest of the settings. The service worker uses them to exchange for a token. The Dropbox app used here is a public client, so `client_secret` can be left empty.
- The extension sends requests to **only** these domains. The WebDAV server address is yours to fill in, so its domain is requested separately the first time you save.
- There is no telemetry, and nothing else receives your data: the author has no server.

```
https://osu.ppy.sh/*
https://www.dropbox.com/*
https://api.dropboxapi.com/*
https://content.dropboxapi.com/*
```

(`https://osu.ppy.sh/*` is for reading the author behind a discussion permalink; the content script itself is injected through the manifest's `content_scripts`. The other three are Dropbox's: the authorization page, the RPC API, and file upload/download.)

---

## Development

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run build          # clean, then build the pages and the content script separately
npm run icons          # regenerate public/icons/* (normally not needed)
```

`npm run build` runs two builds in order: the pages first (app / popup / background), then the content script.

The build runs in two steps, one for the pages and one for the content script. The content script has to be a single JS file that the browser executes as a plain script (no `import` inside), and the two stylesheets injected into the shadow root are inlined into that file as strings, because a shadow root cannot load an external stylesheet.

Either build can also be run on its own:

```bash
npm run build:pages      # pages only
npm run build:content    # content script only
```

`build:pages` wipes the whole `dist/` first, so after running it alone, run `build:content` again.

Real-browser checks use the scripts under `scripts/`: they drive a real Chrome loaded with `dist/` over CDP. Most are named after the milestone they cover (`smoke-m1.mjs` … `smoke-m9.mjs`, except that M7's checks are folded into `smoke-m6.mjs` and M0's are in `smoke-extension.mjs`); `smoke-author.mjs`, `smoke-links.mjs` and `probe-ui.mjs` cover individual features.

---

## License and credits

[MIT License](LICENSE), by flower-iroseka.

This extension was generated by DeepSeek V4 vibe coding.

It is a convenience tool built on the basic ideas of Electoz's [Advanced Modding Guide](https://electoz.s-ul.eu/N7Y53Jaj) (19 April 2020), and is for personal entertainment only. Electoz's osu! profile is [here](https://osu.ppy.sh/users/6485263).

---

This extension is not affiliated with osu!.
