# 网易云音乐 Linux 移植版

这是一个基于 Electron 的网易云音乐 Linux 移植项目。仓库包含 Linux 宿主层、兼容桥接代码，以及运行所需的已提取前端资源，目标是在 Linux 环境下尽可能复现桌面版功能与交互。

## 项目说明

- 项目名称：`Fuck-Netease-Muisc`
- 项目类型：网易云音乐桌面端 Linux 移植与兼容性适配
- 作者：`Codex + ChatGPT 5.4`
- 适用平台：Linux

本仓库主要由两部分组成：

- `linux-port/`：Electron 宿主层、协议映射、原生接口兼容实现
- `extracted/`：运行所需的已提取前端资源与静态文件

## 当前包含内容

- 自定义 `orpheus://` 协议映射
- `window.channel` 兼容桥接
- 常用 `app.*`、`browser.*`、`storage.*`、`network.*`、`winhelper.*` 等接口适配
- 运行所需前端页面与资源文件
- 基础调试脚本与启动检查脚本

## 仓库结构

```text
.
├── README.md
├── .gitignore
├── linux-port
│   ├── package.json
│   ├── scripts
│   └── src
└── extracted
    ├── orpheus_pkg
    │   └── pub
    └── resource
```

## 构建与运行

## 依赖信息

当前 `linux-port/package.json` 没有声明额外的 npm 业务依赖，项目主要依赖以下运行环境与系统工具：

- `Electron`
- `Node.js`
- `npm`
- `bash`
- `sqlite3`

说明：

- `Electron` 用于启动 Linux 宿主应用
- `Node.js` 与 `npm` 用于执行脚本、安装环境和启动项目
- `bash` 用于执行 `npm run debug:boot`
- `sqlite3` 用于读取和维护本地持久化状态、Cookie 数据及宿主补充缓存

建议在 Linux 环境中确认以下命令可用：

```bash
node -v
npm -v
electron --version
sqlite3 --version
bash --version
```

### 1. 环境要求

建议环境：

- Linux 桌面环境
- Node.js 18 及以上
- npm 9 及以上
- 系统已安装图形界面依赖，可正常运行 Electron

你可以先检查版本：

```bash
node -v
npm -v
```

### 2. 安装依赖

进入宿主项目目录并安装依赖：

```bash
cd linux-port
npm install
```

### 3. 启动应用

```bash
cd linux-port
npm start
```

如果需要指定前端资源目录，可以通过环境变量覆盖：

```bash
cd linux-port
NETEASE_ASSET_ROOT=/path/to/pub npm start
```

## 调试与检查

### 语法检查

```bash
cd linux-port
npm run check
```

### 启动诊断

```bash
cd linux-port
npm run debug:boot
```

该脚本会生成启动相关调试信息，用于确认首页是否正常渲染、渲染进程是否报错，以及首屏资源是否加载完成。

## 使用说明

1. 首次运行前先执行 `npm install` 安装依赖。
2. 使用 `npm start` 启动 Linux 版本宿主。
3. 应用启动后，前端资源将通过宿主层加载。
4. 登录、播放、下载、页面数据请求等功能依赖宿主兼容层实现。
5. 应用运行时产生的本地数据通常保存在 Electron 的 `userData` 目录中，不会被提交到本仓库。

## 功能演示截图

### 首页
![首页截图](./docs/screenshots/home.png)


### 登录
![登录截图](./docs/screenshots/login.png)

### 播放页面
![播放截图](./docs/screenshots/player.png)

### 下载管理（暂不可用）
![下载截图](./docs/screenshots/download.png)

## 免责声明

本项目仅供测试、学习、研究 Linux 桌面兼容适配、Electron 宿主桥接、接口分析与逆向验证使用。

- 严禁将本项目用于任何商业用途
- 严禁将本项目用于侵犯第三方权益的用途
- 使用者应自行承担因使用本项目带来的一切风险与责任
- 若相关资源、接口或行为涉及原始软件权利方，请在必要时停止传播或使用

## 致谢

本仓库文档与整理工作由 `Codex + ChatGPT 5.4` 完成。
