# Nstdata Proxy Checker

[English](README.md)

通过 HTTP／HTTPS 代理访问指定目标，检查 HTTP 状态、请求耗时和可选正文断言；可选探测出口 IP。提供 CLI、Node.js 库及可复用代理传输。可使用已有代理连接，也可凭 Nstdata API Key 获取一条代理后检测。

## 功能入口

| 要完成的任务 | 使用入口 | 得到什么 |
|---|---|---|
| 凭 Nstdata Key 获取并检测代理 | [Nstdata API Key](#使用-nstdata-api-key) | 一条连接及一次目标检测 |
| 检查一个代理 | [快速开始](#快速开始) | HTTP 状态、耗时及失败分类 |
| 检查一批代理并输出 CSV | [批量与命令行](docs/guide_zh.md#命令行与批量检查) | 有序结果、成功／失败汇总、退出码 |
| 验证目标正文，而不只看 2xx | [正文检查](docs/guide_zh.md#正文检查与结果解释) | 字面文本匹配或未知状态 |
| 在 Node.js 中执行检测 | [检测库](docs/guide_zh.md#检测库) | `checkProxy`／`checkProxies` |
| 自行处理代理响应 | [共享传输](docs/guide_zh.md#共享传输) | GET／HEAD、响应字节与响应头 |
| 查看出口 IP | [出口信息](docs/guide_zh.md#出口-ip-与详细信息) | 明确区分目标响应和额外回显探测 |

## 安装

支持 Node.js 22（22.18 及以上）和 24。

作为命令行工具安装，不需要创建 Node.js 项目：

```sh
npm install --global @nstdata-ai/proxy-checker
```

## 快速开始

在同一终端设置代理连接。将下面的示例 URL 替换为代理平台生成的完整 HTTP／HTTPS 连接，包含所需的用户名和密码；它不是目标网站地址。

```sh
export NSTDATA_PROXY_URL='http://user:password@proxy.example:8080'
```

然后检测目标：

```sh
nstdata-proxy-checker --target https://example.com/ --timeout 20000
```

代理连接可能包含凭据，避免将真实值保存在共享终端历史或公开日志中。CLI 读取当前终端的环境变量，不自动加载 `.env` 文件；缺少代理时会说明如何配置。`nstdata-proxy-checker --help` 可查看选项与示例。

默认输出 JSON。`ok: true` 表示目标返回 2xx；`statusCode` 是响应状态，`elapsedMs` 是请求至正文读取解码完成的耗时。失败检查 `error.code`；输入配置错误还会给出 `error.message`。完整字段说明见[结果解释](docs/guide_zh.md#正文检查与结果解释)。

检测会使用真实代理流量。默认每条有效输入最多执行一次目标 GET，包括重复项；不跳转、重试、轮换或回退直连。2xx 不证明正文正确、出口身份或 PM 路由符合预期，正文核验需设置 `--expected-text`。

`--ip-probe` 显式增加一次出口回显 GET；轮换代理的额外探测不代表原目标请求的出口。地域／ISP／ASN 信息需要[另行提供查询服务](docs/guide_zh.md#可选查询集成)。

## 使用 Nstdata API Key

将获准使用的 Proxy API Key 保存到本地 `.env` 文件：

```dotenv
NSTDATA_API_TOKEN=your-api-key
```

获取一条 HTTP 代理并检测默认目标：

```sh
nstdata-proxy-checker --nstdata --env .env --yes
```

账号需要可用余额和兼容产品。程序复用 SDK 默认渠道，或创建一个默认渠道；出号一次，再访问一次 `https://example.com/`。代理流量按渠道计量，不购买套餐。可通过 `--target` 指定自己的目标。

在终端直接运行 `nstdata-proxy-checker --nstdata`，可隐藏输入 Key 并确认所选配置；不会写入凭据文件。脚本中使用 `--yes` 接受配置并跳过交互。[选项与失败恢复](docs/guide_zh.md#nstdata-出号与检测)。

## 其他安装方式

临时运行，无需全局安装或添加项目依赖：

```sh
npx --yes --package=@nstdata-ai/proxy-checker \
  nstdata-proxy-checker --help
```

实际检测时，配置 `NSTDATA_PROXY_URL` 或选择 `--nstdata`，再将 `--help` 换成检测选项。npm 包名是 `@nstdata-ai/proxy-checker`，可执行命令名是 `nstdata-proxy-checker`。

需要在 Node.js 项目中调用检测库时，使用该项目原有的包管理器：

```sh
npm install @nstdata-ai/proxy-checker
```

pnpm 项目使用 `pnpm add @nstdata-ai/proxy-checker`。项目内运行 CLI 可用 `npx --no-install nstdata-proxy-checker`；这要求当前项目已经安装该包。

[完整指南](docs/guide_zh.md) · [变更记录](CHANGELOG.md) · [贡献说明](CONTRIBUTING.md) · [安全反馈](SECURITY.md) · [MIT 许可](LICENSE)
