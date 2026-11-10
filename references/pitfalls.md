# 打包坑清单

按「症状 → 根因 → 怎么确认 → 怎么修」组织。每条都是实际踩过的，不是推测。

---

## 一、网络：下载失败

### 症状

```
TypeError: fetch failed
```

或构建跑到某个下载步骤就卡住/超时。

### 根因

构建工具默认从境外源取二进制（Electron、Node、运行时等）。国内网络环境下大概率超时或被重置。

**关键判断**：用浏览器能打开不代表命令行能下。命令行工具往往不走系统代理。

### 怎么确认

1. 看日志里 `fetch failed` 前一行是什么版本号或包名，那就是它在下载的东西。
2. 用同一种方式（Node 的 `fetch`）单独试那个地址：

```bash
node -e "fetch('https://example.com/x.tgz',{method:'HEAD'}).then(r=>console.log(r.status)).catch(e=>console.log('FAIL',e.message))"
```

3. 对比官方源和国内镜像：官方源 FAIL、镜像 200，就确定了。

### 怎么修

按下载物类型配对应镜像（只影响本次构建，不改系统环境）：

| 下载物 | 环境变量 | 国内镜像 |
|---|---|---|
| Electron 二进制 | `ELECTRON_MIRROR` | `https://npmmirror.com/mirrors/electron/` |
| Node 运行时 | `NODE_MIRROR` / 项目自定义 | `https://npmmirror.com/mirrors/node/` |
| npm 依赖 | `npm_config_registry` | `https://registry.npmmirror.com` |
| 通用 HTTP 走系统代理 | `NODE_USE_ENV_PROXY=1` | Node 24+ 支持 |

`package.mjs` 已默认设前两个。

### 修完怎么验

重跑同一命令，看下载步骤是否过去。**不要只看"没报错"，要确认文件真的落地了**（比对大小）。

---

## 二、路径：文件名或扩展名太长

### 症状

```
ImportError: DLL load failed while importing etree: 文件名或扩展名太长。
```

或 `ENAMETOOLONG`、`path too long`。

### 根因

Windows 传统 API 有 260 字符路径上限。构建输出目录本身就很深（`targets/win-x64/unsigned-artifacts/win-unpacked/resources/runtime/.../site-packages/lxml/etree.cp312-win_amd64.pyd`），如果项目根路径还带中文长目录名，一叠加就爆。

**注意**：这跟"磁盘上有文件"无关——文件确实存在，是加载时路径解析失败。

### 怎么确认

把完整路径打出来数字符：

```powershell
("C:\你的项目\...\etree.cp312-win_amd64.pyd").Length
```

超过 260 基本就是它。

### 怎么修

建一个短路径跳板（junction），把构建输出指过去：

```powershell
# 不需要管理员权限，不占额外空间
New-Item -ItemType Junction -Path C:\build -Target <项目>\apps\desktop\.desktop-build
```

然后设构建根变量（变量名由项目自定义，`package.mjs` 用 `--build-root-var` 传）：

```
MY_BUILD_ROOT=C:\build
```

### 修完怎么验

重新算一次路径长度，应 < 200。再跑一次触发过该错误的步骤。

---

## 三、删除保护：构建被中途打断

### 症状

```
[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":776,"threshold":50,"scope":"turn",...}
```

或 PowerShell 下：

```
[safe-delete][SAFE_DELETE_FAIL_CLOSED] {"target":"...","reason":"trash-failed"}
```

### 根因

部分宿主环境会加一层"批量删除保护"，一次删超过阈值（常见 50）个文件就会拦截。而构建工具开跑前**必须清空上次的输出目录**，那些目录动辄几百上千个文件。

**注意**：这不是你的代码有问题，是环境策略。

### 怎么确认

看报错里的 `targets` 指向哪个目录——那就是构建要清的目录。

### 怎么修

按优先级：

1. **先把待清目录挪走**（不是删），让那次清理变成空操作：

```powershell
Move-Item <待清目录> <暂存区>
```

2. **若挪走无效**（有些步骤是自己新建再自清，挪不掉），只能在**构建子进程内**临时关闭该保护：

```powershell
$env:SAFE_DELETE_ENABLED = "0"   # 只对本次子进程生效
pnpm run package -- --dir --unsigned win-x64
```

⚠️ **这条必须满足三个条件**：用户明确同意；只在子进程内设；不改用户级/机器级环境变量。做完要向用户说明。

3. **PowerShell 报 `FAIL_CLOSED` 但目录其实已删**：这是"移到回收站成功、但无法验证"导致的保守报错。**先确认目录是否真的没了**，别急着重试。

### 修完怎么验

`Test-Path <目录>` 返回 False 即已清理；重跑构建看是否越过该步骤。

---

## 四、构建钩子：每次强制重建某个资源

### 症状

某个前端资源（调试面板、静态站点等）每次构建都重新编译，耗时长，而且它自己会建几百个文件的临时目录，正好撞上第三条的删除保护。

### 根因

构建配置里挂了 `build:done` 之类的钩子，无条件调用重建函数。

### 怎么修

优先用项目自带的跳过开关（如果有）。没有的话，加一个环境变量判断：

```js
'build:done': async () => {
  if (process.env.SKIP_XXX_BUILD === '1') return
  await buildXxx()
}
```

前提：**该资源已有可用产物**，跳过重建不会导致产物缺失。跳过前先确认产物目录存在且完整。

### 修完怎么验

构建日志里该步骤应消失或秒过；产物目录里的文件数不变。

---

## 五、命令变体：证书校验失败

### 症状

```
Error: XXX_CER_FILE must identify the public X.509 leaf certificate file
```

### 根因

用了不带 `--unsigned` 的脚本变体。即使你没打算签名，有些变体仍会走证书校验流程。

### 怎么修

不要用 `package:win:x64:dir` 这种预置变体（可能不带 `--unsigned`），改用基础脚本自己传参：

```bash
pnpm run package -- --dir --unsigned win-x64
```

### 修完怎么验

构建日志里不应再出现 `certificate` / `signing` 相关校验。

---

## 六、入口：脚本拒绝直接执行

### 症状

```
Error: invoke this script through a pnpm package command
```

### 根因

脚本内部检查了调用来源（包管理器会注入特定环境变量），直接用 `tsx script.ts` 跑会被拒。

### 怎么修

一律走包管理器入口：

```bash
pnpm run <script> -- <args>
```

注意 `--` 不能省，否则参数会被 pnpm 自己吃掉。

---

## 七、体积：安装程序打不出来

### 症状

打包报错，或打出来的安装程序装到一半失败。

### 根因

NSIS（最常见的 Windows 安装包工具）内部用 32 位偏移记录数据块，**总量超过约 2GB 会溢出**。

### 怎么确认

先看免安装目录的体积。超过 2GB 就别指望 NSIS 了。

### 怎么修

| 体积 | 方案 |
|---|---|
| < 2GB | NSIS 可用 |
| 2–8GB | 7z 自解压（LZMA2 固实压缩，压缩率最高，双击解压） |
| 更大 / 要正规安装体验 | Inno Setup 6（支持大文件，需另装工具链） |

**别用**：MSIX（强制签名）、WiX MSI（CAB 同样受 2GB 限制）。

### 长期建议

如果体积增长主要来自模型/资源文件，考虑「主程序包 + 资源包分离」，首次启动时导入。代价是失去"开箱即用"。

---

## 八、校验：产物看着成功其实是空的

### 症状

命令退出码 0，但装完发现缺东西。

### 根因

`extraResources` / `files` 配置的路径不对，构建工具会**静默跳过不存在的目录**。

### 怎么修

打完必须校验，不能只看退出码：

```bash
node verify-artifact.mjs --artifact <产物目录> \
  --expect resources/模型文件.bin \
  --expect-in-asar "某段只有新代码才有的字符串"
```

`--expect-in-asar` 这条最关键：它能证明**打进包的是新代码，不是上次的缓存**。

---

## 九、时间成本参考

以下都是实际耗时，用来判断"卡住"是不是正常：

| 步骤 | 正常耗时 |
|---|---|
| 环境体检 | < 10 秒 |
| 前端/客户端构建 | 1–2 分钟 |
| 服务端打包 | 2–5 分钟 |
| 完整构建（含运行时准备） | 8–15 分钟 |
| 安装程序生成 | 5–15 分钟 |

超过表中上限 2 倍还没动静，大概率是网络卡住或撞上删除保护。
