# Langfuse OTEL 队列路由与失败分流审核报告

**审核日期**: 2026-05-16  
**审核范围**: OTEL Ingestion 队列与普通 Ingestion 队列的路由、背压、失败处理逻辑

---

## 一、核心架构：两条独立的处理管线

| 管线名称 | 队列类 | 主要职责 | 适用数据 |
|---------|--------|---------|---------|
| **管线 A: OTEL Ingestion** | `OtelIngestionQueue` / `SecondaryOtelIngestionQueue` | 处理 `/api/public/otel/v1/traces` 入口的 OTel 原生数据 | OpenTelemetry resourceSpans |
| **管线 B: 普通 Ingestion** | `IngestionQueue` / `SecondaryIngestionQueue` | 处理 `/api/public/ingestion` 入口的 Langfuse 原生事件 | Trace/Score/Observation 等事件 |

⚠️ **关键更正**: S3 SlowDown 背压逻辑**仅存在于管线 B (普通 Ingestion)**，与 OTEL 管线无关！

---

## 二、管线 A: OTEL Ingestion 队列路由逻辑

**代码路径**: `worker/src/queues/otelIngestionQueue.ts:193-546`

### 2.1 次级队列重定向触发条件

**触发位置**: L225-244 (S3 下载之前)

```typescript
if (
  enableRedirectToSecondaryQueue &&        // Builder 传入参数
  projectIdsToRedirectToSecondaryQueue.includes(projectId)  // 仅白名单
) {
  // 重定向到 SecondaryOtelIngestionQueue
  await secondaryQueue.add(QueueName.OtelIngestionSecondaryQueue, job.data);
  return;  // 终止当前主队列处理
}
```

**重定向触发条件总结**:

| 条件 | 说明 | 代码位置 |
|-----|------|---------|
| ✅ 环境变量白名单 | `LANGFUSE_SECONDARY_OTEL_INGESTION_QUEUE_ENABLED_PROJECT_IDS` 逗号分隔列表 | L196-199 |
| ❌ S3 SlowDown 标记 | **不存在此判断** | - |

### 2.2 失败分流规则

#### 阶段 1: 遮蔽处理 (Masking) 失败

**代码位置**: L269-291

```typescript
if (isIngestionMaskingEnabled()) {
  const maskingResult = await applyIngestionMasking({/*...*/});
  
  if (!maskingResult.success) {
    // ✅ 静默终止：直接丢弃，不重试
    logger.warn(`Dropping OTEL event due to masking failure`, {/*...*/});
    return;  // 正常返回，BullMQ 标记为完成
  }
}
```

**行为**:
- ✅ 静默终止，不重试
- 仅记录 WARN 日志，含 fileKey 便于后续重放

---

#### 阶段 2: 事件转换过程中异常

**代码路径**: `packages/shared/src/server/otel/OtelIngestionProcessor.ts:578-588`

```typescript
catch (error) {
  // 🔄 ForbiddenError: 抛出触发重试
  if (error instanceof ForbiddenError) {
    traceException(error, span);
    throw error;
  }

  // ✅ 其他所有错误：记录日志但返回空数组继续
  logger.error("Error processing OTEL spans:", error);
  traceException(error, span);
  return [];  // 静默失败，无重试
}
```

**行为总结**:

| 错误类型 | 处理方式 | 是否重试 |
|---------|---------|---------|
| `ForbiddenError` | throw 抛出 | ✅ 是 (最多 6 次) |
| 其他所有异常 | `return []` 继续 | ❌ 否 |

---

#### 阶段 3: 事件表写入与评估调度失败

**代码位置**: `worker/src/queues/otelIngestionQueue.ts:493-523`

这两个阶段都有独立的 try-catch 包裹**单条事件**:

```typescript
// 评估调度失败:
try {
  const observation = convertEventRecordToObservationForEval(eventRecord);
  await scheduleObservationEvals({ observation, configs, schedulerDeps });
} catch (error) {
  // ✅ 单条失败不影响整体，仅记录日志
  logger.error(`Failed to schedule observation evals for ...`, { error, fileKey });
}

// 事件表写入失败:
if (shouldWriteToEventsTable) {
  try {
    ingestionService.writeEventRecord(eventRecord);
  } catch (error) {
    // ✅ 单条失败不影响整体，仅记录日志
    logger.error(`Failed to write event record for ...`, { error, fileKey });
  }
}
```

**行为**:
- ✅ 单条事件失败静默容忍，继续处理其他事件
- ❌ 失败的单条事件不会重试

---

#### 阶段 4: 最外层 catch (所有未捕获异常)

**代码位置**: L527-544

```typescript
} catch (e) {
  const fileKey = job.data.payload.data.fileKey;
  
  // ✅ ForbiddenError: 直接终止，不重试
  if (e instanceof ForbiddenError) {
    traceException(e);
    logger.warn(`Failed to parse otel observation: ${e.message}`, {
      error: e, fileKey,
    });
    return;  // 正常返回
  }

  // 🔄 其他所有错误: 抛出触发 BullMQ 重试
  logger.error(`Failed job otel ingestion processing for ${projectId}`, { error: e, fileKey });
  traceException(e);
  throw e;
}
```

**行为总结**:

| 错误类型 | 处理方式 | 是否重试 |
|---------|---------|---------|
| `ForbiddenError` | `return` 正常结束 | ❌ 否 (静默丢弃) |
| 其他所有异常 | `throw e` 抛出 | ✅ 是 (指数退避，最多 6 次) |

---

### 2.3 OTEL 队列重试参数

**代码路径**: `packages/shared/src/server/redis/otelIngestionQueue.ts:78-86, 166-174`

| 参数 | 主队列 | 次级队列 |
|-----|--------|---------|
| `attempts` | 6 次 | 5 次 |
| `backoff.type` | exponential | exponential |
| `backoff.delay` | 5000ms | 5000ms |
| `removeOnComplete` | true | true |
| `removeOnFail` | 100000 | 100000 |

**重试时间序列**:
- 第 1 次失败 → 等待 5s → 第 2 次
- 第 2 次失败 → 等待 10s → 第 3 次
- 第 3 次失败 → 等待 20s → 第 4 次
- 第 4 次失败 → 等待 40s → 第 5 次
- 第 5 次失败 → 等待 80s → 第 6 次 (仅主队列)
- 第 6 次失败 → 进入死信队列 (保留 100k 条)

---

## 三、管线 B: 普通 Ingestion 队列路由逻辑

**代码路径**: `worker/src/queues/ingestionQueue.ts:29-305`

### 3.1 次级队列重定向触发条件

**触发位置**: L108-133 (S3 下载之前)

```typescript
const shouldRedirectEnv =
  projectIdsToRedirectToSecondaryQueue.includes(projectId);
const shouldRedirectSlowdown = await hasS3SlowdownFlag(projectId);

if (
  enableRedirectToSecondaryQueue &&
  (shouldRedirectEnv || shouldRedirectSlowdown)  // 两个条件 OR
) {
  // 重定向到 SecondaryIngestionQueue
  await secondaryQueue.add(QueueName.IngestionSecondaryQueue, job.data);
  return;  // 终止当前主队列处理
}
```

**重定向触发条件总结**:

| 条件 | 说明 | 代码位置 |
|-----|------|---------|
| ✅ 环境变量白名单 | `LANGFUSE_SECONDARY_INGESTION_QUEUE_ENABLED_PROJECT_IDS` 逗号分隔列表 | L32-34 |
| ✅ S3 SlowDown 标记 | Redis key: `langfuse:s3-slowdown:{projectId}` 值为 "1" | L112 |

### 3.2 S3 SlowDown 标记设置逻辑

**代码路径**: `worker/src/queues/ingestionQueue.ts:286-303`

```typescript
} catch (e) {
  // 检测到 S3 SlowDown 错误时，标记项目
  if (isS3SlowDownError(e)) {
    const projectId = job.data.payload.authCheck.scope.projectId;
    logger.warn("S3 SlowDown error during ingestion processing, marking project for secondary queue", { projectId, error: e });
    await markProjectS3Slowdown(projectId);  // 设置 Redis 标记
  }

  logger.error(`Failed job ingestion processing for ${projectId}`, e);
  traceException(e);
  throw e;  // 🔄 所有错误都抛出触发重试
}
```

**S3 SlowDown 错误判定** (`packages/shared/src/server/redis/s3SlowdownTracking.ts:16-33`):

```typescript
function isS3SlowDownError(err: unknown): boolean {
  // AWS SDK 标准错误格式
  if (err?.name === "SlowDown") return true;
  if (err?.Code === "SlowDown") return true;
  if (err?.code === "SlowDown") return true;
  
  // 消息内容回退
  if (err?.message?.includes("SlowDown") || 
      err?.message?.includes("reduce your request rate")) {
    return true;
  }
  return false;
}
```

**Redis 标记参数** (`packages/shared/src/server/redis/s3SlowdownTracking.ts:39-57`):
- Key: `langfuse:s3-slowdown:{projectId}`
- Value: `"1"`
- TTL: `LANGFUSE_S3_RATE_ERROR_SLOWDOWN_TTL_SECONDS` (环境变量)

---

### 3.3 失败分流规则

#### 阶段 1: Redis Seen Cache 命中

**代码位置**: L84-106

```typescript
if (env.LANGFUSE_ENABLE_REDIS_SEEN_EVENT_CACHE === "true" && redis && fileKey) {
  const key = `langfuse:ingestion:recently-processed:${projectId}:${type}:${eventBodyId}:${fileKey}`;
  const exists = await redis.exists(key);
  if (exists) {
    // ✅ 已处理过，直接跳过，不重试
    recordIncrement("langfuse.ingestion.recently_processed_cache", 1, { skipped: "true" });
    return;
  }
}
```

**行为**:
- ✅ 静默终止，不重试
- 仅记录指标，无错误日志

---

#### 阶段 2: 最外层 catch (所有未捕获异常)

**代码位置**: L286-303

```typescript
} catch (e) {
  // 第一步：如果是 S3 SlowDown，设置标记（但仍重试）
  if (isS3SlowDownError(e)) {
    await markProjectS3Slowdown(projectId);
  }

  logger.error(`Failed job ingestion processing for ${projectId}`, e);
  traceException(e);
  throw e;  // 🔄 所有错误统一抛出触发重试
}
```

**关键区别 vs OTEL 管线**:
- 🔄 **没有** `ForbiddenError` 特殊分支
- 🔄 **所有错误** 最终都会 `throw e` 触发 BullMQ 重试
- S3 SlowDown 标记只是副作用，不影响当前任务的重试行为

---

### 3.4 Ingestion 队列重试参数

**代码路径**: `packages/shared/src/server/redis/ingestionQueue.ts:74-85, 161-172`

| 参数 | 主队列 | 次级队列 |
|-----|--------|---------|
| `attempts` | 6 次 | 5 次 |
| `backoff.type` | exponential | exponential |
| `backoff.delay` | 5000ms | 5000ms |
| `removeOnComplete` | true | true |
| `removeOnFail` | 100000 | 100000 |

---

## 四、管线路由完整流程图

```
          OTEL API入口                        Ingestion API入口
              |                                    |
              ▼                                    ▼
  publishToOtelIngestionQueue             processEventBatch
  (S3 上传 + 入队)                        (S3 上传 + 入队)
              |                                    |
              ▼                                    ▼
    ┌─────────────────────┐            ┌─────────────────────┐
    │ OtelIngestionQueue  │            │   IngestionQueue    │
    │ (BullMQ 主队列)     │            │ (BullMQ 主队列)     │
    └─────────────────────┘            └─────────────────────┘
              |                                    |
              ▼                                    ▼
  ┌──────────────────────────┐        ┌──────────────────────────┐
  │  次级重定向判断 (L225)   │        │  次级重定向判断 (L108)   │
  │  - 仅环境白名单          │        │  - 环境白名单 OR         │
  │  - NO S3 SlowDown 检查   │        │    S3 SlowDown 标记      │
  └──────────────────────────┘        └──────────────────────────┘
              |                                    |
        ┌─────┴─────┐                        ┌─────┴─────┐
        ▼           ▼                        ▼           ▼
    [重定向]      [继续]                  [重定向]      [继续]
        |           |                        |           |
        ▼           ▼                        ▼           ▼
  SecondaryOtel   S3下载            SecondaryIngestion  S3下载
  Queue (5次重试) |                 Queue (5次重试)     |
        |         |                        |            |
        |         ▼                        |            ▼
        |   [后续处理]                     |        [后续处理]
        |         |                        |            |
        ▼         ▼                        ▼            ▼
  [次级队列处理]  完成                 [次级队列处理]   |
                                           |            |
                                           ▼            |
                                       catch 块检测到 S3 SlowDown
                                           |            |
                                           ▼            ▼
                                       markProjectS3Slowdown
                                           |            |
                                           ▼            ▼
                                       设置 Redis 标记，下次入队触发重定向
```

---

## 五、失败分流对比总结表

| 失败场景 | 管线 A: OTEL Ingestion | 管线 B: 普通 Ingestion | 代码位置 (OTEL) | 代码位置 (Ingestion) |
|---------|------------------------|------------------------|------------------|----------------------|
| **环境白名单命中** | ✅ 重定向到次级队列，终止主流程 | ✅ 重定向到次级队列，终止主流程 | L225-244 | L108-133 |
| **S3 SlowDown 标记命中** | ❌ 无此逻辑，不重定向 | ✅ 重定向到次级队列，终止主流程 | - | L112 |
| **Masking 遮蔽失败** | ✅ 静默终止，不重试 | N/A (OTEL 独有 EE 特性) | L269-291 | - |
| **Redis Seen Cache 命中** | N/A | ✅ 静默终止，不重试 | - | L84-106 |
| **ForbiddenError** | ✅ 静默终止，不重试 | 🔄 无特殊分支，与其他错误一同 throw 重试 | L529-535 | - |
| **事件转换内部异常 (非 Forbidden)** | ✅ `return []` 继续，不重试 | N/A (无此 try-catch 层级) | L584-588 | - |
| **单个 eval 调度失败** | ✅ 单条失败 catch 容忍，继续 | N/A (OTEL 独有) | L493-510 | - |
| **单个 events 表写入失败** | ✅ 单条失败 catch 容忍，继续 | N/A (OTEL 独有) | L514-523 | - |
| **S3 SlowDown 异常捕获** | ❌ 无检测，直接 throw 重试 | ✅ 检测到则设置 Redis 标记，然后 throw 重试 | - | L288-294 |
| **其他所有未捕获异常** | 🔄 throw 触发重试 (最多 6 次) | 🔄 throw 触发重试 (最多 6 次) | L538-543 | L297-302 |

---

## 六、关键更正结论

### ❌ 之前分析的误判点

1. **S3 SlowDown 背压逻辑不属于 OTEL 管线**：仅普通 Ingestion 队列才有检测与标记逻辑，OTEL 队列完全不涉及
2. **两条管线的次级队列是独立的**：`SecondaryOtelIngestionQueue` vs `SecondaryIngestionQueue`，分别配置
3. **ForbiddenError 静默终止是 OTEL 管线独有**：普通 Ingestion 没有此分支，所有错误都重试

### ✅ 正确结论

| 逻辑 | 适用管线 |
|-----|---------|
| S3 SlowDown 检测与标记 | 仅管线 B (普通 Ingestion) |
| 根据 SlowDown 标记重定向 | 仅管线 B (普通 Ingestion) |
| ForbiddenError 静默终止 | 仅管线 A (OTEL Ingestion) |
| 基于环境白名单的重定向 | 两条管线都有 |
| Masking 遮蔽 EE 特性 | 仅管线 A (OTEL Ingestion) |
| Redis Seen Cache 去重 | 仅管线 B (普通 Ingestion) |

---

## 七、核心代码索引

| 功能 | 文件路径 | 行号 |
|-----|---------|-----|
| OTEL 队列处理器 Builder | `worker/src/queues/otelIngestionQueue.ts` | L193-546 |
| OTEL 次级队列重定向判断 | `worker/src/queues/otelIngestionQueue.ts` | L225-244 |
| OTEL 外层 catch 失败分流 | `worker/src/queues/otelIngestionQueue.ts` | L527-544 |
| 普通 Ingestion 队列处理器 | `worker/src/queues/ingestionQueue.ts` | L29-305 |
| 普通 Ingestion 次级队列重定向 | `worker/src/queues/ingestionQueue.ts` | L108-133 |
| S3 SlowDown 错误标记 | `worker/src/queues/ingestionQueue.ts` | L286-294 |
| S3 SlowDown 标记实现 | `packages/shared/src/server/redis/s3SlowdownTracking.ts` | L1-74 |
| OTEL 事件转换失败处理 | `packages/shared/src/server/otel/OtelIngestionProcessor.ts` | L578-588 |
| OTEL 主/次级队列定义 | `packages/shared/src/server/redis/otelIngestionQueue.ts` | L1-189 |
| 普通 Ingestion 主/次级队列定义 | `packages/shared/src/server/redis/ingestionQueue.ts` | L1-180 |

---

*审核基于 Langfuse v2.x 代码库，截止 2026-05-16*
