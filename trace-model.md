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

**Traces 表增量迁移**:
| 迁移 | 编号 | SQL | 变更 |
|------|------|-----|------|
| 基础建表 | 0001 | `0001_traces.up.sql` | 初始 schema |
| environment 列 | 0008 | `0008_add_environments_column.up.sql` | `ALTER TABLE traces ADD COLUMN environment LowCardinality(String) DEFAULT 'default' AFTER project_id` |
| session_id 索引 | 0005 | `0005_add_session_id_index.up.sql` | 添加 session_id Bloom Filter 索引 |
| user_id 索引 | 0006 | `0006_add_user_id_index.up.sql` | 添加 user_id Bloom Filter 索引 |

### 2.2 Observations 表 (Span + Generation)

Observations 表经过多次增量迁移演化，以下是完整的迁移历史：

#### 阶段一：基础建表 (0002)

**DDL**: `packages/shared/clickhouse/migrations/unclustered/0002_observations.up.sql`

```sql
CREATE TABLE observations (
    `id` String,
    `trace_id` String,
    `project_id` String,
    `type` LowCardinality(String),
    `parent_observation_id` Nullable(String),
    `start_time` DateTime64(3),
    `end_time` Nullable(DateTime64(3)),
    `name` String,
    `metadata` Map(LowCardinality(String), String),
    `level` LowCardinality(String),
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
    `completion_start_time` Nullable(DateTime64(3)),
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

**基础设计要点**:
- **统一存储**: Span 和 Generation 共用一张表，通过 `type` 区分
- **父子关系**: `parent_observation_id` 支持嵌套结构
- **LLM 专属字段**: `provided_model_name`、`usage_details`、`cost_details`、`prompt_id/name/version`
- **LowCardinality**: `type`、`level` 使用低基数编码优化存储
- **Bloom Filter 索引**: `idx_id`、`idx_trace_id`、`idx_project_id`

#### 阶段二：增量迁移演进

| 迁移编号 | SQL 文件 | 变更内容 |
|---------|---------|---------|
| 0004 | `0004_drop_observations_index.up.sql` | `ALTER TABLE observations DROP INDEX IF EXISTS idx_project_id` |
| 0008 | `0008_add_environments_column.up.sql` | `ALTER TABLE observations ADD COLUMN environment LowCardinality(String) DEFAULT 'default' AFTER project_id` |
| 0025 | `0025_add_observations_metadata_indexes.up.sql` | `ALTER TABLE observations ADD INDEX idx_res_metadata_key mapKeys(metadata) TYPE bloom_filter(0.01) GRANULARITY 1`; `ALTER TABLE observations ADD INDEX idx_res_metadata_value mapValues(metadata) TYPE bloom_filter(0.01) GRANULARITY 1` |
| 0031 | `0031_add_usage_pricing_tier_columns.up.sql` | `ALTER TABLE observations ADD COLUMN usage_pricing_tier_id Nullable(String)`; `ALTER TABLE observations ADD COLUMN usage_pricing_tier_name Nullable(String)` |
| 0033 | `0033_add_tool_call_columns.up.sql` | `ALTER TABLE observations ADD COLUMN tool_definitions Map(String, String) DEFAULT map()`; `ALTER TABLE observations ADD COLUMN tool_calls Array(String) DEFAULT []`; `ALTER TABLE observations ADD COLUMN tool_call_names Array(String) DEFAULT []` |

#### Observations 表现有字段汇总

| 字段 | 类型 | 来源迁移 | 用途 |
|------|------|---------|------|
| id | String | 0002 (base) | 观测记录唯一 ID |
| trace_id | String | 0002 (base) | 关联 trace |
| project_id | String | 0002 (base) | 项目 ID |
| environment | LowCardinality(String) | 0008 | 环境标识 |
| type | LowCardinality(String) | 0002 (base) | SPAN/GENERATION/AGENT/... |
| parent_observation_id | Nullable(String) | 0002 (base) | 父子关系 |
| start_time | DateTime64(3) | 0002 (base) | 开始时间 |
| end_time | Nullable(DateTime64(3)) | 0002 (base) | 结束时间 |
| name | String | 0002 (base) | 名称 |
| metadata | Map(LowCardinality(String), String) | 0002 (base) | 元数据 (key-value) |
| level | LowCardinality(String) | 0002 (base) | DEBUG/DEFAULT/WARNING/ERROR |
| status_message | Nullable(String) | 0002 (base) | 状态消息 |
| version | Nullable(String) | 0002 (base) | 版本 |
| input | Nullable(String) | 0002 (base) | 输入 (ZSTD 压缩) |
| output | Nullable(String) | 0002 (base) | 输出 (ZSTD 压缩) |
| provided_model_name | Nullable(String) | 0002 (base) | 用户传入的模型名 |
| internal_model_id | Nullable(String) | 0002 (base) | 内部模型 ID |
| model_parameters | Nullable(String) | 0002 (base) | 模型参数 JSON |
| provided_usage_details | Map(...) | 0002 (base) | 用户传入的 token 统计 |
| usage_details | Map(...) | 0002 (base) | 计算后的 token 统计 |
| provided_cost_details | Map(...) | 0002 (base) | 用户传入的费用 |
| cost_details | Map(...) | 0002 (base) | 计算后的费用 |
| total_cost | Nullable(Decimal64(12)) | 0002 (base) | 总费用 |
| completion_start_time | Nullable(DateTime64(3)) | 0002 (base) | 首 token 时间 (TTFT) |
| prompt_id | Nullable(String) | 0002 (base) | Prompt ID |
| prompt_name | Nullable(String) | 0002 (base) | Prompt 名称 |
| prompt_version | Nullable(UInt16) | 0002 (base) | Prompt 版本 |
| usage_pricing_tier_id | Nullable(String) | 0031 | 计费层级 ID |
| usage_pricing_tier_name | Nullable(String) | 0031 | 计费层级名称 |
| tool_definitions | Map(String, String) | 0033 | 工具定义 |
| tool_calls | Array(String) | 0033 | 工具调用参数 JSON 数组 |
| tool_call_names | Array(String) | 0033 | 工具调用名称数组 |
| created_at | DateTime64(3) | 0002 (base) | 创建时间 |
| updated_at | DateTime64(3) | 0002 (base) | 更新时间 |
| event_ts | DateTime64(3) | 0002 (base) | ReplacingMergeTree 去重版本 |
| is_deleted | UInt8 | 0002 (base) | 软删除标记 |

### 2.3 分析视图

系统自动创建分析视图用于仪表盘和统计：

- `analytics_traces`: 按小时聚合的 trace 统计 (`0019_analytics_traces.up.sql`)
- `analytics_observations`: 按小时+类型聚合的观测统计 (`0020_analytics_observations.up.sql`)

---

## 3. 完整写入路径

### 3.1 总体架构

Langfuse 支持 **两条独立写入路径**：

```
                    ┌──────────────┐
                    │   外部调用方   │
                    └──────┬───────┘
                           │
             ┌─────────────┼─────────────┐
             │                          │
        Langfuse SDK             OpenTelemetry
      /api/public/ingestion    /api/public/otel/v1/traces
             │                          │
             ▼                          ▼
     ┌──────────────┐          ┌──────────────┐
     │  Ingestion   │          │     OTEL     │
     │   主路径     │          │   独立路径    │
     └──────┬───────┘          └──────┬───────┘
             │                       │
             └──────────┬────────────┘
                        │
                        ▼
               ┌─────────────────┐
               │  IngestionService │
               │  + ClickhouseWriter│
               └────────┬────────┘
                        │
                        ▼
               ┌─────────────────┐
               │    ClickHouse   │
               └─────────────────┘
```

### 3.2 Ingestion 主路径 (Langfuse SDK)

#### 3.2.1 流程概览

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           外部调用方 (SDK/API)                                    │
└───────────────────────────────┬─────────────────────────────────────────────────┘
                                │ POST /api/public/ingestion
                                ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          web 容器 - Ingestion API                                │
│  1. CORS 处理                                                                    │
│  2. 认证 (ApiAuthService.verifyAuthHeaderAndReturnScope)                         │
│  3. 限流检查 (RateLimitService)                                                  │
│  4. 调用 processEventBatch()                                                     │
└───────────────────────────────┬─────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                   processEventBatch - S3 上传 + 入队                              │
│  1. Schema 验证 + 权限检查                                                       │
│  2. 按 (entityType-eventBodyId) 分组                                              │
│  3. S3 上传 (并行)                                                                │
│     - 路径: {prefix}/{projectId}/{entityType}/{eventBodyId}/{timestamp}.json    │
│     - 检测到 SlowDown 错误 → 标记 project (markProjectS3Slowdown)                │
│  4. 判断 skipS3List:                                                             │
│     - OTEL 来源项目: true                                                        │
│     - LANGFUSE_SKIP_S3_LIST_FOR_OBSERVATIONS_PROJECT_IDS 包含: true              │
│     - dataset_run_item 类型: true                                               │
│  5. 提交到 IngestionQueue                                                        │
│     - delay: getDelay() - 分段逻辑:                                               │
│       * 跨日窗口 (UTC 23:45-00:15): LANGFUSE_INGESTION_QUEUE_DELAY_MS (默认 15s)  │
│       * API 常态 (其他时间): min(5000, LANGFUSE_INGESTION_QUEUE_DELAY_MS) = 5s    │
│       * OTEL 来源: 0s                                                             │
│     - shardingKey: projectId-eventBodyId                                         │
└───────────────────────────────┬─────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           Redis - BullMQ 队列                                     │
│                                                                                  │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │              IngestionQueue (主队列)                                        │  │
│  │  - 队列名: ingestion-queue[-{shardId}]                                     │  │
│  │  - 分片数: LANGFUSE_INGESTION_QUEUE_SHARD_COUNT (默认 1)                    │  │
│  │  - 重试: 6 次，指数退避 (5s 起始)                                           │  │
│  │  - 路由条件: 无 (默认路径)                                                   │  │
│  └──────────────────────────┬────────────────────────────────────────────────┘  │
│                             │                                                   │
│                             │ 重定向检查?                                        │
│                             ├─────────── YES ──────────────┐                    │
│                             │                              │                    │
│                             │ 条件:                          │                    │
│                             │  1. enableRedirectToSecondary │                    │
│                             │     (主队列处理器传入 true)     │                    │
│                             │  2. 任一满足:                  │                    │
│                             │     - env 配置列表包含 project  │                    │
│                             │       (SECONDARY_INGESTION_    │                    │
│                             │        QUEUE_ENABLED_PROJECT_  │                    │
│                             │        IDS)                     │                    │
│                             │     - Redis 标记 S3 SlowDown    │                    │
│                             │       (hasS3SlowdownFlag)      │                    │
│                             │                              │                    │
│                             ▼                              ▼                    │
│  ┌───────────────────────────────────┐  ┌───────────────────────────────────┐  │
│  │   SecondaryIngestionQueue (降级)   │  │   继续主队列处理                   │  │
│  │  - 队列名: secondary-ingestion-   │  │                                   │  │
│  │    queue[-{shardId}]             │  │  - 不重定向，直接消费               │  │
│  │  - 分片数: LANGFUSE_INGESTION_    │  │  - 重试: 6 次                      │  │
│  │    SECONDARY_QUEUE_SHARD_COUNT   │  │                                   │  │
│  │    (默认 1)                       │  │                                   │  │
│  │  - 重试: 5 次                     │  │                                   │  │
│  │  - 路由条件:                      │  │                                   │  │
│  │    enableRedirectToSecondary     │  │                                   │  │
│  │    传入 false                    │  │                                   │  │
│  └───────────────┬───────────────────┘  └───────────────────┬───────────────┘  │
│                  │                                          │                  │
│                  └──────────────────┬───────────────────────┘                  │
│                                     │                                          │
└─────────────────────────────────────┼──────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                       worker 容器 - ingestionQueueProcessor                       │
│                                                                                  │
│  1. Redis 去重检查 (5min TTL)                                                    │
│     - Key: langfuse:ingestion:recently-processed:{...}                           │
│                                                                                  │
│  2. S3 下载 (skipS3List 分支)                                                    │
│     ┌───────────────── skipS3List=true ─────────────────┐                        │
│     │                                                   │                        │
│     │  直接下载单个文件:                                 │                        │
│     │  - 路径: {prefix}/{projectId}/{entityType}/      │                        │
│     │           {eventBodyId}/{fileKey}.json            │                        │
│     │  - 跳过 S3 List 操作 (高成本)                      │                        │
│     │  - 适用: OTEL项目、配置项目、dataset_run_item       │                        │
│     │                                                   │                        │
│     └───────────────── skipS3List=false ────────────────┘                        │
│     │                                                   │                        │
│     │  先 List 再批量下载:                               │                        │
│     │  - s3Client.listFiles(s3Prefix)                  │                        │
│     │  - 分批并发下载 (LANGFUSE_S3_CONCURRENT_READS)    │                        │
│     │  - 检测到 SlowDown → 标记 project                  │                        │
│     │                                                   │                        │
│     └─────────────────────────┬─────────────────────────┘                        │
│                               │                                                  │
│  3. 合并事件 + IngestionService                                                  │
│     - 按时间戳排序 (更新事件在后)                                                  │
│     - 调用 ingestionService.mergeAndWrite()                                      │
│     - forwardToEventsTable: 实验性功能写入 events 表                             │
└───────────────────────────────┬─────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           IngestionService                                       │
│                                                                                  │
│  mergeAndWrite(entityType, projectId, eventBodyId, events)                       │
│                                                                                  │
│  按 entityType 分发:                                                              │
│  ├─ trace → processTraceEventList()                                              │
│  ├─ observation → processObservationEventList()  (Span + Generation)             │
│  ├─ score → processScoreEventList()                                              │
│  └─ dataset_run_item → processDatasetRunItemEventList()                          │
│                                                                                  │
│  事件合并逻辑:                                                                    │
│  - 同一 entity 的多个事件按 timestamp 合并                                        │
│  - 更新事件 (GENERATION_UPDATE, SPAN_UPDATE) 排在后面                             │
│                                                                                  │
│  数据丰富 (Generation-like):                                                      │
│  - Prompt 查找 (name + version)                                                  │
│  - Model 匹配 + Token 计算 + Cost 计算                                           │
│  - Metadata 扁平化                                                                │
│  - 时间戳标准化                                                                    │
│                                                                                  │
│  输出: ClickHouse 行数据 + (可选) events 表数据                                    │
└───────────────────────────────┬─────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           ClickhouseWriter                                       │
│                                                                                  │
│  单例模式，内存队列 + 批量写入                                                     │
│                                                                                  │
│  队列结构:                                                                        │
│  - queue.traces                                                                  │
│  - queue.observations                                                            │
│  - queue.scores                                                                  │
│  - queue.dataset_run_items                                                       │
│                                                                                  │
│  触发条件 (任一满足):                                                             │
│  1. 数量触发: queue.length >= batchSize (默认 1000)                               │
│  2. 定时触发: 每 writeInterval ms (默认 1000ms)                                   │
│                                                                                  │
│  写入格式:                                                                        │
│  - INSERT INTO ... FORMAT JSONEachRow                                            │
│                                                                                  │
│  错误处理:                                                                        │
│  - 网络错误: 指数退避重试                                                          │
│  - 超大记录: 截断 input/output/metadata                                           │
│  - 超过 maxAttempts (默认 3): 丢弃并记录 metric                                   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

#### 3.2.2 S3 SlowDown 降级机制详解

**触发条件**: `packages/shared/src/server/redis/s3SlowdownTracking.ts`

```
S3 SlowDown 错误检测:
- err.name === "SlowDown"
- err.Code === "SlowDown"
- err.code === "SlowDown"
- err.message 包含 "SlowDown" 或 "reduce your request rate"

Redis 标记:
- Key: langfuse:s3-slowdown:{projectId}
- TTL: LANGFUSE_S3_RATE_ERROR_SLOWDOWN_TTL_SECONDS (默认 3600s = 1小时)
- 标记后: 该 project 后续事件自动路由到 SecondaryIngestionQueue
```

**配置**:
| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `LANGFUSE_S3_RATE_ERROR_SLOWDOWN_ENABLED` | `"false"` | 是否启用 S3 SlowDown 自动降级 |
| `LANGFUSE_S3_RATE_ERROR_SLOWDOWN_TTL_SECONDS` | `3600` | 降级持续时间 (秒) |
| `LANGFUSE_SECONDARY_INGESTION_QUEUE_ENABLED_PROJECT_IDS` | 空 | 静态配置强制走降级队列的项目 ID 列表 |

#### 3.2.3 skipS3List 机制详解

**配置**: `LANGFUSE_SKIP_S3_LIST_FOR_OBSERVATIONS_PROJECT_IDS` (逗号分隔的项目 ID 列表)

**判断逻辑** (`processEventBatch.ts:278-298`):
```typescript
const shouldSkipS3List =
  isDatasetRunItemEvent || 
  (isObservationEvent && isOtelOrSkipS3Project);

const isOtelOrSkipS3Project =
  projectId !== null &&
  (source === "otel" || projectIdsToSkipS3List.includes(projectId));
```

**效果**:
- **skipS3List=true**: 直接下载单个文件 `{prefix}/{projectId}/{entityType}/{eventBodyId}/{fileKey}.json`
- **skipS3List=false**: 先 `listFiles(s3Prefix)` 列出所有文件，再批量下载

**设计目的**:
- S3 List 操作成本高 (API 计费 + 耗时)
- 对于高吞吐量项目，跳过 List 直接下载可显著降低成本和延迟
- 注意: 需要确保同一 `eventBodyId` 下只有一个文件 (即不会有多个 SDK 并发写入同一实体)

### 3.3 OTEL 独立路径 (OpenTelemetry)

#### 3.3.1 流程概览

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      OTEL Collector / OTEL SDK                                    │
└───────────────────────────────┬─────────────────────────────────────────────────┘
                                │ POST /api/public/otel/v1/traces
                                │ 支持 JSON 和 Protobuf
                                │ 支持 gzip 压缩
                                ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        web 容器 - OTEL API                                       │
│  1. 认证 + 限流                                                                   │
│  2. markProjectAsOtelUser() (记录该项目使用 OTEL)                                 │
│  3. 解析 body:                                                                   │
│     - Protobuf: ExportTraceServiceRequest.decode()                               │
│     - JSON: JSON.parse()                                                         │
│  4. 提取 SDK headers:                                                            │
│     - x-langfuse-sdk-name / x-langfuse-sdk-version                               │
│     - x-langfuse-ingestion-version (>=4 表示新 SDK)                               │
│  5. OtelIngestionProcessor.publishToOtelIngestionQueue()                         │
└───────────────────────────────┬─────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│              OtelIngestionProcessor.publishToOtelIngestionQueue()                │
│                                                                                  │
│  1. S3 上传原始 resourceSpans:                                                    │
│     - 路径: {prefix}otel/{projectId}/{yyyy}/{mm}/{dd}/{hh}/{mm}/{uuid}.json     │
│     - 按时间目录分桶，便于按时间范围回放                                            │
│                                                                                  │
│  2. 提交到 OtelIngestionQueue:                                                   │
│     - payload 包含: fileKey, publicKey, auth, propagatedHeaders,                │
│                     sdkName, sdkVersion, ingestionVersion                       │
└───────────────────────────────┬─────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           Redis - BullMQ 队列                                     │
│                                                                                  │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │              OtelIngestionQueue (主队列)                                     │  │
│  │  - 队列名: otel-ingestion-queue[-{shardId}]                                 │  │
│  │  - 分片数: LANGFUSE_OTEL_INGESTION_QUEUE_SHARD_COUNT (默认 1)               │  │
│  │  - 重试: 6 次，指数退避 (5s 起始)                                           │  │
│  └──────────────────────────┬────────────────────────────────────────────────┘  │
│                             │                                                   │
│                             │ 重定向检查?                                        │
│                             ├─────────── YES ──────────────┐                    │
│                             │                              │                    │
│                             │ 条件:                          │                    │
│                             │  1. enableRedirectToSecondary │                    │
│                             │  2. 任一满足:                  │                    │
│                             │     - env 配置列表包含 project  │                    │
│                             │       (SECONDARY_OTEL_       │                    │
│                             │        INGESTION_QUEUE_      │                    │
│                             │        ENABLED_PROJECT_IDS)  │                    │
│                             │     - Redis 标记 S3 SlowDown    │                    │
│                             │                              │                    │
│                             ▼                              ▼                    │
│  ┌───────────────────────────────────┐  ┌───────────────────────────────────┐  │
│  │  SecondaryOtelIngestionQueue     │  │   继续主队列处理                   │  │
│  │  (降级队列)                       │  │                                   │  │
│  │  - 队列名: secondary-otel-       │  │  - 不重定向，直接消费               │  │
│  │    ingestion-queue[-{shardId}]  │  │                                   │  │
│  │  - 分片数: LANGFUSE_OTEL_        │  │                                   │  │
│  │    INGESTION_SECONDARY_QUEUE_   │  │                                   │  │
│  │    SHARD_COUNT (默认 1)          │  │                                   │  │
│  │  - 重试: 5 次                     │  │                                   │  │
│  └───────────────┬───────────────────┘  └───────────────────┬───────────────┘  │
│                  │                                          │                  │
│                  └──────────────────┬───────────────────────┘                  │
│                                     │                                          │
└─────────────────────────────────────┼──────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    worker 容器 - otelIngestionQueueProcessor                      │
│                                                                                  │
│  1. 重定向检查 (同 ingestion 主路径)                                              │
│                                                                                  │
│  2. S3 下载原始 resourceSpans:                                                    │
│     - OTEL 路径总是单个文件 (按时间目录)                                           │
│     - 解析 JSON 或 Protobuf                                                      │
│                                                                                  │
│  3. 应用 ingestion masking (EE 功能):                                             │
│     - 失败时 fail-closed: 丢弃事件                                                │
│     - 记录 S3 fileKey 便于后续回放                                                │
│                                                                                  │
│  4. OTEL → Langfuse 事件转换:                                                     │
│     - OtelIngestionProcessor.processToIngestionEvents()                          │
│     - 输出: IngestionEventType[] (trace + observation 混合)                       │
│                                                                                  │
│  5. 分流处理:                                                                     │
│     ┌──────────────── traces ────────────────┐                                   │
│     │                                         │                                   │
│     │  走 processEventBatch 完整路径:          │                                   │
│     │  - S3 上传 (delay=0, source="otel")     │                                   │
│     │  - IngestionQueue                       │                                   │
│     │  - ingestionQueueProcessor              │                                   │
│     │                                         │                                   │
│     └─────────────── observations ────────────┘                                   │
│     │                                         │                                   │
│     │  直接调用 IngestionService:              │                                   │
│     │  - ingestionSchema 验证                  │                                   │
│     │  - 每条 observation 单独 mergeAndWrite   │                                   │
│     │  - 跳过 S3 存储 (已在 OTEL 层存储原始数据)  │                                   │
│     │                                         │                                   │
│     └─────────────────────────────────────────┘                                   │
│                                                                                  │
│  6. Write Path 判断 (direct vs dual):                                            │
│                                                                                  │
│     优先级 1: Header 判断 (batch 级别)                                             │
│     - ingestionVersion >= 4: direct                                              │
│     - python-sdk >= 4.0.0: direct                                                │
│     - javascript-sdk >= 5.0.0: direct                                            │
│                                                                                  │
│     优先级 2: Scope 判断 (fallback)                                              │
│     - scope.name 包含 "langfuse"                                                 │
│     - environment === "sdk-experiment"                                           │
│     - python >= 3.9.0 或 javascript >= 4.4.0                                     │
│                                                                                  │
│     写入路径标记:                                                                 │
│     - direct_header: Header 判断命中                                            │
│     - direct_scope: Scope 判断命中                                               │
│     - dual: 都不命中，走旧路径                                                   │
│                                                                                  │
│  7. Observation Eval 调度 + Direct Event Write:                                  │
│     - processor.processToEvent() →  enriched event records                      │
│     - 如果有 eval configs: scheduleObservationEvals()                            │
│     - 如果 direct write 且实验开启: 直接写入 events 表                            │
└─────────────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼ (observations 分支)
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    IngestionService + ClickhouseWriter                            │
│  (同主路径，略)                                                                   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

#### 3.3.2 OTEL 路径与 Ingestion 主路径的关键区别

| 维度 | Ingestion 主路径 | OTEL 独立路径 |
|------|-----------------|---------------|
| **API 入口** | `/api/public/ingestion` | `/api/public/otel/v1/traces` |
| **原始数据格式** | Langfuse 事件 JSON | OTEL ResourceSpans (JSON/Protobuf) |
| **S3 路径** | `{projectId}/{entityType}/{eventBodyId}/` | `otel/{projectId}/{yyyy}/{mm}/{dd}/{hh}/{mm}/` |
| **队列** | IngestionQueue | OtelIngestionQueue |
| **事件转换时机** | web 容器 (SDK 已转换) | worker 容器 (OTEL→Langfuse) |
| **traces 处理** | 直接走 IngestionService | 走 processEventBatch 完整路径 |
| **observations 处理** | 走 IngestionService | 直接调用 IngestionService.mergeAndWrite() |
| **skipS3List** | 条件性 (OTEL 项目/配置项目) | 总是 true (OTEL source) |
| **write path 判断** | 无 | 有 (direct vs dual) |

### 3.4 关键配置参数汇总

#### 队列与延迟

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `LANGFUSE_INGESTION_QUEUE_DELAY_MS` | `15000` | ingestion 队列延迟 (毫秒) |
| `LANGFUSE_INGESTION_QUEUE_SHARD_COUNT` | `1` | ingestion 主队列分片数 |
| `LANGFUSE_INGESTION_SECONDARY_QUEUE_SHARD_COUNT` | `1` | ingestion 降级队列分片数 |
| `LANGFUSE_OTEL_INGESTION_QUEUE_SHARD_COUNT` | `1` | OTEL 主队列分片数 |
| `LANGFUSE_OTEL_INGESTION_SECONDARY_QUEUE_SHARD_COUNT` | `1` | OTEL 降级队列分片数 |

#### S3 相关

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `LANGFUSE_S3_LIST_MAX_KEYS` | `200` | S3 List 单次最大数量 |
| `LANGFUSE_S3_CONCURRENT_READS` | 查看代码 | S3 并发下载数 |
| `LANGFUSE_SKIP_S3_LIST_FOR_OBSERVATIONS_PROJECT_IDS` | 空 | 跳过 S3 List 的项目列表 |
| `LANGFUSE_S3_RATE_ERROR_SLOWDOWN_ENABLED` | `"false"` | 启用 S3 SlowDown 自动降级 |
| `LANGFUSE_S3_RATE_ERROR_SLOWDOWN_TTL_SECONDS` | `3600` | S3 SlowDown 标记 TTL |
| `LANGFUSE_SECONDARY_INGESTION_QUEUE_ENABLED_PROJECT_IDS` | 空 | 强制走 ingestion 降级队列的项目 |
| `LANGFUSE_SECONDARY_OTEL_INGESTION_QUEUE_ENABLED_PROJECT_IDS` | 空 | 强制走 OTEL 降级队列的项目 |

#### ClickHouse 写入

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `LANGFUSE_INGESTION_CLICKHOUSE_WRITE_BATCH_SIZE` | `1000` | 批量写入触发数量 |
| `LANGFUSE_INGESTION_CLICKHOUSE_WRITE_INTERVAL_MS` | `1000` | 批量写入触发间隔 |
| `LANGFUSE_INGESTION_CLICKHOUSE_MAX_ATTEMPTS` | `3` | 写入失败重试次数 |

### 3.5 延迟层级总结

| 层级 | 延迟点 | 默认值 | 可配置 | 目的 |
|------|--------|--------|--------|------|
| L1 | API 响应 | 立即 | 否 | 快速响应 SDK，不阻塞调用方 |
| L2 | S3 上传 | 同步 | 否 | 持久化原始事件，防止丢失 |
| L3 | 队列延迟 (getDelay) | 分段 | `LANGFUSE_INGESTION_QUEUE_DELAY_MS` | 避免短时间内重复处理同一实体 |
|    | ├─ 跨日窗口 (UTC 23:45-00:15) | 15s | `LANGFUSE_INGESTION_QUEUE_DELAY_MS` (默认 15000) | 避免跨天分区的乱序处理 |
|    | ├─ API 常态 (其他时间) | 5s | `min(5000, delay_ms)` | 避免 worker 端重复处理 |
|    | └─ OTEL 来源 | 0s | 固定值 | 无额外延迟 |
| L4 | ClickHouse 批量 | 1s / 1000条 | `WRITE_BATCH_SIZE`, `WRITE_INTERVAL_MS` | 优化 ClickHouse 写入性能 |

---

## 4. 批量与实时的取舍设计

### 4.1 为什么选择异步队列 + 批量写入？

**优势**:
1. **API 解耦**: SDK 调用快速返回，不被后端处理阻塞
2. **流量削峰**: Redis 队列缓冲突发流量
3. **事件合并**: 同一 trace/span 的多次 PATCH 可以合并处理
4. **ClickHouse 优化**: ClickHouse 不适合小批量高频写入，批量写入显著提升性能
5. **故障隔离**: 任一环节故障不影响上游调用
6. **可回放性**: S3 存储原始事件，支持重放 (`replayIngestionEventsV2`)

**代价**:
1. **最终一致性**: 数据从调用到可见有延迟 (典型 15-20s)
2. **复杂度增加**: 需要处理 S3、Redis、ClickHouse 多系统协同
3. **失败处理**: 需要考虑重试、截断、丢弃等策略

### 4.2 为什么 Span 和 Generation 存在同一张表？

**设计考量**:
1. **查询模式相似**: 都按 `(project_id, trace_id)` 查询
2. **字段高度重叠**: 共享 `trace_id`、`parent_id`、时间戳、元数据等字段
3. **低基数区分**: `type` 字段使用 LowCardinality 编码，存储开销极小
4. **查询灵活**: 可按类型过滤，也可联合查询整个调用链
5. **演进性**: 支持通过增量迁移添加新字段 (如 tool_definitions)

**代价**:
1. **稀疏字段**: Span 不使用的 Generation 字段 (model, usage, cost 等) 占用空间
2. **索引共享**: 无法为 Generation 专属字段建立独立索引

### 4.3 降级队列的设计考量

**主队列 vs 降级队列**:
| 特性 | 主队列 | 降级队列 |
|------|--------|---------|
| 重试次数 | 6 次 | 5 次 |
| 分片配置 | 独立 | 独立 |
| Worker 并发 | 独立配置 | 独立配置 |
| 路由条件 | 默认 | env 配置或 S3 SlowDown |

**设计目的**:
1. **S3 限流隔离**: S3 被限流的项目不影响其他项目
2. **灰度测试**: 可将特定项目路由到降级队列进行功能灰度
3. **负载隔离**: 高吞吐量项目与低吞吐量项目隔离
4. **故障域隔离**: 降级队列有独立的 worker 池，主队列故障不影响降级队列

### 4.4 skipS3List 的设计考量

**S3 List vs 直接下载**:
| 操作 | API 成本 | 延迟 | 适用场景 |
|------|---------|------|---------|
| List + 批量下载 | 高 (List + N 次 Get) | 高 | 多事件更新同一实体 |
| 直接下载 | 低 (1 次 Get) | 低 | 单事件，SDK 保证唯一写入 |

**skipS3List 的前提假设**:
- SDK 不会并发写入同一 `eventBodyId`
- 同一实体在 S3 中只有一个文件
- 这个假设对于现代 Langfuse SDK (>=4.0.0 python, >=5.0.0 js) 成立

---

## 5. 关键文件索引

| 功能 | 文件路径 | 关键行 |
|------|----------|--------|
| Trace 领域模型 | `packages/shared/src/domain/traces.ts` | 12-32 |
| Observation 领域模型 | `packages/shared/src/domain/observations.ts` | 5-156 |
| Traces 表基础建表 | `packages/shared/clickhouse/migrations/unclustered/0001_traces.up.sql` | 1-32 |
| Observations 表基础建表 | `packages/shared/clickhouse/migrations/unclustered/0002_observations.up.sql` | 1-46 |
| Observations tool_call 字段 | `packages/shared/clickhouse/migrations/unclustered/0033_add_tool_call_columns.up.sql` | 1-3 |
| Observations pricing_tier 字段 | `packages/shared/clickhouse/migrations/unclustered/0031_add_usage_pricing_tier_columns.up.sql` | 1-2 |
| S3 SlowDown 标记逻辑 | `packages/shared/src/server/redis/s3SlowdownTracking.ts` | 1-74 |
| Ingestion 队列定义 | `packages/shared/src/server/redis/ingestionQueue.ts` | 1-180 |
| OTEL 队列定义 | `packages/shared/src/server/redis/otelIngestionQueue.ts` | 1-189 |
| Ingestion 事件批处理 | `packages/shared/src/server/ingestion/processEventBatch.ts` | 104-356 |
| Ingestion 队列处理器 | `worker/src/queues/ingestionQueue.ts` | 29-305 |
| OTEL 队列处理器 | `worker/src/queues/otelIngestionQueue.ts` | 41-500 |
| OTEL 事件处理器 | `packages/shared/src/server/otel/OtelIngestionProcessor.ts` | 1-500 |
| OTEL API 入口 | `web/src/pages/api/public/otel/v1/traces/index.ts` | 1-190 |
| IngestionService | `worker/src/services/IngestionService/index.ts` | 137-195, 212-387 |
| ClickHouse 写入器 | `worker/src/services/ClickhouseWriter/index.ts` | 32-597 |
| 环境变量定义 | `packages/shared/src/env.ts` | 99-244 |

---

## 6. 总结

Langfuse 的追踪数据模型采用 **"两级物理表 + 类型字段区分 + 增量迁移演化"** 的设计：

### 数据模型
1. **Trace 独立表**: 顶层追踪，粒度大、字段少
2. **Observations 统一表**: Span、Generation 及其他类型共用，通过 `type` 字段区分
3. **增量迁移演进**: observations 表从基础 schema 开始，通过多次 ALTER TABLE 添加环境、metadata 索引、计费层级、工具调用等字段

### 写入路径
1. **双路径架构**: Ingestion 主路径 (Langfuse SDK) + OTEL 独立路径 (OpenTelemetry)
2. **主队列 + 降级队列**: 每条路径都有主队列和降级队列，支持 S3 SlowDown 自动降级和静态配置路由
3. **skipS3List 优化**: 高吞吐量项目可跳过 S3 List 操作，直接下载单个文件
4. **多级延迟**: S3 同步上传 → 队列延迟 (常态 5s, 跨日窗口 15s, OTEL 0s) → ClickHouse 批量 (1s/1000条)

### 核心设计考量
- **ClickHouse 写入友好**: 批量写入、ReplacingMergeTree 幂等更新
- **查询模式优化**: 按 `project_id` + 时间维度的主键/排序键设计
- **故障隔离**: 异步队列 + 重试机制 + S3 原始事件存储保证数据最终一致性和可回放性
- **存储效率**: LowCardinality、ZSTD 压缩、Bloom Filter 索引
- **渐进式演化**: 支持通过增量迁移扩展 schema，无需重建表
