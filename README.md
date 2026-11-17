# TaskFlow Hub

TaskFlow Hub 是本地研发协作工具，用于管理 Jira 关联任务、交付材料、评审和进度。仓库包含 React 前端、Node.js / SQLite 服务，以及面向本地 AI 客户端的 CLI 和 MCP 桥接。

## 本地运行

需要 Node.js 24 或更新版本。从仓库根目录安装依赖：

```sh
npm ci --prefix preview-app
npm ci --prefix local-bridge
```

分别在两个终端运行：

```sh
npm run dev:api  # 127.0.0.1:5187
npm run dev:ui   # 127.0.0.1:5186
```

打开 <http://127.0.0.1:5186/>，按提示创建管理员。应用默认在本机回环地址监听，首次启动使用空数据库。可在「连接管理」中按需配置自己的外部连接。

```sh
npm test
npm run build
```

更多说明：[本地服务](platform-server/README.md) · [CLI / MCP 桥接](local-bridge/README.md)
