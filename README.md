# dsh-pi-billion-memory

DeepSeek Harness 原生插件：把 **Pi / OpenCode ACP / DSH billion-context 的压缩摘要**放进同一个本地 SQLite 记忆索引（移植自 [pi-billion-memory 0.5.3](https://github.com/tjp72/pi-billion-memory)）。提供模型工具 `memory_search` 与 `/memory` 人工命令；不自动注入记忆、不发网络请求。

详细功能、来源白名单、隐私与权限边界见 **[README.zh-CN.md](README.zh-CN.md)**；本机安装/运行验证记录见 [VERIFICATION.zh-CN.md](VERIFICATION.zh-CN.md)。

> Native DeepSeek Harness port of pi-billion-memory. Shares `~/.pi/pi-billion-memory.db` with Pi; compatible with billion-context 0.1.166.

## 安装

### 方式 A：Harness 插件管理入口（Desktop，推荐）

1. 获取安装包：下载 [Releases](https://github.com/Juna9969/dsh-pi-billion-memory/releases) 中的 `dsh-pi-billion-memory-1.0.0.tgz`，或按方式 C 从源码打包。
2. 在 Harness 的「插件」管理入口选择从本地 `.tgz` 安装，填写该文件的**绝对路径**。
3. 启用 `dsh-pi-billion-memory` 组合包，刷新**原来的** Harness 页面。

> **不要执行 `dsh plugin --profile desktop ...`**：Desktop profile 由 Electron 应用管理，该命令会被拒绝。

### 方式 B：独立 CLI 管理的 Web profile

```powershell
dsh plugin --profile web add "C:\absolute\path\to\dsh-pi-billion-memory-1.0.0.tgz"
```

将 `web` 换成实际的 profile 名称，**不要替换为 `desktop`**。

### 方式 C：从源码获取与安装

```powershell
git clone https://github.com/Juna9969/dsh-pi-billion-memory.git
cd dsh-pi-billion-memory
npm pack                     # 生成 dsh-pi-billion-memory-1.0.0.tgz
```

然后在目标 profile 目录执行 `pnpm add "<tgz 绝对路径>"`，并确认该 profile 的 `package.json` 中 `dsh.profile.bundles` 列表包含 `dsh-pi-billion-memory`。

### 首次写入前先备份

包内脚本使用 SQLite online backup API（不直接复制活动主库），目标文件必须不存在：

```powershell
node scripts/backup.mjs "C:\Users\you\.pi\pi-billion-memory.db" "C:\private-backups\pi-memory-before-dsh.db"
```

备份仍含全部私人记忆，请放在受限本地目录，勿上传或混入发行包。

## 依赖安装

- **运行**：Node.js **≥ 22.19.0**（需要 `node:sqlite`；本机测试 24.21.0 / SQLite 3.53.4）。多个写入者建议使用包含 SQLite WAL-reset 修复的版本（≥ 3.51.3）。无网络依赖。
- `@deepseek-ai/dsh-tools` 由 Harness 原生加载器提供，声明为 optional peer（该包不在 npm 上），因此常规 `pnpm`/`npm` 安装不会尝试从公共源拉取。
- 发行包也可在隔离目录内直接 `pnpm add <tgz>` 安装。

## 构建步骤

**无构建步骤、无打包步骤**：`src/` 为纯 ESM 源码，由 Harness 直接加载。

## 加载与启用

1. 安装并启用组合包后，刷新 Harness 页面以加载工具与命令列表。
2. 先执行 `/memory sources` 查看生效来源白名单，`/memory status` 查看共享索引数量、最近扫描、跳过原因与当前写权限。
3. 需要写入时再执行 `/memory scan`（增量）或 `/memory rescan`（重新解析，不覆盖已存摘要文字）。
4. 删旧摘要需显式确认：`/memory prune 30 --confirm`（仅删有超期时间戳的摘要，源文件不动）。
5. 可选：`memory_search` 工具跨项目检索历史压缩摘要（可传 `project`，默认 6 条、最多 20 条）。

**任何索引/归属缓存写入与剪枝都要求实际 sandbox policy 为 `danger-full-access`**；`workspace-write` / `read-only` 下仍可检索已有索引，维护命令会明确拒绝。默认仅接纳 `pluginAgent:'dsh'` 的 DSH Bili 来源；代理部署在其他目录时显式设置 `dshSessionsRoot`。

原生插件配置（组合包内）：

```yaml
- insert:
    - id: pi-billion-memory-native
      name: dsh-pi-billion-memory
      config:
        scanIntervalSeconds: 60
        dshEnabled: true
        # dshSessionsRoot: C:/absolute/path/to/billion-context/sessions
```

停用：在插件管理中关闭该组合包，共享数据保留且 Pi 继续可用。卸载只移除本包，**不要删除整个 `.pi`**。

## 自检

```powershell
node --check src/host.js
node --check src/memory-worker.js
node --test test/*.test.mjs
```

36 项隔离 fixture 测试只使用临时 HOME，不扫描真实 `.pi`。

## 许可

MIT（见 [LICENSE](LICENSE)）。移植来源与第三方声明见 [NOTICE.md](NOTICE.md)。
