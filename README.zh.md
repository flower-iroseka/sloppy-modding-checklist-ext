# Sloppy Modding Checklist

[English](README.md) | **中文**

一款用于 osu! beatmap discussion 页面的浏览器扩展，把值得检查的谱面问题整理成清单。

准备申请 BN 前，用它整理这张谱面还有哪些问题要看。平时也可以当作普通的 mod 检查表使用。

清单按两个维度分类：

- **范围**：**General** 指整张谱面的问题（例如整体音量、节奏）；**Individual** 指某个具体物件的问题（例如某个 note 的摆放）。
- **来源**：**Internal** 指自己提出的问题；**External** 指他人提出的问题。

两个维度组合，得到四个格子。

Individual 的记录带有一个**难度**字段，取值为 Easy、Normal、Hard、Insane、Expert 之一。多数 mod 只对某一档难度成立，该字段记录的就是这条记录对应的档位。从 discussion 页面添加记录时，该字段自动填入。

本扩展的做法取自 Electoz 的 [Advanced Modding Guide](https://electoz.s-ul.eu/N7Y53Jaj)（2020-04-19 版），在其基础上增加了跨设备同步。

---

## 安装

构建环境需 Node 18 及以上，浏览器需 Chrome 或 Edge。

```bash
npm install
npm run build          # 产物在 dist/
```

在浏览器中：

1. 打开 `chrome://extensions`，在右上角开启「开发者模式」；
2. 点击「加载已解压的扩展程序」，选择 **`dist/`** 目录（不是仓库根目录）。

修改代码后需重新构建，并在扩展管理页点击「重新加载」。`src/content/` 下的改动例外：浏览器会沿用上一次加载的内容脚本，此时需重启浏览器。

---

## 使用方法

### 1. 在 discussion 页面添加记录

打开任意 beatmap discussion 页面（`https://osu.ppy.sh/beatmapsets/<id>/discussion*`），每条帖子旁会显示「＋ 添加到 Checklist」按钮，点击后为该帖子添加一条记录。

页面左下角有一个浮动按钮，点击后打开 Checklist 页面，用于查看清单。

页面指向某一个具体难度时，记录的难度字段会自动填入：先按该难度的名称查询 [osu! wiki 的难度命名表](https://osu.ppy.sh/wiki/zh/Ranking_criteria/Difficulty_naming)（含从其他音游借用的命名方案），名称不在表中时按该难度的星数判断。填入的值可以在对话框中修改；再次点击已选中的档位即可清空。

### 2. 查看统计

点击浏览器工具栏上的扩展图标，弹出窗口显示清单的统计数据：分类小计和所有分类总计。修改内容请点击窗口下方的「打开 Checklist 页面」。

### 3. 在 Checklist 页面整理记录

页面按上述两个维度分为四个格子，每个格子中的记录以卡片形式排列。卡片可通过左侧的 `⋮⋮` 手柄拖动：

- **在同一格子内拖动**：调整记录在该格子中的先后顺序；
- **拖到其他格子**：修改该记录的范围与来源（例如从 General 改为 Individual）；
- **键盘操作**：按 `Tab` 选中卡片左侧的 `⋮⋮` 手柄，按 `空格` 拿起卡片，用方向键移至目标位置，再按 `空格` 放下；按 `Esc` 取消本次拖动。

卡片右上角有两个图标按钮：编辑和删除。备注按钮位于下一行的右端，与链接排在一起。删除需要二次确认：首次点击后按钮变为「确认」，三秒内再次点击才会删除。

Individual 的卡片设有难度时，难度显示在概述旁，前面的小竖条使用 osu! 为该档难度规定的颜色。未设置难度的卡片不显示。General 的卡片一律不显示：记录拖到 General 列后该标记隐藏，字段值保留；拖回 Individual 列后标记重新显示。

### 4. 修改界面语言

打开 Checklist 页面，切换到顶部的「设置」标签页，最上方有一个语言下拉框，提供三种配置：**跟随浏览器**（默认）、**中文**、**English**。修改后立即生效，扩展的各个页面同步更新。

选择「跟随浏览器」时只识别**主语言**：`zh-CN`、`zh-TW`、`zh` 均视为中文，`en-*` 均视为英文，其余语言使用英文。

---

## 同步（可选）

数据默认保存在本机。

同步分为上传和导入两个方向：**上传**是把本机的清单写入远端，**导入**是把远端的清单取回本机。此处的「远端」指所选同步位置上的一份文件。启用同步并选定同步方式后，清单保存为 `modding-checklist.json` 这一个文件，各台设备同步的是同一份。

**同一时间只能使用一种同步方式**，在设置页的「同步方式」下拉框中选择：

- **本地同步文件夹（免注册）** —— 默认选项。先安装网盘的桌面客户端（Dropbox、坚果云等均提供），由客户端把网盘中的一个目录挂载为电脑上的本地文件夹，然后在设置页选中该文件夹。扩展只往文件夹中写文件，上传到云端由客户端完成。使用该方式时，桌面客户端需保持运行，上传时机由客户端决定。浏览器会收回文件夹权限（通常在关闭并重新打开浏览器之后），此时设置页会提示点击一次「重新授权」。
- **WebDAV** —— 填写服务器地址与账号密码（坚果云、Nextcloud 等均提供 WebDAV）。地址须为 https，只有本机地址（127.0.0.1、localhost）可以用 http：http 会把账号密码明文发到网络上。点击「保存并测试连接」时，扩展会向浏览器申请该服务器的访问权限。
- **Dropbox** —— 需先前往 Dropbox 控制台注册一个应用（见下方的逐步向导）。

### Dropbox 的注册向导

注册地址：[Dropbox App Console](https://www.dropbox.com/developers/apps)（`https://www.dropbox.com/developers/apps`）

1. Create app → 选 Scoped access → 类型选 **App folder**。
2. 「Permissions」里勾上 files.content.read、files.content.write、files.metadata.read。**勾完必须点页面底部的 Submit**，只勾不提交等于没配。
3. 「OAuth 2」→ Redirect URIs 里粘贴下面这个地址。
4. 把 App key 填入 client_id 栏（App secret 不需要填）。

第 3 步要粘贴的地址，就是设置页「重定向地址」一栏中的地址，该栏右侧有「复制」按钮。格式如下，**必须与控制台中登记的一致到每一个字符**（包括结尾的斜杠）：

```
https://<扩展 ID>.chromiumapp.org/
```

文件放在 `/Apps/<应用名>/` 里，不会碰到 Dropbox 里的其它内容。

授权页报错时，扩展无法读取报错原文。常见报错与对应原因如下：

- 授权页显示 **No scope requested can be granted for this app**：「Permissions」里那三个 scope 没勾，或者勾了**没点 Submit**（最容易漏的一条）。改完要重新走一次授权，老 token 不会自动补上权限。
- 授权页显示 redirect_uri 不在白名单里：「OAuth 2」页里的 Redirect URIs 与设置页里那串不一致（结尾斜杠、http/https 都算）。
- 授权页显示应用不可用 / client_id 无效：App key 填错了，或者这个应用在 App Console 里被停用了。

### 同步时机

- **自动上传（改动后自动上传，并每小时导入一次）**，默认关闭：开启后，本地每次修改后 **30 秒**上传一次，并每小时从远端导入一次。
- **打开扩展时导入**，默认关闭：后台 service worker 启动时导入一次，即浏览器启动，以及扩展安装、更新或重新加载时。距上次同步成功不足十分钟时跳过。

两个开关均在设置页中。第二个开关只在「自动上传」开启时生效；「自动上传」关闭时，该开关不起作用。

### 冲突处理

两份数据各带一个 `updatedAt` 时间戳，扩展依据该时间戳判断。

**导入时**（手动导入、每小时一次的导入，或打开扩展时的导入）：

- 远端较新 → 采用远端那一份；
- 本地较新 → 保持本地不变；
- 两边时间戳相同但内容不同 → 由冲突策略决定。

**上传时**（点击「立即上传」，或自动上传）：

- 远端较新 → 扩展先询问是否覆盖，冲突策略为「本地优先」时除外；
- 其他情况 → 直接用本地那一份覆盖远端。

设置页的「冲突策略」只决定上述留下的两种情况：导入时两边时间戳相同，以及上传时远端较新：

| 选项 | 含义 |
| --- | --- |
| 时间戳较新的胜出 | 默认。导入时两边时间戳相同，采用远端那一份 |
| 本地优先 | 导入时两边时间戳相同则保留本地；上传时远端较新也不询问，直接覆盖 |
| 远端优先 | 导入时两边时间戳相同，采用远端那一份 |
| 每次都要确认 | 导入时两边时间戳相同，先询问采用哪一边 |

需要询问时，设置页显示冲突处理面板。导入冲突提供三个选项：「保留本地」「采用远端」「两边合并」；上传冲突提供两个选项：「仍然用本地覆盖」和「取消」。**覆盖远端之前会自动备份一份**（本机与远端各保留最近 5 份）。

---

## 数据存放与隐私

- **清单内容**保存在浏览器的 `chrome.storage.local` 中。手动备份、更换浏览器、更换设备，均通过设置页「数据」面板的导出 / 导入完成，导出的是一份 JSON 文件。
- **Dropbox 的 token** 同样保存在浏览器的 `storage.local` 中，**不会进入导出的 JSON**。该 token 仅由 service worker 读取；页面只能得知是否已连接，无法取得 token 本身。
- **client_id / client_secret** 在设置页中填写，与其他设置一同保存在 `storage.local` 中，由 service worker 用于换取 token。此处使用的 Dropbox 应用属于 public client，因此 `client_secret` 可以留空。
- 扩展**只会**向下列域发送请求。WebDAV 的服务器地址由用户填写，首次保存时会额外申请该域的权限。
- 没有任何遥测，也没有其他接收数据的位置：作者没有服务器。

```
https://osu.ppy.sh/*
https://www.dropbox.com/*
https://api.dropboxapi.com/*
https://content.dropboxapi.com/*
```

（`https://osu.ppy.sh/*` 用于读取 discussion 永久链接对应的作者名；内容脚本本身由 manifest 的 `content_scripts` 注入。另外三个属于 Dropbox：授权页、RPC 接口、文件上传与下载。）

完整说明见[隐私说明](PRIVACY.zh.md)。

---

## 开发

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run build          # 先 clean 再分别构建页面与内容脚本
npm run icons          # 重新生成 public/icons/*（一般不需要执行）
```

`npm run build` 依次执行两个构建：先构建页面（app / popup / background），再构建内容脚本。

构建分为页面和内容脚本两个步骤。内容脚本必须是单独的 JS 文件，由浏览器作为普通脚本直接执行，其中不能使用 `import`；注入 shadow root 的两份样式表需要以字符串形式内联进该文件，shadow root 中无法加载外部样式文件。

两个构建也可以单独执行：

```bash
npm run build:pages      # 只构建页面
npm run build:content    # 只构建内容脚本
```

`build:pages` 会先清空整个 `dist/`，单独执行后需再执行一次 `build:content`。

真机验证使用 `scripts/` 下的脚本：这些脚本通过 Chrome DevTools Protocol（CDP）驱动一个装有 `dist/` 的真实 Chrome。多数脚本按所覆盖的里程碑命名（`smoke-m1.mjs` … `smoke-m9.mjs`，其中 M7 的验收并入 `smoke-m6.mjs`，M0 的在 `smoke-extension.mjs` 中）；`smoke-author.mjs`、`smoke-links.mjs`、`probe-ui.mjs` 则针对具体功能。

---

## 许可与致谢

[MIT License](LICENSE)，作者 flower-iroseka。

本扩展由 DeepSeek V4 以 vibe coding 方式生成。

本扩展依据 Electoz 的 [Advanced Modding Guide](https://electoz.s-ul.eu/N7Y53Jaj)（2020-04-19 版）的基本思路实现，仅供个人娱乐使用。Electoz 的 osu! 主页在[这里](https://osu.ppy.sh/users/6485263)。

---

本扩展与 osu! 官方无关。
