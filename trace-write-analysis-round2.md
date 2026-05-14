# Trace 写入存储层级关系深度分析报告（Round 2）

## 1. 核心架构概览

### 1.1 双写机制（Dual Write）概览

Langfuse 采用了两层存储架构：
- **历史存储层**：`traces` 表 + `observations` 表（面向历史查询）
- **事件存储层**：`events_full` 表 + `observations_batch_staging` 表（面向实时查询和批处理）

关键流程：
```
Ingestion API
     ↓
[写入 traces 表] ←─────────────┐
     ↓                         │
[写入 observations 表]         │
     ↓                         │
[双写 observations_batch_staging]
     ↓                         │
[双写 observations_batch_staging (Trace 转 Synthetic Span)]
     ↓                         │
[Event Propagation Job]        │
     ↓                         │
[写入 events_full 表]         │
     ↓                         │
[Materialized View] → events_core
```

---

## 2. Trace 作为 Synthetic Span 进入 Staging 表

### 2.1 核心函数：`convertTraceToStagingObservation`

**位置**：`packages/shared/src/server/repositories/definitions.ts:383-443`

```typescript
export const convertTraceToStagingObservation = (
  traceRecord: TraceRecordInsertType,
  s3FirstSeenTimestamp: number,
): ObservationBatchStagingRecordInsertType => {
  return {
    // 关键：Trace ID 被加上 't-' 前缀作为 Span ID
    // 避免用户设置 spanId = traceId 时的冲突
    id: `t-${traceRecord.id}`,
    
    trace_id: traceRecord.id,        // 关联到原始 Trace
    project_id: traceRecord.project_id,
    
    // Trace 被伪装成一个 SPAN 类型的 Observation
    type: "SPAN",
    
    // Trace 是根节点，没有父节点
    parent_observation_id: undefined,
    
    // 从 Trace 继承的核心字段
    name: traceRecord.name,
    environment: traceRecord.environment,
    version: traceRecord.version,
    metadata: traceRecord.metadata,
    
    // 时间映射：Trace 的 timestamp 作为 start_time
    start_time: traceRecord.timestamp,
    end_time: undefined,              // Trace 没有 end_time
    completion_start_time: undefined,
    
    // IO 字段直接继承
    input: traceRecord.input,
    output: traceRecord.output,
    
    // Observation 特有字段的默认值
    level: "DEFAULT",
    status_message: undefined,
    provided_model_name: undefined,
    internal_model_id: undefined,
    model_parameters: undefined,
    
    // Usage/Cost 字段初始化为空
    provided_usage_details: {},
    usage_details: {},
    provided_cost_details: {},
    cost_details: {},
    total_cost: undefined,
    
    // Prompt 相关字段为空
    prompt_id: undefined,
    prompt_name: undefined,
    prompt_version: undefined,
    
    // Tool 相关字段为空（Trace 不包含工具调用）
    tool_definitions: undefined,
    tool_calls: undefined,
    tool_call_names: undefined,
    
    // 系统字段
    created_at: traceRecord.created_at,
    updated_at: traceRecord.updated_at,
    event_ts: traceRecord.event_ts,
    is_deleted: traceRecord.is_deleted,
    
    // Staging 表特有字段：分区时间戳
    s3_first_seen_timestamp: s3FirstSeenTimestamp,
  };
};
```

### 2.2 写入触发点

**位置**：`worker/src/services/IngestionService/index.ts:685-695`

```typescript
// 处理 Trace 事件时，双写到 staging 表
if (createEventTraceRecord) {
  const traceAsStagingObservation = convertTraceToStagingObservation(
    finalTraceRecord,
    this.getPartitionAwareTimestamp(createdAtTimestamp),
  );
  this.clickHouseWriter.addToQueue(
    TableName.ObservationsBatchStaging,
    traceAsStagingObservation,
  );
}
```

### 2.3 分区时间戳逻辑

函数 `getPartitionAwareTimestamp` 确保：
- 3.5 分钟内的事件保持原时间戳
- 超过 3.5 分钟的事件使用当前时间戳
- 目的：防止旧数据写入已关闭的分区

---

## 3. 事件传播：`parent_span_id` 串起层级

### 3.1 事件传播 Job 核心逻辑

**位置**：`worker/src/features/eventPropagation/handleEventPropagationJob.ts:58-342`

#### 3.1.1 处理流程

1. **获取下一个分区**：从 Redis 读取上次处理的分区位置，按时间顺序处理
2. **执行 INSERT SELECT**：将 `observations_batch_staging` 关联 `traces` 表写入 `events_full`
3. **更新游标**：记录已处理的分区到 Redis

#### 3.1.2 `parent_span_id` 构建逻辑

```sql
-- 核心 SQL 片段（行 240-243）
CASE
  -- 当 Observation 是 Synthetic Span（来自 Trace）时，parent_span_id 为空
  WHEN obs.id = concat('t-', obs.trace_id) THEN ''
  
  -- 正常 Observation：
  -- 1. 优先使用 parent_observation_id
  -- 2. 回退到 't-' + trace_id（即 Trace 的 Synthetic Span ID）
  ELSE coalesce(obs.parent_observation_id, concat('t-', obs.trace_id))
END AS parent_span_id
```

### 3.2 层级关联示例

假设有如下结构：
```
Trace (id: trace-123)
  └── Span A (id: span-456, parent_observation_id: NULL)
        └── Generation B (id: gen-789, parent_observation_id: span-456)
```

写入 `events_full` 表后的 `parent_span_id`：

| 记录类型 | id | span_id | parent_span_id | 说明 |
|---------|----|---------|----------------|------|
| **Trace (Synthetic Span)** | `t-trace-123` | `t-trace-123` | `''` | 根节点，无父 |
| **Span A** | `span-456` | `span-456` | `t-trace-123` | 父是 Trace 的 Synthetic Span |
| **Generation B** | `gen-789` | `gen-789` | `span-456` | 父是 Span A |

### 3.3 关键设计要点

1. **`t-` 前缀约定**：
   - Trace 转换为 Synthetic Span 时，ID 被加上 `t-` 前缀
   - 这保证了 Trace ID 与 Span ID 空间不会冲突
   - 在 JOIN 时可以通过 `concat('t-', obs.trace_id)` 找到对应的 Synthetic Span

2. **回退机制**：
   - 如果 Observation 没有 `parent_observation_id`，自动挂到 Trace 的 Synthetic Span 下
   - 这保证了"孤儿" Observation 不会丢失层级关系

3. **区分 Synthetic Span**：
   - 通过 `obs.id = concat('t-', obs.trace_id)` 判断是否是 Trace 转换的 Synthetic Span
   - Synthetic Span 的 `parent_span_id` 设为空字符串，表示它是根节点

---

## 4. Observation 先到、Trace 缺失时的 Wrapper Trace 回填

### 4.1 回填触发条件

**位置**：`worker/src/services/IngestionService/index.ts:851-869`

```typescript
// 向后兼容：为没有 trace_id 的 Observation 创建包装 Trace
if (!finalObservationRecord.trace_id) {
  const wrapperTraceRecord: TraceRecordInsertType = {
    id: finalObservationRecord.id,      // 使用 Observation 的 ID 作为 Trace ID
    timestamp: finalObservationRecord.start_time,  // 使用 Observation 的 start_time
    project_id: projectId,
    environment: finalObservationRecord.environment,
    created_at: Date.now(),
    updated_at: Date.now(),
    metadata: {},
    tags: [],
    bookmarked: false,
    public: false,
    event_ts: Date.now(),
    is_deleted: 0,
  };

  this.clickHouseWriter.addToQueue(TableName.Traces, wrapperTraceRecord);
  finalObservationRecord.trace_id = finalObservationRecord.id;
}
```

### 4.2 Wrapper Trace 的特性

| 字段 | 值来源 | 说明 |
|------|--------|------|
| `id` | Observation 的 ID | 两者共用同一个 ID |
| `timestamp` | Observation 的 `start_time` | 时间对齐 |
| `project_id` / `environment` | 直接继承 | 环境保持一致 |
| `metadata` | `{}` | 空元数据 |
| `tags` | `[]` | 空标签 |
| `bookmarked` / `public` | `false` | 默认非公开、未收藏 |

### 4.3 设计意图

1. **SDK 向后兼容**：旧版 SDK（< 2.0.0）可能只发送 Observation 不发送 Trace
2. **保证数据完整性**：确保每个 Observation 都能关联到一个 Trace，避免数据孤岛
3. **简化查询逻辑**：查询时不需要处理 `trace_id IS NULL` 的特殊情况

---

## 5. 按时间顺序的写入示例

### 5.1 场景描述

客户端按顺序发送：
1. Generation（没有 Trace ID，来自旧版 SDK）
2. Span（包含 Trace ID）
3. Trace 元数据

### 5.2 Step 1: 接收 Generation（无 Trace ID）

**时间**：T0

```typescript
// 输入：Generation 事件，无 trace_id
{
  id: "gen-001",
  type: "GENERATION",
  name: "gpt-4-call",
  start_time: 1715000000000,
  project_id: "proj-123",
  // 注意：没有 trace_id!
  input: "Hello",
  output: "Hi there",
  provided_model_name: "gpt-4",
}
```

**写入操作**：
1. ✅ 创建 Wrapper Trace（ID = "gen-001"）写入 `traces` 表
2. ✅ 设置 Observation 的 `trace_id = "gen-001"`
3. ✅ 写入 Observation 到 `observations` 表
4. ✅ 双写 Observation 到 `observations_batch_staging` 表

**此时 traces 表状态**：
```
{
  id: "gen-001",         // Wrapper Trace，ID 与 Observation 相同
  timestamp: 1715000000000,
  project_id: "proj-123",
  metadata: {},
  tags: [],
  // ...其他默认值
}
```

**此时 observations 表状态**：
```
{
  id: "gen-001",
  trace_id: "gen-001",    // 指向 Wrapper Trace
  project_id: "proj-123",
  type: "GENERATION",
  parent_observation_id: undefined,  // 无父节点
  start_time: 1715000000000,
  // ...其他字段
}
```

### 5.3 Step 2: 接收 Span（包含 Trace ID）

**时间**：T0 + 100ms

```typescript
// 输入：Span 事件，有正确的 trace_id
{
  id: "span-001",
  type: "SPAN",
  name: "request-handler",
  start_time: 1715000000050,
  project_id: "proj-123",
  trace_id: "trace-001",        // 正常 Trace ID
  parent_observation_id: undefined,
}
```

**写入操作**：
1. ✅ 不需要 Wrapper Trace（已有 trace_id）
2. ✅ 写入 Observation 到 `observations` 表
3. ✅ 双写 Observation 到 `observations_batch_staging` 表

**此时 observations 表新增**：
```
{
  id: "span-001",
  trace_id: "trace-001",    // 指向真实 Trace（但 traces 表中还不存在）
  project_id: "proj-123",
  type: "SPAN",
  parent_observation_id: undefined,
  start_time: 1715000000050,
  // ...其他字段
}
```

### 5.4 Step 3: 接收 Trace 元数据

**时间**：T0 + 200ms

```typescript
// 输入：Trace 事件
{
  id: "trace-001",
  name: "user-session-abc",
  timestamp: 1715000000000,
  project_id: "proj-123",
  user_id: "user-456",
  session_id: "sess-789",
  tags: ["production", "api"],
  metadata: { route: "/chat" },
}
```

**写入操作**：
1. ✅ 写入 Trace 到 `traces` 表（覆盖 Wrapper Trace 机制）
2. ✅ 调用 `convertTraceToStagingObservation` 转换为 Synthetic Span
3. ✅ 双写 Synthetic Span 到 `observations_batch_staging` 表

**此时 traces 表状态（新增真实 Trace）**：
```
{
  id: "trace-001",
  name: "user-session-abc",
  timestamp: 1715000000000,
  project_id: "proj-123",
  user_id: "user-456",
  session_id: "sess-789",
  tags: ["production", "api"],
  metadata: { route: "/chat" },
  // ...其他字段
}
```

**observations_batch_staging 表中新增 Synthetic Span**：
```
{
  id: "t-trace-001",         // 注意 't-' 前缀！
  trace_id: "trace-001",
  project_id: "proj-123",
  type: "SPAN",              // 伪装成 SPAN
  parent_observation_id: undefined,
  name: "user-session-abc",  // 继承 Trace 的 name
  start_time: 1715000000000, // 使用 Trace 的 timestamp
  // ...其他字段从 Trace 继承
  s3_first_seen_timestamp: 1715000000200,
}
```

### 5.5 Step 4: Event Propagation Job 处理

**时间**：T0 + 5分钟（分区延迟处理）

Job 从 `observations_batch_staging` 读取数据并写入 `events_full`：

#### 对于 Wrapper Trace 的 Generation ("gen-001")：
```sql
-- 伪代码逻辑
SELECT
  obs.id AS span_id,  -- "gen-001"
  CASE
    WHEN obs.id = concat('t-', obs.trace_id) THEN ''
    ELSE coalesce(obs.parent_observation_id, concat('t-', obs.trace_id))
  END AS parent_span_id  -- "t-gen-001" (回退到 Trace 的 Synthetic Span)
  -- ...其他字段
```

**注意**：由于 "gen-001" 这个 Trace 没有被转成 Synthetic Span 写入 staging 表（只有 SDK 发送的 Trace 才会双写），所以在 events 表中这条 Generation 的父节点指向一个不存在的 Synthetic Span。

#### 对于 Span ("span-001")：
```sql
SELECT
  obs.id AS span_id,  -- "span-001"
  CASE
    WHEN obs.id = concat('t-', obs.trace_id) THEN ''
    ELSE coalesce(obs.parent_observation_id, concat('t-', obs.trace_id))
  END AS parent_span_id  -- "t-trace-001" (指向 Trace 的 Synthetic Span)
  -- ...其他字段
```

#### 对于 Trace 的 Synthetic Span ("t-trace-001")：
```sql
SELECT
  obs.id AS span_id,  -- "t-trace-001"
  CASE
    WHEN obs.id = concat('t-', obs.trace_id) THEN ''  -- 命中！parent_span_id = ''
    ELSE coalesce(obs.parent_observation_id, concat('t-', obs.trace_id))
  END AS parent_span_id  -- "" (根节点)
  -- ...其他字段
```

### 5.6 最终 events_full 表层级

| span_id | parent_span_id | 层级说明 |
|---------|----------------|---------|
| `t-trace-001` | `''` | 根节点（Trace 的 Synthetic Span） |
| `span-001` | `t-trace-001` | 挂到 Trace 下 |
| `gen-001` | `t-gen-001` | 挂到 Wrapper Trace 的 Synthetic Span 下（但该 Synthetic Span 可能不存在于 events 表中） |

### 5.7 注意事项：Wrapper Trace 的 Synthetic Span 缺失

**问题**：
- 自动创建的 Wrapper Trace 只写入了 `traces` 表
- **没有**被 `convertTraceToStagingObservation` 转换并写入 staging 表
- 因此 `events_full` 表中没有 `t-gen-001` 这条记录
- 导致 `gen-001` 的 `parent_span_id` 指向一个不存在的节点

**影响**：
- 在 UI 上查看这条 Generation 的调用链时，可能无法正常渲染树形结构
- 但 Generation 的数据本身是完整的，可以单独查看

**潜在改进**：
- 在创建 Wrapper Trace 时，也调用 `convertTraceToStagingObservation` 进行双写

---

## 6. 关键设计权衡总结

### 6.1 Synthetic Span 设计

| 优点 | 缺点 |
|------|------|
| 统一 Trace 和 Observation 的查询模型 | 增加了存储开销（每个 Trace 多存一条 SPAN 记录） |
| 树形结构查询不需要特殊处理 Trace 节点 | ID 前缀约定增加了心智负担 |
| 保证所有节点都在同一棵树上 | JOIN 时需要额外的字符串拼接逻辑 |

### 6.2 Wrapper Trace 回填

| 优点 | 缺点 |
|------|------|
| 旧版 SDK 数据不会丢失 | Trace 元数据缺失（没有 name、user_id、tags 等） |
| 查询逻辑简化（不用处理 NULL trace_id） | 可能造成孤儿节点（父 Synthetic Span 不存在于 events 表） |
| 保证数据完整性约束 | ID 重用可能造成困惑 |

### 6.3 事件传播分区延迟

| 优点 | 缺点 |
|------|------|
| 批量写入提升 ClickHouse 性能 | 事件表有几分钟的延迟（非实时） |
| 减少小分区合并压力 | 需要 Redis 维护处理游标状态 |
| 给乱序到达数据留足窗口 | 延迟可配置（当前约 4 分钟） |

---

## 7. 代码文件索引

| 功能 | 文件路径 | 关键行 |
|------|---------|--------|
| Trace → Synthetic Span 转换 | `packages/shared/src/server/repositories/definitions.ts` | 383-443 |
| Wrapper Trace 回填 | `worker/src/services/IngestionService/index.ts` | 851-869 |
| Trace 双写 Staging | `worker/src/services/IngestionService/index.ts` | 685-695 |
| Observation 双写 Staging | `worker/src/services/IngestionService/index.ts` | 883-892 |
| 事件传播 Job 核心逻辑 | `worker/src/features/eventPropagation/handleEventPropagationJob.ts` | 58-342 |
| parent_span_id 构建 SQL | `worker/src/features/eventPropagation/handleEventPropagationJob.ts` | 240-243 |
| 表结构定义 | `packages/shared/src/server/repositories/definitions.ts` | 34-103 |
