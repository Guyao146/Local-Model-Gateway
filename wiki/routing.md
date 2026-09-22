# 模型路由与轮询

## 路由解析优先级

`chooseRoute(model)` 按以下顺序选择：

1. **精确路由**：`localModel === model` 且 `enabled` 的路由。
2. **通配路由**：`localModel === '*'` 的路由。
3. **上游模型列表匹配**：无路由时，扫描启用上游的 `models` 列表，命中即视为候选。
4. **单上游自动转发**：仅当全局只有一个启用上游时兜底转发（不配路由也能工作）。

命中路由后，候选集为 `[upstreamId, ...fallbackUpstreamIds]`，
再过滤掉「已停用」和「熔断打开」的上游，最后按策略排序。

> 手工路由与模型选择器托管路由可以共存；同名本地模型会优先精确匹配。
> 选择器保存时若与手工路由冲突会直接报错（`本地模型名与手工路由冲突`）。

## 分流策略

| 策略 | 行为 | 说明 |
| --- | --- | --- |
| `failover` | 按主上游 → 备用顺序尝试 | 旧路由默认；候选数组顺序不变 |
| `round_robin` | 轮询健康候选 | 每路由独立游标，`resetRoutingState` 可重置 |
| `weighted` | 平滑加权轮询 | 权重 1–1000 的整数，默认 1；按期望比例分配 |
| `random` | 随机洗牌候选 | 每次请求随机 |

关键行为：

- 轮询 / 加权 / 随机策略在选中上游失败时，仍会按排序结果继续尝试本次请求的其它候选。
- 熔断中的上游不参与候选（`isCircuitOpen` 过滤）。
- 策略游标只存内存，重启后重新开始。

## 备用上游与故障切换

- **可切换的失败**：连接失败、请求超时、`408/425/429`、`5xx`。
- **不切换的失败**：上游已返回 `4xx` 参数或鉴权错误——网关不换站掩盖配置问题。
- 流式请求只在「建立上游响应之前」切换；一旦开始向客户端输出内容就不会中途重试，
  避免重复生成内容。非流式请求切换前可等待 `retryDelayMs`。
- `maxFallbackAttempts`：0 表示不限制；N 表示最多再尝试 N 个备用。

## 原地重试与故障转移顺序

`upstreamRetries`（默认 0，范围 0–10）决定**同一个上游**失败后原地重试几次。单次请求
的尝试顺序是：

1. 请求当前优先级的候选上游；
2. 出现可重试失败（连接失败、超时、`408/425/429`、`5xx`）时，等待 `retryDelayMs` 后
   **重试同一个上游**，直到用尽 `upstreamRetries`；
3. 仍失败才切换到下一优先级的候选上游，重复 1–2；
4. 所有候选都失败时，把最后失败的上游错误返回给客户端，并在错误信息末尾追加
   「已依次尝试：上游A×2、上游B×1」这样的摘要；
5. 遇到 `4xx` 参数/鉴权错误立即返回：不原地重试，也不切换上游。

`attempts` 日志数组按真实尝试顺序记录每一次请求，其中 `retry` 表示这是同一上游的第几次
原地重试（`0` 即首次；缺失同样表示首次）。因此 `failover` 统计的是「换了上游」的请求，
原地重试同一个站不计入故障转移。并发槽位在整个重试/切换过程中始终占用，不会因为重试
额外放行请求。

## 熔断器

- 连续失败达到 `circuitBreakerFailureThreshold`（默认 3）→ 熔断打开，临时跳过该站。
- 冷却 `circuitBreakerCooldownMs`（默认 60000ms）后进入**半开探测**：允许放行请求试探。
- 探测成功则关闭熔断并清零连续失败；失败则重新打开并再次冷却。
- 状态只存内存，重启清零；后台可点「重置状态」立即恢复。
- 余额查询不影响熔断状态。

## 模型选择器

后台「本地模型选择」区域：

1. 按模型 ID 合并所有来源站，按前缀分组展示（前缀取 `-`/`_`/`:`/`/` 之前的片段）。
2. 每个模型可勾选是否暴露给本地 APP；可设置本地别名、默认思考强度与接口协议。
3. 同名模型多站存在时选择 `upstreamMode`：
   - **自动选择（`auto`）**：所有来源站（或勾选的子集）组成轮询池。
   - **固定站（`fixed`）**：只使用下拉框选定的单个站点。
4. **接口协议（`responsesMode`，模型级）**：覆盖上游的 `responsesMode`，决定该模型走
   `/v1/responses` 还是 `/v1/chat/completions`。
   - `auto`（默认）：客户端 Chat 请求保持 Chat；客户端 Responses 请求优先 Responses，上游不支持时对允许兼容转换的请求回退到 Chat。
   - `native`：强制 `/v1/responses`；即使上游返回 404/405/501 也**不会**回退到 Chat Completions。
   - `chat`：强制 `/v1/chat/completions`；客户端打 `/v1/responses` 时网关会自动转换请求与响应。

   适合同一个站点上不同模型走不同协议（例如某些模型只支持 Chat Completions）。
   注意：客户端 Responses 请求的 function tools 与 `reasoning_effort` 组合仍采用保守策略，选 `chat`
   会返回 `unsupported_agent_capability`；客户端 Chat 请求不受此限制，开启思考不会自动升级协议。

保存时后端 `saveModelSelections` 会把每个选择合成（或复用）一条
`managedBy: 'model-selector'` 的托管路由：

| 模式 | 生成的托管路由 |
| --- | --- |
| `auto` | `upstreamId` = 池中第一个站，`fallbackUpstreamIds` = 其余站，`strategy: round_robin`，各站权重 1 |
| `fixed` | 仅 `upstreamId`，无备用，`strategy: failover` |

- 同名模型只保留一条选择器路由；旧版按站点重复保存的同名选择会自动合并为候选池，
  并保留第一条记录的本地别名。
- 导入旧备份时同样会合并同名选择并删除多余的旧托管路由；原有手工路由不会被覆盖。
- 取消所有勾选同样生效（表示只保留手工路由）；进入选择器模式后 `/v1/models`
  只展示勾选模型与手工路由。

### 轮询池子集（`upstreamIds`）— 本次新增

「自动选择」模式下，模型行会渲染 **轮询站点** 勾选框（`data-action="pool-provider"`）：

- 只勾选想参与轮询的上游；`syncRenderedModelDraft` 会把勾选写入 `upstreamIds`。
- **勾选数 < 2 时自动回退为全部站点**（前端保护；后端目前未做同等校验）。
- 下拉框在「自动 / 固定」之间切换时勾选框即时显隐；固定模式下不渲染轮询池。
- 保存后 `upstreamIds` 落在 `modelSelections` 记录中，并转化为托管路由的主上游 + 备用列表，
  因此请求时**路由候选被严格限定在该子集内**。

> 边界说明：
> - 「至少两个站点」的保护目前只在前端；通过 API 直接提交少于 2 个的 `upstreamIds`
>   后端会照单保存（`normalizeModelSelection` 仅把 auto 模式展平为
>   `[upstreamId, ...ids.filter(id => id !== upstreamId)]`，当池只有一个站时路由表现为固定站）。
> - 建议后续在后端 `saveModelSelections` 增加子集校验（过滤不存在/已停用的站，
>   长度 < 2 时回退为全部站点），避免只依赖前端。

## 思考强度识别

模型选择器和手工路由都支持 `client`（界面显示为“遵循客户端设置”）。该模式不会由网关
注入默认的 `reasoning_effort` 或 Anthropic `thinking` 参数；客户端已经提供的显式参数会原样保留。

网关识别常见能力字段：`supports_thinking`、`supports_reasoning`、`thinking_levels`、
`reasoning_effort`、`capabilities.thinking`、`supported_parameters` 等；
部分常见 Claude 3.7/4、o1/o3/o4、GPT-5 模型还会按模型名做保守推断。
转换规则见 [接口参考](api.md) 中的「思考强度参数」表。
