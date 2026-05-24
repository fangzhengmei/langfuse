# 用量计量链路分析：从事件采集到面板展示

## 一、链路总览

用量计量系统采用"**采集→存储→聚合→对账→展示**"五层架构，核心计量指标包括：
- **Traces**（追踪链路）
- **Observations**（观测事件，含 LLM 调用）
- **Scores**（评分数据）
- **Events**（总事件数 = Traces + Observations + Scores）

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  事件采集层      │────▶│  数据存储层      │────▶│  聚合计算层      │
│  (Ingestion)    │     │  (ClickHouse)   │     │  (Worker Jobs)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  面板展示层      │◀────│  对账服务层      │◀────│  外部系统       │
│  (React UI)     │     │  (tRPC/Stripe)  │     │  (Stripe API)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

---

## 二、第一层：事件采集与指标累积

### 2.1 采集入口

**文件**：`web/src/pages/api/public/ingestion.ts:50-173`

采集流程分为三个阶段：
1. **验证阶段**：API Key 鉴权、速率限制、请求格式校验
2. **异步处理**：S3 持久化 + Redis 队列入队
3. **同步处理**：降级时的即时处理

关键代码片段：
```typescript
// 90-93行：检查用量是否超限，超限直接拒绝
if (authCheck.scope.isIngestionSuspended) {
  throw new ForbiddenError(
    "Ingestion suspended: Usage threshold exceeded. Please upgrade your plan."
  );
}

// 133-137行：批处理核心入口
const result = await processEventBatch(
  parsedSchema.data.batch,
  authCheck,
);
```

### 2.2 事件批处理

**文件**：`packages/shared/src/server/ingestion/processEventBatch.ts:104-200`

核心处理逻辑：
1. **指标埋点**：`recordIncrement("langfuse.ingestion.event", input.length)` 记录事件数
2. **Schema 验证**：逐个事件类型校验
3. **权限校验**：按事件类型检查访问范围
4. **事件归类**：按 `eventBodyId` 分组优化存储
5. **队列投递**：写入 Redis  ingestion queue 供 Worker 消费

### 2.3 Token 计数（LLM 观测专属）

**文件**：`worker/src/features/tokenisation/usage.ts:31-174`

针对 LLM Generation 类型的 Observation，进行精细化 Token 计量：

```typescript
export function tokenCount(p: { model: Model; text: unknown }): number | undefined {
  // 43-50行：按模型类型选择分词器
  if (p.model.tokenizerId === "openai") {
    return openAiTokenCount({ model: p.model, text: p.text });
  } else if (p.model.tokenizerId === "claude") {
    return claudeTokenCount(p.text);
  }
}
```

**OpenAI Chat 模型特殊处理**（116-154行）：
- 按消息格式计算：`tokensPerMessage` + 内容 tokens + `tokensPerName`
- 消息数组解析：支持 ClickHouse 存储的字符串化 JSON
- 缓存优化：`cachedTokenizerByModel` 避免重复初始化分词器

---

## 三、第二层：数据存储与归类

### 3.1 ClickHouse 存储表结构

事件最终写入三张核心表，按时间分区：

| 表名 | 计量维度 | 时间字段 | 归类键 |
|------|----------|----------|--------|
| `traces` | Trace 计数 | `created_at`, `timestamp` | `project_id` |
| `observations` | Observation 计数 | `created_at`, `start_time` | `project_id` |
| `scores` | Score 计数 | `created_at` | `project_id` |

### 3.2 归类逻辑

所有计量查询都遵循相同的归类模式：
```sql
SELECT
  project_id,
  count(*) as count
FROM {table}
WHERE created_at >= {start} AND created_at < {end}
GROUP BY project_id
```

**关键归类键**：`project_id` 是所有计量聚合的核心维度，通过 `project→org` 映射最终汇总到组织维度。

---

## 四、第三层：聚合计算与指标累积

系统有**两条独立的聚合流水线**，服务于不同场景：

### 4.1 流水线 A：小时级云用量计量（Stripe 对账）

**文件**：`worker/src/ee/cloudUsageMetering/handleCloudUsageMeteringJob.ts:27-334`

**执行频率**：每小时（整点后5分钟开始）

**处理流程**：

1. **时间窗口确定**（97-98行）：
   ```typescript
   const meterIntervalStart = cron.lastRun;          // 上一个整点
   const meterIntervalEnd = new Date(cron.lastRun.getTime() + 3600000); // +1小时
   ```

2. **ClickHouse 批量查询**（137-149行）：
   ```typescript
   const observationCountsByProject = await getObservationCountsByProjectInCreationInterval({...});
   const traceCountsByProject = await getTraceCountsByProjectInCreationInterval({...});
   const scoreCountsByProject = await getScoreCountsByProjectInCreationInterval({...});
   ```

3. **组织级聚合**（188-220行）：
   ```typescript
   // 按项目过滤后累加
   const countObservations = observationCountsByProject
     .filter((p) => org.projectIds.includes(p.projectId))
     .reduce((sum, p) => sum + p.count, 0);
   
   // 总事件数 = Scores + Traces + Observations
   const countEvents = countScores + countTraces + countObservations;
   ```

4. **Stripe 上报**（197-239行）：
   ```typescript
   // 两种计量指标分别上报
   await stripe.billing.meterEvents.create({
     event_name: "tracing_observations",  // 旧版：仅 Observations
     ...
   });
   await stripe.billing.meterEvents.create({
     event_name: "tracing_events",        // 新版：总 Events
     ...
   });
   ```

5. **消费告警触发**（277-297行）：有活动且配置了告警的组织，触发 `CloudSpendAlertJob`。

### 4.2 流水线 B：天级免费额度阈值（Usage Threshold）

**文件**：`worker/src/ee/usageThresholds/usageAggregation.ts:191-390`

**执行频率**：每小时（但按天聚合，回溯最多31天）

**核心算法**（191-390行）：

1. **前置准备**：
   - 构建 `projectId → orgId` 映射（71-85行）
   - 计算各组织的计费周期起始日（201-219行）
   - 按计费周期起始日分组组织

2. **逐日回溯聚合**（241-387行）：
   ```
   从今天向前回溯 N 天（N = 上月天数）
     ├─ 查询当天所有项目的 traces/observations/scores 计数
     ├─ 聚合到组织维度
     ├─ 累加到组织的 running total
     └─ 处理计费周期起始日为当天的组织（执行阈值检查）
   ```

3. **累加逻辑**（297-306行）：
   ```typescript
   for (const [orgId, counts] of Object.entries(orgDailyCounts)) {
     const state = usageByOrgMap[orgId];
     state.traces += counts.traces;
     state.observations += counts.observations;
     state.scores += counts.scores;
     state.total += counts.total;
   }
   ```

### 4.3 阈值处理逻辑

**文件**：`worker/src/ee/usageThresholds/thresholdProcessing.ts:298-445`

**状态机**：
```
   usage < 50k          50k ≤ usage < 200k        usage ≥ 200k
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   NORMAL    │─────▶│   WARNING   │─────▶│   BLOCKED   │
└─────────────┘      └─────────────┘      └─────────────┘
```

**关键规则**：
- **幂等设计**：仅在状态转换时发送邮件（369行：`stateTransitioned`）
- **优先级**：BLOCK 邮件优先于 WARNING 邮件
- **付费组织跳过**：有 Stripe 订阅或手动 plan 的组织不执行阈值（304行）
- **缓存失效**：BLOCK 状态变化时触发 API Key 缓存失效（414-422行）

---

## 五、第四层：对账服务层

### 5.1 tRPC 路由层

**文件**：`web/src/ee/features/billing/server/cloudBillingRouter.ts:16-396`

核心接口：

| 接口 | 用途 | 客户端 |
|------|------|--------|
| `getSubscriptionInfo` | 获取订阅信息（取消状态、计划变更、计费周期） | `useBillingInformation` |
| `getUsage` | 获取当前周期用量 | `BillingUsageChart` |
| `getInvoices` | 获取发票列表（含预览） | `BillingInvoiceTable` |
| `createStripeCheckoutSession` | 创建结账会话 | 升级按钮 |
| `changeStripeSubscriptionProduct` | 变更订阅计划 | 计划切换 |

### 5.2 Stripe Billing Service

**文件**：`web/src/ee/features/billing/server/stripeBillingService.ts:67-2080`

#### 5.2.1 用量查询（`getUsage` 方法，1778-1909行）

**双源数据策略**：

```
付费用户 → 优先从 Stripe 获取（主数据）
  ├─ 1. 查订阅的 metered usage item
  ├─ 2. 创建 invoice preview 获取累计用量
  ├─ 3. 查 meter 获取显示名称
  └─ 出错时降级到 ClickHouse 缓存

免费用户 → 从组织表缓存获取
  └─ cloudCurrentCycleUsage 字段（由 usageAggregation job 更新）
```

关键代码：
```typescript
// 1836-1846行：从 invoice preview 提取用量
const usageInvoiceLines = previewInvoice.lines.data.filter(
  (line: any) => line.pricing?.price_details?.price === usageItem.price.id
);
const totalUsage = usageInvoiceLines.reduce((acc, line) => {
  if (line.quantity) return acc + line.quantity;
  return acc;
}, 0);
```

#### 5.2.2 发票查询（`getInvoices` 方法，1547-1768行）

**发票明细拆解**（1637-1680行）：
```
invoice total
  ├─ subscriptionCents  订阅基础费（非 metered 项）
  ├─ usageCents         用量费用（metered 项的 unit_amount × quantity）
  ├─ discountCents      折扣
  ├─ taxCents           税费
  └─ totalCents         总计
```

**预览发票**：首页自动插入当前周期的预估发票（1720-1732行）

### 5.3 计费周期计算

**文件**：`packages/shared/src/server/utils/billingCycleHelpers.ts:56-161`

**计费周期锚点**：
- 优先使用 `org.cloudBillingCycleAnchor`
- 降级到 `org.createdAt`
- 统一归一化到 UTC 00:00

**边界处理**（56-91行）：
- 月末日期调整：31日锚点在2月自动调整为28/29日
- 向前回溯：如果当月锚点日 > 参考日，使用上月锚点

---

## 六、第五层：对账界面渲染与数据协同

### 6.1 页面结构

**文件**：`web/src/ee/features/billing/components/BillingSettings.tsx:19-71`

```
BillingSettings
  ├─ BillingScheduleNotification    计划变更预告
  ├─ Header "Usage & Billing"
  ├─ BillingUsageChart              用量卡片（核心计量展示）
  ├─ BillingPlanPeriodView          计费周期视图
  ├─ BillingDiscountView            折扣信息
  ├─ BillingActionButtons           操作按钮（升级/取消/客服）
  ├─ BillingInvoiceTable            发票历史
  └─ SpendAlertsSection             消费告警（付费用户）
```

### 6.2 用量卡片渲染

**文件**：`web/src/ee/features/billing/components/BillingUsageChart.tsx:10-93`

**数据流**：
```
BillingUsageChart
  └─ api.cloudBilling.getUsage.useQuery(orgId)
       ├─ usageCount   → 大字体数字展示
       ├─ usageType    → 显示名称（Events/Observations/Units）
       └─ billingPeriod → 文案中的计费周期
```

**免费计划进度条**（54-83行）：
```typescript
const usagePercent = (usage.data.usageCount / hobbyPlanLimit) * 100;
// 进度条宽度 = min(usagePercent, 100)%
```

### 6.3 发票列表渲染

**文件**：`web/src/ee/features/billing/components/BillingInvoiceTable.tsx:31-306`

**分页机制**（使用 Stripe cursor 分页）：
- 虚拟总数：初始 9999，拉到最后一页时锁定真实总数
- 游标传递：`startingAfter` / `endingBefore`
- 预览行特殊处理：ID 为 `preview` 的行不计入分页游标

### 6.4 数据协同 Hook

**文件**：`web/src/ee/features/billing/components/useBillingInformation.tsx:36-110`

统一封装订阅信息查询，供多个组件复用：
```typescript
// 单次查询，多处使用
const { data: subscriptionInfo } = api.cloudBilling.getSubscriptionInfo.useQuery(
  { orgId: organization?.id ?? "" },
  { enabled: Boolean(organization?.id) }
);

// 派生数据：取消状态、计划变更、支付方式有效性等
```

---

## 七、关键协同关系

### 7.1 数据一致性保障

| 场景 | 主数据源 | 备数据源 | 降级触发条件 |
|------|----------|----------|-------------|
| 付费用户用量 | Stripe Invoice Preview | `org.cloudCurrentCycleUsage` | Stripe API 调用失败 |
| 免费用户用量 | `org.cloudCurrentCycleUsage` | ClickHouse 实时查询 | 缓存过期 |
| 订阅状态 | Stripe API | `org.cloudConfig` | Stripe API 不可用 |

### 7.2 时间轴协同

```
事件产生 → ClickHouse 写入 → 小时级计量（+5min）→ Stripe 接收
                                                       ↓
UI 查询 → tRPC getUsage → Stripe Invoice Preview → 用量展示

事件产生 → ClickHouse 写入 → 天级聚合 → org.cloudCurrentCycleUsage → UI 降级展示
```

**延迟说明**：
- 事件采集到可查询：秒级（ClickHouse 近实时）
- 小时级计量到 Stripe：整点 + 5分钟 + 处理时间
- Stripe 用量更新到 UI：~60分钟（Stripe meter 聚合周期）
- 免费额度缓存更新：每小时（usageAggregation job）

### 7.3 指标口径对齐

| 模块 | Traces | Observations | Scores | Events |
|------|--------|--------------|--------|--------|
| Ingestion 埋点 | ✓ | ✓ | ✓ | - |
| ClickHouse 表 | `traces` | `observations` | `scores` | 计算字段 |
| Cloud Metering | ✓ | ✓ | ✓ | `T+O+S` |
| Usage Aggregation | ✓ | ✓ | ✓ | `T+O+S` |
| Stripe Meter | - | `tracing_observations` | - | `tracing_events` |
| UI 展示 | - | - | - | 主指标 |

---

## 八、核心文件索引

| 层级 | 文件路径 | 关键函数 |
|------|----------|----------|
| 采集 | `web/src/pages/api/public/ingestion.ts` | `handler` |
| 采集 | `packages/shared/src/server/ingestion/processEventBatch.ts` | `processEventBatch` |
| Token | `worker/src/features/tokenisation/usage.ts` | `tokenCount`, `openAiChatTokenCount` |
| 聚合A | `worker/src/ee/cloudUsageMetering/handleCloudUsageMeteringJob.ts` | `handleCloudUsageMeteringJob` |
| 聚合B | `worker/src/ee/usageThresholds/usageAggregation.ts` | `processUsageAggregationForAllOrgs` |
| 阈值 | `worker/src/ee/usageThresholds/thresholdProcessing.ts` | `processThresholds` |
| 查询 | `packages/shared/src/server/repositories/traces.ts` | `getTraceCountsByProject*` |
| 查询 | `packages/shared/src/server/repositories/observations.ts` | `getObservationCountsByProject*` |
| 查询 | `packages/shared/src/server/repositories/scores.ts` | `getScoreCountsByProject*` |
| 对账 | `web/src/ee/features/billing/server/stripeBillingService.ts` | `getUsage`, `getInvoices` |
| 路由 | `web/src/ee/features/billing/server/cloudBillingRouter.ts` | `cloudBillingRouter` |
| UI | `web/src/ee/features/billing/components/BillingUsageChart.tsx` | `BillingUsageChart` |
| UI | `web/src/ee/features/billing/components/BillingInvoiceTable.tsx` | `BillingInvoiceTable` |
| UI | `web/src/ee/features/billing/components/useBillingInformation.tsx` | `useBillingInformation` |
| 工具 | `packages/shared/src/server/utils/billingCycleHelpers.ts` | `getBillingCycleStart`, `getBillingCycleEnd` |
