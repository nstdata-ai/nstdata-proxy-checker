# Nstdata proxy checker

[English](README.md)

HTTP／HTTPS 代理检查 CLI 和 Node.js 库。无运行时依赖，无需托管检测服务或 Crawl Token；支持 Node.js 22 系列的 22.18+ 或 Node.js 24。

## 安装

`1.1.0` 已在本地准备，尚未发布。发布后在应用目录安装：

```sh
npm install @nstdata-ai/proxy-checker@1.1.0
```

发布前的本地安装见[贡献说明](CONTRIBUTING.md)。

## 检查代理

在受保护环境中将 `NSTDATA_PROXY_URL` 设为平台生成的代理 URL，再指定目标：

```sh
npx --no-install nstdata-proxy-checker --target https://example.com/ --timeout 20000
```

`--file` 读取最多 1 MiB、含 1–100 个代理 URL 的 JSON 数组，优先于环境代理；文件应仅所有者可读写。无效条目返回带索引的 `INVALID_CONFIG`，有效条目继续；文档格式或公共选项的格式／范围错误则拒绝整次调用。

每条记录发送一次 GET，包括重复 URL；HTTPS 目标使用 CONNECT。请求可能消耗流量，不跳转、重试、轮换或回退直连。支持 HTTP／HTTPS 网关和生成的用户名／会话语法，不管理通道或验证 PM 路由。

| 选项 | 默认值／行为 |
|---|---|
| `--target` | 必填，或使用 `NSTDATA_PROXY_CHECK_URL` |
| `--timeout` | 每探测 20000 毫秒；范围 1–600000 |
| `--concurrency` | 1；范围 1–4 |
| `--format` | `json` 或 `csv` |
| `--expected-text` | 可选区分大小写的字面串，最多 4096 UTF-8 字节 |
| `NSTDATA_PROXY_CA_FILE` | 可选绝对路径 PEM CA；保持 TLS 验证 |

退出码：0 全部通过、1 存在失败行、2 因文档格式或调用参数错误而拒绝调用、130 中断。SIGINT／SIGTERM 停止在途和排队工作；`probeRequested` 只表示已启动本地传输请求，不证明请求到达目标。

## 正文检查与输出

```sh
npx --no-install nstdata-proxy-checker --file /PATH/TO/proxies.json --target https://example.com/ --expected-text "Example Domain" --format csv
```

2xx 只表示 HTTP 健康，不表示正文符合预期。断言模式用一次 GET 检查完整、有效的 UTF-8 文本；无效 UTF-8 返回 `CONTENT_UNAVAILABLE`，匹配状态为未知，默认 HTTP 健康检查仍按状态判断。不匹配返回 `CONTENT_MISMATCH`，非 2xx 保留 `TARGET_HTTP_ERROR`。脱敏或不可用正文的匹配状态为未知，不对改写后的文本评分；不做正则或 Unicode／空白归一化。

JSON 包含汇总和有序结果；CSV 列为 `index,ok,protocol,probeRequested,statusCode,elapsedMs,observedIp,contentMatched,errorCode`，每输入一行，缺失值留空。输出不包含代理 URL、凭据或响应正文。

`elapsedMs` 从传输请求开始计至正文解码完成，不包含传输初始化和内容断言；已移除原 MCP 调用开销，只应比较相同版本和模式的数据；不代表 TCP、TTFB 或吞吐。`observedIp` 仅从有效 IP 回显取得，普通 HTML 为 null；状态、耗时和匹配结果可能未知。

## 库接口

```js
import { checkProxy, checkProxies } from '@nstdata-ai/proxy-checker';
const one = await checkProxy(process.env.NSTDATA_PROXY_URL, {
  targetURL: 'https://example.com/', timeoutMs: 20000,
});
// checkProxies([url1, url2], {targetURL, concurrency:2, signal}) preserves order.
```

`checkProxies` 保留输入顺序，`invalidInput` 默认为 `'reject'`，可设为 `'report'`；严格模式在所有请求前拒绝无效 URL。其他选项为 `maxResponseBytes`（默认 1 MiB，范围 256–64 MiB）、`caFile`、`signal`、`expectedText`。公共选项的格式／范围在分发前校验；CA 文件读取或 PEM 信任加载失败返回 `INVALID_CONFIG` 失败行，`probeRequested: false`（CLI 退出码 1）。超时按探测计算，整批期限由 signal 控制。

正文体积和断言输出分别受限，断言模式保留序列化响应 16000 字符上限；体积／输出超限不能记为断言成功。TLS、认证、CONNECT 错误与目标 HTTP 失败分别保留。

## 复用代理传输

```js
import { createProxyTransport } from '@nstdata-ai/proxy-checker/transport';
const transport = createProxyTransport({ proxyURL: process.env.NSTDATA_PROXY_URL, timeoutMs: 20000 });
const response = await transport.request({ url: 'https://example.com/', method: 'GET' });
// response: statusCode, body (Buffer), headers
```

传输支持 GET／HEAD 和可选目标请求头，拒绝连接／代理头覆盖；不跳转、重试或回退直连。每次请求独立计时并支持 `signal`；`maxResponseBytes` 限制下载和解码后正文。`caFile` 增加可信 PEM CA，同时保持网关和目标的证书及主机名校验。失败返回安全的 `ProxyTransportError` 错误码，目标 HTTP 状态保留为响应数据。网关／CONNECT 的 407 表示代理认证失败；已建立隧道内 HTTPS 目标返回的 407 仍是目标响应。

与 CLI 输出不同，传输返回的正文和响应头是**未经脱敏的不可信数据**。调用方必须在记录日志或交给 AI 客户端前应用自身的输出／凭据过滤；MCP Adapter 单独提供这些策略。

[贡献说明](CONTRIBUTING.md) · [变更记录](CHANGELOG.md) · [MIT 许可](LICENSE)
