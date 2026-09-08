# 指标与请求日志

## 存储设计：聚合与明细分离

每次模型请求都会记录明细并累加计数，但**计数和明细分开存放**，避免每请求重写大文档的写放大：

| 文件 | 内容 | 写入方式 |
| --- | --- | --- |
| `data/metrics.json` | 聚合计数（总量 + 按上游统计） | 每次请求整份原子重写 |
| `data/metrics-log.jsonl` | 逐条请求明细，一行一条 JSON | append-only 追加 |

### `metrics.json` 结构

```jsonc
{
  "version": 1,
  "totals": {
    "requests": 0, "successful": 0, "failed": 0, "failovers": 0,
    "promptTokens": 0, "completionTokens": 0, "totalTokens": 0
  },
  "byUpstream": {
    "站点名": { "requests": 0, "successful": 0, "failed": 0,
                "promptTokens": 0, "completionTokens": 0, "totalTokens": 0 }
  }
}
```

- `byUpstream` 按上游**名称**分组；每次 `recordRequest` 会为 `attempts` 中的每个上游各计一笔，
  token 只记给最终成功响应的那个站。
- 文件损坏时启动不崩溃（回退为空指标）。

### `metrics-log.jsonl` 单条日志字段

```jsonc
{
  "id": "req_<hex>",          // x-request-id，客户端提供的合法值会被沿用
  "startedAt": "ISO 时间",
  "finishedAt": "ISO 时间",
  "protocol": "openai | anthropic | responses",
  "upstream": "最终上游名",
  "upstreamModel": "上游模型名",
  "status": 200,              // 最终 HTTP 状态码
  "durationMs": 1234,
  "stream": false,
  "success": true,
  "failover": false,          // attempts.length > 1
  "attempts": [{ "upstream": "...", "status": 503 }],  // 最多保留 12 条
  "usage": { "promptTokens": 0, "completionTokens": 0, "totalTokens": 0 },
  "error": "错误信息（仅失败时）"
}
```

日志只含脱敏元数据与 token 数字，**不含请求内容或密钥**。

管理页面可将最近 100 条记录或当前日志上限内的全部记录导出为 JSON。导出内容包含
聚合 totals、byUpstream 和 records 明细；`records` 按时间正序排列，便于归档或分析。

## 日志上限与压实

- **默认保留 5000 条**，环境变量 `LOCAL_MODEL_GATEWAY_MAX_LOGS` 可调，**下限 100**。
- 追加使文件行数超过 `MAX_LOGS × 2` 时，触发一次**压实**：把内存中最新的 `MAX_LOGS` 条
  原子重写回 JSONL（`.tmp` + `rename`），避免文件无限增长。
- 内存中始终只缓存最新 `MAX_LOGS` 条（新在前）；加载时读取文件尾部并反向。

## 分页接口

### `GET /api/admin/metrics/logs?limit=&offset=`

返回：

```jsonc
{
  "items":   [ /* 本页日志，新在前 */ ],
  "limit":   100,     // 默认 100，最大 500
  "offset":  0,       // 默认 0
  "total":   5000,    // 当前可查日志总数
  "hasMore": false,
  "maxLogs": 5000     // 上限，供前端展示
}
```

### `GET /api/admin/metrics?limit=&offset=`

返回聚合计数 + `logs`（一页明细）+ `logPage` 元信息（同上的 `limit/offset/total/hasMore/maxLogs`）。

### 前端「加载更多」

- 首次渲染用 `GET /api/admin/metrics?limit=100`（或 `logs` 为空时）。
- 「加载更多」按钮以 **当前已渲染行数** 作为 `offset`、`limit=100` 请求
  `GET /api/admin/metrics/logs`，追加渲染并更新「已显示 X / Y」计数与 `hasMore`。
- 页面显示 `maxLogs` 用于提示「日志最多保留 5000 条」之类的说明。

### `DELETE /api/admin/metrics`

清空聚合计数、内存日志，并把 JSONL 重写为空文件（`clearMetrics`）。

## 旧数据迁移

旧版本把日志以内联数组 `logs`（新在前）存在 `metrics.json` 里。新版启动时：

1. 若 `metrics.json` 含 `logs` 数组，将其 **反转为时间正序** 后追加写入 JSONL
   （截断到 `MAX_LOGS` 条）。
2. 写完后 `saveMetrics()` 落盘，从 `metrics.json` 中移除内联 `logs`（以后不再有该字段）。

迁移与压实已通过独立临时脚本验证；`model-groups.test.js` 中也有对分页接口存在性的断言。
（目前尚无专门的单测文件覆盖压实/迁移逻辑，见 [开发与测试](development.md)。）

## 相关配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `LOCAL_MODEL_GATEWAY_MAX_LOGS` | `5000` | JSONL 日志保留条数，最小 100 |
| `LOCAL_MODEL_GATEWAY_DATA_DIR` | 项目下 `data` | 数据目录（含 `metrics.json`、`metrics-log.jsonl`） |
