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
// 分片核心逻辑
export function getShardIndex(key: string, shardCount: number): number {
  if (shardCount <= 1) return 0;

  // 使用 SHA-256 哈希计算分片索引
  const hash = createHash("sha256").update(key).digest("hex");
  const hashInt = parseInt(hash.substring(0, 8), 16);
  return hashInt % shardCount;
}
```

**代码证据**：
- 分片计算基于完整的 `key` 字符串的 SHA-256 哈希值
- 取前 8 个十六进制字符转为整数再取模
- 只要 key 的任何一位变化，分片索引就可能变化

### 2.2 分片键构成与本质

#### 分片键构成

| 队列 | 分片键格式 | 各字段的含义与来源 |
|-----|-----------|-------------------|
| **OtelIngestionQueue** | `{projectId}-{fileKey}` | **projectId**: 项目ID（认证获得，固定）<br>**fileKey**: `OtelIngestionProcessor.ts:184` 中用 `randomUUID()` 生成，每次 API 请求生成一个新的唯一值 |
| **IngestionQueue** | `{projectId}-{eventBodyId}` | **projectId**: 项目ID（认证获得，固定）<br>**eventBodyId**: traceId 或 observationId，每个事件实体天然不同 |

**代码证据**：
```typescript
// OtelIngestionProcessor.ts:183-194 - fileKey 生成
async publishToOtelIngestionQueue(resourceSpans: ResourceSpan[]) {
  // 每次请求都用 randomUUID() 生成新 fileKey
  const fileKey = `${env.LANGFUSE_S3_EVENT_UPLOAD_PREFIX}otel/${this.projectId}/${this.getCurrentTimePath()}/${randomUUID()}.json`;

  // 用 projectId + fileKey 作为分片键
  const queue = OtelIngestionQueue.getInstance({
    shardingKey: `${this.projectId}-${fileKey}`,  // 每次都不同
  });
}
```

### 2.3 分片键对顺序性的实际影响

#### 误解一：「同项目固定单分片」

**结论**：不能推出

**原因**：
1. **分片键包含高可变因子**：
   - `projectId` 固定，但 `fileKey` 是每个请求一个 UUID
   - `eventBodyId` 是每个 trace/observation 独立的 ID
   - 只要第二个字段变化，SHA-256 哈希就会完全不同

2. **数学证明**：
   ```
   分片索引 = SHA256("proj1-uuid1") % shardCount  → 可能为分片3
   分片索引 = SHA256("proj1-uuid2") % shardCount  → 可能为分片7
   分片索引 = SHA256("proj1-uuid3") % shardCount  → 可能为分片0
   ```
   同一项目的不同请求，会均匀分布到所有分片上。

3. **代码行为验证**：
   - 同一项目 1000 个请求，会有接近 1000 个不同的分片键
   - 每个键的哈希结果独立，因此分片索引也几乎均匀分布

#### 误解二：「严格顺序保证」

**结论**：不能推出

**原因**：
1. **BullMQ 并发消费机制**（`worker/src/queues/workerManager.ts`）：
   - 每个分片可以被多个 Worker 实例同时拉取
   - Worker 之间没有任何协调机制保证先入先出
   - 即使在同一分片内，`job1` 被 Worker A 拉取，`job2` 被 Worker B 拉取，它们的完成顺序与入队顺序无关

2. **作业执行时间不确定**：
   - 不同 job 的 S3 文件大小差异巨大（几 KB → 几 MB）
   - 不同 job 的 spans 数量差异巨大（几个 → 几千个）
   - 网络波动、GC 暂停都会造成执行时间的随机扰动

3. **重入队机制**：
   - job 失败后会指数退避重试
   - 重试的 job 会排在队尾，打破原始顺序

> **架构设计事实**：Langfuse 的 ingestion 队列从设计之初就是**无序、幂等、最终一致**的系统。分片的唯一目的是水平扩展吞吐量，而非提供顺序保证。

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
| **OtelIngestionQueue** | ✅ | 仅静态环境配置 | 消费开始时（S3下载前） |
| **SecondaryOtelIngestionQueue** | ❌ | 无 | - |
| **IngestionQueue** | ✅ | 环境配置 + S3 SlowDown 动态标记 | 消费开始时（S3下载前） |
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
    return;  // 终止当前处理，重入队到二级队列
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

**代码执行位置与顺序**：
```typescript
// 位置: worker/src/queues/ingestionQueue.ts:108-133
// 时机: 消费开始时，S3 下载之前

// 【第一步】检查是否需要分流
const projectId = job.data.payload.authCheck.scope.projectId;
const shouldRedirectEnv = projectIdsToRedirectToSecondaryQueue.includes(projectId);
const shouldRedirectSlowdown = await hasS3SlowdownFlag(projectId);  // ← 读 Redis 标记

if (enableRedirectToSecondaryQueue && (shouldRedirectEnv || shouldRedirectSlowdown)) {
  // 重定向到二级队列
  const shardingKey = `${projectId}-${eventBodyId}`;
  const secondaryQueue = SecondaryIngestionQueue.getInstance({ shardingKey });
  if (secondaryQueue) {
    await secondaryQueue.add(QueueName.IngestionSecondaryQueue, job.data);
    return;  // 终止当前处理，不再往下执行
  }
}

// 【后续】如果不分流，继续执行 S3 下载和处理逻辑
```

#### S3 SlowDown 标记机制

**标记发生位置**：catch 块中，处理失败时

```typescript
// 位置: worker/src/queues/ingestionQueue.ts:286-295
catch (e) {
  // 【第二步】遇到 S3 限流时设置标记（写 Redis）
  if (isS3SlowDownError(e)) {
    const projectId = job.data.payload.authCheck.scope.projectId;
    await markProjectS3Slowdown(projectId);  // ← 设置 Redis flag
  }
  throw e;  // 继续抛出，触发 BullMQ 重试
}
```

**S3 SlowDown 检测逻辑** (`packages/shared/src/server/redis/s3SlowdownTracking.ts`):
```typescript
function isS3SlowDownError(err: unknown): boolean {
  // 检查多种 AWS SDK 错误格式
  if (err.name === "SlowDown") return true;
  if (err.Code === "SlowDown") return true;
  if (err.code === "SlowDown") return true;
  
  // 消息内容回退检查
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

#### 主队列 vs 二级队列的行为差异

| 行为 | 主队列消费者<br>(`enableRedirectToSecondaryQueue=true`) | 二级队列消费者<br>(`enableRedirectToSecondaryQueue=false`) |
|-----|--------------------------------------------------------|----------------------------------------------------------|
| **调用 `hasS3SlowdownFlag`** | ✅ 在处理前调用<br>如返回 true 则重定向到二级队列 | ❌ 不调用<br>因为 `enableRedirectToSecondaryQueue=false` 时整个 if 判断不成立 |
| **调用 `markProjectS3Slowdown`** | ✅ 在 catch 块中调用<br>遇到 S3 SlowDown 时设置 flag | ✅ 在 catch 块中同样调用<br>**无论主/二级队列，只要遇到 S3 SlowDown 都会刷新 flag TTL** |
| **对后续分流的影响** | ✅ flag 存在时，后续新 job 会被分流 | ✅ flag 存在时，不影响当前二级队列的 job<br>但会影响**该项目新入队的主队列 job** |

#### 处理路径
```
IngestionQueue 消费 (主队列)
       │
       ▼
  hasS3SlowdownFlag? ──┐
       │               │
       ├─ 是 → 重定向到 SecondaryIngestionQueue → 返回
       │               │
       └─ 否 → 继续处理
              → 下载 S3 文件
              → 合并事件
              → 写入 ClickHouse
              │
              └─ 如遇 S3 SlowDown 错误
                  └─ markProjectS3Slowdown(projectId)  ← 设置 Redis flag
                     └─ 影响该项目后续所有新的主队列 job
```

```
SecondaryIngestionQueue 消费 (二级队列)
       │
       ▼
  【跳过】hasS3SlowdownFlag 检查  ← 因为 enableRedirectToSecondaryQueue=false
       │
       ▼
  继续处理
       │
       ▼
  下载 S3 文件
       │
       ▼
  合并事件
       │
       ▼
  写入 ClickHouse
       │
       └─ 如遇 S3 SlowDown 错误
           └─ markProjectS3Slowdown(projectId)  ← 仍然会设置/刷新 Redis flag
              └─ 不影响当前二级队列的 job
              └─ 但会影响该项目后续新入队的主队列 job
```

> **代码事实**：`markProjectS3Slowdown` 在 catch 块中无条件执行，与 `enableRedirectToSecondaryQueue` 无关。二级队列中发生的 S3 SlowDown 错误，仍然会刷新 Redis flag 的 TTL，延长该项目的降级时间。

### 4.4 二级队列的处理路径

**所有二级队列共享以下特性**：
1. `enableRedirectToSecondaryQueue = false` - 不会再次重定向
2. 跳过所有分流检查（包括 `hasS3SlowdownFlag` 调用），直接处理 payload
3. `markProjectS3Slowdown` 仍然在 catch 块中执行，用于刷新 flag TTL

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
  如遇 S3 SlowDown → markProjectS3Slowdown(projectId)  ← 刷新 TTL
       │
       ▼
  完成（不会再次重定向）
```

> **设计意图**：防止无限循环重定向，二级队列作为最终的"安全网"处理层；但仍然持续监控 S3 限流状态，必要时延长降级时间。

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
| **OTel 处理器** | `packages/shared/src/server/otel/OtelIngestionProcessor.ts` |
| **OTel 队列定义** | `packages/shared/src/server/redis/otelIngestionQueue.ts` |
| **Ingestion 队列定义** | `packages/shared/src/server/redis/ingestionQueue.ts` |
| **OTel 消费者逻辑** | `worker/src/queues/otelIngestionQueue.ts` |
| **Ingestion 消费者逻辑** | `worker/src/queues/ingestionQueue.ts` |
| **S3 SlowDown 检测** | `packages/shared/src/server/redis/s3SlowdownTracking.ts` |
| **分片算法** | `packages/shared/src/server/redis/sharding.ts` |
| **Worker 注册** | `worker/src/app.ts` |
| **队列类型定义** | `packages/shared/src/server/queues.ts` |
| **Worker Manager** | `worker/src/queues/workerManager.ts` |

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
| **分片键** | `projectId-fileKey` (每次请求 UUID) | `projectId-eventBodyId` (每个实体 ID) |
| **重试次数** | 6次（主）/ 5次（二级） | 6次（主）/ 5次（二级） |

### IngestionQueue S3 SlowDown 行为总结

| 操作 | 主队列 | 二级队列 |
|-----|-------|---------|
| **hasS3SlowdownFlag** | ✅ 处理前调用，命中则分流 | ❌ 不调用，整个分流判断跳过 |
| **markProjectS3Slowdown** | ✅ catch 块中调用，设置 flag | ✅ catch 块中同样调用，刷新 TTL |
| **对后续 job 影响** | 新入队的主队列 job 会被分流 | 新入队的主队列 job 同样会被分流（flag 是全局的） |

> **关键结论**：S3 SlowDown flag 是项目级的全局标记，与队列无关。二级队列中的 S3 错误仍然会延长 flag TTL，持续影响该项目的主队列新 job。

### 分片与顺序性关键结论

1. **不能推出「同项目固定单分片」**
   - `fileKey` 是 UUID，`eventBodyId` 是实体 ID，每个 job 都不同
   - SHA-256 哈希对输入变化敏感 → 同一项目的不同 job 均匀分布到全部分片

2. **不能推出「严格顺序保证」**
   - BullMQ 多 Worker 并发拉取，无协调
   - job 执行时间差异巨大（大小、数量、网络）
   - 重试机制会把失败 job 移到队尾

3. **分片唯一目的：水平扩展吞吐量**
   - 每个分片可以独立增加消费者
   - 避免单 Redis 队列成为瓶颈
   - 设计上就是无序 + 幂等 + 最终一致

### 两级队列设计目标

1. **主队列**: 正常流量，高优先级，快速失败
2. **二级队列**: 隔离高负载/故障项目，作为系统的「安全气囊」
   - Otel 队列：仅静态配置的项目
   - Ingestion 队列：静态配置 + 动态 S3 限流降级
3. **单向降级**: 一旦标记为 SlowDown，TTL 内该项目的所有新 job 都会走二级队列；TTL 过期后自动恢复
