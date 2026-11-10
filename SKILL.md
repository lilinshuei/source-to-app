---
name: source-to-app
display_name: 把源码变成能双击用的程序
display_name_en: From Source Code to a Double-Click App
description: 把 Electron / Node 桌面项目的源码打包成可分发目录或安装程序，自动处理国内镜像、长路径、构建缓存清理、产物校验等环境坑。当用户说打包、出包、构建 exe、生成安装包、发布桌面版、打包失败排障、确认包里有没有某个文件时使用。
description_zh: 一条命令把桌面项目源码变成别人能双击运行的程序，自动绕开国内网络、Windows 长路径、构建清理被拦这些坑，并在打完包后真去检查包里到底有什么。
description_en: Turn a desktop project's source code into a double-clickable app in one command, automatically handling mirror configuration, Windows long-path limits, build-cache cleanup blocks, and post-build artifact verification.
examples_zh:
  - "帮我把这个桌面应用打包一下，出个能直接跑的版本"
  - "打包又失败了，报 fetch failed，怎么回事"
  - "确认一下打出来的包里有没有那个模型文件"
examples_en:
  - "Package this desktop app into something I can hand to someone"
  - "The build keeps failing with fetch failed — what's wrong?"
  - "Check whether the model file actually made it into the build"
version: 1.0.0
author: "lilinshuei"
---

# 把源码变成能双击用的程序

## 这个技能是干什么的

开发时跑的是 `npm run dev`，源码在、依赖在、终端开着，一切正常。但你要把它交给一个不懂技术的人时，对方需要的不是仓库，是**一个双击就能开的东西**。

这中间隔着一段很容易翻车的路：从境外源下载二进制、Windows 路径超长、构建工具清缓存被安全策略拦、打完了发现关键文件根本没进包。

这个技能就是把这段路走顺：**一条命令，从源码到能双击的程序，并且打完真的去检查包里有什么。**

## 什么时候该用它（应用场景）

### 场景一：第一次要把项目交给别人

你在自己机器上开发完了，想拷给同事试用、或者发给客户看。直接给文件夹对方不会用，需要打成能双击的形态。这时候用「体检 + 打包」两步，先确认环境没问题，再出包。

### 场景二：打包报错，看不懂在说什么

常见的是这几种，每一种都对应一个具体原因，不是"玄学失败"：

- `fetch failed` —— 某个二进制在从境外下载，超时了
- `DLL load failed ... 文件名或扩展名太长` —— Windows 260 字符路径上限
- `SAFE_DELETE_BULK_CONFIRM_REQUIRED` —— 构建要清空上次输出，文件太多被安全策略拦下
- `invoke this script through a pnpm package command` —— 脚本要求经包管理器入口调用
- `xxx_CER_FILE must identify ...` —— 用了带签名校验的脚本变体，但你并没有证书

这个技能会把报错翻译成"哪一类问题、改哪个设置、重跑哪条命令"。

### 场景三：换了台机器就打不出来

同一份代码，原来能打，新机器上各种报错。多半是 Node 版本不对、没配国内镜像、或者项目路径太长。体检脚本会在开打前把这几项都查一遍。

### 场景四：不确定包里到底有没有某个文件

比如模型文件、运行时、配置文件。构建工具的 `extraResources` 配错了路径时**会静默跳过**——命令退出码 0，装完才发现缺东西。校验脚本能查"关键文件在不在"，还能查"包里的代码是不是新的"（在 `app.asar` 里搜一段只有新代码才有的字符串）。

### 场景五：想知道包为什么这么大

打包完先看体积构成：Electron 本体、运行时、模型、前端资源各占多少。知道占比才能决定砍哪里。这个技能会把文件数和总体积报出来，配合各目录单独统计就能定位。

### 场景六：决定给文件夹还是做安装程序

给内部测试用，文件夹最省事；给客户，要看体积——**超过 2GB 不要用 NSIS**（32 位计数器溢出，打出来装到一半失败）。技能里给了按体积选方案的判断表。

### 场景七：想把这套流程固定下来

今天调通了，明天换个项目又得重来一遍。把这个技能当作可复用的检查清单：坑清单、参数、判断标准都在里面，不用靠记忆。

## 用户一般会怎么问（示例提问）

- 「帮我把这个桌面应用打包一下，出个能直接跑的版本」
- 「打包又失败了，报 `fetch failed`，怎么回事」
- 「构建跑到一半就断了，说是安全删除被拦」
- 「报 `DLL load failed ... 文件名或扩展名太长`，怎么解决」
- 「确认一下打出来的包里有没有那个模型文件」
- 「这个包为什么这么大，都占在哪了」
- 「我要发给客户，是给文件夹还是做成安装程序」
- 「上次能打包，这次不行了，帮我看看环境哪里变了」
- 「打出来的包装上之后打不开，怎么排查」
- 「换个电脑就打不出来了，是不是缺什么东西」

## 它会替你做哪些事（功能清单）

| 能力 | 说白了就是 |
|---|---|
| **环境体检** | 开打前先查 Node 版本、磁盘、路径长度、镜像、包管理器、上次残留。**问题 10 秒暴露，而不是等 20 分钟后失败** |
| **自动配国内镜像** | Electron 这类二进制默认从境外下，国内基本必挂。自动切到国内镜像，不用你手动设环境变量 |
| **绕开长路径限制** | Windows 有 260 字符上限，中文目录名一叠加就超。自动建一个短路径跳板，把构建输出指过去 |
| **处理缓存清理被拦** | 构建开跑前要清空上次输出，文件一多就被安全策略拦。先把这些目录挪到暂存区，让清理变成空操作 |
| **一条命令跑完** | 预检 → 配置 → 构建 → 打包，中间不用盯着 |
| **失败说人话** | 不是甩一堆堆栈，是告诉你"这是哪一类问题、改哪个设置、重跑哪条命令" |
| **产物校验** | 不看"命令没报错"就算完，而是真去查：文件数、体积、关键文件在不在、包里的代码是不是新的 |
| **安全可回退** | 挪走的目录一律进暂存区不直接删；关安全开关只限定在构建子进程内 |

## 怎么用

### 第一步：体检（10 秒，不构建）

```bash
node <技能目录>/scripts/preflight.mjs --project-root <项目根>
```

输出分三档：

- `✓` 通过
- `!` 警告（能打，但建议先处理）
- `✗` 阻塞（必须修）

退出码：`0` 全通过 / `1` 有阻塞 / `2` 只有警告。

**这一步的价值**：把"打了二十分钟才失败"变成"十秒就知道哪里不行"。

### 第二步：打包

```bash
# 出免安装目录（最常用）
node <技能目录>/scripts/package.mjs \
  --project-root <项目根> \
  --desktop-dir apps/desktop \
  --mode dir

# 出安装程序
node <技能目录>/scripts/package.mjs --mode installer

# 项目路径很长时，把构建输出指到短路径
node <技能目录>/scripts/package.mjs \
  --build-root-var MY_BUILD_ROOT \
  --build-root-path C:\build
```

### 第三步：校验产物

```bash
node <技能目录>/scripts/verify-artifact.mjs \
  --artifact <产物目录> \
  --expect resources/模型文件.bin \
  --expect-in-asar "某段只有新代码才有的字符串"
```

`--expect` 查关键文件在不在；`--expect-in-asar` 查**打进包的是新代码还是上次的缓存**——这条最容易被忽略，也最容易出事故。

### 参数说明

| 参数 | 作用 | 默认 |
|---|---|---|
| `--project-root` | 项目根目录 | 当前目录 |
| `--desktop-dir` | 桌面端子目录（含 package.json） | `apps/desktop` |
| `--script` | 要跑的 npm script 名 | `package` |
| `--mode` | `dir`（免安装目录）/ `installer`（安装程序） | `dir` |
| `--unsigned` | 跳过代码签名 | 是 |
| `--build-root-var` | 项目自定义的「构建根目录」环境变量名 | 不设 |
| `--build-root-path` | 上面那个变量要指向的短路径 | 不设 |
| `--park-dir` | 待清缓存临时挪到哪（**必须与项目同盘**） | `<项目根>/.packaging-parked` |

## 出安装程序还是给文件夹

| 产物体积 | 建议 | 原因 |
|---|---|---|
| < 2GB | NSIS 安装程序可用 | 常规方案，有卸载项、开始菜单 |
| 2–8GB | **7z 自解压**（LZMA2 固实） | NSIS 32 位偏移会溢出；7z 压缩率最高且支持大文件 |
| 更大 / 要正规安装体验 | Inno Setup 6 | 支持大文件，但需另装工具链 |
| 不建议 | MSIX / WiX MSI | MSIX 强制签名；MSI 的 CAB 同样受 2GB 限制 |

**长期建议**：如果体积增长主要来自模型或资源文件，考虑「主程序 + 资源包分离、首次启动导入」。代价是失去"开箱即用"，要权衡。

## 常见故障速查

| 症状 | 真正原因 | 怎么办 |
|---|---|---|
| `fetch failed` | 二进制从境外源下载失败 | 配国内镜像（Electron 用 `ELECTRON_MIRROR`） |
| `DLL load failed ... 太长` | Windows 260 字符路径上限 | 建短路径跳板，构建输出指过去 |
| `SAFE_DELETE_BULK_CONFIRM_REQUIRED` | 批量删除保护拦截构建清缓存 | 先挪走待清目录；仍不行需在构建子进程内临时放行（要用户同意） |
| `ERR_PNPM_NO_SCRIPT` | 脚本名不存在 | 用 `--script` 指定真实脚本名 |
| `EXDEV: cross-device link` | 暂存区与项目不同盘 | `--park-dir` 指到项目同盘目录 |
| `invoke this script through a pnpm` | 脚本要求包管理器入口 | 用 `pnpm run <script>`，别直接跑 tsx |
| 产物比预期小很多 | 关键资源没进包 | 用 `verify-artifact.mjs` 查关键文件 |

详细版（含每条怎么确认、怎么验证修好了）见 `references/pitfalls.md`。

## 安全边界（必须遵守）

1. **只动构建产物目录**，不碰用户文档、桌面、下载目录。
2. 需要挪走目录时，**挪到暂存区，不直接删**；打完由用户决定是否清理。
3. 下载一律**优先国内官方镜像**；必须走外网时先说明，下载后**用哈希或数字签名校验**。
4. 关闭任何安全开关（如批量删除保护）**只限定在构建子进程内**，不改用户环境变量、不写注册表，并且**必须告知用户**。
5. 不在产物里写入任何凭据、令牌、内部地址。

## 文件说明

| 文件 | 用途 |
|---|---|
| `scripts/preflight.mjs` | 环境体检：Node 版本、磁盘、路径长度、镜像变量、包管理器、构建残留 |
| `scripts/package.mjs` | 主流程：配镜像 → 短路径跳板 → 挪缓存 → 构建 → 失败翻译 |
| `scripts/verify-artifact.mjs` | 产物校验：文件数、体积、新鲜度、关键文件、包内代码版本 |
| `references/pitfalls.md` | 全部坑的症状、根因、确认方式、修复步骤、耗时参考 |
