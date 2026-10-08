# 本机安装与验证记录

验证日期：2026-09-28。此记录只包含版本、计数、文件哈希与控制面结果，不包含摘要正文、会话原文、认证令牌或 Cookie。

## 环境

- DeepSeek Harness：验证时为 `0.1.7-rc.2`；此后官方桌面端自行升级到 `0.2.0-rc.1`（`@deepseek-ai/dsh-desktop-runtime@0.2.0-rc.1`，build commit `62962ee48ef60ed1f97c10fffceb294eb3adf719`），见下方“环境变更”。
- billion-context：`0.1.166`
- 实际 Electron Host：Node `24.18.1`，SQLite `3.53.1`；安装与首轮验证期间宿主未重启（PID 23244），也没有启动替代 Web 服务。升级由官方更新器自行完成并重启（新 PID 21272，本机时间 23:21:47），本人未执行任何重启。
- 现有 GUI：`http://127.0.0.1:19387`。

### 环境变更（由官方更新器触发，非本人操作）

- `G:\DeepSeek Harness\resources\app.asar` 已不存在，改为目录形式 `resources\app\`（`app\dsh\...`）；旧包留为 `app.asar.bak`（118651499 B）与 `app.asar.rename-pending`（14 B）。
- 更新器缓存：`%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\pending\deepseek-harness-0.2.0-rc.1-win-x64.exe`。
- 该冷启动自动补上了本记录原先“未验证”的宿主冷启动一环：升级后的宿主按 profile 冷启动即加载了本插件，`memory_search` 在 `0.2.0-rc.1` 上仍可正常执行。
- `profiles\desktop\cordis.yml` 已变为 `0.2.0` 的新形态（223 B，注释 + `[]`，配置全部由 patch 层合成）。本记录中引用 `0.1.7-rc.2` 的源码行号来自当时抽取的 `harness-reference`，在 `0.2.0-rc.1` 上需要重新抽取核对。
- 安装后配置为 `scanOnStartup:false`、`scanIntervalSeconds:0`，因此除人工明确执行外不会发生任何扫描或写入。验证会话 policy 为 `danger-full-access`；全局 policy 为 `workspace-write`，自动写入同样会被策略拒绝。

## 本机实际安装方式

本机采用“包目录 + profile 清单”的方式安装（Harness 插件管理入口的 `file:` 安装路径未在本机验证过）：

1. 将发行包内容放入 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-pi-billion-memory`。
2. 在该 profile 的 `package.json` 中：`dependencies` 增加 `"dsh-pi-billion-memory": "file:<发行包绝对路径>"`，`dsh.profile.bundles` 追加 `dsh-pi-billion-memory`。
3. 在该 profile 的 `cordis.patch.yml` 追加本插件条目，并把 `scanOnStartup` 设为 `false`、`scanIntervalSeconds` 设为 `0`。

profile 内其他依赖、bundle 与 patch 条目均未改动。

### 关于依赖解析

`@deepseek-ai/dsh-tools` 是宿主提供的 peer，不需要、也无法随本包安装：

- 从 profile 目录用独立 `node` 直接 `import('dsh-pi-billion-memory')` 会得到 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`；该 profile 的 `node_modules\@deepseek-ai\` 下只有 `cosmokit` 与 `schemastery`。
- 宿主把发行包以扁平目录形式打包在 `app.asar` 内（asar 头中可见 `dsh-tools` 等条目），profile 插件的同名 peer 导入由宿主加载器解析。已在用的 profile 插件（如 `dshmarket`）同样以裸名导入 `@deepseek-ai/*`。
- 本机实测证据：插件在运行中的宿主里被加载器激活（`enabled:true`、`fiberPhase:'active'`），说明该解析路径在本机成立。

### 关于 profile 热重载

宿主应用在 profile 变化时重写过一次 `cordis.yml`（本机时间 22:01:20），插件由此在本机被激活；但随后对 `cordis.patch.yml` 与 profile `package.json` 的改动（22:11–22:18）没有再触发 reconcile（`cordis.yml` mtime 未再变化）。因此在 `0.1.7-rc.2` 上不能依赖“手工改 patch 热插拔”来做验证或安装：新增/修改插件应走插件管理入口或重启宿主。

补充观察（同为 `0.1.7-rc.2`）：profile 的 `package.json` 改动（23:17:54）之后约 2 秒内，`%USERPROFILE%\.dsh\redteam\setup.sh` 与 `%USERPROFILE%\.dsh\.agent-presets\redteam\{agent.cordis.yml,preset.yml}`（均由新装入的 `dsh-purge` 生成）出现在磁盘上（23:17:56），说明该运行中的宿主确实响应了这次清单变更并加载了新 bundle；`cordis.yml` 未改写并不等于未 reconcile。`0.2.0-rc.1` 上 `cordis.yml` 的形态已改变（注释 + `[]`），该结论需在新版上重新测量。

## 安装包与已安装副本一致性

从发行包 `dsh-pi-billion-memory-1.0.0.tgz`（`1.0.1` 仅补 README.md，包内容一致）解出 25 个文件与已安装目录逐文件比对：

| 结果 | 数量 |
| --- | ---: |
| 存在于发行包 | 25 |
| 已安装目录文件 | 25 |
| 内容逐字节一致 | 24 |
| 仅 JSON 格式/键顺序不同（`package.json`） | 1 |
| 缺失或多余 | 0 |

`package.json` 的差异仅为 `pnpm pack` 归一化成紧凑单行写法，按 JSON 语义（忽略键顺序）深比较为相同。已安装副本按发行包内容重新同步后，两者一致。

## 只读链路（活体）

活体验证使用真实运行中的宿主与已安装插件，共 6 次 `memory_search` 调用：

| 查询性质 | 模式 | 命中 |
| --- | --- | ---: |
| 中文双词 | mixed trigram + LIKE | 2 |
| 中文双词 | short-query LIKE | 2 |
| 英文包名 + 中文词 | mixed trigram + LIKE | 3 |
| 单一英文标识符 | trigram relevance sort | 1 |
| 构造为不可能命中 | 空结果（返回提示文本） | 0 |
| 构造为不可能命中 | 空结果（返回提示文本） | 0 |

- 返回值逐字匹配 `src/engine.js:56` 的前缀与 `vendor/extension.js:1594-1596` 的模式标签；该前缀只存在于本移植，上游 `dist`/`src` 均无此串，因此可确证输出由本插件产生，链路为工具调用 → 工具注册表 → 插件 → worker → 只读 SQLite → 格式化返回。
- 命中来源标签同时出现 `[pi]`（Pi sidecar）与 `[bili]`（billion-context 会话，project 为对端地址、来源文件为 hash24 命名的 `.json`），说明 DSH/Bili 适配写入的行在真实宿主中确实可被检索。
- 四种检索形态在活体中各至少出现一次：trigram relevance sort、short-query LIKE、mixed trigram + LIKE、以及无命中的提示文本。
- 命中结果只读取、不写入；验证过程未复制摘要正文到任何文件。
- `memory_search` 与 `/memory` 命令均在真实 agent 上注册。斜杠命令的**注册表执行**路径（命令准入、`command/run`/`command/done` 会话事件）未在本机验证：临时验证插件无法注入（见上文热重载一节），且未重启宿主。命令处理器本身已在进程内以真实数据库执行并返回正确计数。

## 共享库与受控写入

首次写入前已用 SQLite online backup API 建立私有一致性备份；没有把活动 WAL 数据库直接复制进发行包。

| 阶段 | sources | sources_with_blocks | blocks | tombstones |
| --- | ---: | ---: | ---: | ---: |
| 扫描前 | 267 | 107 | 5291 | 0 |
| 首次增量扫描后 | 283 | 120 | 5429 | 0 |
| 第二次幂等增量扫描后 | 283 | 120 | 5431 | 0 |

- 首次扫描：枚举 3 个来源、353 个候选文件，解析 17 个变化文件，新增 138 个摘要块；入库前脱敏命中 45 次。
- 第二次扫描：解析运行期间新增/变化的 4 个文件，新增 2 个摘要块；已存文字保持不可变。
- 两次扫描均明确报告 73 个 `nonDsh`：它们不带 `pluginAgent:'dsh'`，是默认 DSH-only 来源中的预期跳过项（按设计跳过，不是故障）。
- 另有 1 个持续 `invalidOrUnreadable`：诊断确认是含 NUL 的无效 Pi ACP sidecar（`2026-09-21T14-16-24-618Z_01a0c453-3d28-71ce-b7a6-fdb3e2672a29.jsonl.acp.json`），非本插件产生。插件未修改源文件、未推进该文件 watermark，后续扫描仍会安全重试。
- 第二次扫描后的一次独立最终完整性核对为 `quick_check: ok`；当时共享的其他写入者已把 blocks 继续推进到 5433，sources 仍为 283、tombstone 仍为 0。本插件保持无启动/定时扫描配置。
- Pi 0.5.x schema 仍兼容；DSH 精确 session ID → cwd 归属写入独立 sidecar（`attribution` 单表），没有给共享 Pi 数据库增加表。

## 隔离测试

最终测试命令：

```powershell
node --test test/*.test.mjs
```

共 36 项测试，覆盖在线 WAL 备份、三类来源、schema 拒绝、隐私脱敏、TOCTOU、CAS、多 worker、取消/回滚、归属合并、原生注册与生命周期。fixture 使用临时 HOME，不读取正式记忆正文。

## 发行包隔离安装

在空目录中用 `pnpm add file:<发行包>` 安装并核对：

- 修复前：失败。pnpm 默认 `autoInstallPeers` 会尝试从公共 npm 源自动安装 peer `@deepseek-ai/dsh-tools@*`（该包不在 npm 上），报 `ERR_PNPM_FETCH_404`。
- 本机 profile 的安装路径不受影响：`profiles\desktop\pnpm-workspace.yaml` 已设 `autoInstallPeers: false`。
- 修复：`package.json` 增加 `"peerDependenciesMeta": { "@deepseek-ai/dsh-tools": { "optional": true } }`（与 `dshmarket` 对同类 peer 的做法一致）。
- 修复后：安装成功（`exit=0`），落地 25 个文件，`src/host.js` 存在，`node_modules\@deepseek-ai` 不会被创建（未抓取 peer），发行包内 `peerDependenciesMeta` 字段保留。

## 本机尚未验证的面

以下项目缺少本机证据，测试与实现虽已覆盖，但不应视为“已在正式环境验证”：

1. 斜杠命令经命令注册表的完整执行与会话事件记录（需要重启宿主，或由界面手动输入 `/memory status`）。
2. 宿主冷启动后从 profile 重新加载本插件（当前激活发生在运行期，未重启）。
3. `memory_expand` 在正式环境的注册与展开（默认关闭，属 opt-in）。
4. 在 profile 内执行真实 `pnpm install`（本机采用手工放置包目录；发行包本身的隔离安装已在上节验证）。
