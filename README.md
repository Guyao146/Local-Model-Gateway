# Local Model Gateway

一个运行在本机的轻量模型聚合网关。它不依赖 npm 第三方包，使用 Node.js 内置 HTTP 服务和 `fetch`，可以把本地客户端的 OpenAI / Anthropic 请求转发到多个可配置的上游站点。

## 当前功能

- OpenAI 兼容接口：`POST /v1/chat/completions`、`GET /v1/models`
- OpenAI Responses 兼容接口：`POST /v1/responses`
- Anthropic 兼容接口：`POST /v1/messages`
- OpenAI ↔ Anthropic 请求、响应和 SSE 流式响应转换
- 流式响应保持统一的响应 ID，支持文本增量、结束事件和上游返回的 usage 统计
- 后台添加、编辑、删除、测试上游站点
- 上游协议支持 OpenAI 兼容和 Anthropic；支持 Bearer、`x-api-key`、无鉴权
- 本地模型名到上游模型名的路由映射，支持 `*` 兜底路由
- 路由支持备用上游；主上游连接失败、超时、429 或 5xx 时按顺序切换
- 请求统计和最近请求元数据，可查看成功率、故障转移次数、Token 数量及按上游统计
- 路由支持故障转移、轮询、加权轮询和随机四种策略
- 添加上游时填写地址和 API Key 即可从 `/v1/models` 拉取并回填模型列表
- 已保存的上游支持从 `/v1/models` 同步模型列表
- 模型目录支持按上游分组、展开/收起、搜索和复选框选择
- 可为每个“上游 + 模型”设置本地别名和默认思考强度
- 支持从上游模型元数据识别 reasoning/thinking 能力，并转换思考参数
- 管理后台按访问来源认证：本机回环访问免认证，远程访问使用 Authentik OIDC
- OIDC 使用 Authorization Code + PKCE、state、nonce、JWKS 签名校验和 HttpOnly 会话
- 本地 API Key 管理
- 本地 API Key 支持启用/停用和重命名，至少保留一个可管理的 Key
- 可配置上游超时、备用尝试次数和切换前等待时间
- 每次模型请求返回 `x-request-id`，并把同一 ID 传递给上游，便于排查后台日志
- 上游健康状态和内存熔断：连续失败达到阈值后暂时跳过，冷却后自动半开探测
- 配置保存在 `data/config.json`，该文件已加入 `.gitignore`
- 默认只监听 `127.0.0.1`，避免未经配置暴露到局域网

## 启动

需要 Node.js 18 或更高版本（当前服务使用 Node 18+ 内置 `fetch`）。在 Windows PowerShell 中：

```powershell
cd "C:\Users\guxua\.cline\data\workspaces\chat\local-model-gateway"
node src/server.js
```

如果 PowerShell 的执行策略阻止 `npm.ps1`，本项目不需要 npm 安装依赖，直接使用 `node src/server.js` 即可。也可以使用：

```powershell
npm.cmd start
```

启动时终端会打印默认本地 API Key：`sk-local_...`。打开 <http://127.0.0.1:8787/> 后，本机回环访问会自动进入后台，不需要输入任何管理凭据。

管理认证与模型调用认证彼此独立：

- 管理后台和 `/api/admin/*`：本机回环访问免认证；远程访问必须通过 Authentik OIDC
- `/v1/*` 模型接口：无论本机还是远程，仍然必须使用后台创建的本地 API Key

## Authentik OIDC 远程管理认证

### 1. 在 Authentik 创建 Provider 和 Application

创建一个 OAuth2/OpenID Provider，并建议使用：

- Client type：`Confidential`
- Authorization flow：`Authorization Code`
- Redirect URI：你的公网网关地址加 `/auth/oidc/callback`，例如 `https://gateway.example.com/auth/oidc/callback`
- Scopes：`openid profile email`
- Signing Key：建议选择证书密钥，让 ID Token 使用非对称签名并通过 JWKS 校验
- Encryption Key：不要配置；当前网关验证签名 JWT，不支持加密的 JWE ID Token

然后创建 Authentik Application 并绑定该 Provider。哪些用户或组能进入后台，应通过 Authentik Application 的 Policy/Binding 控制；只要用户能通过这个 Application 的认证，就拥有网关管理权限。

Issuer URL 使用该 Application 的 OIDC issuer，通常格式为：

```text
https://auth.example.com/application/o/<application-slug>
```

不要在 `AUTHENTIK_ISSUER_URL` 末尾填写 `/.well-known/openid-configuration`，网关会自动请求 discovery 地址。

### 2. 配置环境变量

OIDC Client Secret 只从环境变量读取，不会写入 `data/config.json` 或 Git。Windows PowerShell 示例：

```powershell
$env:HOST = "0.0.0.0"
$env:AUTHENTIK_ISSUER_URL = "https://auth.example.com/application/o/local-model-gateway"
$env:AUTHENTIK_CLIENT_ID = "在 Authentik 中生成的 Client ID"
$env:AUTHENTIK_CLIENT_SECRET = "在 Authentik 中生成的 Client Secret"
$env:AUTHENTIK_REDIRECT_URI = "https://gateway.example.com/auth/oidc/callback"
node src/server.js
```

远程用户访问 `https://gateway.example.com/` 时会自动跳转 Authentik。认证成功后，网关验证 discovery、issuer、audience、过期时间、state、nonce、PKCE 和 ID Token 签名，并创建仅服务端保存的 `HttpOnly` 会话。服务重启后远程会话失效，需要重新登录。

### 3. 反向代理与来源判断

网关默认只根据 TCP socket 的来源地址判断本地或远程，不会直接信任客户端发送的 `X-Forwarded-For`。如果使用 Nginx、Caddy 或 Traefik 反向代理，必须把代理实际连接网关时使用的 IP 明确加入 `TRUSTED_PROXY_ADDRESSES`，多个地址用逗号分隔。例如代理与网关都在本机：

```powershell
$env:TRUSTED_PROXY_ADDRESSES = "127.0.0.1,::1"
```

反向代理必须覆盖而不是盲目透传客户端提供的来源头。例如 Nginx：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

如果不使用反向代理、远程客户端直接连接网关，不要设置 `TRUSTED_PROXY_ADDRESSES`。该变量只接受精确 IP 地址，不接受主机名或 CIDR。错误地信任客户端可以直接连接的地址会造成认证绕过风险。

> 注意：如果同机反向代理连接 `127.0.0.1`，但没有配置 `TRUSTED_PROXY_ADDRESSES`，网关看到转发头时会拒绝把该连接当作本地访问，并要求 Authentik，防止远程请求被错误地免认证。

本机免认证访问请使用 `http://127.0.0.1:8787/`、`http://localhost:8787/` 或 IPv6 回环地址。管理后台会校验回环 Host、Origin 和浏览器来源信息，防止 DNS Rebinding 或跨站页面利用本机免认证权限修改配置。

## 配置上游

### sub2api / newapi 类 OpenAI 兼容站点

通常填写：

- 地址：站点的 API 根地址，例如 `https://example.com/v1`
- 协议：`OpenAI 兼容`
- 鉴权：`Bearer`
- API Key：该站点的 Key
- 模型列表：填写地址和 API Key 后可点击“拉取模型”自动获取，也可以每行手工填写一个

如果站点明确要求 `x-api-key`，把鉴权方式改为 `x-api-key`。

### Claude / Anthropic 上游

填写：

- 地址：站点 API 根地址，例如 `https://example.com` 或 `https://example.com/v1`
- 协议：`Anthropic`
- 鉴权：默认 `x-api-key`
- API Key：该站点的 Key

网关会请求上游的 `/v1/messages`，并自动转换 system、文本、工具调用以及流式事件。

## 配置路由

例如将本地客户端请求的 `claude-3-5-sonnet` 转发为某个上游实际模型：

- 本地模型名：`claude-3-5-sonnet`
- 上游：选择目标站点
- 上游模型名：`claude-3-5-sonnet-20241022`

路由优先级：精确路由 → `*` 兜底路由 → 上游模型列表匹配 → 仅有一个启用上游时自动转发。

路由可以配置多个备用上游。非流式请求在主上游连接失败、请求超时、返回 408/425/429 或 5xx 时，会依次尝试备用上游；如果上游已经返回 4xx 参数或鉴权错误，网关不会自动换站点掩盖配置问题。流式请求也只会在建立上游响应之前切换，一旦开始向客户端输出内容就不会中途重试，避免重复生成内容。

路由的分流策略可以选择：

- `failover`：按主上游和备用上游顺序尝试，旧路由默认使用此策略
- `round_robin`：健康候选上游轮询分配
- `weighted`：按路由中配置的正整数权重进行平滑加权轮询
- `random`：从健康候选上游中随机选择

轮询、加权和随机策略仍会在选中的上游失败时尝试本次请求的其它候选；熔断中的上游不会参与分流。策略游标只存在内存中，重启后重新开始。

## 本地客户端调用

### OpenAI SDK / OpenAI 兼容 APP

Base URL 填：

```text
http://127.0.0.1:8787/v1
```

API Key 填后台创建的本地 Key，模型名填配置的“本地模型名”。例如：

```bash
curl http://127.0.0.1:8787/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer sk-local_xxx" ^
  -d "{\"model\":\"claude-3-5-sonnet\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"
```

### Anthropic 兼容 APP

Base URL 同样填：

```text
http://127.0.0.1:8787/v1
```

请求 `POST /v1/messages`，使用本地 API Key 作为 `x-api-key` 或 Bearer Token。网关会根据模型路由选择上游。

### OpenAI Responses API

支持常见的 Responses 请求字段 `input`、`instructions`、`max_output_tokens`、`tools` 和 `stream`。请求会先转换为网关内部的 Chat Completions 格式，再按路由转发到 OpenAI 兼容或 Anthropic 上游。非流式示例：

```bash
curl http://127.0.0.1:8787/v1/responses ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer sk-local_xxx" ^
  -d "{\"model\":\"gpt-4o\",\"instructions\":\"Be concise\",\"input\":\"你好\",\"max_output_tokens\":100}"
```

Responses 流式请求会返回 `response.created`、`response.output_text.delta`、`response.output_text.done` 和 `response.completed` 等 SSE 事件。当前版本重点兼容文本输出；如果上游在流中返回 usage，网关会同步到后台统计。复杂的 Responses 专有事件和部分高级工具事件会在后续继续扩展。

## 配置备份和恢复

后台“配置备份”区域可以导出完整 JSON 配置，也可以从备份文件导入上游和路由。导入默认保留当前机器的本地 API Key；备份中的完整上游 API Key 会恢复，掩码 Key 会尝试使用当前相同上游 ID 的 Key。旧备份中的管理员 Token 字段仅为格式兼容保留，不再参与后台认证。监听地址或端口导入后需要重启服务才会生效。

## 请求统计和模型同步

后台的“请求统计”区域会显示请求总数、成功率、故障转移次数、输入/输出/总 Token、按上游统计以及最近 200 条请求元数据。日志不会保存请求内容、请求头、API Key 或上游完整地址。可以在后台点击“清空统计”。统计数据保存在 `data/metrics.json`，与上游配置分开保存。

添加或编辑上游时，填写地址和 API Key 后可以直接点击“拉取模型”，网关会调用该站点的 `/v1/models` 并把模型 ID 回填到表单；确认列表后仍需点击“保存上游”。编辑已有上游时 API Key 可以留空，拉取会安全复用已保存的 Key。已保存的上游卡片也提供“同步模型”按钮。部分 Anthropic 上游没有标准模型列表接口，此时仍需手工填写模型。

## 模型目录和本地模型选择

后台“本地模型选择”区域会按上游站点分组展示模型。可以：

- 点击“拉取全部模型”尝试从所有启用上游的 `/v1/models` 获取模型；不提供该接口的 Anthropic 站点继续使用上游表单中的手工模型
- 使用搜索框按站点名、模型 ID 或显示名筛选
- 点击站点标题展开或收起，也可以“全部展开/全部收起”
- 勾选要暴露给本地 APP 的模型
- 给相同模型设置不同的本地别名，例如 `claude-sonnet-a`、`claude-sonnet-b`
- 为每个模型设置默认思考强度：自动、关闭、低、中、高

点击“保存勾选”后，网关会自动创建或更新选择器管理的本地路由；原有手工路由不会被覆盖。进入选择器模式后，`/v1/models` 只展示勾选的本地模型和手工路由，不再展示未勾选的上游原始模型。取消所有勾选也会生效，表示只保留手工路由。

思考强度的转换规则：

- OpenAI 兼容上游：低/中/高转换为 `reasoning_effort: low/medium/high`
- Anthropic 上游：低/中/高转换为 `thinking: { type: "enabled", budget_tokens: 2048/4096/8192 }`
- 自动：不主动添加思考参数
- 上游明确声明不支持思考时：不会添加思考参数
- 上游能力未知时：后台仍允许配置；如果客户端没有显式思考参数，网关会按选择的强度尝试发送
- 客户端请求显式提供 `reasoning_effort` 或 `thinking` 时，优先使用客户端值

网关会识别常见的模型能力字段，包括 `supports_thinking`、`supports_reasoning`、`thinking_levels`、`reasoning_effort`、`capabilities.thinking`、`supported_parameters` 等；部分常见 Claude 3.7/4、o1/o3/o4、GPT-5 模型也会按模型名做保守推断。不同站点的私有字段可能需要后续适配。

## 可靠性设置和 Key 管理

后台“可靠性设置”可以调整：

- 上游超时：1000 到 3600000 毫秒，默认 600000 毫秒
- 最大备用尝试次数：0 表示不限制；1 表示主上游失败后最多再尝试 1 个备用
- 切换前等待：0 到 30000 毫秒
- 熔断失败阈值：1 到 20 次，默认 3 次
- 熔断冷却时间：1000 到 3600000 毫秒，默认 60000 毫秒
- 最大并发请求数：0 表示不限制，范围 0 到 1000
- 每 Key 每分钟请求数：0 表示不限制，范围 0 到 10000

本地 Key 的完整值可以在已认证的管理后台直接查看和一键复制，也可以编辑名称、启用或停用。停用会立即使该 Key 的模型请求返回 401；系统不允许删除最后一个本地 Key。

后台上游卡片会显示健康状态、连续失败次数和熔断冷却时间。熔断状态只存在内存中，网关重启后会清除；也可以点击“重置状态”立即恢复该上游。熔断失败阈值默认是 3 次，冷却时间默认是 60000 毫秒。

每次 `/v1/chat/completions`、`/v1/messages` 或 `/v1/responses` 请求都会返回 `x-request-id`。如果客户端自己提供符合格式的 `x-request-id`，网关会沿用它并传给上游；否则自动生成一个。后台请求日志也会保存这个 ID。

限流只作用于模型调用接口，不影响 `/v1/models` 和管理接口。并发限制是全局模型请求数；每分钟限制按本地 API Key 独立计算。被拒绝请求返回 HTTP 429、`Retry-After` 和 `x-request-id`，不会消耗并发槽或每分钟配额。

## 环境变量

- `HOST`：监听地址，默认 `127.0.0.1`
- `PORT`：监听端口，默认 `8787`
- `LOCAL_MODEL_GATEWAY_DATA_DIR`：可选，指定配置数据目录；默认是项目下的 `data`
- `AUTHENTIK_ISSUER_URL`：Authentik Application 的 OIDC issuer URL
- `AUTHENTIK_CLIENT_ID`：Authentik OAuth2/OpenID Provider 的 Client ID
- `AUTHENTIK_CLIENT_SECRET`：Confidential Provider 的 Client Secret
- `AUTHENTIK_REDIRECT_URI`：完整回调地址，必须以 `/auth/oidc/callback` 结尾并与 Authentik 配置一致
- `AUTHENTIK_SCOPES`：可选，默认 `openid profile email`
- `AUTHENTIK_TOKEN_AUTH_METHOD`：可选，`client_secret_basic` 或 `client_secret_post`；默认按 discovery 自动选择
- `AUTHENTIK_SESSION_TTL_SECONDS`：可选，远程管理会话最长有效期，默认 28800 秒，范围 300 到 604800
- `AUTHENTIK_COOKIE_SECURE`：可选；默认根据回调 URL 是否为 HTTPS 自动决定，生产环境不要关闭
- `AUTHENTIK_POST_LOGOUT_REDIRECT_URI`：可选，Authentik 登出后的返回地址
- `TRUSTED_PROXY_ADDRESSES`：可选，允许提供 `X-Forwarded-For` 的反向代理精确 IP 列表

如果需要让其它设备访问，可以用 `HOST=0.0.0.0` 启动。远程管理访问必须完整配置 Authentik；模型接口仍需使用本地 API Key，并建议同时使用 HTTPS、防火墙和网络访问控制。

## 注意事项

- `data/config.json` 含有上游 API Key、本地 API Key 和旧版兼容字段，请不要提交或分享；Authentik Client Secret 不会写入该文件。
- `data/metrics.json` 只包含脱敏请求元数据和 Token 数字，不包含请求内容或密钥；仍建议不要分享运行数据目录。
- 已认证的管理后台会显示完整本地调用 Key；上游 API Key 仍只显示掩码。请避免向不受信任的用户授予 Authentik 管理后台访问权限。
- 第一版按最常见的 OpenAI Chat Completions 与 Anthropic Messages 协议实现，复杂的供应商私有字段、图片 URL 的特殊格式、部分高级工具参数可能需要后续适配。
- 目前没有余额监控、计费统计和多用户权限，这些可以在后续需求中继续补充。
