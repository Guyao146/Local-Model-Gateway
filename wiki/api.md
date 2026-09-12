# 接口参考

## 鉴权总览

| 接口范围 | 鉴权方式 |
| --- | --- |
| `/v1/*`（模型调用） | 后台创建的本地 API Key，`Authorization: Bearer <key>` 或 `x-api-key: <key>` |
| `/api/admin/*`（管理） | 本机回环访问免认证；远程必须通过 Authentik OIDC 登录（会话 Cookie） |
| `/health` | 无鉴权 |
| `/auth/*` | 无鉴权（登录/登出流程本身） |

所有模型调用响应都携带 `x-request-id`，JSON 响应体还会在首层携带 `request_id`
（客户端提供合法值时沿用，否则自动生成），
该 ID 会透传给上游，并写入请求日志。

---

## 模型调用接口

### `POST /v1/chat/completions`（OpenAI Chat Completions）

转发到 OpenAI 兼容上游的 `/v1/chat/completions`，或经协议转换转发到 Anthropic 上游的 `/v1/messages`。
支持 `stream: true` 的 SSE 流式响应。
当请求同时包含 function tools 与非 `none` 的 `reasoning_effort` 时，OpenAI 上游改用原生
`/v1/responses`，响应再转换回 Chat Completions（含 function tool call 与 SSE 增量）；该组合禁止改发上游 `/v1/chat/completions`。

### `POST /v1/messages`（Anthropic Messages）

转发到 Anthropic 上游 `/v1/messages`，或经转换转发到 OpenAI 兼容上游。

### `POST /v1/responses`（OpenAI Responses API）

OpenAI 上游默认优先原生转发到上游 `/v1/responses`，保留 Responses API 的工具、Agent 状态和事件。
上游设置为“自动”时，仅对不含原生 Agent 能力的普通请求在上游返回 404/405/501 后回退到
Chat Completions；包含 `computer`、shell、apply_patch、`previous_response_id` 或其它原生字段的
请求不会有损回退。Anthropic 上游和显式 Chat 模式只能使用兼容转换。
携带 function tools 且 `reasoning_effort` 不为 `none` 的请求同样强制使用原生 `/v1/responses`；
若上游原生端点返回 404/405/501，则返回 `unsupported_agent_capability`，不会改发 `/v1/chat/completions`。
原生模式透明保留包括 `input`、`instructions`、`tools`、`tool_choice`、`previous_response_id`、
`include`、`reasoning` 和供应商扩展字段在内的请求字段；非流式响应与 SSE 事件同样原样转发。

### `GET /v1/models`

- 选择器模式关闭时：列出所有启用上游模型列表中的模型 + 手工路由。
- 选择器模式开启（`modelSelectionMode === true`）时：只列出勾选的本地模型与手工路由，
  不再展示未勾选的上游原始模型。

### 思考强度参数

客户端显式提供 `reasoning_effort`（OpenAI）或 `thinking`（Anthropic）时优先使用客户端值；
否则按模型选择/路由配置的 `thinkingLevel` 转换：

| 强度 | OpenAI 兼容上游 | Anthropic 上游 |
| --- | --- | --- |
| low | `reasoning_effort: low` | `thinking: { type: "enabled", budget_tokens: 2048 }` |
| medium | `reasoning_effort: medium` | `budget_tokens: 4096` |
| high | `reasoning_effort: high` | `budget_tokens: 8192` |
| client | 不主动添加，遵循客户端显式设置 | 不主动添加，遵循客户端显式设置 |
| auto / off | 不主动添加 | 不主动添加（上游声明不支持思考时也不添加） |

---

## 管理接口（`/api/admin/*`）

统一前缀，均需管理鉴权，响应头带 `Cache-Control: no-store`。

### 配置与模型目录

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/config` | 返回脱敏配置（上游 apiKey 掩码，本地 Key 完整） |
| GET | `/api/admin/model-catalog` | 模型目录（按上游分组 + 对应选择） |
| POST | `/api/admin/model-catalog/sync` | 拉取全部启用上游的 `/v1/models` |
| POST | `/api/admin/model-catalog/preview` | 保存前预览某上游的模型列表 |
| GET | `/api/admin/config/export` | 导出完整配置备份（`exportVersion: 1`） |
| POST | `/api/admin/config/import` | 导入备份；`preserveCredentials` 控制是否保留现有凭据 |

### 上游

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/upstreams` | 添加上游（返回 `201`，apiKey 掩码） |
| PUT | `/api/admin/upstreams/:id` | 更新上游；apiKey 留空时复用已保存 Key |
| DELETE | `/api/admin/upstreams/:id` | 删除上游（同时清理其路由、健康与余额缓存） |
| POST | `/api/admin/upstreams/:id/test` | 连接测试 |
| POST | `/api/admin/upstreams/:id/sync-models` | 同步该上游模型列表 |
| POST | `/api/admin/upstreams/:id/balance` | 查询单个上游余额 |
| POST | `/api/admin/upstreams/:id/reset-health` | 重置熔断/健康状态 |

### 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/routes` | 添加路由 |
| PUT | `/api/admin/routes/:id` | 更新路由 |
| DELETE | `/api/admin/routes/:id` | 删除路由 |

路由字段：`localModel`、`upstreamId`、`upstreamModel`、`fallbackUpstreamIds`、
`strategy`（`failover`/`round_robin`/`weighted`/`random`）、`upstreamWeights`、
`thinkingLevel`、`enabled`。

### 本地 Key

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/local-keys` | 新建 Key（名称留空自动生成） |
| PUT | `/api/admin/local-keys/:id` | 编辑名称 / 启用停用 |
| DELETE | `/api/admin/local-keys/:id` | 删除（系统至少保留一个 Key，最后一个不允许删除） |

### 模型选择器

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| PUT | `/api/admin/model-selections` | 保存勾选；body 为 `{ selections: [...] }` |

`selection` 字段：`upstreamModel`（上游模型 ID）、`localModel`（本地别名）、
`upstreamId`（主站）、`upstreamIds`（轮询池子集）、`upstreamMode`（`auto`/`fixed`）、
`thinkingLevel`、`enabled`。详见 [模型路由与轮询](routing.md)。

### 可靠性设置与状态

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / PUT | `/api/admin/settings` | 读取 / 更新可靠性设置 |
| GET | `/api/admin/upstream-status` | 上游健康状态（含 `settings`） |
| GET | `/api/admin/upstream-balances` | 全部上游余额（内存缓存） |
| POST | `/api/admin/upstream-balances/query` | 触发批量查询全部余额（最多 4 路并发） |

### 指标与请求日志

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/metrics` | 聚合计数 + 一页日志；支持 `?limit=&offset=` |
| GET | `/api/admin/metrics/logs` | 纯日志分页接口，返回 `{items, limit, offset, total, hasMore, maxLogs}` |
| GET | `/api/admin/metrics/export?scope=recent\|all` | 导出最近 100 条或当前保留的全部用量记录（JSON） |
| DELETE | `/api/admin/metrics` | 清空聚合计数与 JSONL 日志 |

`limit` 默认 100、最大 500；`offset` 默认 0。详见 [指标与请求日志](metrics.md)。

---

## 认证与健康接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查：`{status:'ok', service:'local-model-gateway', time}` |
| GET | `/auth/status` | 当前管理会话状态：`{authenticated, mode, configured, user}` |
| GET | `/auth/login` | 网关本地登录页；不依赖 Authentik 在线，支持展示认证连接错误和重试 |
| GET | `/auth/oidc/login` | 发起 OIDC 登录（重定向 Authentik） |
| GET | `/auth/oidc/callback` | OIDC 回调（校验 code/state/nonce/PKCE/签名后建会话） |
| GET / POST | `/auth/logout` | 退出登录（同时请求 Authentik end_session_endpoint） |

---

## 错误与限流

- 模型接口校验失败 / Key 无效：`401`。
- 限流拒绝：`429` + `Retry-After` + `x-request-id`（不消耗并发槽 / 每分钟配额）。
- 上游不可用：按候选顺序切换；全部失败返回上游错误（含 `x-request-id`）。
- 管理接口未知路径：`404 { error: { message: '管理接口不存在' } }`。
