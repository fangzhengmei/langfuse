# Trace、Span、Generation 写入存储层级关系分析报告

## 1. 数据模型概述

### 1.1 核心实体关系

在 Langfuse 系统中，Trace、Span、Generation 三者的核心关系如下：

```
Trace (独立顶级实体)
  └─── Observations (统一存储表)
         ├─── SPAN 类型
         │     └─── 可嵌套其他 SPAN 或 GENERATION
         └─── GENERATION 类型
               └─── 可嵌套其他 GENERATION 或 SPAN
```

### 1.2 数据模型定义位置

| 实体 | 定义文件 | 说明 |
|------|---------|------|
| Trace | `packages/shared/src/domain/traces.ts` | 独立的 Trace 领域模型 |
| Observation (Span/Generation) | `packages/shared/src/domain/observations.ts` | 统一的观察模型，通过 type 字段区分 |

---

## 2. 存储表结构

### 2.1 traces 表 (Trace 存储)

**位置**: `packages/shared/src/server/repositories/traces.ts`

**核心字段**:
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String | Trace 唯一标识符 |
| `project_id` | String | 项目 ID |
| `timestamp` | DateTime64 | Trace 时间戳 |
| `name` | String | 名称 |
| `user_id` | String | 用户 ID |
| `session_id` | String | 会话 ID |
| `metadata` | Map | 元数据 |
| `tags` | Array | 标签数组 |
| `input` / `output` | String | 输入输出 |
| `event_ts` | DateTime | 事件时间戳（用于去重） |

### 2.2 observations 表 (Span/Generation 统一存储)

**位置**: `packages/shared/src/server/repositories/observations.ts`

**核心字段**:
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String | Observation 唯一标识符 |
| `trace_id` | String | **关联到父 Trace** |
| `project_id` | String | 项目 ID |
| `parent_observation_id` | String | **关联到父 Observation** (实现嵌套层级) |
| `type` | Enum | 类型：`SPAN` / `GENERATION` / `EVENT` 等 |
| `start_time` / `end_time` | DateTime64 | 起止时间 |
| `name` | String | 名称 |
| `metadata` | Map | 元数据 |
| `level` | Enum | 日志级别：DEBUG / DEFAULT / WARNING / ERROR |
| `provided_model_name` | String | 模型名称 (Generation 特有) |
| `usage_details` | Map | Token 使用详情 |
| `cost_details` | Map | 成本详情 |
| `total_cost` | Decimal | 总成本 |
| `event_ts` | DateTime | 事件时间戳（用于去重） |

---

## 3. 层级关系实现机制

### 3.1 Trace 与 Observation 的关联

**关联字段**: `trace_id`

**实现逻辑**:
1. 每个 Observation (Span 或 Generation) 必须包含 `trace_id` 字段
2. 通过 `trace_id` 将所有子节点关联到顶层 Trace
3. 查询时使用 `WHERE trace_id = {traceId}` 可获取该 Trace 下的所有 Observations

**代码位置**: `packages/shared/src/server/repositories/observations.ts:136-188`

```sql
-- 获取特定 Trace 的所有 Observations
SELECT id, trace_id, parent_observation_id, type, ...
FROM observations
WHERE trace_id = {traceId: String}
AND project_id = {projectId: String}
ORDER BY event_ts DESC
LIMIT 1 BY id, project_id
```

### 3.2 Observation 之间的嵌套层级

**关联字段**: `parent_observation_id`

**实现逻辑**:
1. 每个 Observation 可以有一个父 Observation
2. 通过 `parent_observation_id` 字段形成树形嵌套结构
3. 支持任意深度的嵌套：Span → Span → Generation → ...

**层级构建示例**:
```
Observation A (type=SPAN, parent_observation_id=NULL)
  ├─── Observation B (type=SPAN, parent_observation_id=A.id)
  │     └─── Observation C (type=GENERATION, parent_observation_id=B.id)
  └─── Observation D (type=GENERATION, parent_observation_id=A.id)
```

**代码位置**: `packages/shared/src/server/repositories/traces.ts:1556-1592` (Agent 图谱查询)

```sql
-- 查询构建层级关系所需的字段
SELECT
  id,
  parent_observation_id,
  type,
  name,
  start_time,
  end_time
FROM observations
WHERE trace_id = {traceId: String}
```

---

## 4. 写入机制

### 4.1 ClickhouseWriter 单例写入器

**位置**: `worker/src/services/ClickhouseWriter/index.ts:32-78`

**核心特性**:
1. **单例模式**: `ClickhouseWriter.getInstance()` 获取唯一实例
2. **批量写入**: 内部维护队列，达到 `batchSize` 时批量写入
3. **定时刷写**: 按 `writeInterval` 定时刷写队列
4. **重试机制**: 失败时自动重试，最多 `maxAttempts` 次

### 4.2 写入流程

```
API 接收请求
     ↓
  数据验证
     ↓
  转换为 Clickhouse 格式
     ↓
  添加到对应表的写入队列
     ↓
[达到 batchSize 或 时间到]
     ↓
  调用 upsertClickhouse 写入
     ↓
[失败?] → 重试 → 超过最大次数 → 丢弃
     ↓
  写入完成
```

### 4.3 Trace 写入

**位置**: `packages/shared/src/server/repositories/traces.ts:198-214`

**写入函数**: `upsertTrace()`

**必填字段**:
- `id`
- `project_id`
- `timestamp`

**去重机制**: `ORDER BY event_ts DESC LIMIT 1 BY id, project_id`

### 4.4 Observation (Span/Generation) 写入

**位置**: `packages/shared/src/server/repositories/observations.ts:103-126`

**写入函数**: `upsertObservation()`

**必填字段**:
- `id`
- `project_id`
- `start_time`
- `type` (SPAN / GENERATION / ...)

**层级关联字段**:
- `trace_id`: 关联到 Trace (可为 NULL)
- `parent_observation_id`: 关联到父 Observation (可为 NULL)

---

## 5. 类型区分与扩展

### 5.1 Observation 类型枚举

**位置**: `packages/shared/src/domain/observations.ts:5-29`

```typescript
export const ObservationType = {
  SPAN: "SPAN",
  EVENT: "EVENT",
  GENERATION: "GENERATION",
  AGENT: "AGENT",
  TOOL: "TOOL",
  CHAIN: "CHAIN",
  RETRIEVER: "RETRIEVER",
  EVALUATOR: "EVALUATOR",
  EMBEDDING: "EMBEDDING",
  GUARDRAIL: "GUARDRAIL",
} as const;
```

### 5.2 Generation 类型识别

**位置**: `packages/shared/src/domain/observations.ts:136-149`

```typescript
const GenerationLikeObservationTypes = [
  ObservationType.GENERATION,
  ObservationType.AGENT,
  ObservationType.TOOL,
  ObservationType.CHAIN,
  ObservationType.RETRIEVER,
  ObservationType.EVALUATOR,
  ObservationType.EMBEDDING,
  ObservationType.GUARDRAIL,
] as const;

export const isGenerationLike = (observationType: ObservationType): boolean => {
  return GenerationLikeObservationTypes.includes(observationType as any);
};
```

---

## 6. 查询与层级重建

### 6.1 获取 Trace 及其所有子节点

**步骤**:
1. 查询 `traces` 表获取 Trace 基本信息
2. 查询 `observations` 表通过 `trace_id` 获取所有子节点
3. 在应用层通过 `parent_observation_id` 构建树形结构

### 6.2 聚合查询示例

**位置**: `packages/shared/src/server/repositories/traces.ts:58-191`

```sql
-- 聚合 Trace 的 Observations 统计信息
WITH observations_agg AS (
  SELECT
    multiIf(
      arrayExists(x -> x = 'ERROR', groupArray(level)), 'ERROR',
      arrayExists(x -> x = 'WARNING', groupArray(level)), 'WARNING',
      arrayExists(x -> x = 'DEFAULT', groupArray(level)), 'DEFAULT',
      'DEBUG'
    ) AS aggregated_level,
    date_diff('millisecond', least(min(start_time), min(end_time)), greatest(max(start_time), max(end_time))) as latency_milliseconds,
    sumMap(usage_details) as usage_details,
    sumMap(cost_details) as cost_details,
    trace_id,
    project_id
  FROM observations o FINAL
  WHERE o.project_id = {projectId: String}
  GROUP BY trace_id, project_id
)
SELECT t.*, o.*
FROM traces t FINAL
LEFT JOIN observations_agg o ON t.id = o.trace_id AND t.project_id = o.project_id
WHERE t.id = {traceId: String}
```

---

## 7. 关键设计特点

### 7.1 优势

1. **统一存储**: Span 和 Generation 共用一张表，简化 Schema
2. **灵活嵌套**: 通过 `parent_observation_id` 支持任意深度层级
3. **高性能**: ClickHouse 列存 + 批量写入 + 时间窗口优化
4. **幂等性**: 通过 `LIMIT 1 BY id, project_id` 实现去重

### 7.2 约束

1. **最终一致性**: 批量写入和去重机制导致短时间内可能不一致
2. **无外键约束**: ClickHouse 不支持外键，关联关系由应用层维护
3. **层级重建开销**: 树形结构需要在应用层重建，大数据量时有开销

### 7.3 性能优化点

1. **时间窗口过滤**: 查询时使用 `start_time >= timestamp - INTERVAL` 减少扫描范围
2. **投影下推**: 只查询需要的字段，减少数据传输
3. **批量写入**: 减少 ClickHouse 写入次数，提升吞吐量
4. **FINAL 关键字**: 在需要强一致性的查询中使用，但会影响性能

---

## 8. 总结

| 维度 | Trace | Span | Generation |
|------|-------|------|------------|
| **存储表** | `traces` | `observations` | `observations` |
| **唯一标识** | `id` | `id` | `id` |
| **关联 Trace** | - | `trace_id` | `trace_id` |
| **关联父节点** | - | `parent_observation_id` | `parent_observation_id` |
| **类型区分** | - | `type = 'SPAN'` | `type = 'GENERATION'` |
| **写入入口** | `upsertTrace()` | `upsertObservation()` | `upsertObservation()` |
| **去重机制** | `LIMIT 1 BY id, project_id` | `LIMIT 1 BY id, project_id` | `LIMIT 1 BY id, project_id` |

**核心设计理念**: 使用统一的 `observations` 表存储所有观察类型，通过 `type` 字段区分 Span 和 Generation，通过 `trace_id` 和 `parent_observation_id` 两个字段共同构建完整的层级关系树。
