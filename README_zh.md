# Nstdata Proxy Checker

[English](README.md)

通过 HTTP／HTTPS 代理访问指定目标，检查 HTTP 状态、请求耗时和可选正文断言。提供 CLI、Node.js 库及可复用代理传输；无运行时依赖，无需 Crawl Key。

## 功能入口

| 要完成的任务 | 使用入口 | 得到什么 |
|---|---|---|
| 检查一个代理 | [快速开始](#快速开始) | HTTP 状态、耗时及失败分类 |
| 检查一批代理并输出 CSV | [批量与命令行](docs/guide_zh.md#命令行与批量检查) | 有序结果、成功／失败汇总、退出码 |
| 验证目标正文，而不只看 2xx | [正文检查](docs/guide_zh.md#正文检查与结果解释) | 字面文本匹配或未知状态 |
| 在 Node.js 中执行检测 | [检测库](docs/guide_zh.md#检测库) | `checkProxy`／`checkProxies` |
| 自行处理代理响应 | [共享传输](docs/guide_zh.md#共享传输) | GET／HEAD、响应字节与响应头 |

## 安装

支持 Node.js 22（22.18 及以上）和 24。

> 1.1.0 尚未在 npm 发布。从源码安装见[贡献说明](CONTRIBUTING.md)。

```sh
npm install @nstdata-ai/proxy-checker@1.1.0
```

## 快速开始

在受保护的环境变量 `NSTDATA_PROXY_URL` 中设置平台生成的代理连接，然后运行：

```sh
npx --no-install nstdata-proxy-checker --target https://example.com/ --timeout 20000
```

默认输出 JSON。`ok: true` 表示目标返回 2xx；`statusCode` 是响应状态，`elapsedMs` 是请求至正文读取解码完成的耗时。失败检查 `error.code`；完整字段说明见[结果解释](docs/guide_zh.md#正文检查与结果解释)。

检测会使用真实代理流量。每条有效输入最多执行一次目标 GET，包括重复项；不跳转、重试、轮换或回退直连。2xx 不证明正文正确、出口身份或 PM 路由符合预期，正文核验需设置 `--expected-text`。

[完整指南](docs/guide_zh.md) · [变更记录](CHANGELOG.md) · [贡献说明](CONTRIBUTING.md) · [安全反馈](SECURITY.md) · [MIT 许可](LICENSE)
