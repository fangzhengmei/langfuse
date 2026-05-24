# 用量计量链路分析：从事件采集到面板展示

> **文档状态**：所有结论均标注证据等级。✅ 已证实事实（有直接代码依据） | ⚠️ 待验证假设（合理推断但无直接代码证据）

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
          │                       │                        │
          ▼                       ▼                        ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ isIngestionSuspend │   │ 双时间口径     │     │  两阈值状态机   │
│  拦截链路        │     │ (created_at vs │     │ (告警/封禁)     │
└─────────────────┘     │  start_time)    │     └─────────────────┘
                        └─────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │ 对账展示差异     │
                        └─────────────────┘
```

---

## 二、第一层：事件采集与指标累积

### 2.1 采集入口与 isIngestionSuspended 拦截链路

✅ **已证实**：拦截链路完整传递关系

```
阈值状态变化 → DB 更新 → 缓存失效 → 重新鉴权 → 采集拦截
      │            │          │          │          │
      ▼            ▼          ▼          ▼          ▼
cloudFreeTierUsage  isIngestion  invalidate  ApiAuthService  各 ingesting
ThresholdState  ──▶ Suspended ──▶ Cached ──▶ verifyAuth ──▶ 入口检查
("BLOCKED")     ◀──  (true)   ◀──  OrgKeys ◀── HeaderAnd  ◀── 403拒绝
                                         ◀── ReturnScope
```

#### 2.1.1 采集入口拦截（最外层）

✅ **已证实**：5个采集入口均检查 `isIngestionSuspended`

**代码依据**：
- `web/src/pages/api/public/ingestion.ts:88-94`
- `web/src/pages/api/public/scores/index.ts:27`
- `web/src/pages/api/public/otel/v1/traces/index.ts:40`
- `web/src/pages/api/public/media/index.ts:30`
- `web/src/pages/api/public/mcp/index.ts:100`

```typescript
// ingestion.ts:88-94
if (authCheck.scope.isIngestionSuspended) {
  throw new ForbiddenError(
    "Ingestion suspended: Usage threshold exceeded. Please upgrade your plan."
  );
}
```

#### 2.1.2 鉴权层：isIngestionSuspended 注入

✅ **已证实**：两条路径注入 `isIngestionSuspended`

**代码依据**：`web/src/features/public-api/server/apiAuth.ts:188-201, 483-490`

**路径 A：Redis 缓存命中（常用）**
```typescript
// apiAuth.ts:199 - 直接从缓存的 API Key 读取
return {
  validKey: true,
  scope: {
    ...
    isIngestionSuspended: finalApiKey.isIngestionSuspended,
  },
};
```

**路径 B：缓存未命中，从 DB 重建**
```typescript
// apiAuth.ts:489 - 从组织状态派生
isIngestionSuspended: cloudFreeTierUsageThresholdState === "BLOCKED",
```

✅ **已证实**：`isIngestionSuspended` 是 API Key 缓存字段

**代码依据**：`packages/shared/src/server/auth/types.ts:19, 70`
```typescript
// 缓存 Schema 定义
isIngestionSuspended: z.boolean().nullish(),
```

#### 2.1.3 缓存失效触发

✅ **已证实**：BLOCK 状态变化时触发全组织 API Key 缓存失效

**代码依据**：
- `worker/src/ee/usageThresholds/bulkUpdates.ts:84-102`
- `worker/src/ee/usageThresholds/thresholdProcessing.ts:413-422`

```typescript
// bulkUpdates.ts:84-102
const orgsNeedingCacheInvalidation = chunk.filter(
  (u) => u.shouldInvalidateCache,
);
for (const update of orgsNeedingCacheInvalidation) {
  await invalidateCachedOrgApiKeys(update.orgId);
}
```

✅ **已证实**：缓存失效的精确条件

**代码依据**：`thresholdProcessing.ts:304-319, 413-422`
```typescript
// 条件1：付费组织之前被 BLOCKED，现在转为付费（需解除封禁）
shouldInvalidateCache: org.cloudFreeTierUsageThresholdState === "BLOCKED"

// 条件2：BLOCKED 状态发生切换
const blockingStateChanged =
  (previousState === "BLOCKED" && currentState !== "BLOCKED") ||
  (previousState !== "BLOCKED" && currentState === "BLOCKED");
```

### 2.2 事件批处理

✅ **已证实**：事件批处理的5个核心步骤

**代码依据**：`packages/shared/src/server/ingestion/processEventBatch.ts:104-200`

核心处理逻辑：
1. **指标埋点**：`recordIncrement("langfuse.ingestion.event", input.length)` 记录事件数
2. **Schema 验证**：逐个事件类型校验
3. **权限校验**：按事件类型检查访问范围
4. **事件归类**：按 `eventBodyId` 分组优化存储
5. **队列投递**：写入 Redis ingestion queue 供 Worker 消费

### 2.3 Token 计数（LLM 观测专属）

✅ **已证实**：按模型类型选择分词器

**代码依据**：`worker/src/features/tokenisation/usage.ts:31-174`

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

✅ **已证实**：OpenAI Chat 模型特殊处理逻辑

**代码依据**：`worker/src/features/tokenisation/usage.ts:116-154`
- 按消息格式计算：`tokensPerMessage` + 内容 tokens + `tokensPerName`
- 消息数组解析：支持 ClickHouse 存储的字符串化 JSON
- 缓存优化：`cachedTokenizerByModel` 避免重复初始化分词器

---

## 三、第二层：数据存储与归类

### 3.1 ClickHouse 存储表结构与双时间口径

✅ **已证实**：三张核心表均有两套时间字段

**代码依据**：
- `packages/shared/src/server/repositories/traces.ts:1633-1636`
- `packages/shared/src/server/repositories/observations.ts:2027-2030`
- `packages/shared/src/server/repositories/scores.ts:2295-2298`

| 表名 | 业务时间字段 | 入库时间字段 |
|------|-------------|-------------|
| `traces` | `timestamp`（业务发生时间） | `created_at`（入库时间） |
| `observations` | `start_time`（观测开始时间） | `created_at`（入库时间） |
| `scores` | `timestamp`（评分时间） | `created_at`（入库时间） |

### 3.2 归类逻辑

✅ **已证实**：所有计量查询以 `project_id` 为核心归类键

**代码依据**：
- `traces.ts:421-428`
- `observations.ts:1710-1718`
- `scores.ts:2292-2301`

```sql
SELECT
  project_id,
  count(*) as count
FROM {table}
WHERE {time_field} >= {start} AND {time_field} < {end}
GROUP BY project_id
```

---

## 四、第三层：聚合计算与指标累积

✅ **已证实**：两条独立聚合流水线使用不同时间口径

### 4.1 流水线 A：小时级云用量计量（Stripe 对账）

✅ **已证实**：调度配置 - 每小时第5分钟执行

**代码依据**：`packages/shared/src/server/redis/cloudUsageMeteringQueue.ts:49-61`
```typescript
// 5 * * * * = 每小时第5分钟（1:05, 2:05, 3:05...）
repeat: { pattern: "5 * * * *" },
```

✅ **已证实**：时间口径 - 使用 `created_at`（入库时间）

**代码依据**：
- `observations.ts:1715-1716`
- `traces.ts:426-427`
- `handleCloudUsageMeteringJob.ts:137-149`

```sql
-- getObservationCountsByProjectInCreationInterval
WHERE created_at >= {start: DateTime64(3)}
AND created_at < {end: DateTime64(3)}
```

✅ **已证实**：处理流程

**代码依据**：`worker/src/ee/cloudUsageMetering/handleCloudUsageMeteringJob.ts:97-272`

1. **时间窗口确定**（97-98行）：
   ```typescript
   const meterIntervalStart = cron.lastRun;          // 上一个整点
   const meterIntervalEnd = new Date(cron.lastRun.getTime() + 3600000); // +1小时
   ```

2. **组织级聚合**（188-220行）：
   ```typescript
   // 按项目过滤后累加
   const countObservations = observationCountsByProject
     .filter((p) => org.projectIds.includes(p.projectId))
     .reduce((sum, p) => sum + p.count, 0);
   
   // 总事件数 = Scores + Traces + Observations
   const countEvents = countScores + countTraces + countObservations;
   ```

3. **Stripe 上报**（197-239行）：
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

### 4.2 流水线 B：天级免费额度阈值（Usage Threshold）

✅ **已证实**：调度配置 - 每小时第35分钟执行（比 Stripe 对账晚30分钟）

**代码依据**：`packages/shared/src/server/redis/cloudFreeTierUsageThresholdQueue.ts:50-67`
```typescript
// 35 * * * * = 每小时第35分钟（1:35, 2:35, 3:35...）
repeat: { pattern: "35 * * * *" },
```

✅ **已证实**：时间口径 - 使用业务时间（`start_time` / `timestamp`）

**代码依据**：
- `traces.ts:1629-1636`
- `observations.ts:2023-2030`
- `scores.ts:2292-2298`

```sql
-- 免费额度查询使用业务时间字段
-- traces: WHERE timestamp >= ... AND timestamp < ...
-- observations: WHERE start_time >= ... AND start_time < ...
-- scores: WHERE timestamp >= ... AND timestamp < ...
```

✅ **已证实**：4倍缓冲设计的代码注释

**代码依据**（三处相同注释）：
- `traces.ts:1617-1619`
- `observations.ts:2012-2014`
- `scores.ts:2279-2281`

```
Note: Skips using FINAL (double counting risk) for faster and cheaper
queries against clickhouse. Generous 4x overcompensation before blocking allows
for usage aggregation to be meaningful.
```

✅ **已证实**：免费额度阈值常量与 4x 缓冲的数值对应关系

**代码依据**：`worker/src/ee/usageThresholds/constants.ts:9-26`
```typescript
export const MAX_EVENTS_FREE_PLAN = 50_000;                 // 免费计划额度

export const NOTIFICATION_THRESHOLDS = [
  MAX_EVENTS_FREE_PLAN,      // 50,000  - 告警线 1（达到免费额度）
  MAX_EVENTS_FREE_PLAN * 2,  // 100,000 - 告警线 2（2倍额度）
  MAX_EVENTS_FREE_PLAN * 4,  // 200,000 - 告警线 3（4倍额度）
] as const;

export const BLOCKING_THRESHOLD = MAX_EVENTS_FREE_PLAN * 5; // 250,000 - 封禁线（5倍额度）
```

> **数值对应关系**：免费额度 50k × 5 = 250k 封禁线，其中 50k-250k 之间为 200k 缓冲空间（4 倍免费额度），与代码注释中的 "4x overcompensation" 完全对应。

✅ **已证实**：逐日回溯聚合逻辑

**代码依据**：`worker/src/ee/usageThresholds/usageAggregation.ts:241-387`

```
从今天向前回溯 N 天（N = 上月天数）
  ├─ 查询当天所有项目的 traces/observations/scores 计数（业务时间口径）
  ├─ 聚合到组织维度
  ├─ 累加到组织的 running total
  └─ 处理计费周期起始日为当天的组织（执行阈值检查）
```

### 4.3 阈值处理逻辑：准确数值与状态变化

✅ **已证实**：准确的阈值数值与状态机

**代码依据**：
- `worker/src/ee/usageThresholds/constants.ts:9-26`
- `worker/src/ee/usageThresholds/thresholdProcessing.ts:351-362`

```
   usage < 50k        50k ≤ usage < 250k       usage ≥ 250k
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   NORMAL    │─────▶│   WARNING   │─────▶│   BLOCKED   │
│ (state=null)│      │(state="WARNING")│  │(state="BLOCKED")│
└─────────────┘      └─────────────┘      └─────────────┘
       │                    │                    │
       ▼                    ▼                    ▼
  无动作               发送告警邮件         发送封禁邮件 +
  采集正常             采集正常              API Key 缓存失效
                                              isIngestionSuspended=true
                                              采集拦截
```

✅ **已证实**：状态判断逻辑

**代码依据**：`thresholdProcessing.ts:351-362`
```typescript
let currentState: string | null = null;

if (cumulativeUsage >= BLOCKING_THRESHOLD) {        // >= 250,000
  currentState = "BLOCKED";
} else if (cumulativeUsage >= NOTIFICATION_THRESHOLDS[0]) {  // >= 50,000
  currentState = "WARNING";
} else {
  currentState = null;  // NORMAL
}
```

✅ **已证实**：仅在状态转换时发送邮件（幂等设计）

**代码依据**：`thresholdProcessing.ts:368-374, 390`
```typescript
const stateTransitioned = previousState !== currentState;

if (stateTransitioned && currentState === "BLOCKED") {
  // 发送封禁邮件
} else if (stateTransitioned && currentState === "WARNING") {
  // 发送告警邮件（取最高已达到的阈值）
  const highestCrossedThreshold = Math.max(
    ...NOTIFICATION_THRESHOLDS.filter((t) => cumulativeUsage >= t),
  );
}
```

✅ **已证实**：付费组织跳过阈值检查

**代码依据**：`thresholdProcessing.ts:302-304`
```typescript
// Skip notifications if org is on a paid plan
if (org.cloudConfig?.stripe?.activeSubscriptionId || org.cloudConfig?.plan) {
  // 直接返回 PAID_PLAN，不执行阈值检查
}
```

✅ **已证实**：功能开关可禁用阈值强制执行

**代码依据**：`thresholdProcessing.ts:330-331`
```typescript
if (env.LANGFUSE_FREE_TIER_USAGE_THRESHOLD_ENFORCEMENT_ENABLED !== "true") {
  // 仅追踪用量，不设置状态
}
```

---

## 五、第四层：对账服务层

### 5.1 tRPC 路由层

✅ **已证实**：5个核心计费接口

**代码依据**：`web/src/ee/features/billing/server/cloudBillingRouter.ts:16-396`

| 接口 | 用途 | 客户端 |
|------|------|--------|
| `getSubscriptionInfo` | 获取订阅信息 | `useBillingInformation` |
| `getUsage` | 获取当前周期用量 | `BillingUsageChart` |
| `getInvoices` | 获取发票列表 | `BillingInvoiceTable` |
| `createStripeCheckoutSession` | 创建结账会话 | 升级按钮 |
| `changeStripeSubscriptionProduct` | 变更订阅计划 | 计划切换 |

### 5.2 Stripe Billing Service

#### 5.2.1 用量查询（`getUsage` 方法）

✅ **已证实**：双源数据策略

**代码依据**：`web/src/ee/features/billing/server/stripeBillingService.ts:1778-1909`

```
付费用户 → 优先从 Stripe 获取（主数据）
  ├─ 1. 查订阅的 metered usage item
  ├─ 2. 创建 invoice preview 获取累计用量
  ├─ 3. 查 meter 获取显示名称
  └─ 出错时降级到 org.cloudCurrentCycleUsage（免费额度聚合结果）

免费用户 → 从组织表缓存获取
  └─ cloudCurrentCycleUsage 字段（由 usageAggregation job 更新，业务时间口径）
```

✅ **已证实**：从 invoice preview 提取用量的逻辑

**代码依据**：`stripeBillingService.ts:1836-1846`
```typescript
const usageInvoiceLines = previewInvoice.lines.data.filter(
  (line: any) => line.pricing?.price_details?.price === usageItem.price.id
);
const totalUsage = usageInvoiceLines.reduce((acc, line) => {
  if (line.quantity) return acc + line.quantity;
  return acc;
}, 0);
```

#### 5.2.2 发票查询（`getInvoices` 方法）

✅ **已证实**：发票明细拆解

**代码依据**：`stripeBillingService.ts:1637-1680`
```
invoice total
  ├─ subscriptionCents  订阅基础费（非 metered 项）
  ├─ usageCents         用量费用（metered 项的 unit_amount × quantity）
  ├─ discountCents      折扣
  ├─ taxCents           税费
  └─ totalCents         总计
```

✅ **已证实**：自动插入预览发票

**代码依据**：`stripeBillingService.ts:1720-1732`
- 首页自动插入当前周期的预估发票

### 5.3 计费周期计算

✅ **已证实**：计费周期锚点优先级

**代码依据**：`packages/shared/src/server/utils/billingCycleHelpers.ts:56-161`
- 优先使用 `org.cloudBillingCycleAnchor`
- 降级到 `org.createdAt`
- 统一归一化到 UTC 00:00

✅ **已证实**：月末日期调整逻辑

**代码依据**：`billingCycleHelpers.ts:56-91`
- 31日锚点在2月自动调整为28/29日
- 如果当月锚点日 > 参考日，使用上月锚点

---

## 六、第五层：对账界面渲染与数据协同

### 6.1 页面结构

✅ **已证实**：BillingSettings 组件结构

**代码依据**：`web/src/ee/features/billing/components/BillingSettings.tsx:19-71`

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

✅ **已证实**：数据流

**代码依据**：`web/src/ee/features/billing/components/BillingUsageChart.tsx:10-93`

```
BillingUsageChart
  └─ api.cloudBilling.getUsage.useQuery(orgId)
       ├─ usageCount   → 大字体数字展示
       ├─ usageType    → 显示名称（Events/Observations/Units）
       └─ billingPeriod → 文案中的计费周期
```

✅ **已证实**：免费计划进度条逻辑

**代码依据**：`BillingUsageChart.tsx:28-83`
```typescript
// 28行：从常量读取免费计划额度
const hobbyPlanLimit =
  organization?.cloudConfig?.monthlyObservationLimit ?? MAX_EVENTS_FREE_PLAN;
// MAX_EVENTS_FREE_PLAN = 50,000（web/src/ee/features/billing/constants.ts:1）

const usagePercent = (usage.data.usageCount / hobbyPlanLimit) * 100;
// 进度条宽度 = min(usagePercent, 100)%
```

⚠️ **待验证假设**：付费用户与免费用户看到的用量数字可能存在差异
- 付费用户：Stripe Invoice Preview 数据（created_at 口径，入库时间）
- 免费用户：`cloudCurrentCycleUsage`（start_time/timestamp 口径，业务时间）
- **没有代码证据**证明具体差异比例（删除原文档中 10%-40% 的推断）

### 6.3 发票列表渲染

✅ **已证实**：Stripe cursor 分页机制

**代码依据**：`web/src/ee/features/billing/components/BillingInvoiceTable.tsx:31-306`
- 虚拟总数：初始 9999，拉到最后一页时锁定真实总数
- 游标传递：`startingAfter` / `endingBefore`
- 预览行特殊处理：ID 为 `preview` 的行不计入分页游标

### 6.4 数据协同 Hook

✅ **已证实**：`useBillingInformation` 统一封装

**代码依据**：`web/src/ee/features/billing/components/useBillingInformation.tsx:36-110`
```typescript
const { data: subscriptionInfo } = api.cloudBilling.getSubscriptionInfo.useQuery(
  { orgId: organization?.id ?? "" },
  { enabled: Boolean(organization?.id) }
);
```

---

## 七、关键协同关系

### 7.1 数据一致性保障

✅ **已证实**：双数据源策略

**代码依据**：`stripeBillingService.ts:1778-1909`

| 场景 | 主数据源 | 备数据源 | 时间口径 | 降级触发条件 |
|------|----------|----------|----------|-------------|
| 付费用户用量 | Stripe Invoice Preview | `org.cloudCurrentCycleUsage` | created_at → 降级为业务时间 | Stripe API 调用失败 |
| 免费用户用量 | `org.cloudCurrentCycleUsage` | ClickHouse 实时查询 | 业务时间 | 缓存过期 |
| 订阅状态 | Stripe API | `org.cloudConfig` | - | Stripe API 不可用 |

### 7.2 双时间口径差异

✅ **已证实**：两条流水线使用不同时间字段

**代码依据**：
- Stripe 对账：`traces.ts:426-427`, `observations.ts:1715-1716`（created_at）
- 免费额度：`traces.ts:1633-1636`, `observations.ts:2027-2030`, `scores.ts:2295-2298`（业务时间）

| 场景 | created_at（入库时间） | start_time/timestamp（业务时间） | 差异来源 |
|------|------------------------|----------------------------------|----------|
| 延迟上报 | 统计到上报当天 | 统计到事件发生当天 | 跨天/跨周期上报 |
| 离线数据导入 | 统计到导入时间 | 统计到原始业务时间 | 历史数据回溯 |
| OTel 异步上传 | 统计到接收时间 | 统计到埋点时间 | 客户端缓存延迟 |
| 重试事件 | 统计到最后一次成功时间 | 统计到原始事件时间 | 网络重试 |

⚠️ **待验证假设**：跨周期上报事件会导致对账差异
- **假设原因**：无实际数据或测试用例证实
- **推断逻辑**：5月31日产生的事件6月1日才上报：Stripe 对账（`created_at`）计入6月，免费额度（`start_time`/`timestamp`）计入5月，两套口径归属不同计费周期
- **验证方法**：构造 5月31日事件6月1日上报的测试用例，对比两套口径的统计结果

### 7.3 时间轴协同

✅ **已证实**：作业调度时间

**代码依据**：
- `cloudUsageMeteringQueue.ts:50`：每小时第5分钟（Stripe 对账）
- `cloudFreeTierUsageThresholdQueue.ts:54`：每小时第35分钟（免费额度）

```
事件产生 → ClickHouse 写入 → 小时级计量（+5min, created_at）→ Stripe 接收
                                                           ↓
UI 查询 → tRPC getUsage → Stripe Invoice Preview → 用量展示（付费）

事件产生 → ClickHouse 写入 → 天级聚合（+35min, start_time）→ org.cloudCurrentCycleUsage → UI 展示（免费）
```

⚠️ **待验证假设**：Stripe meter 聚合存在延迟
- **假设原因**：代码库中无任何关于 Stripe meter 聚合周期的注释或常量定义
- **推断逻辑**：`getUsage` 方法通过 `invoice.preview` 实时计算用量（`stripeBillingService.ts:212-218`），不依赖 Stripe 后台聚合
- **验证方法**：查阅 Stripe 官方文档或实测 meter 事件上报到 invoice preview 可见的延迟

### 7.4 指标口径对齐

✅ **已证实**：各模块指标口径

**代码依据**：综合所有查询函数和常量定义

| 模块 | Traces | Observations | Scores | Events | 时间口径 |
|------|--------|--------------|--------|--------|----------|
| Ingestion 埋点 | ✓ | ✓ | ✓ | - | - |
| ClickHouse 表 | `traces` | `observations` | `scores` | 计算字段 | - |
| Cloud Metering (Stripe) | ✓ | ✓ | ✓ | `T+O+S` | created_at |
| Usage Aggregation (免费) | ✓ | ✓ | ✓ | `T+O+S` | start_time/timestamp |
| Stripe Meter | - | `tracing_observations` | - | `tracing_events` | Stripe 接收时间 |
| UI 展示（付费） | - | - | - | 主指标 | Stripe 口径 |
| UI 展示（免费） | - | - | - | 主指标 | 业务时间口径 |

---

## 八、已证实事实 vs 待验证假设汇总

### ✅ 已证实事实（27项，均有直接代码依据）

| 类别 | 事实 | 精确代码依据 |
|------|------|-------------|
| **阈值常量** | 免费额度 = 50,000 events | `worker/src/ee/usageThresholds/constants.ts:9` |
| **阈值常量** | 告警线 = [50k, 100k, 200k] | `worker/src/ee/usageThresholds/constants.ts:16-19` |
| **阈值常量** | 封禁线 = 250,000 events（5倍免费额度） | `worker/src/ee/usageThresholds/constants.ts:26` |
| **阈值常量** | 4x 缓冲设计注释（FINAL 跳过重计风险） | `packages/shared/src/server/repositories/traces.ts:1617-1619`、`observations.ts:2012-2014`、`scores.ts:2279-2281` |
| **状态机** | NORMAL: usage < 50k (state=null) | `worker/src/ee/usageThresholds/thresholdProcessing.ts:361` |
| **状态机** | WARNING: 50k ≤ usage < 250k | `worker/src/ee/usageThresholds/thresholdProcessing.ts:357-359` |
| **状态机** | BLOCKED: usage ≥ 250k | `worker/src/ee/usageThresholds/thresholdProcessing.ts:355-356` |
| **状态机** | 仅在状态转换时发送邮件（幂等设计） | `worker/src/ee/usageThresholds/thresholdProcessing.ts:369` |
| **状态机** | 付费组织跳过阈值检查 | `worker/src/ee/usageThresholds/thresholdProcessing.ts:304` |
| **状态机** | 功能开关可禁用强制执行 | `worker/src/ee/usageThresholds/thresholdProcessing.ts:330-331` |
| **拦截链路** | 5个采集入口检查 isIngestionSuspended | `web/src/pages/api/public/ingestion.ts:88-94`、`scores/index.ts:27`、`otel/v1/traces/index.ts:40`、`media/index.ts:30`、`mcp/index.ts:100` |
| **拦截链路** | 缓存命中时从 API Key 读取 isIngestionSuspended | `web/src/features/public-api/server/apiAuth.ts:199` |
| **拦截链路** | 缓存未命中时从组织状态派生 | `web/src/features/public-api/server/apiAuth.ts:489` |
| **拦截链路** | BLOCK 状态变化时触发缓存失效 | `worker/src/ee/usageThresholds/bulkUpdates.ts:84-102` |
| **拦截链路** | isIngestionSuspended 是缓存字段 | `packages/shared/src/server/auth/types.ts:19,70` |
| **双时间口径** | traces 表有 timestamp 和 created_at | `packages/shared/src/server/repositories/traces.ts:1633-1636` |
| **双时间口径** | observations 表有 start_time 和 created_at | `packages/shared/src/server/repositories/observations.ts:2027-2030` |
| **双时间口径** | scores 表有 timestamp 和 created_at | `packages/shared/src/server/repositories/scores.ts:2295-2298` |
| **双时间口径** | Stripe 对账使用 created_at | `packages/shared/src/server/repositories/observations.ts:1715-1716` |
| **双时间口径** | 免费额度使用 start_time/timestamp | `packages/shared/src/server/repositories/observations.ts:2027-2030` |
| **调度** | Stripe 对账每小时第5分钟执行 | `packages/shared/src/server/redis/cloudUsageMeteringQueue.ts:60` |
| **调度** | 免费额度每小时第35分钟执行 | `packages/shared/src/server/redis/cloudFreeTierUsageThresholdQueue.ts:65` |
| **调度** | 免费额度在 Stripe 对账后30分钟执行 | `"5 * * * *"` vs `"35 * * * *"` cron 表达式对比 |
| **对账** | 付费用户优先从 Stripe 获取用量 | `web/src/ee/features/billing/server/stripeBillingService.ts:1778-1909` |
| **对账** | 免费用户从组织缓存获取用量 | `web/src/ee/features/billing/server/stripeBillingService.ts:1901-1908` |
| **对账** | Stripe 失败时降级到缓存 | `web/src/ee/features/billing/server/stripeBillingService.ts:1890-1899` |
| **UI** | 免费进度条使用 MAX_EVENTS_FREE_PLAN | `web/src/ee/features/billing/components/BillingUsageChart.tsx:28` |

### ⚠️ 待验证假设（3项，合理推断但无直接代码证据）

| 假设 | 假设原因 | 推断逻辑 | 验证方法 |
|------|----------|----------|----------|
| 付费与免费用户看到的用量数字存在差异 | 无代码直接证明差异存在 | 付费用户从 Stripe 获取（`created_at` 口径，`stripeBillingService.ts:1836-1846`），免费用户从组织缓存获取（业务时间口径，`stripeBillingService.ts:1901-1908`），两套口径统计规则不同 | 对比同一组织在付费/免费状态下的 `getUsage` 返回值 |
| 跨周期上报事件会导致对账差异 | 无实际数据或测试用例证实 | 5月31日产生的事件6月1日才上报：Stripe 对账（`created_at`）计入6月，免费额度（`start_time`/`timestamp`）计入5月，两套口径归属不同计费周期 | 构造 5月31日事件6月1日上报的测试用例，对比两套口径的统计结果 |
| Stripe meter 聚合存在延迟 | 代码库中无任何关于 Stripe meter 聚合周期的注释或常量定义 | `getUsage` 方法通过 `invoice.preview` 实时计算用量（`stripeBillingService.ts:212-218`），不依赖 Stripe 后台聚合，但 meter 事件上报到 invoice preview 可见可能存在延迟 | 查阅 Stripe 官方文档或实测 meter 事件上报到 invoice preview 可见的延迟 |

### ❌ 已删除的无依据推断

1. ~~"两者可能存在 10%-40% 的差异"~~ - 无代码或数据支持，已删除
2. ~~"差异取决于事件上报延迟"~~ - 逻辑合理但无量化证据，改为定性描述差异来源

---

## 九、核心文件索引

| 层级 | 文件路径 | 关键函数/常量 |
|------|----------|--------------|
| 采集拦截 | `web/src/pages/api/public/ingestion.ts:88-94` | `isIngestionSuspended` 检查 |
| 采集拦截 | `web/src/features/public-api/server/apiAuth.ts:188-201,483-490` | `verifyAuthHeaderAndReturnScope` |
| 采集 | `packages/shared/src/server/ingestion/processEventBatch.ts` | `processEventBatch` |
| 阈值常量 | `worker/src/ee/usageThresholds/constants.ts:9-26` | `MAX_EVENTS_FREE_PLAN=50k`, `NOTIFICATION_THRESHOLDS=[50k,100k,200k]`, `BLOCKING_THRESHOLD=250k` |
| Token | `worker/src/features/tokenisation/usage.ts` | `tokenCount`, `openAiChatTokenCount` |
| 聚合A调度 | `packages/shared/src/server/redis/cloudUsageMeteringQueue.ts:49-61` | `"5 * * * *"` |
| 聚合B调度 | `packages/shared/src/server/redis/cloudFreeTierUsageThresholdQueue.ts:50-67` | `"35 * * * *"` |
| 聚合A | `worker/src/ee/cloudUsageMetering/handleCloudUsageMeteringJob.ts` | `handleCloudUsageMeteringJob`（created_at 口径） |
| 聚合B | `worker/src/ee/usageThresholds/usageAggregation.ts` | `processUsageAggregationForAllOrgs`（业务时间口径） |
| 阈值 | `worker/src/ee/usageThresholds/thresholdProcessing.ts` | `processThresholds`（状态机） |
| 缓存失效 | `worker/src/ee/usageThresholds/bulkUpdates.ts:84-102` | `bulkUpdateOrganizations` |
| 4x缓冲注释 | `packages/shared/src/server/repositories/traces.ts:1617-1619` | `"Generous 4x overcompensation"` |
| 查询（created_at） | `packages/shared/src/server/repositories/traces.ts` | `getTraceCountsByProjectInCreationInterval` |
| 查询（created_at） | `packages/shared/src/server/repositories/observations.ts` | `getObservationCountsByProjectInCreationInterval` |
| 查询（业务时间） | `packages/shared/src/server/repositories/traces.ts:1622-1663` | `getTraceCountsByProjectAndDay` (timestamp) |
| 查询（业务时间） | `packages/shared/src/server/repositories/observations.ts:2016-2057` | `getObservationCountsByProjectAndDay` (start_time) |
| 查询（业务时间） | `packages/shared/src/server/repositories/scores.ts:2284-2314` | `getScoreCountsByProjectAndDay` (timestamp) |
| 对账 | `web/src/ee/features/billing/server/stripeBillingService.ts` | `getUsage`, `getInvoices` |
| 路由 | `web/src/ee/features/billing/server/cloudBillingRouter.ts` | `cloudBillingRouter` |
| UI | `web/src/ee/features/billing/components/BillingUsageChart.tsx` | `BillingUsageChart` |
| UI | `web/src/ee/features/billing/components/BillingInvoiceTable.tsx` | `BillingInvoiceTable` |
| UI | `web/src/ee/features/billing/components/useBillingInformation.tsx` | `useBillingInformation` |
| 工具 | `packages/shared/src/server/utils/billingCycleHelpers.ts` | `getBillingCycleStart`, `getBillingCycleEnd` |
| 缓存类型 | `packages/shared/src/server/auth/types.ts:19,70` | `isIngestionSuspended` 字段定义 |
