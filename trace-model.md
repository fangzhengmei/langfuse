# LLM 调用链路追踪数据模型与写入路径

## 1. 三层数据模型概览

Langfuse 将 LLM 调用链路拆分为三层：**Trace**、**Span**、**Generation**，它们在 ClickHouse 中的存储方式如下：

### 1.1 层次关系

```
Trace (顶层)
  └── Span (通用观测)
  │     └── Span (子调用)
  └── Generation (LLM 调用)
  │     └── Tool (工具调用)
  └── Agent / Chain / Retriever / Evaluator / Embedding / Guardrail
        (都是 Generation-like，存储在同一张表中)
```

### 1.2 数据模型定义

#### Trace 模型

**Domain 定义**: `packages/shared/src/domain/traces.ts:12-32`

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 唯一标识 |
| name | string? | 追踪名称 |
| timestamp | date | 时间戳 |
| environment | string | 环境标识 |
| tags | string[] | 标签列表 |
| metadata | Record<string, any> | 元数据 |
| input / output | JSON? | 输入输出 |
| sessionId / userId | string? | 会话/用户关联 |
| projectId | string | 所属项目 |

#### Observations (Span + Generation 统一存储)

**Domain 定义**: `packages/shared/src/domain/observations.ts:5-156`

Observations 表通过 `type` 字段区分不同类型的观测记录：

```typescript
enum ObservationType {
  SPAN = "SPAN",           // 通用跨度
  EVENT = "EVENT",         // 事件
  GENERATION = "GENERATION", // LLM 调用
  AGENT = "AGENT",         // Agent 调用
  TOOL = "TOOL",           // 工具调用
  CHAIN = "CHAIN",         // 链式调用
  RETRIEVER = "RETRIEVER", // 检索器
  EVALUATOR = "EVALUATOR", // 评估器
  EMBEDDING = "EMBEDDING", // 嵌入模型
  GUARDRAIL = "GUARDRAIL", // 防护栏
}
```

**Span 与 Generation 的核心区别**:

| 特性 | Span | Generation |
|------|------|------------|
| 核心用途 | 通用追踪跨度 | LLM API 调用 |
| Model 信息 | 可选 | 核心字段 |
| Token 统计 | 可选 | 核心字段 |
| Cost 计算 | 可选 | 核心字段 |
| Prompt 关联 | 无 | 支持 |
| Tool 调用 | 无 | 支持 (tool_definitions, tool_calls) |

**Generation-like 类型** (支持 LLM 相关字段):
- GENERATION, AGENT, TOOL, CHAIN, RETRIEVER, EVALUATOR, EMBEDDING, GUARDRAIL

**判断函数**: `packages/shared/src/domain/observations.ts:147-149`
```typescript
export const isGenerationLike = (observationType: ObservationType): boolean => {
  return GenerationLikeObservationTypes.includes(observationType as any);
};
```

---

## 2. ClickHouse 表结构

### 2.1 Traces 表

**DDL**: `packages/shared/clickhouse/migrations/unclustered/0001_traces.up.sql`

```sql
CREATE TABLE traces (
    `id` String,
    `timestamp` DateTime64(3),
    `name` String,
    `user_id` Nullable(String),
    `metadata` Map(LowCardinality(String), String),
    `release` Nullable(String),
    `version` Nullable(String),
    `project_id` String,
    `public` Bool,
    `bookmarked` Bool,
    `tags` Array(String),
    `input` Nullable(String) CODEC(ZSTD(3)),
    `output` Nullable(String) CODEC(ZSTD(3)),
    `session_id` Nullable(String),
    `created_at` DateTime64(3) DEFAULT now(),
    `updated_at` DateTime64(3) DEFAULT now(),
    `event_ts` DateTime64(3),
    `is_deleted` UInt8,
    INDEX idx_id id TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_res_metadata_key mapKeys(metadata) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_metadata_value mapValues(metadata) TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = ReplacingMergeTree(event_ts, is_deleted) 
PARTITION by toYYYYMM(timestamp)
PRIMARY KEY (project_id, toDate(timestamp))
ORDER BY (project_id, toDate(timestamp), id);
```

**设计要点**:
- **ReplacingMergeTree**: 支持幂等更新，通过 `event_ts` + `is_deleted` 去重
- **分区**: 按月 (`toYYYYMM(timestamp)`) 分区
- **主键**: `(project_id, toDate(timestamp))` - 按项目+日期查询优化
- **排序键**: `(project_id, toDate(timestamp), id)` - 便于快速定位单个 trace
- **压缩**: `input`/`output` 使用 ZSTD(3) 压缩存储

### 2.2 Observations 表 (Span + Generation)

**DDL**: `packages/shared/clickhouse/migrations/unclustered/0002_observations.up.sql`

```sql
CREATE TABLE observations (
    `id` String,
    `trace_id` String,           -- 关联 trace
    `project_id` String,
    `type` LowCardinality(String), -- SPAN / GENERATION / ...
    `parent_observation_id` Nullable(String), -- 父子关系
    `start_time` DateTime64(3),
    `end_time` Nullable(DateTime64(3)),
    `name` String,
    `metadata` Map(LowCardinality(String), String),
    `level` LowCardinality(String),  -- DEBUG/DEFAULT/WARNING/ERROR
    `status_message` Nullable(String),
    `version` Nullable(String),
    `input` Nullable(String) CODEC(ZSTD(3)),
    `output` Nullable(String) CODEC(ZSTD(3)),
    `provided_model_name` Nullable(String),
    `internal_model_id` Nullable(String),
    `model_parameters` Nullable(String),
    `provided_usage_details` Map(LowCardinality(String), UInt64),
    `usage_details` Map(LowCardinality(String), UInt64),
    `provided_cost_details` Map(LowCardinality(String), Decimal64(12)),
    `cost_details` Map(LowCardinality(String), Decimal64(12)),
    `total_cost` Nullable(Decimal64(12)),
    `completion_start_time` Nullable(DateTime64(3)), -- TTFT
    `prompt_id` Nullable(String),
    `prompt_name` Nullable(String),
    `prompt_version` Nullable(UInt16),
    `created_at` DateTime64(3) DEFAULT now(),
    `updated_at` DateTime64(3) DEFAULT now(),
    `event_ts` DateTime64(3),
    `is_deleted` UInt8,
    INDEX idx_id id TYPE bloom_filter() GRANULARITY 1,
    INDEX idx_trace_id trace_id TYPE bloom_filter() GRANULARITY 1,
    INDEX idx_project_id project_id TYPE bloom_filter() GRANULARITY 1
) ENGINE = ReplacingMergeTree(event_ts, is_deleted) 
PARTITION by toYYYYMM(start_time)
PRIMARY KEY (project_id, `type`, toDate(start_time))
ORDER BY (project_id, `type`, toDate(start_time), id);
```

**设计要点**:
- **统一存储**: Span 和 Generation 共用一张表，通过 `type` 区分
- **父子关系**: `parent_observation_id` 支持嵌套结构
- **LLM 专属字段**: 
  - `provided_model_name` / `internal_model_id`: 模型信息
  - `usage_details`: Token 统计 (input/output/...)
  - `cost_details`: 费用明细
  - `completion_start_time`: 首 token 时间 (用于 TTFT 计算)
  - `prompt_id/name/version`: Prompt 版本关联
  - `tool_definitions` / `tool_calls`: 工具调用支持
- **LowCardinality**: `type`、`level` 使用低基数编码优化存储
- **Bloom Filter 索引**: 支持按 `id`、`trace_id`、`project_id` 快速过滤

### 2.3 分析视图

系统自动创建分析视图用于仪表盘和统计：

- `analytics_traces`: 按小时聚合的 trace 统计 (`0019_analytics_traces.up.sql`)
- `analytics_observations`: 按小时+类型聚合的观测统计 (`0020_analytics_observations.up.sql`)

---

## 3. 完整写入路径

### 3.1 写入流程概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        外部调用方 (SDK/API)                          │
└─────────────────────────┬───────────────────────────────────────────┘
                          │ POST /api/public/ingestion
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    web 容器 - Ingestion API                          │
│  1. 认证校验 (ApiAuthService)                                        │
│  2. 限流检查 (RateLimitService)                                      │
│  3. Schema 验证 (createIngestionEventSchema)                         │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  processEventBatch - S3 上传 + 入队                   │
│  1. 按 eventBodyId 分组                                              │
│  2. 上传事件 JSON 到 S3 (长期存储 + 事件缓存)                          │
│  3. 提交任务到 Redis Queue (BullMQ)                                   │
│     - 延迟: getDelay() 5秒 (避免重复处理)                              │
│     - 分片: 按 projectId-eventBodyId 哈希                            │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Redis - BullMQ Queue                              │
│  - IngestionQueue (主队列)                                           │
│  - IngestionSecondaryQueue (S3 SlowDown 降级队列)                     │
│  - 支持多分片 (LANGFUSE_INGESTION_QUEUE_SHARD_COUNT)                  │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                worker 容器 - ingestionQueueProcessor                  │
│  1. 去重检查 (Redis seen cache, 5分钟 TTL)                            │
│  2. 从 S3 下载事件文件 (并发下载 LANGFUSE_S3_CONCURRENT_READS)          │
│  3. 解析 JSON 事件列表                                                │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  IngestionService.mergeAndWrite()                    │
│  1. 按类型分发: trace / observation / score / dataset_run_item        │
│  2. 合并事件 (多事件更新同一实体)                                       │
│  3. 丰富数据:                                                         │
│     - Prompt 查找 (name + version)                                    │
│     - Model 匹配 + Token 计算 + Cost 计算                             │
│     - Metadata 扁平化                                                │
│     - 时间戳标准化                                                    │
│  4. 转换为 ClickHouse Insert 格式                                     │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    ClickhouseWriter.addToQueue()                      │
│  1. 加入内存队列 (按表独立)                                            │
│  2. 触发条件: 达到 batchSize OR 定时 flush                             │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    ClickhouseWriter.flush() / writeToClickhouse()    │
│  1. 批量写入 (JSONEachRow 格式)                                        │
│  2. 错误处理:                                                         │
│     - 网络错误: 指数退避重试                                           │
│     - 超大记录: 截断 input/output/metadata                           │
│     - 超过最大重试: 丢弃并记录                                         │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 关键组件详解

#### 3.2.1 API 入口

**文件**: `web/src/pages/api/public/ingestion.ts`

```
处理流程:
1. CORS 处理
2. 认证 (ApiAuthService.verifyAuthHeaderAndReturnScope)
3. 限流检查 (RateLimitService)
4. 调用 processEventBatch()
```

#### 3.2.2 事件批处理

**文件**: `packages/shared/src/server/ingestion/processEventBatch.ts:104-356`

**核心逻辑**:
```typescript
// 1. 验证
const batch = input.flatMap((event) => {
  const parsed = ingestionSchema.safeParse(event);
  // ... 验证失败 -> validationErrors
  // ... 权限检查 -> authenticationErrors
});

// 2. 按 eventBodyId 分组 (S3 批量存储优化)
const sortedBatchByEventBodyId = sortedBatch.reduce((acc, event) => {
  const key = `${getClickhouseEntityType(event.type)}-${event.body.id}`;
  acc[key].data.push(event);
  return acc;
}, {});

// 3. S3 上传 (长期存储)
const results = await Promise.allSettled(
  Object.keys(sortedBatchByEventBodyId).map(async (id) => {
    const bucketPath = `.../${projectId}/${entityType}/${eventBodyId}/${key}.json`;
    return s3StorageService.uploadJson(bucketPath, data);
  })
);

// 4. Redis 队列提交
await queue.add(QueueJobs.IngestionJob, payload, {
  delay: getDelay(delay, source) // 默认 5秒，避免重复处理
});
```

#### 3.2.3 队列处理器

**文件**: `worker/src/queues/ingestionQueue.ts:29-305`

**核心流程**:
1. **Redis 去重缓存**: `langfuse:ingestion:recently-processed:{projectId}:{type}:{eventBodyId}:{fileKey}` (5分钟 TTL)
2. **S3 下载**: 从 S3 拉取事件文件，支持并发下载
3. **事件合并**: 同一实体的多个事件按时间戳合并
4. **IngestionService 处理**: 调用 `mergeAndWrite()`

#### 3.2.4 IngestionService

**文件**: `worker/src/services/IngestionService/index.ts:137-195`

**按类型分发**:
```typescript
switch (eventType) {
  case "trace":
    return await this.processTraceEventList(...);
  case "observation":
    return await this.processObservationEventList(...);  // Span + Generation
  case "score":
    return await this.processScoreEventList(...);
  case "dataset_run_item":
    return await this.processDatasetRunItemEventList(...);
}
```

**Generation 专属处理** (`createEventRecord`):
```typescript
// 1. Prompt 查找
const prompt = eventData.promptName && eventData.promptVersion
  ? await this.promptService.getPrompt({...})
  : null;

// 2. Model 匹配 + Token 计算 + Cost 计算
const generationUsage = eventData.modelName
  ? await this.getGenerationUsage({
      provided_model_name: eventData.modelName,
      provided_usage_details: eventData.providedUsageDetails ?? {},
      provided_cost_details: eventData.providedCostDetails ?? {},
      input: eventData.input,
      output: eventData.output,
    })
  : null;

// 3. Metadata 扁平化
const flattened = eventData.metadata
  ? flattenJsonToPathArrays(eventData.metadata)
  : { names: [], values: [] };
```

#### 3.2.5 ClickHouse 写入器

**文件**: `worker/src/services/ClickhouseWriter/index.ts`

**单例设计**:
```typescript
export class ClickhouseWriter {
  private static instance: ClickhouseWriter | null = null;
  batchSize: number;           // LANGFUSE_INGESTION_CLICKHOUSE_WRITE_BATCH_SIZE (默认 1000)
  writeInterval: number;       // LANGFUSE_INGESTION_CLICKHOUSE_WRITE_INTERVAL_MS (默认 1000ms)
  maxAttempts: number;         // LANGFUSE_INGESTION_CLICKHOUSE_MAX_ATTEMPTS (默认 3)
  queue: ClickhouseQueue;      // 按表分队列: traces, observations, scores, ...
}
```

**写入触发机制**:
```typescript
// 1. 数量触发: addToQueue 时检查队列长度
public addToQueue<T extends TableName>(tableName: T, data: ...) {
  entityQueue.push({ createdAt: Date.now(), attempts: 1, data });
  if (entityQueue.length >= this.batchSize) {
    this.flush(tableName);  // 立即 flush
  }
}

// 2. 定时触发: setInterval 周期性 flush
private start() {
  this.intervalId = setInterval(() => {
    if (this.isIntervalFlushInProgress) return;
    this.flushAll();
  }, this.writeInterval);
}
```

**错误处理策略**:
```typescript
// 1. 网络错误: 指数退避重试
isRetryableError = (error) => error.message.includes("socket hang up");

// 2. 超大 JSON: 截断关键字段
truncateOversizedRecord = (record) => {
  // input/output: 保留前 500KB + "[TRUNCATED: Field exceeded size limit]"
  // metadata: 逐个字段检查并截断
  // maxFieldSize = 1MB
};

// 3. 字符串长度限制: 分批重试
handleStringLengthError = (queueItems) => {
  // 对半拆分，先重试前半部分，后半部分重新入队
  // 单条记录时 -> 截断处理
};

// 4. 超过最大重试: 丢弃并记录
if (item.attempts < this.maxAttempts) {
  entityQueue.push({ ...item, attempts: item.attempts + 1 });
} else {
  recordIncrement("langfuse.queue.clickhouse_writer.error");
  // TODO: Dead Letter Queue
}
```

---

## 4. 批量与实时的取舍设计

### 4.1 延迟层级

系统设计了多层延迟机制，在吞吐量和实时性之间平衡：

| 层级 | 延迟点 | 默认值 | 目的 |
|------|--------|--------|------|
| L1 | API 响应 | 立即 | 快速响应 SDK，不阻塞调用方 |
| L2 | S3 上传 | 同步 | 持久化原始事件，防止丢失 |
| L3 | 队列延迟 | 5s (`LANGFUSE_INGESTION_QUEUE_DELAY_MS`) | 避免短时间内重复处理同一实体 |
| L4 | ClickHouse 批量 | 1s / 1000条 | 优化 ClickHouse 写入性能 |
| L5 | 日期边界 | 额外延迟 (23:45-00:15) | 避免跨天分区的重复处理 |

### 4.2 关键配置参数

**环境变量**: `worker/src/env.ts:90-101`

```typescript
LANGFUSE_INGESTION_CLICKHOUSE_WRITE_BATCH_SIZE: z.coerce
  .number().positive().default(1000),
  // - 调大: 吞吐量↑、延迟↑、内存占用↑
  // - 调小: 实时性↑、吞吐↓、ClickHouse 压力↑

LANGFUSE_INGESTION_CLICKHOUSE_WRITE_INTERVAL_MS: z.coerce
  .number().positive().default(1000),
  // - 调小: 实时性↑、ClickHouse 合并压力↑
  // - 调大: 批量效率↑、延迟↑

LANGFUSE_INGESTION_CLICKHOUSE_MAX_ATTEMPTS: z.coerce
  .number().positive().default(3),
  // - 重试失败写入的次数

LANGFUSE_INGESTION_QUEUE_DELAY_MS:
  // 队列延迟，默认 API 事件 5秒，OTel 事件 0秒
  // 目的: 合并短时间内对同一实体的多次更新
```

### 4.3 设计权衡

#### 为什么选择异步队列 + 批量写入？

**优势**:
1. **API 解耦**: SDK 调用快速返回，不被后端处理阻塞
2. **流量削峰**: Redis 队列缓冲突发流量
3. **事件合并**: 同一 trace/span 的多次 PATCH 可以合并处理
4. **ClickHouse 优化**: ClickHouse 不适合小批量高频写入，批量写入显著提升性能
5. **故障隔离**: 任一环节故障不影响上游调用

**代价**:
1. **最终一致性**: 数据从调用到可见有延迟 (典型 5-10s)
2. **复杂度增加**: 需要处理 S3、Redis、ClickHouse 多系统协同
3. **失败处理**: 需要考虑重试、截断、丢弃等策略

#### 为什么 Span 和 Generation 存在同一张表？

**设计考量**:
1. **查询模式相似**: 都按 `(project_id, trace_id)` 查询
2. **字段高度重叠**: 共享 `trace_id`、`parent_id`、时间戳、元数据等字段
3. **低基数区分**: `type` 字段使用 LowCardinality 编码，存储开销极小
4. **查询灵活**: 可按类型过滤，也可联合查询整个调用链

**代价**:
1. **稀疏字段**: Span 不使用的 Generation 字段 (model, usage, cost 等) 占用空间
2. **索引共享**: 无法为 Generation 专属字段建立独立索引

---

## 5. 关键文件索引

| 功能 | 文件路径 | 关键行 |
|------|----------|--------|
| Trace 领域模型 | `packages/shared/src/domain/traces.ts` | 12-32 |
| Observation 领域模型 | `packages/shared/src/domain/observations.ts` | 5-156 |
| Traces 表 DDL | `packages/shared/clickhouse/migrations/unclustered/0001_traces.up.sql` | 1-32 |
| Observations 表 DDL | `packages/shared/clickhouse/migrations/unclustered/0002_observations.up.sql` | 1-46 |
| 批量事件处理 | `packages/shared/src/server/ingestion/processEventBatch.ts` | 104-356 |
| 队列处理器 | `worker/src/queues/ingestionQueue.ts` | 29-305 |
| 摄入服务 | `worker/src/services/IngestionService/index.ts` | 137-195, 212-387 |
| ClickHouse 写入器 | `worker/src/services/ClickhouseWriter/index.ts` | 32-597 |
| 环境变量配置 | `worker/src/env.ts` | 90-101 |

---

## 6. 总结

Langfuse 的追踪数据模型采用 **"两级物理表 + 类型字段区分"** 的设计：

1. **Trace 独立表**: 顶层追踪，粒度大、字段少
2. **Observations 统一表**: Span、Generation 及其他类型共用，通过 `type` 字段区分
3. **批量异步写入**: 经过 S3 → Redis → Worker → ClickHouse 四层，通过队列延迟和批量参数平衡实时性与吞吐量

这种设计的核心考量是：
- **ClickHouse 写入友好**: 批量写入、ReplacingMergeTree 幂等更新
- **查询模式优化**: 按 `project_id` + 时间维度的主键/排序键设计
- **故障隔离**: 异步队列 + 重试机制保证数据最终一致性
- **存储效率**: LowCardinality、ZSTD 压缩、Bloom Filter 索引
