/**
 * Chinese catalog (CODING_PLAN §14).
 *
 * This file is the base: `MessageKey` comes from it (`keyof typeof zh`) and the other locales
 * are checked against it, so renaming a key here breaks every locale at compile time -- a
 * missing translation shows up in `tsc`, not in front of a user.
 *
 * A value is a sentence, not a place for logic: `{name}` params have to match what the call
 * site passes, and brand names (Dropbox, WebDAV, osu!) always come in as params. Plurals are
 * dodged with wording for now; when a language really needs them, the rules go in one place,
 * the value type of `Catalog`.
 */
export const zh = {
  // ---------------------------------------------------------------- Action words
  // These are phrases embedded in other sentences, not button labels, so case and tone are
  // written for "inserted mid-sentence".
  'action.test': '测试连接',
  'action.upload': '上传',
  'action.download': '下载',
  'action.folderOpen': '打开同步文件夹',
  'action.folderRead': '读取同步文件',
  'action.folderWrite': '写入同步文件',

  // ---------------------------------------------------------------- HTTP layer
  'err.http.unreachable': '连不上 {host}：{detail}',
  // Pure passthrough. The technical strings the platform throws (fetch errors, JSON parse
  // errors) cannot be translated anyway, but `describeError` has to return a uniform Msg
  // type, so it gets a slot that outputs them as-is -- and if a prefix is ever wanted for
  // this kind of text, there is only one place to change.
  'err.raw': '{detail}',

  // ---------------------------------------------------------------- WebDAV
  // Form validation: these four do not fit the "{action}失败" templates in `err.webdav.*` --
  // nothing has even connected to the server yet, so it is not a "failure", it is "not
  // filled in completely".
  'err.webdav.noBaseUrl': '请填写 WebDAV 服务器地址。',
  'err.webdav.badBaseUrl': '服务器地址要是完整的 http(s) URL，例如 https://dav.jianguoyun.com/dav/',
  'err.webdav.noUsername': '请填写账号。',
  'err.webdav.noPassword': '请填写密码或应用密码。',

  // One template × three actions (test connection / upload / download), so the action word is a param.
  'err.webdav.auth': '{action}失败：{host} 拒绝了认证（HTTP {status}），请检查账号与密码。',
  'err.webdav.notFound': '{action}失败：路径不存在（HTTP 404），请检查服务器地址与子目录。',
  'err.webdav.unsupported': '{action}失败：服务器不支持该操作（HTTP {status}）。',
  'err.webdav.server': '{action}失败：服务器错误（HTTP {status}），稍后可重试。',
  'err.webdav.other': '{action}失败：HTTP {status}。',

  // ---------------------------------------------------------------- OAuth flow
  'err.oauth.redirectUnparsable': '授权回调地址无法解析。',
  'err.oauth.stateMismatch': '授权回调的 state 不匹配，已中止。请重新连接。',
  'err.oauth.cancelled': '已取消授权（你在授权页点了拒绝）。',
  'err.oauth.deniedByServer': '授权被拒绝：{error}',
  'err.oauth.deniedByServerDetail': '授权被拒绝：{error}（{detail}）',
  'err.oauth.noCode': '授权没有返回 code，请重试。',
  'err.oauth.noAccessToken': '授权服务器没有返回 access_token，请重试。',
  'err.oauth.tokenInvalid': '{provider} 的授权已失效，请在设置页重新连接。',
  'err.oauth.badClient':
    '{provider} 拒绝了 client 凭据（HTTP {status}），请检查 client_id / client_secret。',
  'err.oauth.providerServer': '{provider} 的服务器出错（HTTP {status}），稍后可重试。',
  'err.oauth.exchangeFailed': '{provider} 换 token 失败：{reason}',
  'err.oauth.exchangeFailedDetail': '{provider} 换 token 失败：{reason}（{detail}）',
  'err.oauth.noClientId': '请先填写 {provider} 的 client_id。',

  // The closed-authorization-window notice has several paragraphs: a conclusion + a lead-in
  // + some console pitfalls + a redirect URL reminder. The caller joins them (`Msg[]` joined
  // with newlines), so each paragraph is its own key.
  'err.oauth.windowClosed': '授权窗口被关闭了，没有拿到授权码。\n{hints}\n{redirect}',
  'err.oauth.windowClosedIntro':
    '如果那个窗口里出现过报错，那多半不是「没完成」，而是控制台里的配置对不上。{provider} 最常见的是：',
  'err.oauth.windowClosedNoHints':
    '（如果那个窗口里出现过 400 之类的报错，那就不是「没完成」，而是控制台里的配置对不上。）',
  'err.oauth.windowClosedHintLine': '{n}. {hint}',
  'err.oauth.windowClosedRedirect':
    '扩展发出的重定向地址是 {redirectUri}，必须与控制台里登记的那一串**逐字符一致**，结尾的斜杠不能少（对不上时授权方的报错里会带 redirect_uri_mismatch）。',

  // ---------------------------------------------------------------- OAuth provider API errors
  // `X` / `XDetail` come in pairs: "with detail" and "without detail" are two sentences, not
  // one sentence with a switch -- parentheses can only appear or disappear as a whole, and
  // template strings cannot express a conditional slot. The call site picks the sentence with
  // `detail ? 'XDetail' : 'X'`, and the punctuation stays here; the two should differ in
  // exactly one placeholder, `detail` (tests/i18n.test.ts watches this).
  'err.api.auth': '{provider} {action}失败：授权被拒（HTTP {status}）。请在设置页重新连接。',
  'err.api.authDetail':
    '{provider} {action}失败：授权被拒（HTTP {status}）（{detail}）。请在设置页重新连接。',
  'err.api.rateLimited': '{provider} {action}失败：请求太频繁（HTTP 429），稍后再试。',
  'err.api.server': '{provider} {action}失败：服务端错误（HTTP {status}），稍后可重试。',
  'err.api.serverDetail':
    '{provider} {action}失败：服务端错误（HTTP {status}）（{detail}），稍后可重试。',
  'err.api.other': '{provider} {action}失败：HTTP {status}。',
  'err.api.otherDetail': '{provider} {action}失败：HTTP {status}（{detail}）。',
  'err.api.notConnected': '{provider} 还没有连接，请先在设置页点「连接」。',
  'err.api.expired': '{provider} 的授权已过期，请重新连接。',

  // ---------------------------------------------------------------- Local sync folder
  'err.folder.permissionRevoked':
    '浏览器收回了同步文件夹的访问权限，无法{action}。请回到设置页，在「本地同步文件夹」那张卡片上点「重新授权」，并在系统弹框里点「允许」。',
  'err.folder.missing':
    '同步文件夹不在了（被删除、改名，或者云盘客户端断开挂载了？），无法{action}。请在设置页重新选择一次文件夹。',
  'err.folder.busy': '同步文件正被别的程序占用，无法{action}。稍后重试一次。',
  'err.folder.notAFile': '那个位置上已经有一个同名的**文件夹**，无法{action}。请换一个同步文件夹。',
  'err.folder.other': '无法{action}：{detail}',
  'err.folder.noFolder': '还没有选择同步文件夹。请在设置页点「选择文件夹」。',
  'err.folder.handleLost':
    '记不起「{name}」这个文件夹了（扩展的数据可能被清理过，或者是导入的设置里带过来的）。请在设置页重新选择一次文件夹。',
  'err.folder.denied':
    '浏览器明确拒绝了「{name}」的访问权限。请在设置页重新选择一次文件夹（如果还是被拒，去地址栏左侧的站点设置里，把本扩展的「文件编辑」权限恢复成「询问」）。',
  'err.folder.needsReauth':
    '「{name}」需要重新授权才能读写。请回到设置页，点那张卡片上的「重新授权」，在系统弹框里点「允许」。',

  // ---------------------------------------------------------------- SyncManager
  'err.manager.badRemoteJson': '远端文件不是合法的 checklist JSON：{detail}',
  'err.manager.readFailed': '读取远端失败：{detail}',
  'err.manager.pushFailed': '上传失败：{detail}',

  // ---------------------------------------------------------------- Background messages
  'err.bg.notOAuth': '这个同步端不是通过 OAuth 授权的。',
  'err.bg.noClientId': '请先填写并保存 {provider} 的 client_id。',
  'err.bg.unknown': '未知的同步端：{id}。',
  // These three used to be bare `Error`s, which describeError collects into `err.raw` and
  // shows as-is -- so they slipped through as "the whole UI in English except this one
  // Chinese sentence".
  'err.bg.noProvider': '还没有选择同步方式。',
  'err.bg.notConfigured': '{provider} 还没有配置完整。',
  'err.bg.noLocalDoc': '本地还没有数据。',
  // The SW got a type that matches the prefix but that it does not know: nine times out of
  // ten the page is new and the running SW is old.
  'err.bg.unknownMessage': '后台不认识这条消息（{type}），扩展可能没有重新加载。',
  'err.bg.commFailed': '后台通信失败：{detail}',
  // Last resort: describeError itself threw (which should not happen), but the user still
  // needs a sentence.
  'err.sync.failed': '同步失败。',
  'err.sync.failedDetail': '同步失败：{detail}',

  // ---------------------------------------------------------------- Settings registration wizard
  // Where to create the app (consoleUrl) and what the console is called (consoleLabel) are
  // brand names/URLs and stay out of the catalog; these entries are the explanatory text
  // that really does need translating.
  'help.dropbox.step1': 'Create app → 选 Scoped access → 类型选 **App folder**。',
  'help.dropbox.step2':
    '「Permissions」里勾上 files.content.read、files.content.write、files.metadata.read。**勾完必须点页面底部的 Submit**，只勾不提交等于没配。',
  'help.dropbox.step3': '「OAuth 2」→ Redirect URIs 里粘贴下面这个地址。',
  'help.dropbox.step4': '把 App key 填入 client_id 栏（App secret 不需要填）。',
  'help.dropbox.caution': '文件放在 `/Apps/<应用名>/` 里，不会碰到 Dropbox 里的其它内容。',
  'help.dropbox.misconfig1':
    '授权页显示 **No scope requested can be granted for this app**：「Permissions」里那三个 scope 没勾，或者勾了**没点 Submit**（最容易漏的一条）。改完要重新走一次授权，老 token 不会自动补上权限。',
  'help.dropbox.misconfig2':
    '授权页显示 redirect_uri 不在白名单里：「OAuth 2」页里的 Redirect URIs 与设置页里那串不一致（结尾斜杠、http/https 都算）。',
  'help.dropbox.misconfig3':
    '授权页显示应用不可用 / client_id 无效：App key 填错了，或者这个应用在 App Console 里被停用了。',

  // ---------------------------------------------------------------- Sync decision (plan.ts)
  'plan.pull.noRemote': '远端还没有备份文件；可以点「立即上传」创建一份。',
  'plan.pull.same': '远端与本地内容一致，无需拉取。',
  'plan.pull.remoteNewer': '远端更新，将采用远端。',
  'plan.pull.localNewer': '本地更新，已跳过往回拉（如需上传请点「立即上传」）。',
  'plan.pull.localWins': '时间戳相同，策略为「本地优先」，保持本地。',
  'plan.pull.remoteWins': '时间戳相同，策略为「远端优先」，采用远端。',
  'plan.pull.ask': '时间戳相同但内容不同，需要你决定保留哪一份。',
  'plan.pull.tieRemote': '时间戳相同（无法判谁更新），按平局规则采用远端。',
  'plan.push.noRemote': '远端还没有备份文件，将新建一份。',
  'plan.push.same': '远端与本地内容一致，无需上传。',
  'plan.push.localWins': '远端更新，但策略为「本地优先」，将覆盖远端。',
  'plan.push.ask': '远端比本地更新，上传会覆盖它，需要你确认。',
  'plan.push.ok': '将本地内容上传到远端。',

  // ---------------------------------------------------------------- Sync results
  // The count goes through `{count}` rather than being glued into "N 条" here: English needs
  // wording that does not inflect (see the conventions in the header), so the concatenation
  // stays in the template -- don't leak a countLabel out here.
  'sync.pushed': '已上传 {count} 条{suffix}',
  'sync.pushedBackup': '；覆盖前的远端已备份为「{backup}」',
  'sync.pulled': '已采用远端 {count} 条{suffix}',
  'sync.pulledBackup': '；覆盖前的本地已备份为「{backup}」',
  'sync.testOk': '连接正常（{provider}）。',
  'sync.connected': '已连接 {provider}。',
  'sync.disconnected': '已断开 {provider}，远端文件不会被删除。',

  // ================================================================ UI text
  // From this line down it is UI text (buttons, headings, hints); above it is the "which
  // sentence + what params" that core code produces. Sharing one catalog between the two is
  // deliberate: there is only one place to look up a translation.

  // ---------------------------------------------------------------- Brands / proper nouns
  // Provider names go in the catalog too: they get interpolated into all sorts of sentences
  // as `{provider}`, and "本地同步文件夹" has to be "Local sync folder" in English. WebDAV /
  // Dropbox are trademarks and read the same in both, but they still take a key -- that way
  // `displayName` can have the uniform type `MessageKey` and call sites don't have to
  // distinguish "this one is translatable, that one isn't".
  'provider.localFolder': '本地同步文件夹（免注册）',
  // The short name used inside sentences (the "（免注册）" in the dropdown is a selling
  // point, but stuffing it into a sentence is wordy)
  'provider.localFolderShort': '本地同步文件夹',
  'provider.webdav': 'WebDAV',
  'provider.dropbox': 'Dropbox',

  // ---------------------------------------------------------------- Common words
  'common.listSeparator': '、',
  'common.cancel': '取消',
  'common.close': '关闭',
  'common.noSummary': '(无概述)',

  // The names of the four category cells. Both catalogs have the same values (General /
  // Individual / Internal / External are the established terms in the osu! modding
  // community, and users talk to each other with those four words), but each still takes a
  // key -- same as the provider brand names, so call sites don't have to distinguish "this
  // one is translatable, that one isn't". If they ever really need translating (saying
  // "具体对象" for Individual, say), change the catalog -- not a line of code.
  'scope.general': 'General',
  'scope.individual': 'Individual',
  'source.internal': 'Internal',
  'source.external': 'External',

  // Difficulty tiers. Same reasoning as the four cell names above: Easy / Normal / Hard /
  // Insane / Expert are the words osu! itself uses, so both catalogs read the same. They
  // still take keys, so a call site never has to know which labels happen to be identical.
  'difficulty.easy': 'Easy',
  'difficulty.normal': 'Normal',
  'difficulty.hard': 'Hard',
  'difficulty.insane': 'Insane',
  'difficulty.expert': 'Expert',

  // ---------------------------------------------------------------- Shell (top bar / settings page)
  'nav.checklist': 'Checklist',
  'nav.settings': '设置',
  'nav.aria': '主导航',
  'settings.title': '设置',

  // The language toggle needs its own labels too -- and it is the one place where you cannot
  // cut corners on grammar: a user who cannot read the current language has to switch back
  // here, so each language name is written the way that language writes itself (endonym:
  // "中文" is not rendered as "Chinese", "English" is not rendered as "英文"), which is why
  // these values are the same in both catalogs. This is the usual practice for a language
  // picker.
  'settings.language': '界面语言',
  'settings.languageAuto': '跟随浏览器',
  'settings.languageZh': '中文',
  'settings.languageEn': 'English',

  // ---------------------------------------------------------------- Conflict strategy
  'strategy.newest-wins': '时间戳较新的胜出',
  'strategy.local-wins': '本地优先',
  'strategy.remote-wins': '远端优先',
  'strategy.ask': '每次都要确认',

  // ---------------------------------------------------------------- Sync panel
  'sync.title': '同步',
  'sync.loading': '正在载入同步设置…',
  'sync.intro': '把 checklist 备份到自己的网盘，多台设备各取一份。同一时刻只用一个同步方式。',
  'sync.providerLabel': '同步方式',
  'sync.providerConnected': '（已连接）',
  'sync.test': '测试连接',
  'sync.testBusy': '测试中…',
  'sync.testAndSave': '保存并测试连接',
  'sync.push': '立即上传',
  'sync.pushBusy': '上传中…',
  'sync.pull': '从远端拉取',
  'sync.pullBusy': '拉取中…',
  'sync.autoSync': '自动上传（改动后自动传，并每小时拉一次）',
  'sync.pullOnStart': '打开扩展时拉取',
  'sync.strategyLabel': '冲突策略',

  'sync.conflict.pushHeadline': '远端比本地更新',
  'sync.conflict.pullHeadline': '两边内容不同',
  'sync.conflict.pushReason': '现在上传会用本地内容覆盖远端，那边更晚的改动会丢（覆盖前会自动备份一份）。',
  'sync.conflict.pullReason': '时间戳相同，无法自动判断该保留哪一份。',
  // The announcement has one extra sentence over the visible text, "请选择如何处理": after
  // reading a live region a screen reader does not move focus here automatically, and
  // without spelling it out the user only hears "something went wrong" with no idea that a
  // button is waiting below.
  'sync.conflict.announce': '同步冲突：{headline}。{reason}请选择如何处理。',
  'sync.conflict.overwrite': '仍然用本地覆盖',
  'sync.conflict.cancel': '取消',
  'sync.conflict.keepLocal': '保留本地',
  'sync.conflict.takeRemote': '采用远端',
  'sync.conflict.merge': '两边合并',

  'sync.stats.lastSync': '上次同步',
  'sync.stats.lastAction': '上次动作',
  'sync.stats.status': '状态',
  'sync.stats.actionPush': '上传',
  'sync.stats.actionPull': '拉取',
  'sync.stats.failed': '失败',
  'sync.stats.ok': '正常',
  'sync.stats.disabled': '未启用',
  'sync.stats.lastError': '最近一次同步失败：{detail}',

  'sync.err.noHostPermission': '没有获得访问该服务器的权限，无法发送同步请求。',
  'sync.err.pickerUnsupported': '这个浏览器不支持直接选择文件夹（需要 Chrome 或 Edge 86 以上）。',
  'sync.err.pickCancelled': '已取消：没有选择文件夹。',
  'sync.err.handleLost': '记不起之前选的文件夹了，请重新选择一次。',
  'sync.err.folderDenied':
    '没有得到文件夹的访问权限。可以再点一次，或者在系统的文件夹选择框里重新选它。',
  'sync.err.folderNeedsReauth': '文件夹需要重新授权。',
  'sync.err.noFolderChosen': '请先选择同步文件夹。',
  'sync.err.noClientId': '请填写 client_id。',
  'sync.err.bgNoResponse': '后台没有响应，请重试。',
  'sync.folderPicked': '已选择「{name}」。同步文件是它里面的 modding-checklist.json。',
  'sync.folderRestored': '已恢复文件夹的访问权限。',
  'sync.folderForgotten': '已断开。网盘里的那个文件没有被删除，重新选回来就能继续用。',
  'sync.merged': '已合并：新增 {added}，跳过重复 {skipped}。确认无误后再点「立即上传」。',
  'sync.keptLocal': '已保留本地内容。',

  // WebDAV form
  'sync.dav.baseUrl': '服务器地址',
  // This sentence has a `<strong>集合</strong>` in the middle. The standard i18n practice is
  // to split around the markup; putting a whole sentence with HTML in the catalog means a
  // translator can break the tags without noticing.
  'sync.dav.baseUrlHint1': '填 WebDAV 的',
  'sync.dav.baseUrlHintStrong': '集合',
  'sync.dav.baseUrlHint2':
    '地址（目录），不是文件地址。文件名固定为 modding-checklist.json。坚果云填 https://dav.jianguoyun.com/dav/',
  'sync.dav.username': '账号',
  'sync.dav.password': '密码 / 应用密码',
  'sync.dav.path': '子目录（可留空）',
  'sync.dav.pathPlaceholder': '例如 osu-checklist',
  'sync.dav.plaintextWarning':
    '密码以明文存在扩展自己的本地存储里（本机 chrome.storage.local），不会随同步上传、也不会进导出的 JSON。建议在网盘那边单独生成一个应用密码，别用主账号密码。',

  // ---------------------------------------------------------------- Local sync folder card
  'folder.label': '同步文件夹',
  // Same as `sync.dav.baseUrlHint`: split around `<strong>`. This paragraph has two markers
  // in it, so it is cut into five segments -- a few extra cuts cost far less than making a
  // translator count whether a pair of tags balances.
  'folder.intro1': '用 Google Drive、OneDrive、Dropbox 等',
  'folder.introStrong1': '桌面客户端',
  'folder.intro2':
    '把网盘映射成一个本地文件夹，然后在这里选中它。扩展会往里面写一个 {file}，上云由客户端负责。整个过程',
  'folder.introStrong2': '不需要注册应用、不需要开发者控制台、不需要登录任何账号',
  'folder.intro3': '。',
  'folder.current': '当前文件夹：',
  'folder.statusGranted': '（可读写）',
  'folder.statusPrompt': '（需要重新授权）',
  'folder.statusDenied': '（权限被拒绝）',
  'folder.none': '还没有选择文件夹。',
  'folder.permissionNotice':
    '浏览器会在一段时间后收回文件夹的访问权限（关掉浏览器再打开、或者系统重启之后通常就会）。这不是出错。点一下「重新授权」，在系统弹框里点「允许」就好。',
  // A bit longer than `sync.err.pickerUnsupported`: the text on the card is always visible,
  // so it can mention that there are other routes; that error only appears after the user
  // clicks the button, so it has to be short.
  'folder.unsupported':
    '这个浏览器不支持直接选择文件夹（需要 Chrome 或 Edge 86 以上）。换用下面的 WebDAV 或网盘方式同样可以同步。',
  'folder.pick': '选择文件夹',
  'folder.change': '换个文件夹',
  'folder.picking': '处理中…',
  'folder.reauthorize': '重新授权',
  'folder.forget': '断开',
  // Same as `sync.dav.baseUrlHint`: split around `<strong>`
  'folder.tip1':
    '小提示：建议在网盘里新建一个空文件夹专门放它，别直接选「我的云端硬盘」的根目录，省得以后在一堆文件里找。断开只会清掉扩展这边的记录，',
  'folder.tipStrong': '不会删除那个文件',
  'folder.tip2': '。',

  // ---------------------------------------------------------------- OAuth card
  'oauth.status.connected': '● 已连接',
  'oauth.status.disconnected': '○ 未连接',
  'oauth.registerUrl': '注册地址：',
  'oauth.redirectUri': '重定向地址（粘到控制台里）',
  'oauth.copy': '复制',
  'oauth.secretOptional': '（可留空）',
  'oauth.scopes': '申请的权限：{scopes}',
  'oauth.credentialsNote':
    '凭据只在扩展的 service worker 里用于换 token；token 存在本机，不进导出的 JSON。',
  'oauth.originsNote': '网络请求只发往 {origins}。',
  'oauth.disconnect': '断开连接',
  'oauth.authorized': '已授权，可以直接上传 / 拉取。',
  'oauth.connecting': '授权中…',
  'oauth.connect': '保存并连接',
  'oauth.needClientId': '先把 client_id 填上。',

  // ---------------------------------------------------------------- Checklist list page
  'checklist.loading': '正在载入 checklist…',
  // "共 N 条 · 拖动卡片左侧 ⋮⋮ 可排序或跨区移动" is cut into three segments around <strong>
  // and that `<span aria-hidden>` (same as folder.intro).
  // `⋮⋮` is deliberately kept in code and out of the catalog: it is an icon, not a word --
  // a translator might turn it into text, and the point of `aria-hidden` is precisely to
  // keep a screen reader from reading those dots out.
  'checklist.meta1': '共 ',
  'checklist.meta2': ' 条 · 拖动卡片左侧 ',
  'checklist.meta3': ' 可排序或跨区移动',
  // Section names are joined with `×` inside these sentences (General × Internal); English
  // switches to `·` so a full-width multiplication sign does not sit inside English text --
  // this kind of punctuation difference is exactly what you cannot force by concatenating.
  'checklist.movedTo': '已移动到 {scope} × {source}',
  'checklist.jumpTo': '跳到 {scope} × {source}',
  'checklist.addTo': '新增到 {scope} × {source}',
  'checklist.addToAria': '新增到 {scope} {source}',
  'checklist.dropHere': '放到这里',
  'checklist.dragHint': '把 {source} 的条目拖到这里',
  'checklist.addOne': '添加一条',
  'checklist.toTop': '回到顶部',
  'checklist.saved': '已保存',
  'checklist.added': '已添加',
  'checklist.deleted': '已删除',
  'checklist.noteSaved': '备注已保存',
  'checklist.noteCleared': '已清除备注',

  // ---------------------------------------------------------------- Card
  'card.dragLabel': '拖动排序：{summary}',
  'card.edit': '编辑',
  'card.editAria': '编辑条目',
  'card.delete': '删除',
  'card.deleteAria': '删除条目',
  'card.confirmDelete': '确认删除',
  'card.confirmTitle': '再点一次确认删除',
  'card.confirm': '确认',
  'card.note': '备注',
  'card.addNote': '添加备注',
  'card.notePlaceholder': '备注（可留空清除）',
  'card.saveNote': '保存备注',

  // ---------------------------------------------------------------- Entry dialog
  'entry.titleCreate': '添加到 Checklist',
  'entry.titleEdit': '编辑条目',
  'entry.submitAdd': '添加',
  'entry.submitSave': '保存',
  'entry.submitDuplicate': '仍然添加',
  'entry.summaryRequired': '概述不能为空',
  'entry.duplicateFooter': '已存在：#{summary}',
  'entry.duplicateHead': '已存在：',
  'entry.duplicateTail': '链接与该条目重合，仍要新增吗？',
  'entry.scopeLabel': '范围（整图问题 / 具体对象）',
  'entry.scopeAria': '范围',
  'entry.sourceLabel': '来源（自己提出 / 他人提出）',
  'entry.sourceAria': '来源',
  'entry.scopeDetected': '已按讨论页位置识别为 {scope}',
  'entry.sourceDetected': '已按帖子作者识别为 {source}',
  'entry.difficultyLabel': '难度（Easy / Normal / Hard / Insane / Expert）',
  'entry.difficultyAria': '难度',
  'entry.difficultyDetectedName': '已按谱面难度名识别为 {tier}',
  'entry.difficultyDetectedStars': '已按星数 {stars} 识别为 {tier}',
  'entry.difficultyClearTitle': '再点一次取消难度',
  'entry.summaryLabel': '概述（必填）',
  'entry.summaryPlaceholder': '这条 mod 提示检查谱面的什么？一句概括即可，细节放在链接和备注里。',
  'entry.linksLabel': '示例链接',
  'entry.addLink': '＋ 添加链接',
  'entry.linkAuthorTitle': '帖子作者：{name}',
  'entry.authorLoading': '读取作者…',
  'entry.authorUnknown': '未识别作者',
  'entry.authorUnknownTitle': '这条链接没有可识别的帖子作者',
  'entry.removeLink': '删除第 {n} 个链接',
  'entry.noteLabel': '备注（可选）',
  'entry.notePlaceholder': '还有什么要补充的？例如复现方式、相关 diff、处理结果。',
  'entry.author': '作者：{name}',

  // ---------------------------------------------------------------- Data panel
  'data.title': '数据',
  'data.totalEntries': '条目总数',
  'data.deviceId': '设备 id',
  'data.docUpdated': '文档更新时间',
  'data.saveStatus': '保存状态',
  'data.saving': '保存中…',
  'data.savedAt': '已保存 {time}',
  'data.exportJson': '导出 JSON',
  'data.importJson': '导入 JSON',
  'data.importModeAria': '导入方式',
  'data.modeMerge': '合并',
  'data.modeOverwrite': '覆盖',
  'data.clearData': '清空数据',
  'data.clearConfirm': '确认清空全部条目？此操作不可撤销。',
  'data.clearYes': '确认清空',
  'data.cleared': '已清空全部条目',
  'data.persistError': '持久化错误：{detail}',
  'data.exported': '已导出 {count} 条',
  // "丢弃了 N 条非法数据" is a sentence appended after the result, so this is another
  // `X` / `XDropped` pair (see the note on `X` / `XDetail` in the header): the parentheses
  // can only appear or disappear as a whole.
  'data.importOverwrite': '已覆盖导入 {count} 条',
  'data.importOverwriteDropped': '已覆盖导入 {count} 条（丢弃非法条目 {dropped}）',
  'data.importMerged': '合并导入完成：新增 {added}，跳过重复 {skipped}',
  'data.importMergedDropped':
    '合并导入完成：新增 {added}，跳过重复 {skipped}（丢弃非法条目 {dropped}）',

  // ---------------------------------------------------------------- Popup
  'popup.total': '共 {count} 条',
  // The four cell names are built by concatenation (cell name × cell name), and the separator
  // counts as text too -- see `common.listSeparator`.
  'popup.cellLabel': '{scope} · {source}',
  'popup.gridAria': 'Checklist 四格计数',
  'popup.readError': '读取本地数据失败：{detail}',
  'popup.pageError': '打不开 Checklist 页面：{detail}',
  'popup.empty':
    '还没有记录。在 beatmap discussion 页面点扩展图标就能收一条，也可以打开 Checklist 页面手动添加。',
  'popup.openPage': '打开 Checklist 页面',

  // ---------------------------------------------------------------- Text injected by the content script
  // These are created with `document.createElement` (the "＋" next to a post, the floating
  // button in the bottom right) and are not in React -- see `relabelInjected` in
  // content/index.tsx: when the locale changes they have to be relabelled by hand.
  'content.addEntry': '＋ 添加到 Checklist',
  'content.addEntryTitle': '把这条 mod 加入你的 checklist',
  'content.openApp': '打开 Sloppy Modding Checklist',
  'content.added': '已添加到 Checklist',
  'content.addedLocalSaveFailed': '已添加到 Checklist（本地保存失败）',
  'content.readFailed': '没能读取这条帖子的信息',
  'content.siteChanged': '站点结构可能有变化，读取失败',
  'content.openFailed': '打开 Checklist 页面失败',

  // ---------------------------------------------------------------- Toasts
  'toast.copied': '已复制，粘到控制台即可',
  'toast.copyFailed': '复制失败，请手动选中输入框里的地址',

  // ---------------------------------------------------------------- About panel
  'about.title': '关于',
  'about.author': '作者：{author}',
  'about.version': '版本 {version}',
  'about.license': 'MIT License',
  'about.aiNote': '本扩展由 DeepSeek V4 的 vibe coding 生成。',
  'about.repo': 'GitHub 仓库',
  'about.electoz':
    '本扩展是依据 Electoz 的《Advanced Modding Guide》的基本思路做的便利工具，仅供个人娱乐使用。',
  'about.electozUser': 'Electoz 的 osu! 主页',
  'about.electozGuide': 'Advanced Modding Guide（PDF）',
} as const;
