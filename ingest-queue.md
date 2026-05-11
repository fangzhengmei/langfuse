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
     - `application/x-protobuf`: Protobuf 格式解码

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

## 2. 队列分层架构与分片机制

Langfuse 存在**两组独立的两级队列**，每组都有主队列和二级队列：

| 队列组 | 主队列 | 二级队列 |
|-------|-------|---------|
| **OTel Ingestion** | `OtelIngestionQueue` | `SecondaryOtelIngestionQueue` |
| **普通 Ingestion** | `IngestionQueue` | `SecondaryIngestionQueue` |

> **重要**：这两组队列的分流机制、触发条件和处理路径存在显著差异，详见第 4 章。

### 2.1 分片算法详解

**位置**: `packages/shared/src/server/redis/sharding.ts`

```typescript
export function getShardIndex(key: string, shardCount: number): number {
  if (shardCount <= 1) return 0;

  // 使用 SHA-256 哈希
  const hash = createHash("sha256").update(key).digest("hex");

  // 取前 8 个十六进制字符转为整数
  const hashInt = parseInt(hash.substring(0, 8), 16);

  // 映射到分片索引
  return hashInt % shardCount;
}
```

### 2.2 分片键对顺序性的实际影响

#### 分片键构成

| 队列 | 分片键构成 | 说明 |
|-----|-----------|------|
| **OtelIngestionQueue** | `{projectId}-{fileKey}` | fileKey 是 S3 上的单个批文件标识 |
| **SecondaryOtelIngestionQueue** | `{projectId}-{fileKey}` | 同上 |
| **IngestionQueue** | `{projectId}-{eventBodyId}` | eventBodyId 是 trace/observation ID |
| **SecondaryIngestionQueue** | `{projectId}-{eventBodyId}` | 同上 |

#### 对顺序性的实际影响

**分片键不能保证严格的事件处理顺序**，原因如下：

1. **BullMQ 并发消费机制**
   - 即使在同一个分片内，多个 Worker 也会并发拉取任务
   - BullMQ 不保证 FIFO 顺序，仅保证任务至少被执行一次
   - 同一分片内先入队的 job 可能后被处理（网络延迟、执行时间差异等）

2. **每个 job 是独立的批处理单元**
   - Otel 的每个 job 对应一个完整的 batch 文件
   - Ingestion 的每个 job 对应一个 eventBody 的合并操作
   - job 之间没有显式的依赖关系

3. **分片键的真实作用**
   - ✅ **负载均衡**：通过 SHA-256 哈希将不同项目均匀分布到多个分片
   - ✅ **避免热点**：高流量项目不会集中在单一分片
   - ✅ **同项目同分片**：同一项目的事件会路由到相同分片，减少跨分片资源竞争
   - ❌ **不保证顺序**：不提供任何事件级别的顺序保证

> **设计结论**：分片是为了水平扩展和负载均衡，不是为了顺序性。Langfuse ingestion 架构本身就是无序设计，依赖幂等性保证最终一致性。

---

## 3. 消费节奏控制

### 3.1 消费者注册模式

所有队列遵循相同的注册模式（`worker/src/app.ts`）：

```typescript
// 注册主队列消费者
const shardNames = Queue.getShardNames();
shardNames.forEach((shardName) => {
  WorkerManager.register(
    shardName as QueueName,
    queueProcessorBuilder(true),  // true = 允许重定向到二级队列
    { concurrency: envVar }
  );
});

// 注册二级队列消费者
if (secondaryQueueEnabled) {
  const secondaryShardNames = SecondaryQueue.getShardNames();
  secondaryShardNames.forEach((shardName) => {
    WorkerManager.register(
      shardName as QueueName,
      queueProcessorBuilder(false),  // false = 禁止重定向
      { concurrency: secondaryEnvVar }
    );
  });
}
```

### 3.2 重试策略对比

| 参数 | 所有主队列 | 所有二级队列 |
|------|----------|------------|
| **最大重试次数** | 6次 | 5次 |
| **重试策略** | 指数退避 | 指数退避 |
| **初始延迟** | 5000ms | 5000ms |
| **失败保留数** | 100,000 | 100,000 |

**重试延迟序列（主队列）**:
1. 第1次重试: 5秒
2. 第2次重试: 10秒
3. 第3次重试: 20秒
4. 第4次重试: 40秒
5. 第5次重试: 80秒
6. 第6次重试: 160秒

### 3.3 并发控制参数

| 环境变量 | 作用 |
|---------|------|
| `LANGFUSE_OTEL_INGESTION_QUEUE_PROCESSING_CONCURRENCY` | Otel主队列单分片并发 |
| `LANGFUSE_OTEL_INGESTION_SECONDARY_QUEUE_PROCESSING_CONCURRENCY` | Otel二级队列单分片并发 |
| `LANGFUSE_INGESTION_QUEUE_PROCESSING_CONCURRENCY` | Ingestion主队列单分片并发 |
| `LANGFUSE_INGESTION_SECONDARY_QUEUE_PROCESSING_CONCURRENCY` | Ingestion二级队列单分片并发 |
| `LANGFUSE_OTEL_INGESTION_QUEUE_SHARD_COUNT` | Otel主队列分片数 |
| `LANGFUSE_OTEL_INGESTION_SECONDARY_QUEUE_SHARD_COUNT` | Otel二级队列分片数 |
| `LANGFUSE_INGESTION_QUEUE_SHARD_COUNT` | Ingestion主队列分片数 |
| `LANGFUSE_INGESTION_SECONDARY_QUEUE_SHARD_COUNT` | Ingestion二级队列分片数 |

**总消费能力计算**:
```
总并发 = 分片数 × 单分片并发数
```

---

## 4. 回压分流机制详解

### 4.1 分流机制总览

| 队列 | 是否支持分流 | 分流触发条件 | 分流检测时机 |
|-----|------------|------------|------------|
| **OtelIngestionQueue** | ✅ | 仅环境配置 | 消费开始时（S3下载前） |
| **SecondaryOtelIngestionQueue** | ❌ | 无 | - |
| **IngestionQueue** | ✅ | 环境配置 + S3 SlowDown | 消费开始时（S3下载前） |
| **SecondaryIngestionQueue** | ❌ | 无 | - |

### 4.2 OtelIngestionQueue 分流机制

#### 触发条件
**仅支持静态配置分流**，不支持 S3 SlowDown 自动降级。

```typescript
// 位置: worker/src/queues/otelIngestionQueue.ts:225-244
if (
  enableRedirectToSecondaryQueue &&
  projectIdsToRedirectToSecondaryQueue.includes(projectId)
) {
  // 重定向到二级队列
  const shardingKey = `${projectId}-${fileKey}`;
  const secondaryQueue = SecondaryOtelIngestionQueue.getInstance({ shardingKey });
  if (secondaryQueue) {
    await secondaryQueue.add(QueueName.OtelIngestionSecondaryQueue, job.data);
    return;  // 终止当前处理
  }
}
```

#### 配置方式
```bash
# 逗号分隔的项目 ID 列表
LANGFUSE_SECONDARY_OTEL_INGESTION_QUEUE_ENABLED_PROJECT_IDS=proj-a,proj-b,proj-c
```

#### 处理路径
```
OtelIngestionQueue 消费
       │
       ▼
  检查环境配置？
       │
       ├─ 是 → 重新入队 SecondaryOtelIngestionQueue → 返回
       │
       └─ 否 → 继续正常处理
              → 下载 S3 文件
              → 解析 spans
              → OtelIngestionProcessor 处理
```

> **注意**：Otel 队列**没有** S3 SlowDown 检测和自动标记逻辑，即使 S3 返回限流也不会触发二级队列重定向。

### 4.3 IngestionQueue 分流机制

#### 触发条件
**支持两种分流方式**：静态配置 + 动态 S3 SlowDown 检测。

```typescript
// 位置: worker/src/queues/ingestionQueue.ts:108-133
const shouldRedirectEnv = projectIdsToRedirectToSecondaryQueue.includes(projectId);
const shouldRedirectSlowdown = await hasS3SlowdownFlag(projectId);

if (enableRedirectToSecondaryQueue && (shouldRedirectEnv || shouldRedirectSlowdown)) {
  // 重定向到二级队列
  const shardingKey = `${projectId}-${eventBodyId}`;
  const secondaryQueue = SecondaryIngestionQueue.getInstance({ shardingKey });
  if (secondaryQueue) {
    await secondaryQueue.add(QueueName.IngestionSecondaryQueue, job.data);
    return;  // 终止当前处理
  }
}
```

#### S3 SlowDown 标记机制

当消费过程中检测到 S3 限流错误，会自动标记项目：

```typescript
// 位置: worker/src/queues/ingestionQueue.ts:286-295
catch (e) {
  if (isS3SlowDownError(e)) {
    // 设置 Redis flag，TTL 由环境变量控制
    await markProjectS3Slowdown(projectId);
  }
  // ...
}
```

**S3 SlowDown 检测逻辑** (`packages/shared/src/server/redis/s3SlowdownTracking.ts`):
```typescript
function isS3SlowDownError(err: unknown): boolean {
  // 检查 AWS SDK 错误格式
  if (err.name === "SlowDown") return true;
  if (err.Code === "SlowDown") return true;
  if (err.code === "SlowDown") return true;
  
  // 消息回退检查
  if (err.message?.includes("SlowDown") || 
      err.message?.includes("reduce your request rate")) return true;
  
  return false;
}
```

**Redis Flag 配置**:
```bash
# 启用 S3 SlowDown 标记功能
LANGFUSE_S3_RATE_ERROR_SLOWDOWN_ENABLED=true

# Flag 过期时间（秒）
LANGFUSE_S3_RATE_ERROR_SLOWDOWN_TTL_SECONDS=3600  # 默认为 1 小时
```

#### 处理路径
```
IngestionQueue 消费
       │
       ▼
  检查分流条件？
       │
       ├─ 环境配置命中？→ 是 → 重新入队 SecondaryIngestionQueue → 返回
       │
       ├─ S3 SlowDown Flag？→ 是 → 重新入队 SecondaryIngestionQueue → 返回
       │
       └─ 否 → 继续正常处理
              → 下载 S3 文件
              → 合并事件
              → IngestionService 写入 ClickHouse
              → 如遇 S3 SlowDown 错误
                  └─ markProjectS3Slowdown(projectId)
                     └─ 影响该项目后续的所有新 job
```

### 4.4 二级队列的处理路径

**所有二级队列共享以下特性**：
1. `enableRedirectToSecondaryQueue = false` - 不会再次重定向
2. 跳过所有分流检查，直接处理 payload
3. 不会执行 `markProjectS3Slowdown` 标记（IngestionQueue 例外，catch 块中仍会标记但不影响后续）

**处理流程**:
```
Secondary*Queue 消费
       │
       ▼
  跳过分流检查
       │
       ▼
  正常处理 payload
       │
       ▼
  完成（不会再次重定向）
```

> **设计意图**：防止无限循环重定向，二级队列作为最终的"安全网"处理层。

---

## 5. 写路径决策（Write Path Selection）

### 5.1 两种写路径

仅适用于 **Otel Ingestion** 流程，基于 SDK 版本自动选择：

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
                  │  Path A: Dual Write   │ ← 默认路径
                  │  Path B: Direct Write │ ← 直写 events 表
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

---

## 6. 流量控制与缓存机制

### 6.1 S3 批量下载并发控制

**仅适用于 IngestionQueue**：

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

### 6.2 重复事件防御缓存

**仅适用于 IngestionQueue**：

```typescript
if (env.LANGFUSE_ENABLE_REDIS_SEEN_EVENT_CACHE === "true" && redis) {
  const key = `langfuse:ingestion:recently-processed:${projectId}:${type}:${eventBodyId}:${fileKey}`;
  const exists = await redis.exists(key);
  if (exists) {
    return;  // 跳过已处理事件
  }
}
```

**缓存策略**:
- Redis SETEX，TTL 5分钟
- 防止同一事件被重复处理
- 降低 S3 下载压力和 ClickHouse 写入压力

---

## 7. 关键代码位置索引

| 功能模块 | 文件路径 |
|---------|---------|
| **OTel API 入口** | `web/src/pages/api/public/otel/v1/traces/index.ts` |
| **OTel 队列定义** | `packages/shared/src/server/redis/otelIngestionQueue.ts` |
| **Ingestion 队列定义** | `packages/shared/src/server/redis/ingestionQueue.ts` |
| **OTel 消费者逻辑** | `worker/src/queues/otelIngestionQueue.ts` |
| **Ingestion 消费者逻辑** | `worker/src/queues/ingestionQueue.ts` |
| **S3 SlowDown 检测** | `packages/shared/src/server/redis/s3SlowdownTracking.ts` |
| **分片算法** | `packages/shared/src/server/redis/sharding.ts` |
| **Worker 注册** | `worker/src/app.ts` |
| **队列类型定义** | `packages/shared/src/server/queues.ts` |

---

## 8. 配置参数汇总

### 8.1 队列开关

```bash
# Otel 队列
QUEUE_CONSUMER_OTEL_INGESTION_QUEUE_IS_ENABLED
QUEUE_CONSUMER_OTEL_INGESTION_SECONDARY_QUEUE_IS_ENABLED

# Ingestion 队列
QUEUE_CONSUMER_INGESTION_QUEUE_IS_ENABLED
QUEUE_CONSUMER_INGESTION_SECONDARY_QUEUE_IS_ENABLED
```

### 8.2 分流配置

```bash
# Otel 静态分流（仅主队列）
LANGFUSE_SECONDARY_OTEL_INGESTION_QUEUE_ENABLED_PROJECT_IDS=

# Ingestion 静态分流（主队列）
LANGFUSE_SECONDARY_INGESTION_QUEUE_ENABLED_PROJECT_IDS=

# Ingestion S3 SlowDown 动态分流
LANGFUSE_S3_RATE_ERROR_SLOWDOWN_ENABLED=true
LANGFUSE_S3_RATE_ERROR_SLOWDOWN_TTL_SECONDS=3600
```

### 8.3 并发与分片

```bash
# Otel 队列分片数
LANGFUSE_OTEL_INGESTION_QUEUE_SHARD_COUNT
LANGFUSE_OTEL_INGESTION_SECONDARY_QUEUE_SHARD_COUNT

# Ingestion 队列分片数
LANGFUSE_INGESTION_QUEUE_SHARD_COUNT
LANGFUSE_INGESTION_SECONDARY_QUEUE_SHARD_COUNT

# Otel 并发
LANGFUSE_OTEL_INGESTION_QUEUE_PROCESSING_CONCURRENCY
LANGFUSE_OTEL_INGESTION_SECONDARY_QUEUE_PROCESSING_CONCURRENCY

# Ingestion 并发
LANGFUSE_INGESTION_QUEUE_PROCESSING_CONCURRENCY
LANGFUSE_INGESTION_SECONDARY_QUEUE_PROCESSING_CONCURRENCY
```

### 8.4 缓存与优化

```bash
LANGFUSE_ENABLE_REDIS_SEEN_EVENT_CACHE
LANGFUSE_S3_CONCURRENT_READS
```

---

## 9. 监控指标

### 9.1 Ingestion 相关指标

| 指标名称 | 标签 | 说明 |
|---------|------|------|
| `langfuse.ingestion.event` | `source=otel` | 处理的 observation 数量 |
| `langfuse.ingestion.otel.trace_count` | - | 处理的 trace 数量 |
| `langfuse.ingestion.otel.observation_count` | - | 处理的 observation 数量 |
| `langfuse.ingestion.otel.write_path` | `path=direct_header/direct_scope/dual` | 写路径分布 |
| `langfuse.ingestion.recently_processed_cache` | `skipped=true/false` | 重复事件缓存命中 |
| `langfuse.ingestion.s3_file_size_bytes` | `skippedS3List, otel` | S3 文件大小分布 |
| `langfuse.ingestion.count_files_distribution` | `kind` | 每个事件的文件数分布 |
| `langfuse.s3_slowdown.marked` | - | 被标记 SlowDown 的项目次数 |

---

## 总结

### 核心架构差异澄清

| 维度 | OtelIngestionQueue | IngestionQueue |
|-----|-------------------|---------------|
| **分流触发** | 仅静态环境配置 | 静态配置 + 动态 S3 SlowDown |
| **S3 限流感知** | ❌ 不感知 | ✅ 自动标记 + 重定向后续任务 |
| **分片键** | `projectId-fileKey` | `projectId-eventBodyId` |
| **重试次数** | 6次（主）/ 5次（二级） | 6次（主）/ 5次（二级） |

### 关键设计结论

1. **分片是为了水平扩展，不是为了顺序性**
   - SHA-256 哈希保证负载均衡
   - BullMQ 并发消费天然无序
   - 依赖幂等性保证最终一致性

2. **两级队列是断路器模式**
   - 主队列：正常流量，快速失败
   - 二级队列：隔离高负载/故障项目
   - Otel 仅支持静态隔离，Ingestion 支持动态降级

3. **两种 Ingestion 路径不可混用**
   - Otel Ingestion：专门处理 OTLP 协议，有写路径选择
   - Ingestion：处理通用事件合并，有 S3 限流保护

4. **S3 SlowDown 是单向降级**
   - 标记后 TTL 内该项目所有新 job 都走二级队列
   - TTL 过期后自动恢复主队列
   - 没有自动 "恢复健康" 的检测机制
