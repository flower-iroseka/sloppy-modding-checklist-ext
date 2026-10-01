import type { Catalog } from './types';

/**
 * English catalog (CODING_PLAN §14).
 *
 * Typed as `Catalog` (= `Record<MessageKey, string>`), so a key missing on either side is a
 * `tsc` error; adding a third language is copy this file, translate the values, add one line
 * to `CATALOGS`. Two wording conventions, both forced by English grammar: the provider goes
 * before the colon so a capitalised `{action}` works both mid-sentence and at the start
 * (`Dropbox: Upload failed`), and quantifiers use wording like `total` to dodge
 * `1 entry / 2 entries` (see the header of zh.ts).
 */
export const en: Catalog = {
  // ---------------------------------------------------------------- Action words
  'action.test': 'Connection test',
  'action.upload': 'Upload',
  'action.download': 'Download',
  'action.folderOpen': 'open the sync folder',
  'action.folderRead': 'read the sync file',
  'action.folderWrite': 'write the sync file',

  // ---------------------------------------------------------------- HTTP layer
  'err.http.unreachable': "Can't reach {host}: {detail}",
  // Pure passthrough technical strings (fetch / JSON parse errors) with nothing to
  // translate -- they exist so `describeError` has a uniform Msg return type.
  'err.raw': '{detail}',

  // ---------------------------------------------------------------- OAuth flow
  'err.oauth.redirectUnparsable': 'Could not parse the authorization callback URL.',
  'err.oauth.stateMismatch': 'The authorization callback had a mismatched state; aborted. Please reconnect.',
  'err.oauth.cancelled': 'Authorization cancelled (you clicked deny on the authorization page).',
  'err.oauth.deniedByServer': 'Authorization denied: {error}',
  'err.oauth.deniedByServerDetail': 'Authorization denied: {error} ({detail})',
  'err.oauth.noCode': 'The authorization did not return a code. Please try again.',
  'err.oauth.noAccessToken': 'The authorization server did not return an access_token. Please try again.',
  'err.oauth.tokenInvalid': "{provider}'s authorization is no longer valid. Please reconnect in Settings.",
  'err.oauth.badClient':
    '{provider} rejected the client credentials (HTTP {status}). Check the client_id / client_secret.',
  'err.oauth.providerServer': "{provider}'s server errored (HTTP {status}), you can retry later.",
  'err.oauth.exchangeFailed': '{provider} token exchange failed: {reason}',
  'err.oauth.exchangeFailedDetail': '{provider} token exchange failed: {reason} ({detail})',
  'err.oauth.noClientId': 'Please fill in the client_id for {provider} first.',

  // The closed-authorization-window notice: several paragraphs, joined by the caller with
  // newlines (see the note in zh.ts).
  'err.oauth.windowClosed': 'The authorization window was closed without returning a code.\n{hints}\n{redirect}',
  'err.oauth.windowClosedIntro':
    'If that window showed an error, it most likely was not "incomplete" but a mismatch in the console settings. The most common cause for {provider} is:',
  'err.oauth.windowClosedNoHints':
    '(If that window showed a 400 or similar, it was not "incomplete" but a mismatch in the console settings.)',
  'err.oauth.windowClosedHintLine': '{n}. {hint}',
  'err.oauth.windowClosedRedirect':
    "The redirect URL the extension sends is {redirectUri}; it must match the one registered in the console **character for character**, including the trailing slash (a mismatch shows up as redirect_uri_mismatch in the authorization error).",

  // ---------------------------------------------------------------- OAuth provider API errors
  // The provider goes before the colon so a capitalised `{action}` works in both sentence
  // shapes (see the wording conventions in the header).
  // `X` / `XDetail` are a pair: the call site picks one based on whether there is a detail,
  // and the two should differ in exactly one `{detail}`.
  'err.api.auth':
    '{provider}: {action} failed (authorization refused, HTTP {status}). Please reconnect in Settings.',
  'err.api.authDetail':
    '{provider}: {action} failed (authorization refused, HTTP {status}, {detail}). Please reconnect in Settings.',
  'err.api.rateLimited': '{provider}: {action} failed (too many requests, HTTP 429). Try again later.',
  'err.api.server': '{provider}: {action} failed (server error, HTTP {status}). You can retry later.',
  'err.api.serverDetail':
    '{provider}: {action} failed (server error, HTTP {status}, {detail}). You can retry later.',
  'err.api.other': '{provider}: {action} failed (HTTP {status}).',
  'err.api.otherDetail': '{provider}: {action} failed (HTTP {status}, {detail}).',
  'err.api.notConnected': '{provider} is not connected yet. Click "Connect" in Settings first.',
  'err.api.expired': "{provider}'s authorization expired. Please reconnect.",

  // ---------------------------------------------------------------- Local sync folder
  'err.folder.permissionRevoked':
    "The browser revoked access to the sync folder, so it couldn't {action}. Go back to Settings, click \"Re-authorize\" on the \"Local sync folder\" card, and click \"Allow\" in the system dialog.",
  'err.folder.missing':
    "The sync folder is gone (deleted, renamed, or the cloud client unmounted it?), so it couldn't {action}. Please pick the folder again in Settings.",
  'err.folder.busy': "The sync file is locked by another program, so it couldn't {action}. Try again shortly.",
  'err.folder.notAFile':
    "There is already a **folder** with that name in the way, so it couldn't {action}. Please use a different sync folder.",
  'err.folder.other': "Couldn't {action}: {detail}",
  'err.folder.noFolder': 'No sync folder selected yet. Click "Choose folder" in Settings.',
  'err.folder.handleLost':
    'This extension no longer has a handle for "{name}" (its data may have been cleared, or the setting came from an import). Please pick the folder again in Settings.',
  'err.folder.denied':
    'The browser explicitly denied access to "{name}". Please pick the folder again in Settings (if it is still denied, open the site settings from the icon at the left of the address bar and set this extension\'s "Edit files" permission back to "Ask").',
  'err.folder.needsReauth':
    '"{name}" needs re-authorization before it can be read or written. Go back to Settings, click "Re-authorize" on that card, and click "Allow" in the system dialog.',

  // ---------------------------------------------------------------- SyncManager
  'err.manager.badRemoteJson': 'The remote file is not valid checklist JSON: {detail}',
  'err.manager.readFailed': 'Reading from the remote failed: {detail}',
  'err.manager.pushFailed': 'Upload failed: {detail}',

  // ---------------------------------------------------------------- Background messages
  'err.bg.notOAuth': 'This sync target is not authorized through OAuth.',
  'err.bg.noClientId': 'Please fill in and save the client_id for {provider} first.',
  'err.bg.unknown': 'Unknown sync target: {id}.',
  'err.bg.noProvider': 'No sync target has been selected yet.',
  'err.bg.notConfigured': '{provider} is not fully configured yet.',
  'err.bg.noLocalDoc': 'There is no local data yet.',
  'err.bg.unknownMessage':
    "The background does not recognise this message ({type}); the extension may not have been reloaded.",
  'err.bg.commFailed': 'Could not reach the background: {detail}',
  'err.sync.failed': 'Sync failed.',
  'err.sync.failedDetail': 'Sync failed: {detail}',

  // ---------------------------------------------------------------- Settings registration wizard
  // consoleUrl / consoleLabel are brand names and stay out of the catalog.
  'help.dropbox.step1': 'Create app → choose Scoped access → pick the **App folder** type.',
  'help.dropbox.step2':
    'Under "Permissions", tick files.content.read, files.content.write and files.metadata.read. **You must then click Submit at the bottom of the page**; ticking without submitting counts as not configured.',
  'help.dropbox.step3': 'Under "OAuth 2" → Redirect URIs, paste the address shown below.',
  'help.dropbox.step4': 'Paste the App key into the client_id field (the App secret is not needed).',
  'help.dropbox.caution':
    'Files live under `/Apps/<app name>/`, so nothing else in the Dropbox account is touched.',
  'help.dropbox.misconfig1':
    'The authorization page shows **"No scope requested can be granted for this app"**: those three scopes are not ticked under "Permissions", or they are ticked but you **did not click Submit** (the easiest one to miss). After fixing it you must authorize again; an old token does not pick up new permissions.',
  'help.dropbox.misconfig2':
    'The authorization page shows the redirect_uri is not whitelisted: the Redirect URIs on the "OAuth 2" page do not match the address in Settings (a trailing slash, or http vs https, counts as a mismatch).',
  'help.dropbox.misconfig3':
    'The authorization page shows the app is unavailable / the client_id is invalid: the App key is wrong, or the app has been disabled in the App Console.',

  // ---------------------------------------------------------------- Sync decision (plan.ts)
  'plan.pull.noRemote': 'There is no backup file on the remote yet; click "Upload now" to create one.',
  'plan.pull.same': 'The remote and local contents are identical; nothing to import.',
  'plan.pull.remoteNewer': 'The remote is newer; it will be adopted.',
  'plan.pull.localNewer': 'The local copy is newer, so the import was skipped (click "Upload now" to upload it).',
  'plan.pull.localWins': 'Same timestamp and the strategy is "local wins"; keeping the local copy.',
  'plan.pull.remoteWins': 'Same timestamp and the strategy is "remote wins"; adopting the remote.',
  'plan.pull.ask': 'Same timestamp but different contents; you need to decide which copy to keep.',
  'plan.pull.tieRemote': 'Same timestamp (cannot tell which is newer); adopting the remote per the tie rule.',
  'plan.push.noRemote': 'There is no backup file on the remote yet; a new one will be created.',
  'plan.push.same': 'The remote and local contents are identical; nothing to upload.',
  'plan.push.localWins': 'The remote is newer, but the strategy is "local wins"; the remote will be overwritten.',
  'plan.push.ask': 'The remote is newer than the local copy; uploading would overwrite it, so please confirm.',
  'plan.push.ok': 'The local contents will be uploaded to the remote.',

  // ---------------------------------------------------------------- Sync results
  'sync.pushed': 'Uploaded: {count} in total{suffix}',
  'sync.pushedBackup': '; the overwritten remote was backed up as "{backup}"',
  'sync.pulled': 'Adopted the remote copy: {count} in total{suffix}',
  'sync.pulledBackup': '; the overwritten local copy was backed up as "{backup}"',
  'sync.testOk': 'Connection OK ({provider}).',
  'sync.connected': 'Connected to {provider}.',
  'sync.disconnected': 'Disconnected {provider}. The remote file was not deleted.',

  // ================================================================ UI text
  // From this line down it is UI text (buttons, headings, hints); above it is the "which
  // sentence + what params" that core code produces. Sharing one catalog between the two is
  // deliberate: there is only one place to look up a translation.

  // ---------------------------------------------------------------- Brands / proper nouns
  // Dropbox is a trademark and reads the same in both -- but it still takes a key, so
  // `displayName` can have the uniform type `MessageKey` and call sites don't have to
  // distinguish "this one is translatable, that one isn't".
  'provider.localFolder': 'Local sync folder (no signup)',
  'provider.localFolderShort': 'Local sync folder',
  'provider.dropbox': 'Dropbox',

  // ---------------------------------------------------------------- Common words
  'common.listSeparator': ', ',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.noSummary': '(no summary)',

  // The names of the four category cells. Identical in both catalogs (see the note in zh.ts),
  // but each still takes a key.
  'scope.general': 'General',
  'scope.individual': 'Individual',
  'source.internal': 'Internal',
  'source.external': 'External',

  // The five difficulty tiers. Identical in both catalogs, same as the cell names above
  // (see the note in zh.ts).
  'difficulty.easy': 'Easy',
  'difficulty.normal': 'Normal',
  'difficulty.hard': 'Hard',
  'difficulty.insane': 'Insane',
  'difficulty.expert': 'Expert',

  // ---------------------------------------------------------------- Shell (top bar / settings page)
  // The language names are explained in full in zh.ts: always written the way that language
  // writes itself. Having these two values identical in both catalogs is deliberate.
  'nav.checklist': 'Checklist',
  'nav.settings': 'Settings',
  'nav.aria': 'Main navigation',
  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.languageAuto': 'Match browser',
  'settings.languageZh': '中文',
  'settings.languageEn': 'English',

  // ---------------------------------------------------------------- Conflict strategy
  'strategy.newest-wins': 'Newest timestamp wins',
  'strategy.local-wins': 'Local wins',
  'strategy.remote-wins': 'Remote wins',
  'strategy.ask': 'Always ask',

  // ---------------------------------------------------------------- Sync panel
  'sync.title': 'Sync',
  'sync.loading': 'Loading sync settings…',
  'sync.intro':
    'Back your checklist up to your own cloud drive and pick it up on every device. Only one sync target is used at a time.',
  'sync.providerLabel': 'Sync target',
  'sync.providerConnected': ' (connected)',
  'sync.test': 'Test connection',
  'sync.testBusy': 'Testing…',
  'sync.push': 'Upload now',
  'sync.pushBusy': 'Uploading…',
  'sync.pull': 'Import from remote',
  'sync.pullBusy': 'Importing…',
  'sync.autoSync': 'Auto-upload (upload after changes, import once an hour)',
  'sync.pullOnStart': 'Import when the extension opens',
  'sync.strategyLabel': 'Conflict strategy',

  'sync.conflict.pushHeadline': 'The remote copy is newer',
  'sync.conflict.pullHeadline': 'The two copies differ',
  'sync.conflict.pushReason':
    'Uploading now would overwrite the remote with your local copy, losing the newer changes there (a backup is taken first).',
  'sync.conflict.pullReason': 'The timestamps are identical, so it cannot tell which copy to keep.',
  'sync.conflict.announce': 'Sync conflict: {headline}. {reason} Please choose how to proceed.',
  'sync.conflict.overwrite': 'Overwrite with local anyway',
  'sync.conflict.cancel': 'Cancel',
  'sync.conflict.keepLocal': 'Keep local',
  'sync.conflict.takeRemote': 'Take remote',
  'sync.conflict.merge': 'Merge both',

  'sync.stats.lastSync': 'Last sync',
  'sync.stats.lastAction': 'Last action',
  'sync.stats.status': 'Status',
  'sync.stats.actionPush': 'Upload',
  'sync.stats.actionPull': 'Import',
  'sync.stats.failed': 'Failed',
  'sync.stats.ok': 'OK',
  'sync.stats.disabled': 'Not enabled',
  'sync.stats.lastError': 'Last sync failure: {detail}',

  'sync.err.pickerUnsupported':
    'This browser cannot pick a folder directly (Chrome or Edge 86+ is required).',
  'sync.err.pickCancelled': 'Cancelled: no folder was chosen.',
  'sync.err.handleLost': "Can't recall the folder you picked before. Please pick it again.",
  'sync.err.folderDenied':
    'Access to the folder was not granted. You can click again, or pick it again in the system folder dialog.',
  'sync.err.folderNeedsReauth': 'The folder needs re-authorization.',
  'sync.err.noFolderChosen': 'Please choose a sync folder first.',
  'sync.err.noClientId': 'Please fill in the client_id.',
  'sync.err.bgNoResponse': 'The background did not respond. Please try again.',
  'sync.folderPicked': 'Chose "{name}". The sync file is modding-checklist.json inside it.',
  'sync.folderRestored': 'Access to the folder has been restored.',
  'sync.folderForgotten':
    'Disconnected. The file in your cloud drive was not deleted. Pick the same folder again to carry on.',
  'sync.merged':
    'Merged: {added} added, {skipped} duplicates skipped. Click "Upload now" once you are happy with it.',
  'sync.keptLocal': 'Kept the local copy.',

  // ---------------------------------------------------------------- Local sync folder card
  'folder.label': 'Sync folder',
  // Five segments built around two `<strong>`s (see the note in zh.ts). The markers sit in
  // different places in English than in Chinese, which is why the split is the
  // language-neutral "lead-in / emphasis / middle / emphasis / tail".
  'folder.intro1': 'Use the ',
  'folder.introStrong1': 'desktop client',
  'folder.intro2':
    ' of Google Drive, OneDrive, Dropbox (etc.) to mount your cloud drive as a local folder, then pick it here. The extension writes a {file} inside it and the client uploads it for you. The whole thing ',
  'folder.introStrong2': 'needs no app registration, no developer console and no account sign-in',
  'folder.intro3': '.',
  'folder.current': 'Current folder: ',
  'folder.statusGranted': ' (read/write)',
  'folder.statusPrompt': ' (needs re-authorization)',
  'folder.statusDenied': ' (permission denied)',
  'folder.none': 'No folder chosen yet.',
  'folder.permissionNotice':
    'The browser takes the folder permission back after a while (usually once you close and reopen the browser, or reboot). This is not a failure. Click "Re-authorize" and hit "Allow" in the system dialog.',
  'folder.unsupported':
    'This browser cannot pick a folder directly (Chrome or Edge 86+ is required). Dropbox will sync just as well.',
  'folder.pick': 'Choose folder',
  'folder.change': 'Change folder',
  'folder.picking': 'Working…',
  'folder.reauthorize': 'Re-authorize',
  'folder.forget': 'Disconnect',
  'folder.tip1':
    'Tip: create an empty folder in your cloud drive just for this, rather than picking the root of "My Drive"; it will be much easier to find later. Disconnecting only clears the extension\'s own record, and ',
  'folder.tipStrong': 'will not delete that file',
  'folder.tip2': '.',

  // ---------------------------------------------------------------- OAuth card
  'oauth.status.connected': '● Connected',
  'oauth.status.disconnected': '○ Not connected',
  'oauth.registerUrl': 'Register at:',
  'oauth.redirectUri': 'Redirect URL (paste into the console)',
  'oauth.copy': 'Copy',
  'oauth.secretOptional': ' (optional)',
  'oauth.scopes': 'Scopes requested: {scopes}',
  'oauth.credentialsNote':
    "The credentials are only used inside the extension's service worker to exchange for a token; the token is stored on this machine and is never part of an exported JSON.",
  'oauth.originsNote': 'Network requests only go to {origins}.',
  'oauth.disconnect': 'Disconnect',
  'oauth.authorized': 'Authorized. You can upload or import right away.',
  'oauth.connecting': 'Authorizing…',
  'oauth.connect': 'Save and connect',
  'oauth.needClientId': 'Fill in the client_id first.',

  // ---------------------------------------------------------------- Checklist list page
  'checklist.loading': 'Loading checklist…',
  // Three segments built around `<strong>` and that `<span aria-hidden>` (see the note in zh.ts).
  'checklist.meta1': 'Total ',
  'checklist.meta2': ' in total · drag the ',
  'checklist.meta3': ' on the left of a card to reorder or move it between sections',
  'checklist.movedTo': 'Moved to {scope} · {source}',
  'checklist.jumpTo': 'Jump to {scope} · {source}',
  'checklist.addTo': 'Add to {scope} · {source}',
  'checklist.addToAria': 'Add to {scope} {source}',
  'checklist.dropHere': 'Drop here',
  'checklist.dragHint': 'Drag a {source} entry here',
  'checklist.addOne': 'Add one',
  'checklist.toTop': 'Back to top',
  'checklist.saved': 'Saved',
  'checklist.added': 'Added',
  'checklist.deleted': 'Deleted',
  'checklist.noteSaved': 'Note saved',
  'checklist.noteCleared': 'Note cleared',

  // ---------------------------------------------------------------- Card
  'card.dragLabel': 'Drag to reorder: {summary}',
  'card.edit': 'Edit',
  'card.editAria': 'Edit entry',
  'card.delete': 'Delete',
  'card.deleteAria': 'Delete entry',
  'card.confirmDelete': 'Confirm delete',
  'card.confirmTitle': 'Click again to confirm deletion',
  'card.confirm': 'Confirm',
  'card.note': 'Note',
  'card.addNote': 'Add a note',
  'card.notePlaceholder': 'Note (leave empty to clear)',
  'card.saveNote': 'Save note',

  // ---------------------------------------------------------------- Entry dialog
  'entry.titleCreate': 'Add to Checklist',
  'entry.titleEdit': 'Edit entry',
  'entry.submitAdd': 'Add',
  'entry.submitSave': 'Save',
  'entry.submitDuplicate': 'Add anyway',
  'entry.summaryRequired': 'The summary is required',
  'entry.duplicateFooter': 'Already exists: #{summary}',
  'entry.duplicateHead': 'Already exists: ',
  'entry.duplicateTail': 'its links overlap with that entry. Add it anyway?',
  'entry.scopeLabel': 'Scope (whole map / a specific object)',
  'entry.scopeAria': 'Scope',
  'entry.sourceLabel': 'Source (raised by you / by someone else)',
  'entry.sourceAria': 'Source',
  'entry.scopeDetected': 'Detected {scope} from the position in the discussion',
  'entry.sourceDetected': 'Detected {source} from the post author',
  'entry.difficultyLabel': 'Difficulty (Easy / Normal / Hard / Insane / Expert)',
  'entry.difficultyAria': 'Difficulty',
  'entry.difficultyDetectedName': 'Detected {tier} from the difficulty name',
  'entry.difficultyDetectedStars': 'Detected {tier} from the star rating {stars}',
  'entry.difficultyClearTitle': 'Click again to clear the difficulty',
  'entry.summaryLabel': 'Summary (required)',
  'entry.summaryPlaceholder': 'What does this mod ask you to check in the beatmap? One sentence is enough; details belong in the links and note.',
  'entry.linksLabel': 'Example links',
  'entry.addLink': '+ Add link',
  'entry.linkAuthorTitle': 'Post author: {name}',
  'entry.authorLoading': 'Reading author…',
  'entry.authorUnknown': 'Author not recognised',
  'entry.authorUnknownTitle': 'This link has no recognisable post author',
  'entry.removeLink': 'Remove link {n}',
  'entry.noteLabel': 'Note (optional)',
  'entry.notePlaceholder': 'Anything else to add? For example how to reproduce it, a related diff, or the outcome.',
  'entry.author': 'Author: {name}',

  // ---------------------------------------------------------------- Data panel
  'data.title': 'Data',
  'data.totalEntries': 'Entries',
  'data.deviceId': 'Device id',
  'data.docUpdated': 'Document updated',
  'data.saveStatus': 'Save status',
  'data.saving': 'Saving…',
  'data.savedAt': 'Saved {time}',
  'data.exportJson': 'Export JSON',
  'data.importJson': 'Import JSON',
  'data.importModeAria': 'Import mode',
  'data.modeMerge': 'Merge',
  'data.modeOverwrite': 'Overwrite',
  'data.clearData': 'Clear data',
  'data.clearConfirm': 'Clear every entry? This cannot be undone.',
  'data.clearYes': 'Yes, clear it',
  'data.cleared': 'Cleared every entry',
  'data.persistError': 'Persistence error: {detail}',
  'data.exported': 'Exported {count}',
  'data.importOverwrite': 'Imported {count} (overwrote everything)',
  'data.importOverwriteDropped': 'Imported {count} (overwrote everything, dropped {dropped} invalid)',
  'data.importMerged': 'Merge done: {added} added, {skipped} duplicates skipped',
  'data.importMergedDropped':
    'Merge done: {added} added, {skipped} duplicates skipped (dropped {dropped} invalid)',

  // ---------------------------------------------------------------- Popup
  'popup.total': '{count} in total',
  'popup.cellLabel': '{scope} · {source}',
  'popup.gridAria': 'Checklist cell counts',
  'popup.readError': 'Could not read the local data: {detail}',
  'popup.pageError': 'Could not open the Checklist page: {detail}',
  'popup.empty':
    'Nothing recorded yet. Click the extension icon on a beatmap discussion page to collect one, or open the Checklist page and add one by hand.',
  'popup.openPage': 'Open the Checklist page',

  // ---------------------------------------------------------------- Text injected by the content script
  'content.addEntry': '+ Add to Checklist',
  'content.addEntryTitle': 'Add this mod to your checklist',
  'content.openApp': 'Open Sloppy Modding Checklist',
  'content.added': 'Added to the Checklist',
  'content.addedLocalSaveFailed': 'Added to the Checklist (saving locally failed)',
  'content.readFailed': 'Could not read this post.',
  'content.siteChanged': 'The site layout may have changed, so reading it failed.',
  'content.openFailed': 'Could not open the Checklist page',

  // ---------------------------------------------------------------- Toasts
  'toast.copied': 'Copied. Paste it into the console.',
  'toast.copyFailed': 'Copy failed. Select the address in the box and copy it manually.',

  // ---------------------------------------------------------------- About panel
  'about.title': 'About',
  'about.author': 'Author: {author}',
  'about.version': 'Version {version}',
  'about.license': 'MIT License',
  'about.aiNote': 'This extension was generated by DeepSeek V4 vibe coding.',
  'about.repo': 'GitHub repository',
  'about.electoz':
    "This extension is a convenience tool built on the basic ideas of Electoz's \"Advanced Modding Guide\". It is for personal entertainment only.",
  'about.electozUser': 'Electoz on osu!',
  'about.electozGuide': 'Advanced Modding Guide (PDF)',
};
