# OpenTelemetry Ingestion Queue Architecture

## 1. 数据接入入口

### 1.1 OTel API 入口

**端点**: `POST /api/public/otel/v1/traces`

**位置**: `web/src/pages/api/public/otel/v1/traces/index.ts`

**接入流程**:

1. **认证与权限检查**
   - 通过 `createAuthedProjectAPIRoute` 进行项目级认证
   - 检查 `isIngestionSuspended` 状态，防止超量使用

2. **请求体处理**
   - 支持 `gzip` 压缩解码
   - 支持两种内容类型:
     - `application/json`: JSON 格式解析
     - `application/x-protobuf`: Protobuf 格式解码（使用生成的类型定义）

3. **请求体大小监控**
   - 超过 16MB 的请求会触发警告日志
   - 日志包含项目ID、字节大小、span 数量

4. **版本验证**
   - 检查 `x-langfuse-ingestion-version` 头
   - 目前支持最大版本为 "4"，更高版本会被拒绝

5. **入队处理**
   - 调用 `OtelIngestionProcessor.publishToOtelIngestionQueue()`
   - 完整的 resourceSpans 批量先上传到 S3，再入队异步处理

### 1.2 头部传递机制

用于 ingestion masking 的头部传递:
```
LANGFUSE_INGESTION_MASKING_PROPAGATED_HEADERS
```
配置的头部会从请求中提取并传递到队列 payload。

---

## 2. 队列优先级与分级架构

### 2.1 队列分层设计

Langfuse 采用**两级队列架构**来实现优先级隔离和负载保护:

```
                    ┌─────────────────────────┐
                    │    OtelIngestionQueue   │  ← 主队列（高优先级）
                    │    (otel-ingestion-     │
                    │     queue-{shard})      │
                    └────────────┬────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
┌─────────▼─────────┐  ┌────────▼─────────┐  ┌──────────▼──────────┐
│  环境配置分流    │  │  S3 SlowDown 检测 │  │   正常处理流程      │
│ LANGFUSE_SECONDARY│  │  标记项目自动    │  │    (主队列消费)     │
│ _OTEL_INGESTION   │  │  路由到二级队列  │  │                     │
│ _QUEUE_ENABLED    │  │                  │  │                     │
│ _PROJECT_IDS      │  │                  │  │                     │
└─────────┬─────────┘  └────────┬─────────┘  └─────────────────────┘
          │                     │
          └─────────────────────┘
                    │
          ┌─────────▼─────────┐
          │ SecondaryOtel-    │  ← 二级队列（低优先级/隔离）
          │   IngestionQueue  │
          │ (secondary-otel-  │
          │  ingestion-queue) │
          └───────────────────┘
```

### 2.2 分流条件

**主队列 → 二级队列** 的分流条件:

| 触发条件 | 检测位置 | 说明 |
|---------|---------|------|
| **环境配置** | `app.ts` 启动时 | 通过 `LANGFUSE_SECONDARY_OTEL_INGESTION_QUEUE_ENABLED_PROJECT_IDS` 配置指定项目列表 |
| **S3 SlowDown 错误** | `ingestionQueue.ts` 处理时 | 当 S3 返回 503 SlowDown 时，调用 `markProjectS3Slowdown()` 标记项目 |

### 2.3 队列配置对比

| 参数 | 主队列 (OtelIngestionQueue) | 二级队列 (SecondaryOtelIngestionQueue) |
|------|----------------------------|---------------------------------------|
| **重试次数** | 6次 | 5次 |
| **重试策略** | 指数退避，延迟5000ms | 指数退避，延迟5000ms |
| **分片支持** | ✓ 支持 Redis Cluster 分片 | ✓ 支持 Redis Cluster 分片 |
| **分片 Key** | `{projectId}-{fileKey}` | `{projectId}-{fileKey}` |
| **消费并发** | 环境变量配置 | 环境变量配置（通常更低） |

### 2.4 分片机制

**分片数量配置**:
- 主队列: `LANGFUSE_OTEL_INGESTION_QUEUE_SHARD_COUNT`
- 二级队列: `LANGFUSE_OTEL_INGESTION_SECONDARY_QUEUE_SHARD_COUNT`

**分片算法**:
```typescript
// 位置: packages/shared/src/server/redis/sharding.ts
// 使用 projectId + fileKey 作为分片键
const shardingKey = `${projectId}-${fileKey}`;
// 基于哈希值映射到分片索引
```

**设计目的**:
- 实现 Redis Cluster 水平扩展
- 同一项目的消息路由到相同分片，保证顺序性
- 避免热点分片

---

## 3. 消费节奏控制

### 3.1 消费者注册

**位置**: `worker/src/app.ts`

```typescript
// 主队列消费者
if (env.QUEUE_CONSUMER_OTEL_INGESTION_QUEUE_IS_ENABLED === "true") {
  const shardNames = OtelIngestionQueue.getShardNames();
  shardNames.forEach((shardName) => {
    WorkerManager.register(
      shardName as QueueName,
      otelIngestionQueueProcessorBuilder(true),  // true = 可重定向到二级队列
      {
        concurrency: env.LANGFUSE_OTEL_INGESTION_QUEUE_PROCESSING_CONCURRENCY,
      },
    );
  });
}

// 二级队列消费者
if (env.QUEUE_CONSUMER_OTEL_INGESTION_SECONDARY_QUEUE_IS_ENABLED === "true") {
  const shardNames = SecondaryOtelIngestionQueue.getShardNames();
  shardNames.forEach((shardName) => {
    WorkerManager.register(
      shardName as QueueName,
      otelIngestionQueueProcessorBuilder(false),  // false = 不再重定向
      {
        concurrency: env.LANGFUSE_OTEL_INGESTION_SECONDARY_QUEUE_PROCESSING_CONCURRENCY,
      },
    );
  });
}
```

### 3.2 并发控制参数

| 环境变量 | 作用 | 默认/典型值 |
|---------|------|------------|
| `LANGFUSE_OTEL_INGESTION_QUEUE_PROCESSING_CONCURRENCY` | 主队列每个分片的并发数 | 需查看 env |
| `LANGFUSE_OTEL_INGESTION_SECONDARY_QUEUE_PROCESSING_CONCURRENCY` | 二级队列每个分片的并发数 | 需查看 env |
| `LANGFUSE_OTEL_INGESTION_QUEUE_SHARD_COUNT` | 主队列分片总数 | 需查看 env |
| `LANGFUSE_OTEL_INGESTION_SECONDARY_QUEUE_SHARD_COUNT` | 二级队列分片总数 | 需查看 env |

**总消费能力计算**:
```
主队列总并发 = 分片数 × 单分片并发数
二级队列总并发 = 分片数 × 单分片并发数
```

### 3.3 队列重试配置

**主队列重试策略** (`otelIngestionQueue.ts`):
```typescript
defaultJobOptions: {
  removeOnComplete: true,
  removeOnFail: 100_000,  // 保留最近10万条失败记录
  attempts: 6,            // 最多重试6次
  backoff: {
    type: "exponential",  // 指数退避
    delay: 5000,          // 初始延迟5秒
  },
}
```

**重试延迟序列**:
1. 第1次重试: 5秒
2. 第2次重试: 10秒
3. 第3次重试: 20秒
4. 第4次重试: 40秒
5. 第5次重试: 80秒
6. 第6次重试: 160秒

---

## 4. 回压与隔离机制

### 4.1 S3 SlowDown 检测与自动降级

**位置**: `worker/src/queues/ingestionQueue.ts`

```typescript
catch (e) {
  // Check if this is a SlowDown error and mark the project for secondary queue
  if (isS3SlowDownError(e)) {
    const projectId = job.data.payload.authCheck.scope.projectId;
    logger.warn(
      "S3 SlowDown error during ingestion processing, marking project for secondary queue",
      { projectId, error: e },
    );
    await markProjectS3Slowdown(projectId);
  }
  // ...
}
```

**工作流程**:
1. 消费作业时检测到 S3 503 SlowDown 错误
2. 调用 `markProjectS3Slowdown(projectId)` 标记项目
3. 该项目后续的所有新消息会自动路由到二级队列
4. 二级队列使用独立的消费者池，不影响主队列正常项目

### 4.2 二级队列作为断路器

**设计意图**:
- **故障隔离**: S3 限流影响的项目不会拖慢整个系统
- **资源保护**: 高负载项目被隔离，防止资源耗尽
- **优雅降级**: 二级队列可以配置更低的并发，避免雪崩

**二级队列的特性**:
1. 独立的分片配置
2. 独立的并发配置
3. 独立的重试策略（更少的重试次数）
4. 不再重定向（避免无限循环）

### 4.3 内存与流量控制

**S3 文件下载优化**:

```typescript
// 位置: worker/src/queues/ingestionQueue.ts
const S3_CONCURRENT_READS = env.LANGFUSE_S3_CONCURRENT_READS;
const batches = chunk(eventFiles, S3_CONCURRENT_READS);
for (const batch of batches) {
  const batchEvents = await Promise.all(
    batch.map(downloadAndParseFile),
  );
  events.push(...batchEvents.flat());
}
```

**控制机制**:
- 批量并行下载 S3 文件，限制并发数
- 避免瞬间大量网络请求耗尽连接池
- 通过 `LANGFUSE_S3_CONCURRENT_READS` 调优

### 4.4 重复事件防御

**位置**: `worker/src/queues/ingestionQueue.ts`

```typescript
if (env.LANGFUSE_ENABLE_REDIS_SEEN_EVENT_CACHE === "true" && redis) {
  const key = `langfuse:ingestion:recently-processed:${projectId}:${type}:${eventBodyId}:${fileKey}`;
  const exists = await redis.exists(key);
  if (exists) {
    recordIncrement("langfuse.ingestion.recently_processed_cache", 1, {
      type: job.data.payload.data.type,
      skipped: "true",
    });
    logger.debug(`Skipping ingestion event ${fileKey} for project ${projectId}`);
    return;  // 跳过已处理事件
  }
}
```

**缓存策略**:
- Redis SETEX，TTL 5分钟
- 防止同一事件被重复处理
- 降低 S3 下载压力和 ClickHouse 写入压力

---

## 5. 写路径决策（Write Path Selection）

### 5.1 两种写路径

OTel ingestion 支持两种写路径策略，基于 SDK 版本自动选择:

```
                  ┌─────────────────────┐
                  │  接收到 OTel Span   │
                  └──────────┬──────────┘
                             │
              ┌──────────────▼──────────────┐
              │   检查 HTTP 头 / SDK 版本   │
              │  x-langfuse-sdk-name/version│
              │  x-langfuse-ingestion-version │
              └──────────────┬──────────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
┌─────────▼────────┐  ┌──────▼───────┐  ┌──────▼────────┐
│  版本 >= 要求    │  │  sdk-experiment │  │   版本不足     │
│  (Python >=4.0.0,│  │  + 作用域匹配  │  │   使用双写     │
│   JS >=5.0.0)    │  │               │  │   (Dual Write) │
└─────────┬────────┘  └──────┬───────┘  └──────┬────────┘
          │                   │                   │
          └───────────────────┼───────────────────┘
                              │
                  ┌───────────▼───────────┐
                  │   写入路径选择        │
                  │                       │
                  │  Path A: Dual Write   │ ← 默认路径，双写到 staging + batch
                  │  Path B: Direct Write │ ← 直写 events 表（新SDK）
                  └───────────────────────┘
```

### 5.2 写路径判定逻辑

**位置**: `worker/src/queues/otelIngestionQueue.ts`

**优先级 1: HTTP 头部判定**（批级别决策）
- `x-langfuse-sdk-name` + `x-langfuse-sdk-version`
  - Python SDK >= 4.0.0
  - JavaScript SDK >= 5.0.0
- `x-langfuse-ingestion-version` == "4"

**优先级 2: 作用域 + 环境判定**（回退逻辑）
- scope.name 包含 "langfuse"
- environment == "sdk-experiment"
- Python SDK >= 3.9.0 或 JS SDK >= 4.4.0

### 5.3 写路径指标统计

```typescript
recordIncrement("langfuse.ingestion.otel.write_path", 1, {
  path: writePath,  // "direct_header" | "direct_scope" | "dual"
});
```

可通过监控面板观察各路径的分布情况。

---

## 6. 关键代码位置索引

| 功能模块 | 文件路径 |
|---------|---------|
| **OTel API 入口** | `web/src/pages/api/public/otel/v1/traces/index.ts` |
| **OTel 处理器** | `packages/shared/src/server/otel/OtelIngestionProcessor.ts` |
| **OTel 队列定义** | `packages/shared/src/server/redis/otelIngestionQueue.ts` |
| **普通 Ingestion 队列** | `packages/shared/src/server/redis/ingestionQueue.ts` |
| **OTel 消费者逻辑** | `worker/src/queues/otelIngestionQueue.ts` |
| **Ingestion 消费者逻辑** | `worker/src/queues/ingestionQueue.ts` |
| **Worker 注册与配置** | `worker/src/app.ts` |
| **队列类型定义** | `packages/shared/src/server/queues.ts` |
| **分片算法** | `packages/shared/src/server/redis/sharding.ts` |
| **Worker Manager** | `worker/src/queues/workerManager.ts` |

---

## 7. 配置参数汇总

### 7.1 队列开关

```
QUEUE_CONSUMER_OTEL_INGESTION_QUEUE_IS_ENABLED
QUEUE_CONSUMER_OTEL_INGESTION_SECONDARY_QUEUE_IS_ENABLED
QUEUE_CONSUMER_INGESTION_QUEUE_IS_ENABLED
QUEUE_CONSUMER_INGESTION_SECONDARY_QUEUE_IS_ENABLED
```

### 7.2 并发与分片

```
LANGFUSE_OTEL_INGESTION_QUEUE_PROCESSING_CONCURRENCY
LANGFUSE_OTEL_INGESTION_SECONDARY_QUEUE_PROCESSING_CONCURRENCY
LANGFUSE_OTEL_INGESTION_QUEUE_SHARD_COUNT
LANGFUSE_OTEL_INGESTION_SECONDARY_QUEUE_SHARD_COUNT
LANGFUSE_INGESTION_QUEUE_PROCESSING_CONCURRENCY
LANGFUSE_INGESTION_SECONDARY_QUEUE_PROCESSING_CONCURRENCY
LANGFUSE_INGESTION_QUEUE_SHARD_COUNT
LANGFUSE_INGESTION_SECONDARY_QUEUE_SHARD_COUNT
```

### 7.3 项目分流配置

```
LANGFUSE_SECONDARY_OTEL_INGESTION_QUEUE_ENABLED_PROJECT_IDS
LANGFUSE_SECONDARY_INGESTION_QUEUE_ENABLED_PROJECT_IDS
```

逗号分隔的项目 ID 列表，这些项目会直接路由到二级队列。

### 7.4 缓存与优化

```
LANGFUSE_ENABLE_REDIS_SEEN_EVENT_CACHE
LANGFUSE_S3_CONCURRENT_READS
```

---

## 8. 监控指标

### 8.1 Ingestion 相关指标

| 指标名称 | 标签 | 说明 |
|---------|------|------|
| `langfuse.ingestion.event` | `source=otel` | 处理的 observation 数量 |
| `langfuse.ingestion.otel.trace_count` | - | 处理的 trace 数量 |
| `langfuse.ingestion.otel.observation_count` | - | 处理的 observation 数量 |
| `langfuse.ingestion.otel.write_path` | `path=direct_header/direct_scope/dual` | 写路径分布 |
| `langfuse.ingestion.recently_processed_cache` | `skipped=true/false` | 重复事件缓存命中 |
| `langfuse.ingestion.s3_file_size_bytes` | `skippedS3List, otel` | S3 文件大小分布 |
| `langfuse.ingestion.count_files_distribution` | `kind` | 每个事件的文件数分布 |

---

## 总结

Langfuse 的 ingestion 队列系统是一个**分层、分片、自适应**的架构:

1. **两级队列**实现优先级隔离，二级队列作为系统的"安全气囊"
2. **自动降级**机制检测 S3 限流并自动路由受影响项目
3. **分片架构**支持水平扩展，避免单点瓶颈
4. **精细的并发控制**在每个层面都有调优参数
5. **多写路径策略**根据 SDK 版本自动选择最优的写入方案

这种设计使得系统能够:
- 承受突发流量冲击
- 隔离故障项目
- 优雅降级而非雪崩
- 根据负载自动调整处理节奏
