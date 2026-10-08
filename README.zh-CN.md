# Pi Billion Memory · DeepSeek Harness 原生版

**1.0.1** · 移植自 [pi-billion-memory 0.5.3](https://github.com/tjp72/pi-billion-memory)，针对 Harness **0.1.7-rc.2** / **billion-context 0.1.166** 的原生持久化格式适配。

把 **Pi / OpenCode ACP / DSH billion-context 的压缩摘要**放入同一个本地 SQLite 记忆索引。不是把 Pi 扩展直接塞进 Harness，也不是完整会话搜索器。

## 快速使用

- 模型工具 **`memory_search`**：跨项目检索历史压缩摘要；可传 `project` 精确筛选项目标签，默认 6 条、最多 20 条。中英文空格分词，多个词为 AND；少于 3 字符的词走 LIKE，其余走 FTS5 trigram。
- 人工命令 **`/memory status`**：共享索引数量、最近扫描、跳过原因和当前写权限。
- **`/memory sources`**：查看实际生效的来源白名单。
- **`/memory scan`**：增量扫描。
- **`/memory rescan`**：重新解析；**不会覆盖已存摘要文字**，只补入新块、刷新来源信息和消息引用。
- **`/memory prune 30`**：只提示确认语法。实际删除须 **`/memory prune 30 --confirm`**；仅删除有时间戳、超过保留期的摘要，记录 tombstone，源文件不删。此操作影响 Pi 与 DSH 共享索引，不能在插件内撤销。

没有自动剪枝，没有网络请求，没有自动向提示词注入记忆。检索结果是历史资料，不是当前指令。命令不触发模型轮次；Harness 仍会记录命令执行事件。

## 与现有 Pi 共享什么

默认以运行 Harness 的操作系统用户 HOME 为基准：

| 路径 | 用途 |
| --- | --- |
| `~/.pi/pi-billion-memory.db` | 与 Pi 共用的摘要、FTS 索引、来源水位和剪枝墓碑 |
| `~/.pi/pi-billion-memory.json` | 共用配置；只读入，不自动重写 |
| `~/.pi/pi-billion-memory.sources.jsonl` | 共用来源白名单；只读入，不自动重写 |
| `~/.pi/pi-billion-memory.dsh-attribution.db` | 本插件额外建立的 DSH 会话 ID → cwd 归属缓存；不改共享数据库结构 |

保留 Pi 0.5.x 的 `UNIQUE(source_file,block_id)`、不可变摘要、mtime/size 水位、消息引用及 tombstone 语义。当前 Pi 0.5.2 可以继续使用同一兼容索引，不会被隐式升级。未知/旧版/不兼容数据库结构会**拒绝打开并提示迁移**，绝不删除重建。

读写连接使用 WAL、`busy_timeout=5000`、`synchronous=NORMAL` 和 `BEGIN IMMEDIATE`，扫描有水位比较与有界重试。支持**同一台机器**的多进程；**不要把活动数据库放到 NFS/SMB 等网络文件系统**。保持各进程使用同一规范路径，避免硬链接或别名重复索引。

检索和状态查询使用 SQLite `readOnly:true` / `query_only`，不创建索引数据库、不迁移、不扫描、不写日志。注意：SQLite 活动 WAL 数据库的只读连接仍可能需要创建或更新 `-shm` / `-wal` 辅助文件，**不是逐字节文件系统只读承诺**；不能对活动共享库使用 `immutable=1` 忽略 WAL。参见 [SQLite 官方说明](https://www.sqlite.org/wal.html#read_only_databases)。

## 来源与 DSH 适配

共享白名单不存在时，默认扫描 Pi sidecar 与 OpenCode ACP 目录；另外添加一个**不写回共享白名单的 DSH-only Bili 来源**。已有白名单中的同根 Bili 条目优先，包括 `enabled:false` 和更窄的 pattern；Windows 大小写及可解析目录别名会归一化比较。白名单损坏/不可读时整个扫描失败关闭，而非退回宽泛默认值。空白名单仍可能有独立的 DSH 默认来源；要全部禁用，同时设置 `dshEnabled:false`。

原生 DSH 根目录按以下顺序确定：

1. 插件配置 `dshSessionsRoot`；
2. **Harness Host 进程**的 `BILI_SESSIONS_DIR`；
3. `$XDG_DATA_HOME/billion-context/sessions`；
4. `~/.local/share/billion-context/sessions`。

默认 DSH 来源仅接纳 `pluginAgent:'dsh'` 的 Bili 文件。读取 v3 envelope 的 `payload.state.blocks`，也兼容旧版平铺 state；不索引 `messages`、`blockContents` 或 content-store。只接受 hash24 会话文件名，跳过临时文件、内容库和恢复 `.fb.json`。如果代理部署在另一个进程/主机、使用另一个根目录，请显式设置 `dshSessionsRoot`；不从路由提示猜测。

当前格式没有持久化 cwd。本插件监听/引导加载当前 Harness agent 的**精确 session ID 与 header.cwd**，核对文件 ID 的 SHA-256 后才归属项目；未知历史不会套用当前工作目录。之后发现精确归属时，即使摘要文件未变化也会刷新元数据。归属缓存只保留首个精确映射，避免冲突覆盖。

`BILI_PERSIST=false` 时没有可扫描文件。`BILIENC1` 加密和 `BILIZSTD1` 压缩文件跳过并计数；**不会读取密钥、解密或额外导出明文**。

白名单示例（JSONL，每行一个对象；Windows 反斜杠须按 JSON 转义，也可用 `/`）：

```jsonl
{"id":"pi","adapter":"pi-sidecar","root":"~/.pi/agent/sessions","pattern":"**/*.jsonl.acp.json","enabled":true}
{"id":"dsh-off","adapter":"bili-session","root":"~/.local/share/billion-context/sessions","pattern":"**/*.json","enabled":false}
```

仅显式 `adapter:'bili-session'` 的自定义条目可以扫描非 DSH 的 Bili 摘要。支持的 glob 是 `*` 和 `**`，不是完整 minimatch 语法；不要使用 `..`。

## 配置与权限

共用 JSON 配置示例（无需为默认值创建文件）：

```json
{
  "scanOnStartup": true,
  "maxSummaryChars": 20000,
  "expandEnabled": false,
  "expandMaxChars": 40000,
  "expandMaxMessages": 200,
  "expandMaxReadBytes": 33554432,
  "excludeDirs": [],
  "debug": false
}
```

也兼容 `dbPath`、`sourcesPath`、`logPath`；路径必须绝对或以 `~/` 开头。诊断仅保存在本插件内存中的有界、脱敏环形记录，**不写共用日志文件**。共享配置在 worker 启动时载入，改后需停用/启用插件；白名单每次维护或展开都会重新验证。

插件组合包中的 native-only 配置：

```yaml
- insert:
    - id: pi-billion-memory-native
      name: dsh-pi-billion-memory
      config:
        scanIntervalSeconds: 60
        dshEnabled: true
        # dshSessionsRoot: C:/absolute/path/to/billion-context/sessions
        # scanOnStartup: false
```

插件选项覆盖共享配置。`scanIntervalSeconds:0` 关闭定时扫描；正值范围 10–2147483 秒。启动和定时扫描服从**全局** sandbox policy；人工维护服从**明确发起命令的会话** policy。

**任何索引/归属缓存写入和剪枝都要求实际 policy 为 `danger-full-access`。** 插件不会偷偷覆盖模式，也不会用 `--confirm` 绕过沙箱。`workspace-write` / `read-only` 下仍可检索已有共享索引，维护命令会明确拒绝。Native 插件是受信任的 Host 代码，其直接文件/SQLite 访问不是 shell 沙箱代理；安装本插件即信任其限域实现。

## 隐私边界与可选展开

- 插入前完整脱敏，再截断摘要/主题；读旧索引结果时再次脱敏，避免把早期未脱敏数据直接回显。脱敏是启发式规则，不能保证识别所有秘密。旧行本身不会因此被改写。
- 扫描不跟随白名单根目录下的 symlink/junction 子项；允许根目录本身是 junction（兼容 Pi 安装布局）。同一文件句柄在读前/读后校验身份、大小和时间。Node 没有跨平台父目录句柄 `openat` API，因此这不是对恶意本地并发写入者的强安全边界；只允许可信用户写入来源目录。
- 单文件最多 128 MiB；Bili 流式投影丢弃原文对象，不构造原文对象树。额外有嵌套、字符串、块数量和选中数据大小限制，超限会跳过，不记录成功水位。
- Pi 入库只读 sidecar 摘要和原始 JSONL 第一行 cwd 头；OpenCode 归属库仅只读访问。
- `memory_expand` 默认**完全不注册**。显式 `expandEnabled:true` 后只支持 Pi 原始 JSONL：先 `mode:'list'` 获取索引清单，再 `mode:'full',select:[1,3]` 选择具体消息。每次重新验证当前白名单、文件边界和字符/消息/读取上限，输出再脱敏。没有消息引用或源文件已删时会说明缺失。**不支持 DSH/Bili 原文展开**。
- 取消扫描/展开采用共享取消标记；工具请求等 worker 确认静止或退出才结束。SQLite 原子操作不能立即中断，已提交的早先文件不会回滚；当前未提交事务回滚。关闭插件会排空/终止其 worker，单个 agent 结束不关闭共享 worker。

## 安装、备份和回滚

要求支持 native bundle 的 Harness，以及提供 `node:sqlite` 的 Node **≥22.19.0**。本机测试使用 Node **24.21.0** / SQLite **3.53.4**；多个写入者应使用包含 SQLite WAL-reset 修复的版本（3.51.3 或相应维护分支回补版以上）。

1. **首次写入前做一致性备份**。包内脚本使用 SQLite online backup API，不直接复制活动主库：

   ```powershell
   node scripts/backup.mjs "C:\Users\you\.pi\pi-billion-memory.db" "C:\private-backups\pi-memory-before-dsh.db"
   ```

   目标必须不存在，且脚本不会输出摘要。备份仍包含全部私人记忆，请放在受限本地目录，勿上传或混入发行包。
2. Desktop 从 Harness 插件管理入口安装本地发行 `.tgz` 的**绝对路径**，启用 `dsh-pi-billion-memory` 组合包。不要执行 `dsh plugin --profile desktop ...`，Desktop profile 由 Electron 管理。
3. 在**原来的 Harness 页面**刷新工具/命令列表；无需替换 Web 服务。先 `/memory sources`、`/memory status`，确认根目录和权限；需要写入时再执行 `/memory scan`。
4. 独立 CLI 管理的 Web profile 可用 `dsh plugin --profile web add "C:\path\dsh-pi-billion-memory-1.0.1.tgz"`。不要为了本插件启动第二个 GUI。

停用：在插件管理中关闭此组合包。取消未完成扫描并关闭 worker 后，共享数据保留，Pi 继续可用。卸载只移除这个包/组合包，**不要删除整个 `.pi`，不要恢复旧的整个 profile manifest**。更换同名 Host 源码版本可能受到模块缓存影响，必要时等现有任务结束再重启，而非重启正在工作的 Host。

如确实要恢复备份，先停止 **Pi 与 DSH 所有连接/写入者**，单独保留当前主库及 WAL/SHM，再在离线状态恢复一致性备份；不要用旧备份覆盖活动主库。恢复会丢失备份后的记忆与墓碑，不能作为普通卸载步骤。

## 开发与验证

无构建步骤或网络依赖；Host 的 `@deepseek-ai/dsh-tools` 由 Harness 原生加载器提供，且声明为 optional peer，因此普通 `pnpm`/`npm` 安装不会尝试从公共源拉取该包（它不在 npm 上）。发行包本身可在隔离目录内直接 `pnpm add <tgz>` 安装。

```powershell
node --check src/host.js
node --check src/memory-worker.js
node --test test/*.test.mjs
```

36 项隔离 fixture 测试覆盖在线 WAL 一致性备份及：三种来源、仅摘要/原文哨兵、UTF-8 投影、拒绝损坏/编码文件、同根禁用及 Windows junction、schema/trigger/FTS 拒绝、不可变文字/引用更新/水位/CAS 重试、WAL 多 worker、tombstone、完整主题脱敏、归属合并与迟到刷新、可选展开、取消回滚、worker 致命退出/排空、原生 API 注册/权限和 150 个已有 agent 引导。测试只使用临时 HOME，不扫描真实 `.pi`。

正式机器的结构验证仅输出版本与计数，不输出记忆正文。最新本机安装/运行结果另见发行附带的验证记录；离线 mock 通过不等于所有外部版本均已验证。
