# Proxy Checker 使用指南

[返回快速开始](../README_zh.md) · [English](guide.md)

[连接与协议](#连接与协议) · [命令行与批量检查](#命令行与批量检查) · [正文检查与结果解释](#正文检查与结果解释) · [检测库](#检测库) · [共享传输](#共享传输) · [错误与排查](#错误与排查)

## 连接与协议

代理连接使用平台生成的 `http://` 或 `https://` URL，可包含经 URL 编码的用户名和密码。放在 `NSTDATA_PROXY_URL` 或受保护文件中，避免作为命令行参数暴露。支持 HTTP／HTTPS 网关以及 HTTP／HTTPS 目标；HTTPS 目标使用 CONNECT。

不支持 SOCKS、浏览器交互、通道管理或自动轮换。TLS 证书和主机名始终校验；私有 CA 可通过绝对路径 `NSTDATA_PROXY_CA_FILE`（CLI）或 `caFile`（库）额外信任，不关闭校验。

## 命令行与批量检查

### 输入与输出

单代理使用环境变量。批量使用 `--file`：文件为含 1–100 个代理 URL 的 JSON 数组，最多 1 MiB，仅所有者可读写。文件输入优先于 `NSTDATA_PROXY_URL`；有效条目继续执行，无效条目保留原索引并报告 `INVALID_CONFIG`。

```sh
npx --no-install nstdata-proxy-checker --file /path/to/proxies.json --target https://example.com/ --concurrency 2 --format csv
```

| 选项／环境变量 | 默认值 | 用途与限制 |
|---|---|---|
| `--target` / `NSTDATA_PROXY_CHECK_URL` | 必填其一 | 目标 HTTP(S) URL，不含用户名密码；命令行优先 |
| `NSTDATA_PROXY_URL` | 无 | 未设置 `--file` 时的代理连接 |
| `--file` | 无 | 受保护的代理 JSON 数组文件 |
| `--timeout` | 20000 ms | 单次探测期限，整数 1–600000 |
| `--concurrency` | 1 | 并发数，整数 1–4 |
| `--format` | `json` | 输出 `json` 或 `csv` |
| `--expected-text` | 无 | 区分大小写的非空字面串，最多 4096 UTF-8 字节 |
| `NSTDATA_PROXY_CA_FILE` | 无 | 额外信任的 PEM CA 文件绝对路径 |
| `--help` / `-h` | — | 查看用法，不执行检测 |

JSON 返回 `total/succeeded/failed/results`，结果保持输入顺序。CSV 每输入一行，固定列为 `index,ok,protocol,probeRequested,statusCode,elapsedMs,observedIp,contentMatched,errorCode`，未知值留空。输出不包含代理 URL、凭据或响应正文。

| 退出码 | 含义 |
|---|---|
| 0 | 所有条目通过 |
| 1 | 至少一条失败，包括文件输入中的无效代理和 CA 加载失败 |
| 2 | 调用被拒绝，例如文件格式或公共参数错误 |
| 130 | SIGINT／SIGTERM 中断，停止在途及排队任务 |

### 正文断言

```sh
npx --no-install nstdata-proxy-checker --target https://example.com/ --expected-text "Example Domain"
```

## 正文检查与结果解释

默认只按 2xx 判断 HTTP 健康。设置正文断言后，使用同一次 GET 返回的完整、有效 UTF-8 正文进行区分大小写的字面匹配；不做正则、Unicode 或空白归一化。

| 字段 | 类型 | 解释 |
|---|---|---|
| `ok` | `boolean` | HTTP 成功，且设置断言时断言也通过 |
| `index` | `number`，批量结果提供 | 对应输入位置，重复代理也单独检测 |
| `protocol` | `http`／`https`／`null` 或缺失 | 代理网关协议，不是目标协议 |
| `probeRequested` | `boolean` | 已开始本地传输调用，不证明请求到达目标 |
| `statusCode` | `number`／`null` | 已完整取得的目标响应状态；未取得则未知 |
| `elapsedMs` | `number`／`null` | 从传输调用至完整正文解码完成；不含传输初始化、正文断言或 MCP 开销 |
| `observedIp` | `string`／`null` | 仅从有效的纯 IP 或 JSON `ip` 回显取得；普通 HTML 为未知 |
| `contentMatched` | `boolean`／`null` 或缺失 | 设置断言时提供；`null` 表示无法可靠评分 |
| `error.code` | `string`，失败时提供 | 失败分类，见排查表 |

`elapsedMs` 不等于 TCP 延迟、TTFB 或吞吐；比较时使用同版本和同一检测模式。IP 回显不证明地理位置、信誉或匿名性。

无效 UTF-8、包含凭据或脱敏标记的正文不能记为匹配成功。断言评估保留 16000 字符的序列化响应上限；超限时 `contentMatched` 为未知，但保留已知 HTTP 状态和耗时。完整取得非 2xx 响应时优先报告 `TARGET_HTTP_ERROR`。下载或解码体积超限则无法得到完整结果，属于 `RESPONSE_LIMIT`。

## 检测库

以下是完整 ESM 示例。默认目标为 HTTPS；可通过 `NSTDATA_PROXY_CHECK_URL` 选择获准检测的目标。

```js
import { checkProxy } from '@nstdata-ai/proxy-checker';

const proxyURL = process.env.NSTDATA_PROXY_URL;
if (!proxyURL) throw new Error('Set NSTDATA_PROXY_URL');
const result = await checkProxy(proxyURL, {
    targetURL: process.env.NSTDATA_PROXY_CHECK_URL ?? 'https://example.com/',
    timeoutMs: 20000,
    expectedText: 'Example Domain',
});
console.log(result);
if (!result.ok) process.exitCode = 1;
```

| 方法 | 返回 | 输入处理 |
|---|---|---|
| `checkProxy(proxyURL, options)` | `Promise<CheckResult>` | 配置无效时抛 `ProxyCheckError`；探测失败返回 `ok: false` |
| `checkProxies(proxies, options)` | `Promise<{total, succeeded, failed, results}>` | 1–100 条，保持顺序和重复项；支持有界并发 |

公共选项为必填 `targetURL`，以及可选 `timeoutMs`、`expectedText`、`caFile`、`signal`、`maxResponseBytes`。`maxResponseBytes` 默认 1 MiB，范围 256–67108864 字节；`timeoutMs` 默认 20000 ms，范围 1–600000。

批量额外支持 `concurrency`（默认 1，范围 1–4）及 `invalidInput`：默认 `'reject'` 在请求前拒绝任何无效代理，`'report'` 保留无效行并执行有效行。公共参数格式／范围在分发前验证；CA 文件读取或信任加载失败则返回 `INVALID_CONFIG` 行，`probeRequested: false`。

`signal` 控制整次调用或批次的本地取消；单次探测期限不包含排队时间。调用方可用 `AbortSignal.timeout(...)` 给整个批次设置期限。

## 共享传输

`/transport` 用于需要自行处理响应的调用方，支持 GET／HEAD 和目标请求头。下面仅打印状态与字节数：

```js
import { createProxyTransport, ProxyTransportError } from '@nstdata-ai/proxy-checker/transport';

const proxyURL = process.env.NSTDATA_PROXY_URL;
if (!proxyURL) throw new Error('Set NSTDATA_PROXY_URL');
try {
    const transport = createProxyTransport({ proxyURL, timeoutMs: 20000 });
    const response = await transport.request({
        url: process.env.NSTDATA_PROXY_CHECK_URL ?? 'https://example.com/',
        method: 'GET',
    });
    console.log({ statusCode: response.statusCode, bodyBytes: response.body.length });
} catch (error) {
    console.error(error instanceof ProxyTransportError ? error.code : 'TRANSPORT_ERROR');
    process.exitCode = 1;
}
```

| 输入／输出 | 说明 |
|---|---|
| `createProxyTransport({proxyURL, timeoutMs?, maxResponseBytes?, caFile?})` | 建立本地配置；无效配置抛 `ProxyTransportError` |
| `request({url, method?, headers?}, {signal}?)` | 默认为 GET；HEAD 无正文，连接／代理专用请求头不可覆盖 |
| `{statusCode, body, headers}` | `body` 是完整解码后的 `Buffer`；`headers` 保留原始响应头，可能仍描述压缩／编码后的传输内容 |

网关和目标证书校验都保持开启，`caFile` 增加信任。每次请求有独立期限，下载和解码后正文都受体积限制；不跳转、重试或回退直连。

**正文与响应头未经脱敏且不可信。**交给日志、终端或 AI 前由调用方过滤；`checkProxy` 不返回这些原始内容。目标非 2xx 作为响应数据返回，不由传输层评分；网关／CONNECT 的 407 是代理认证失败，已建立隧道内目标的 407 则是目标 HTTP 响应。

## 错误与排查

| 错误码 | 含义／下一步 |
|---|---|
| `INVALID_CONFIG` | 核对代理格式、选项范围、目标地址及 CA 路径／文件 |
| `INVALID_INPUT_FILE` / `INVALID_INPUT` | CLI 文件或输入无法读取／解析，检查受保护文件与 JSON 格式 |
| `PROXY_AUTHORIZATION_FAILED` | 网关或 CONNECT 拒绝认证，核对生成的连接凭据 |
| `PROXY_CONNECT_FAILED` | CONNECT 被网关拒绝，核对目标和通道可访问范围 |
| `TLS_ERROR` | TLS 握手／证书链／主机名校验失败，核对 CA 和完整证书链 |
| `TIMEOUT` / `CANCELLED` | 本地探测期限或取消；排查网络，避免无界重试 |
| `TARGET_HTTP_ERROR` | 完整目标响应不是 2xx，查看 `statusCode` |
| `CONTENT_MISMATCH` | 有效完整正文不含预期文本，核对目标及断言 |
| `CONTENT_UNAVAILABLE` | 正文无法可靠评分，例如无效 UTF-8 或敏感文本 |
| `OUTPUT_LIMIT` | 完整 2xx 响应超出断言评估上限，匹配未知 |
| `RESPONSE_LIMIT` | 响应头／下载／解码正文超限，不是成功检测 |
| `INVALID_RESPONSE` / `UNSUPPORTED_RESPONSE` / `UNSUPPORTED_ENCODING` | 代理响应、协议升级或正文编码不受支持 |
| `UPSTREAM_ERROR` / `CHECK_FAILED` | 其他传输或检测失败，按最小脱敏复现排查 |

检测结果不能替代 Proxy Manager 路由核验、IP 数据查询或真实业务站点验收。
