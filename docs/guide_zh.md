# Proxy Checker 使用指南

[返回快速开始](../README_zh.md) · [English](guide.md)

[连接与协议](#连接与协议) · [命令行与批量检查](#命令行与批量检查) · [正文检查与结果解释](#正文检查与结果解释) · [检测库](#检测库) · [共享传输](#共享传输) · [出口信息](#出口-ip-与详细信息) · [错误与排查](#错误与排查)

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
| `--ip-probe` | 无 | 通过同一代理连接配置，额外 GET 指定回显 URL；支持纯 IP、JSON `ip` 或成功的 Nstdata `data.ip` 包装 |
| `--ip-info` | 关闭 | 使用可选 `@nstdata-ai/ip-lookup` 查询观测到的 IP |
| `NSTDATA_IP_LOOKUP_BASE_URL` | IP 查询包默认地址 | CLI 详细查询使用的服务地址；不改变代理检测目标 |
| `--help` / `-h` | — | 查看用法，不执行检测 |

JSON 返回 `total/succeeded/failed/results`，结果保持输入顺序。CSV 每输入一行，默认列为 `index,ok,protocol,probeRequested,statusCode,elapsedMs,observedIp,contentMatched,errorCode`，未知值留空。输出不包含代理 URL、凭据或响应正文。启用出口选项时，CSV 追加 `ipSource,exitIp,ipProbeErrorCode,ipLookupErrorCode,country,regionName,city,isp,as,ipLookupStatusCode`；未知值留空。为防止表格公式执行，以 `= + - @` 开头（包括前导空白）的文本加单引号。

| 退出码 | 含义 |
|---|---|
| 0 | 所有目标检测通过；额外探测／详细查询失败单独记录，不改变此退出码 |
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
| `observedIp` | `string`／`null` | 仅从有效的纯 IP、JSON `ip` 或成功的 Nstdata `data.ip` 包装取得；普通 HTML 为未知 |
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

## 出口 IP 与详细信息

### 命令行

默认只访问目标一次；普通 HTML 不会给出出口 IP。要同时保留业务目标检测和出口探测，可使用 Nstdata 的公开回显接口：

```sh
npx --no-install nstdata-proxy-checker --target https://example.com/ --ip-probe https://api.nstdata.io/api/v2/public/utility/client-ip
```

地域／ISP／ASN 查询是独立的可选功能，需要在同一个项目另行安装 IP 查询包。安装命令适用于该包发布后；发布前本地归档安装见贡献说明。

```sh
npm install @nstdata-ai/ip-lookup@1.0.0
npx --no-install nstdata-proxy-checker --target https://example.com/ --ip-probe https://api.nstdata.io/api/v2/public/utility/client-ip --ip-info
```

回显也可换成获准使用的地址，支持纯 IPv4／IPv6、`{"ip":"地址"}` 或 `code=200,err=false,data.ip` 的 Nstdata 响应包装；非 IP 内容记为未知。

`--ip-info` 仅查询实际观测到的 IP。若目标本身已返回 IP，可省略 `--ip-probe`，复用该次目标响应。普通正文、失败的回显或缺失 IP 都不会触发查询；缺少可选包时在网络请求前退出，错误为 `IP_LOOKUP_NOT_INSTALLED`。默认安装不会自动安装 IP 查询包。

查询通过 IP 查询包访问 Nstdata 服务，发送指定的观测 IP，不复用被测代理的传输实例或凭据。服务存在独立限流和数据使用条件；批量可能得到部分查询失败，不自动排队重试或切换数据源。使用查询结果前应核对服务和数据使用条款。

### 结果含义

原有顶层 `observedIp`、`statusCode`、`elapsedMs`、`ok` 始终描述目标检测。启用出口选项时额外提供 `ip`：

| 字段 | 含义 |
|---|---|
| `ip.source` | `target-response` 为目标响应；`separate-probe` 为独立回显请求 |
| `ip.observedIp` | 从成功 2xx 响应得到的 IP；无法确认时为 null |
| `ip.probe` | 仅额外回显时提供；包含自己的状态、耗时和错误 |
| `ip.lookup.requested` | 是否调用了查询函数；不保证请求已到达服务 |
| `ip.lookup.ok` | 信息查询是否成功；不影响顶层目标成功判定 |
| `ip.lookup.result` | 成功时的来源、取得时间、源更新时间、缓存标记及字段摘要 |
| `ip.lookup.error.code` | 查询失败或跳过原因；例如 `IP_NOT_OBSERVED`、`HTTP_ERROR`、`TIMEOUT`。服务错误还保留有效的 `statusCode`／`apiCode` |

摘要保留 `query`，以及服务实际提供的国家、国家代码、地区、城市、时区、ISP、组织、AS／AS名称、mobile／proxy／hosting 标记；缺字段省略，null／false 保留。未知源更新时间仍为 null；取得时间不代表数据库更新时间。其余字段可用独立 IP 查询工具获取。供应商标记不证明代理类型、信誉或精确位置。

**两次请求可能使用不同出口。** `separate-probe` 只证明回显服务观测到的 IP；即使沿用相同网关和凭据，也不能证明它是前一次目标请求的出口。主机名／端口是输入网关，并不等于出口 IP。

每个有效条目最多一次目标 GET，显式回显再加一次代理 GET；有 IP 且开启查询时，再调用一次查询函数。HTTPS 的 CONNECT 另计。每一步单独受 `timeoutMs` 限制，三步总耗时可能接近三倍；调用方用 `signal` 限制整批。取消后不启动后续步骤，已完成的目标结果保留。CLI 信号退出仍为 130。

### Node.js 组合使用

库不自动加载 IP 查询包；将其 `lookupIp` 传入即可。`ipProbeURL` 和 `lookupIp` 都是可选参数，批量接口也支持。自定义查询函数必须接受明确的 IP 及期限／体积／signal 选项，返回与 IP 查询包一致的结果；不匹配的 IP 或无效字段会被拒绝。

```js
import { checkProxy } from '@nstdata-ai/proxy-checker';
import { lookupIp } from '@nstdata-ai/ip-lookup';

const proxyURL = process.env.NSTDATA_PROXY_URL;
const ipProbeURL = process.env.NSTDATA_PROXY_IP_ECHO_URL ?? 'https://api.nstdata.io/api/v2/public/utility/client-ip';
if (!proxyURL) throw new Error('Set NSTDATA_PROXY_URL');
const result = await checkProxy(proxyURL, {
    targetURL: process.env.NSTDATA_PROXY_CHECK_URL ?? 'https://example.com/',
    ipProbeURL,
    lookupIp,
    timeoutMs: 20000,
});
console.log(result);
if (!result.ok) process.exitCode = 1;
```

## 错误与排查

| 错误码 | 含义／下一步 |
|---|---|
| `IP_LOOKUP_NOT_INSTALLED` | CLI 启用详情前安装可选 IP 查询包；不执行代理检测 |
| `IP_NOT_OBSERVED` | 没有可查询的出口 IP，核对回显格式和状态 |
| `IP_LOOKUP_FAILED` | 查询函数返回无效摘要、IP 不一致或其他未知错误 |
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

检测结果不能替代 Proxy Manager 路由核验、数据来源核实或真实业务场景验收。
