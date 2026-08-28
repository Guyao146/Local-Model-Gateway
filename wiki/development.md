# 开发与测试

## 运行测试

无第三方依赖，全部测试是纯 Node 脚本（`node:assert/strict`）。运行全部测试：

```powershell
cd local-model-gateway
npm.cmd test
# 等价于依次执行 test/ 下 10 个脚本
```

测试清单（`package.json` 的 `scripts.test`）：

| 文件 | 类型 | 覆盖 |
| --- | --- | --- |
| `test/protocol.test.js` | 单元 | OpenAI ↔ Anthropic、Responses 转换、endpoint 拼接 |
| `test/routing.test.js` | 单元 | 四种分流策略的排序与游标、权重分布 |
| `test/model-groups.test.js` | 单元 | 模型目录分组、勾选合并、轮询池勾选（`pool-provider`）、日志分页接口存在性 |
| `test/balance.test.js` | 单元 | NewAPI/Sub2API 余额解析、余额路径安全校验 |
| `test/client-identity.test.js` | 单元 | 客户端标识预设、自定义 UA 校验 |
| `test/admin-auth.test.js` | 单元 | 回环识别、转发头伪造防护、可信代理解析 |
| `test/auth.integration.test.js` | 集成 | 模拟 OIDC 服务：登录流程、PKCE/state/nonce、会话、登出 |
| `test/gateway.integration.test.js` | 集成 | 转发/备用/熔断/限流/并发/`x-request-id`/余额查询 |
| `test/stream.integration.test.js` | 集成 | 流式响应转换与 SSE 转发 |
| `test/model-selection.integration.test.js` | 集成 | 模型选择保存、`upstreamIds` 轮询池、固定站、旧备份合并迁移 |

集成测试模式：

- 用 `fs.mkdtempSync(os.tmpdir())` 创建临时数据目录，
  以 `spawn(process.execPath, ['src/server.js'])` 启动真实网关进程。
- 用内存 HTTP mock 服务模拟上游（OpenAI/Anthropic 两站）。
- 随机端口（如 `19000+`、`21000+`）避免冲突；`waitForOutput` 等待启动标记
  （如「本地管理访问：无需认证」）。

## 新功能在测试中的落点

- **轮询池勾选（前端）**：`model-groups.test.js` 断言 `app.js` 存在
  `data-action="pool-provider"`，并验证 `upstreamMode: auto` 时 `upstreamIds` 合并正确。
- **日志分页（后端）**：`model-groups.test.js` 断言 `app.js` 引用
  `/api/admin/metrics/logs`；分页/压实/迁移另用独立临时脚本验证过。
- **`upstreamIds` 落库与路由合成**：`model-selection.integration.test.js` 覆盖
  auto 模式保存、轮询请求在两站间分配、切到 fixed 后单站、旧备份同名选择合并为候选池。

## 代码约定

- CommonJS：`require` / `module.exports`，无 ESM。
- 纯函数尽量独立成模块（`protocol.js`、`routing.js`、`balance.js` 等），便于单测。
- 配置文件写入一律 `.tmp` + `rename` 原子替换，`0o600`（Windows 下 chmod 失败被忽略）。
- 前端：`app.js` 使用 `#id` 选择器辅助函数与 `data-action` 事件委托；字符串渲染 +
  `escapeHtml` 防注入；无框架。
- 错误消息使用中文，便于后台直接展示。
- 集成测试只在临时目录写文件，不污染项目 `data/`。

## 已知边界与改进建议

1. **轮询池「至少两站」保护仅在前端**：直接调 `PUT /api/admin/model-selections`
   提交 <2 个 `upstreamIds` 后端不校验。建议在 `saveModelSelections` 增加子集校验：
   过滤不存在/已停用站，长度 <2 时回退为全部站点。
2. **JSONL 压实与迁移无专项单测**：目前靠临时脚本验证，建议新增
   `test/metrics.test.js`，直接对 `metrics.js` 的 `recordRequest/getLogs/clearMetrics`
   以及迁移、压实做单元断言（可注入临时 `DATA_DIR`）。
3. **~~`.gitignore` 未包含 `data/metrics-log.jsonl`~~**：已修复，运行时日志不会被提交。
4. **模型选择器与手工路由冲突**：同名冲突会在保存时报错，但前端反馈路径可再打磨。
5. **日志只保留成功/失败的摘要**：不含请求体/响应体，若需排查内容级问题需另加审计日志。
6. **多用户权限**：Authentik 只做「能进后台即可管理」的粗粒度控制；细分权限待扩展。
7. **思考能力识别依赖字段名**：私有站点的能力字段可能需要持续适配。

## 变更记录（本次迭代）

- 轮询池子集：`public/app.js` 的 `renderModelRow` / `syncRenderedModelDraft`、
  `styles.css` 的 `.model-pool*`、`index.html` 文案；后端 `saveModelSelections` 原已支持
  `upstreamIds`，未改动。
- 滚动日志：`src/metrics.js`（append-only + 压实 + `getLogs`）、`src/server.js`
  （`GET /api/admin/metrics/logs` 与 metrics 分页参数）、`public/app.js`
  （`renderLogRow`/`updateLogSummary`/`loadMoreLogs`）、`public/index.html`
  （`requestLogSummary` + 加载更多按钮）、`public/styles.css`（`.log-more`）、
  `README.md` 两处说明、`test/model-groups.test.js` 两条断言。
