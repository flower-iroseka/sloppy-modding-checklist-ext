# osu! Modding Checklist

在 osu! 的 beatmap discussion 页面上，把谱面里该检查的各种问题整理成一份清单。

准备申请 BN 前，用它整理这张谱面还有哪些问题要看，免得漏掉该查的项；平时也可以当作普通的 mod 检查表，把发现的问题逐条记下来，用来提高 mod 质量。

清单按两个维度分类：

- **范围**：**General** 是整张谱面的问题（例如整体音量、节奏）；**Individual** 是某个具体物件的问题（例如某一个 note 的摆放）。
- **来源**：**Internal** 是自己提出的问题；**External** 是别人提出的问题。

两个维度组合起来，就是四个格子。

这个思路来自 Electoz 的 [Advanced Modding Guide](https://electoz.s-ul.eu/N7Y53Jaj)（2020-04-19 版）。扩展把这份清单做成了浏览器里的工具，方便一键填写，还可以跨设备同步。

---

## 安装

构建需要 Node 18+。浏览器使用 Chrome 或 Edge。

```bash
npm install
npm run build          # 产物在 dist/
```

然后在浏览器中：

1. 打开 `chrome://extensions`，在右上角开启「开发者模式」；
2. 点击「加载已解压的扩展程序」，选择 **`dist/`** 目录（不是仓库根目录）。

修改代码后需要重新构建，并在扩展管理页点击一次「重新加载」。

---

## 使用方法

### 1. 在 discussion 页面添加记录

打开任意 beatmap discussion 页面（`https://osu.ppy.sh/beatmapsets/<id>/discussion*`），每条帖子旁边会多出一个「＋ 添加到 Checklist」按钮，点击它就能把这条修改加进清单。

查看清单时，点击页面左下角的浮动按钮，打开 Checklist 页面。

### 2. 查看统计

点击浏览器工具栏上的扩展图标，会弹出一个窗口，显示清单的统计数据：四个分类各有多少条、总共有多少条。要修改内容，点击窗口下方的「打开 Checklist 页面」。

### 3. 在 Checklist 页面整理记录

页面按上面说的两个维度分成四个格子，每个格子里的记录排成一张张卡片。卡片可以从左侧的 `⋮⋮` 手柄拖动：

- **在同一个格子内拖动**：调整记录在这个格子里的先后顺序；
- **拖到另一个格子**：修改这条记录的范围与来源（例如从 General 改到 Individual）；
- **键盘快捷键**：按 `Tab` 选中卡片左侧的 `⋮⋮` 手柄，按 `空格` 拿起这张卡片，用方向键移动到目标位置，再按 `空格` 放下；按 `Esc` 取消这次拖动。

卡片右上角有三个图标：编辑、添加备注、删除。删除时会提示确认。

### 4. 修改界面语言

打开 Checklist 页面后，切换到顶部的「设置」标签页，最上面有一个语言下拉框，可选下列三种配置：**跟随浏览器**（默认）、**中文**、**English**。修改后立即生效，扩展的每个页面都会同步。

选择「跟随浏览器」时只识别**主语言**：`zh-CN`、`zh-TW`、`zh` 都算中文，`en-*` 都算英文，其它语言一律使用英文。

---

## 同步（可选）

数据默认保存在本机。

同步分上传和拉取。**上传**是把本机的清单写到远端，**拉取**是把远端的清单取回本机；这里的「远端」指所选同步位置上的那份文件。启用同步并选好同步方式之后，清单会保存成 `modding-checklist.json` 这一个文件，各台设备同步的是同一份。

**同一时间只能使用一个同步方式**，在设置页的「同步方式」下拉框里选择：

- **本地同步文件夹（免注册）** —— 默认选项。先安装网盘的桌面客户端（Dropbox、坚果云等都提供），它把网盘里的一个目录挂载成电脑上的本地文件夹；然后在设置页选中那个文件夹。扩展往文件夹里写文件，上传到云端由客户端完成。代价是电脑上要一直运行那个客户端，上传时机也由客户端决定。浏览器偶尔会收回文件夹权限，此时设置页会提示点击一次「重新授权」。
- **WebDAV** —— 自行填写服务器地址和账号密码（坚果云、Nextcloud 等都提供 WebDAV）。服务器地址需自行填写，点击「保存并测试连接」时会向浏览器申请访问该服务器的权限。
- **Dropbox** —— 需要自行前往 Dropbox 控制台注册一个应用（下面有逐步向导）。

### Dropbox 的注册向导

注册地址：[Dropbox App Console](https://www.dropbox.com/developers/apps)（`https://www.dropbox.com/developers/apps`）

1. Create app → 选 Scoped access → 类型选 **App folder**。
2. 「Permissions」里勾上 files.content.read、files.content.write、files.metadata.read。**勾完必须点页面底部的 Submit**，只勾不提交等于没配。
3. 「OAuth 2」→ Redirect URIs 里粘贴下面这个地址。
4. 把 App key 填入 client_id 栏（App secret 不需要填）。

第 3 步要粘贴的地址，就是设置页「重定向地址」一栏里的那一串，旁边有「复制」按钮。它长这样，**必须和控制台里登记的那一串逐字符一致**（连结尾的斜杠都算）：

```
https://<扩展 ID>.chromiumapp.org/
```

文件放在 `/Apps/<应用名>/` 里，不会碰到 Dropbox 里的其它内容。

授权页报错时，扩展读不到报错原文。常见的是这几种：

- 授权页显示 **No scope requested can be granted for this app**：「Permissions」里那三个 scope 没勾，或者勾了**没点 Submit**（最容易漏的一条）。改完要重新走一次授权，老 token 不会自动补上权限。
- 授权页显示 redirect_uri 不在白名单里：「OAuth 2」页里的 Redirect URIs 与设置页里那串不一致（结尾斜杠、http/https 都算）。
- 授权页显示应用不可用 / client_id 无效：App key 填错了，或者这个应用在 App Console 里被停用了。

### 同步时机

- **自动同步**（默认关闭）：开启后，本地每修改一次，**30 秒**后上传一次；另外每小时拉取一次。
- **打开扩展时拉取**（默认关闭）：打开 Checklist 页面时拉取一次，十分钟内刚拉取过就跳过。

这两个开关都在设置页里。

### 冲突处理

两台设备都修改过、远端又有别的设备改过时，扩展会提示是否覆盖。设置页的「冲突策略」决定什么时候提示：

| 选项 | 意思 |
| --- | --- |
| 时间戳较新的胜出 | 默认。两边都有更新时，按 `updatedAt` 判断，用较新的那一份 |
| 本地优先 | 一律用本地的，覆盖远端 |
| 远端优先 | 一律用远端的，覆盖本地 |
| 每次都要确认 | 任何改动都先确认 |

选择「每次都要确认」，或者扩展无法自动判断哪一边较新时，设置页会显示一个冲突处理面板，提供三个选项：保留本地 / 采用远端 / 两边合并。**覆盖远端之前会自动备份一份**（本机和远端各保留最近 5 份）。

---

## 数据存放与隐私

- **清单内容**保存在浏览器的 `chrome.storage.local` 里。手动备份、更换浏览器、更换设备，都通过设置页「数据」面板的导出 / 导入完成，导出的是一份 JSON 文件。
- **Dropbox 的 token** 也保存在浏览器的 `storage.local` 里，**不会进入导出的 JSON**。
- **client_id / client_secret** 只在扩展的 service worker 里用于换取 token；页面代码拿不到凭据，也拿不到 token。
- 扩展**只会**向下面这几个域发送请求。WebDAV 使用的服务器地址需自行填写，第一次保存时会额外申请该域的权限。
- 没有任何遥测，也没有其它会收到数据的地方：作者没有服务器。

```
https://osu.ppy.sh/*
https://www.dropbox.com/*
https://api.dropboxapi.com/*
https://content.dropboxapi.com/*
```

（`https://osu.ppy.sh/*` 是内容脚本读取帖子用的；另外三个都是 Dropbox 的：授权页、RPC 接口、文件上传下载。）

---

## 开发

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run build          # 先 clean 再分别构建页面与内容脚本
npm run icons          # 重新生成 public/icons/*（一般不需要执行）
```

`npm run build` 会依次执行两个构建：先构建页面（app / popup / background），再构建内容脚本。

分成两个构建，是因为内容脚本有两条限制：它必须是一个单独的 JS 文件，浏览器把它当普通脚本直接执行（里面不能用 `import`）；注入到 shadow root 里的那两份样式表还要以字符串形式内联进这个文件，因为 shadow root 里没法加载外部样式文件。

两个构建也可以单独执行：

```bash
npm run build:pages      # 只构建页面
npm run build:content    # 只构建内容脚本
```

`build:pages` 会先清空整个 `dist/`，单独执行后要记得再跑一次 `build:content`。

真机验证使用 `scripts/` 下的冒烟脚本：它们用 CDP 驱动一个装了 `dist/` 的真实 Chrome，每个里程碑一个文件（`smoke-m1.mjs` … `smoke-m9.mjs`）。

---

本扩展与 osu! 官方无关。
