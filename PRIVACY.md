# Privacy Policy

**English** | [中文](PRIVACY.zh.md)

Sloppy Modding Checklist is a browser extension that keeps a modding checklist on osu! beatmap discussion pages. This page says what it stores and where that data goes.

---

## What stays on this machine

The following lives in the browser's `chrome.storage.local` and exists only on this device:

- **The checklist itself**: entry text, notes, links, difficulty, and for each entry the discussion link and author name it came from.
- **Sync settings**: the sync method that was chosen and its configuration, including the WebDAV server address, username and password, and the Dropbox app's client_id and client_secret.
- **The Dropbox access token and refresh token.**
- **A device id and the sync status**: a randomly generated device identifier, plus the time and result of the last sync.

None of this is sent to the author; the author has no server that could receive it.

The export button in Settings produces a JSON file of the checklist. It does **not** contain passwords, client_secret or tokens.

## What leaves this machine

The extension talks to these addresses, and no others:

- **osu.ppy.sh** — to read a discussion permalink the user entered and fetch the author of that post. The request carries the browser's existing osu! session (`credentials: 'include'`) and reads a publicly visible page.
- **The server of the sync method that was chosen** — the Dropbox API, or a WebDAV server the user typed in. What is sent is the checklist's JSON file. WebDAV sends the username and password as HTTP Basic authentication, so the extension requires that address to use https; only addresses on this machine (127.0.0.1, localhost) may use http.
- **The local sync folder sends no network request at all**: the extension only writes a file into the folder the user picked, and the user's own cloud client does the uploading.

There are no other recipients.

## What is not collected

No telemetry, no usage statistics, no crash reports, no advertising. The extension does not read browsing history, does not read pages outside osu.ppy.sh, does not collect account information, and does not build a profile.

## Third parties

The checklist is stored at the sync location the user chose. That location is held by the corresponding service under its own privacy policy; the extension does not control that data and does not give the service anything beyond the file itself.

## Chrome Web Store User Data policy

The extension's use of user data is limited to its single purpose: keeping and syncing the user's own modding checklist. The data it handles is not sold, is not used for advertising, and is not used to determine creditworthiness or for lending purposes. It is not transferred to third parties except as needed to provide that single purpose.

## Contact

Questions and reports go to the [GitHub repository](https://github.com/flower-iroseka/sloppy-modding-checklist-ext).

---

This extension is not affiliated with osu!.
