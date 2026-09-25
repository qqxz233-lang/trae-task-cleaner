# Trae CN Task Cleaner

批量清理 Trae CN（TraeCode CN）AI 任务面板里堆积的历史任务。数量按项目可控、可预览、可重复运行。

Trae CN 的任务面板会长期累积历史任务，成千上万条后界面明显变卡，手动点击删除又极其耗时。本工具直接调用 Trae 内部的 `deleteSession` 接口按项目批量清理，只保留最新若干个任务，其余全部删除——效果与手动点击「删除任务」完全一致，但不需要任何模拟点击。

## 特性

- **批量清理**：一条命令清掉指定项目下所有历史任务
- **保留策略**：每个项目保留最新 N 个（默认 20），自动保护「置顶」与「运行/排队中」的任务
- **只处理已打开的项目**：按窗口标题匹配，没打开的自动跳过，不会误删
- **安全可控**：支持 `--dry-run` 先预览待删列表；支持 `--batch` 限制单批删除数量
- **失败重试**：单条删除失败自动重试一次，最后输出失败明细
- **纯本地**：只与本机 Trae 的调试端口通信，不上传任何数据

## 目录结构

```
trae-task-cleaner/
├── trae-auto-clean.bat      # Windows 一键入口（检查调试端口 / 可选自动重启 Trae / 调用清理）
├── trae-task-cleaner.mjs    # 清理核心脚本（Node.js，无第三方依赖）
├── trae-projects.txt        # 项目清单，一行一个项目名
└── README.md
```

## 原理

Trae CN 基于 Electron，暴露了标准 Chrome 调试协议（CDP）端口。工具流程：

1. 通过 `http://127.0.0.1:9222/json/list` 拿到所有窗口（page target）列表；
2. 用 WebSocket 连上目标窗口，从任务面板 DOM 节点的 React Fiber 上取到内部 `sessionAdapter`；
3. 调用 `sessionAdapter.loadMoreSessions()` 翻页拉取完整任务列表；
4. 按策略筛出待删任务，逐条调用 `sessionAdapter.deleteSession(id)`。

不注入任何第三方代码，不修改 Trae 安装文件。

## 环境要求

- Windows（`trae-auto-clean.bat` 依赖 `curl`、`choice`、`powershell`，Win10 及以上自带）
- Node.js 18+（脚本使用内置 `fetch` 与 `WebSocket`，无需 `npm install`）
- Trae CN 桌面版

## 快速开始

1. 把整个目录放到任意位置。
2. 编辑 [trae-projects.txt](trae-projects.txt)，写入要清理的项目名（需与 Trae 窗口标题中的项目名完全一致）：

   ```
   my-web-app
   my-backend-api
   ```

3. 双击 `trae-auto-clean.bat`。脚本会：
   - 检测调试端口 `9222`；若不可用，询问是否关闭并带调试端口重启 Trae（窗口状态会被保留）；
   - 自动匹配清单里已打开的项目，逐个清理，保留最新 20 个任务。

## 命令行用法

```bash
node trae-task-cleaner.mjs inspect
node trae-task-cleaner.mjs eval [--title 标题关键字] "<js代码>"
node trae-task-cleaner.mjs clean [--title 标题关键字] [--keep N] [--batch M] [--dry-run]
node trae-task-cleaner.mjs auto  [--keep N] [--dry-run]
```

| 命令 | 说明 |
| --- | --- |
| `inspect` | 列出当前所有 CDP 页面目标，并探测哪个页面含任务面板。排查问题时先用它 |
| `eval` | 在目标页面里执行任意 JS，返回结果。调试用 |
| `clean` | 清理**单个**窗口的任务。配合 `--title` 指定窗口 |
| `auto` | 读取 `trae-projects.txt`，清理所有**已打开**的项目（bat 默认走这条） |

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--title <关键字>` | 无 | 只处理标题包含该关键字的窗口；不传则自动挑选含任务面板的窗口 |
| `--keep N` | `20` | 每个项目保留最新的 N 个任务 |
| `--batch M` | 不限 | 单批最多删除 M 个，避免一次性删除过多；删除达上限后重新运行可继续 |
| `--dry-run` | 关 | 只预览待删列表，不实际删除。**建议首次先跑这个** |

环境变量 `CDP_PORT` 可覆盖默认调试端口 `9222`。

## 使用示例

先预览，确认待删列表符合预期：

```bash
node trae-task-cleaner.mjs auto --dry-run
```

确认无误后实际清理，每次最多删 50 条：

```bash
node trae-task-cleaner.mjs auto --keep 20 --batch 50
```

只清理某一个项目窗口：

```bash
node trae-task-cleaner.mjs clean --title my-web-app --keep 10
```

## 前置条件

Trae CN 必须以调试端口启动，且目标窗口的 **AI 任务面板处于打开状态**（脚本需要从面板 DOM 上取 `sessionAdapter`）。

```bat
"D:\Program Files\Trae CN\Trae CN.exe" --remote-debugging-port=9222
```

`trae-auto-clean.bat` 已内置这一步：检测不到端口时会询问是否自动重启 Trae。若 Trae 装在别的路径，请修改 bat 顶部的 `TRAE_EXE` 与 `NODE_FALLBACK` 配置项。

## 常见问题

**提示「无法连接调试端口 9222」**
Trae 不是以调试端口启动的。手动带 `--remote-debugging-port=9222` 重启，或直接用 bat 让它代为重启。

**提示「未找到 sessionAdapter」**
该窗口的 AI 任务面板没有打开。打开面板后重试；批量处理时建议把所有目标项目的窗口都打开。

**界面上还有残留条目，删不掉**
后端其实已删除，只是前端列表没刷新。重启一次 Trae 即可，属正常现象。

**项目被跳过，显示「未打开」**
`trae-projects.txt` 里的项目名必须与 Trae 窗口标题里的项目名**完全一致**（区分大小写）。用 `inspect` 或直接看窗口标题确认。

**任务太多，一次没删完**
用 `--batch` 限了量时属预期行为，重复运行同一条命令即可继续。

## 注意事项

- 删除不可恢复，请先用 `--dry-run` 确认。
- 工具依赖 Trae CN 的内部实现（React Fiber 上的 `sessionAdapter`）。Trae 版本升级后内部结构若变动，可能需要更新脚本中的查找逻辑（[trae-task-cleaner.mjs](trae-task-cleaner.mjs) 里的 `SETUP_JS`）。
- 仅在本机使用，调试端口不要暴露到公网。

## License

MIT