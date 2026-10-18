# yOA 运行说明

## 环境要求

- Node.js 22.5 或更高版本（推荐 24 LTS）
- 无需 `npm install`，项目没有第三方依赖
- 数据保存在 `data/yoa.db`（SQLite，首次启动时自动创建）

## 启动

在项目目录双击 `start.bat`，或执行：

```powershell
npm start
```

默认监听 `0.0.0.0:3000`，浏览器访问：

- 本机：http://localhost:3000
- 手机（同一局域网）：http://电脑局域网IP:3000

开发时自动重启：

```powershell
npm run dev
```

## 配置

通过环境变量覆盖默认值：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `YOA_LOGIN_KEY` | `28uyhed78430ghf7438` | 访问密钥；正式使用前建议修改 |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `YOA_DB` | `data/yoa.db` | SQLite 数据库路径 |

PowerShell 示例：

```powershell
$env:YOA_LOGIN_KEY = "你的新密钥"
$env:PORT = "3000"
npm start
```

## 部署到 IIS 服务器

当前项目由 Node 直接提供页面和 API。最简单的两种方式：

1. 在服务器上安装 Node.js 24，启动 `start.bat`，直接访问 `http://服务器IP:3000`。
2. 保留 IIS，在 IIS 中安装 ARR + URL Rewrite，把站点请求反向代理到 `http://127.0.0.1:3000`。

页面和 API 必须由同一个 Node 服务提供，不能只把 `public` 目录交给 IIS 静态托管，否则登录与数据库接口不可用。

## 数据备份

停止服务后复制 `data/yoa.db` 即可。SQLite 运行时可能同时存在 `yoa.db-wal` 和 `yoa.db-shm`，备份时一并复制更稳妥。
