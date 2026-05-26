# Langfuse CSV 导出链路完整分析

本文档详细分析 Langfuse 中观测数据导出为 CSV 的完整技术链路，从前端触发到最终下载链接生成，跨越多个组件。

## 一、架构总览

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Web API (tRPC) │────▶│  BullMQ Queue   │────▶│  Worker (Bull)  │
│  触发入口        │     │  排队机制        │     │  任务消费        │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                                                         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  下载链接返回   │◀────│  对象存储 (S3)  │◀────│  流式生成 CSV   │
│  邮件通知       │     │  签名 URL       │     │  ClickHouse 查询│
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**核心组件：**
- `web` 容器：tRPC API 入口、权限校验、任务入库、队列投递
- `Redis`：BullMQ 队列存储、任务状态管理
- `worker` 容器：队列消费、流式数据处理、CSV 序列化、S3 上传
- `ClickHouse`：观测数据的数据源
- `PostgreSQL`：导出任务元数据存储（batchExport 表）
- `S3/OSS/Azure/GCS`：CSV 文件持久化存储

---

## 二、阶段一：触发入口（Web 层）

### 2.1 API 路由定义

**文件：** `web/src/features/batch-exports/server/batchExport.ts:20-78`

用户通过前端点击导出按钮，触发 tRPC mutation：

```typescript
export const batchExportRouter = createTRPCRouter({
  create: protectedProjectProcedure
    .input(CreateBatchExportSchema)
    .mutation(async ({ input, ctx }) => {
      // 1. 权限校验
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "batchExports:create",
      });

      // 2. 创建任务记录（PostgreSQL）
      const exportJob = await ctx.prisma.batchExport.create({
        data: {
          projectId,
          userId: ctx.session.user.id,
          status: BatchExportStatus.QUEUED,  // 初始状态：排队中
          name,
          format,  // CSV / JSON / JSONL
          query,   // 过滤条件、排序、表名等
        },
      });

      // 3. 审计日志
      await auditLog({ ... });

      // 4. 投递到 BullMQ 队列
      await BatchExportQueue.getInstance()?.add(QueueJobs.BatchExportJob, {
        id: exportJob.id,           // 用 batchExportId 去重
        name: QueueJobs.BatchExportJob,
        timestamp: new Date(),
        payload: {
          batchExportId: exportJob.id,
          projectId,
        },
      });
    }),
});
```

### 2.2 关键设计点

1. **去重机制**：使用 `batchExportId` 作为 BullMQ 任务的 `id`，防止重复投递
2. **状态机起点**：初始状态为 `QUEUED`
3. **幂等性考虑**：任务记录先落库，再投递队列，即使队列投递失败也能重试
4. **查询上下文**：完整的查询条件（`filter`、`searchQuery`、`orderBy`、`tableName`）序列化后存入 `query` 字段

---

## 三、阶段二：队列机制（BullMQ）

### 3.1 队列配置

**文件：** `packages/shared/src/server/redis/batchExport.ts:10-49`

```typescript
export class BatchExportQueue {
  private static instance: Queue<TQueueJobTypes[QueueName.BatchExport]> | null = null;

  public static getInstance(): Queue<...> | null {
    const newRedis = createNewRedisInstance({
      enableOfflineQueue: false,
      ...redisQueueRetryOptions,
    });

    BatchExportQueue.instance = newRedis
      ? new Queue<TQueueJobTypes[QueueName.BatchExport]>(
          QueueName.BatchExport,  // "batch-export-queue"
          {
            connection: newRedis,
            prefix: getQueuePrefix(QueueName.BatchExport),
            defaultJobOptions: {
              removeOnComplete: true,          // 成功后删除
              removeOnFail: 10_000,            // 失败后保留 10000 条
              attempts: 8,                     // ⭐ 最多重试 8 次
              backoff: {
                type: "exponential",           // ⭐ 指数退避
                delay: 5000,                   // 首次重试延迟 5 秒
              },
            },
          },
        )
      : null;
    return BatchExportQueue.instance;
  }
}
```

### 3.2 Worker 注册与限流

**文件：** `worker/src/app.ts:291-300`

```typescript
if (env.QUEUE_CONSUMER_BATCH_EXPORT_QUEUE_IS_ENABLED === "true") {
  WorkerManager.register(QueueName.BatchExport, batchExportQueueProcessor, {
    concurrency: 1,           // ⭐ 同一时间只处理 1 个导出任务
    limiter: {
      max: 1,                 // 每 5 秒最多执行 1 个任务
      duration: 5_000,        // 避免数据库过载
    },
  });
}
```

**限流设计原因：** 导出任务是重量级操作，会扫描大量 ClickHouse 数据，严格的并发控制防止对在线业务造成影响。

### 3.3 WorkerManager 包装层

**文件：** `worker/src/queues/workerManager.ts:41-110`

`metricWrapper` 为每个任务添加了可观测性：

```typescript
private static metricWrapper(processor: Processor, queueName: QueueName): Processor {
  return async (job: Job) => {
    const startTime = Date.now();
    const waitTime = Date.now() - job.timestamp;

    // 指标记录：请求数、等待时间
    recordIncrement(baseMetric + ".rate", 1, { type: "request", ...shardTag });
    recordHistogram(baseMetric + ".time", waitTime, { type: "wait", ... });

    const result = await processor(job);

    // 指标记录：队列深度、处理时间
    recordHistogram(baseMetric + ".time", processingTime, { type: "processing", ... });

    return result;
  };
}
```

**监控指标：**
- `batch_export_queue.request`：请求计数
- `batch_export_queue.wait_time`：排队等待时间
- `batch_export_queue.processing_time`：实际处理时间
- `batch_export_queue.length`：等待队列深度
- `batch_export_queue.dlq_length`：死信队列长度
- `batch_export_queue.active`：活跃任务数
- `batch_export_queue.failed` / `.error`：失败计数

---

## 四、阶段三：任务处理与流式生成

### 4.1 队列处理器

**文件：** `worker/src/queues/batchExportQueue.ts:14-53`

```typescript
export const batchExportQueueProcessor = async (
  job: Job<TQueueJobTypes[QueueName.BatchExport]>,
) => {
  try {
    logger.info("[BATCH EXPORT] Executing Batch Export Job", job.data.payload);
    await handleBatchExportJob(job.data.payload);  // 核心处理逻辑
    logger.info("[BATCH EXPORT] Finished Batch Export Job", job.data.payload);
    return true;
  } catch (e) {
    if (e instanceof LangfuseNotFoundError) {
      // 任务已被删除，静默跳过
      logger.warn(`[BATCH EXPORT] Batch export ${...} not found. Job will be skipped.`);
      return true;
    }

    // 更新任务状态为 FAILED
    await prisma.batchExport.update({
      where: { id: batchExportId, projectId },
      data: {
        status: BatchExportStatus.FAILED,
        finishedAt: new Date(),
        log: displayError,
      },
    });

    traceException(e);
    throw e;  // ⭐ 抛出异常触发 BullMQ 重试
  }
};
```

**关键点：** 只有抛出异常才会触发 BullMQ 的重试机制。`LangfuseNotFoundError` 被捕获并正常返回，不会重试。

### 4.2 核心处理流程

**文件：** `worker/src/features/batchExport/handleBatchExportJob.ts:34-314`

#### 前置检查（步骤 1-3）

```typescript
export const handleBatchExportJob = async (batchExportJob: BatchExportJobType) => {
  // 检查特性开关
  if (env.LANGFUSE_S3_BATCH_EXPORT_ENABLED !== "true") {
    throw new Error("Batch export is not enabled...");
  }

  // 步骤 1: 从 DB 获取任务详情
  const jobDetails = await prisma.batchExport.findFirst({
    where: { projectId, id: batchExportId },
  });
  if (!jobDetails) throw new LangfuseNotFoundError(...);

  // 步骤 2: 检查是否已取消
  if (jobDetails.status === BatchExportStatus.CANCELLED) {
    logger.info(`[BATCH EXPORT] Batch export ${batchExportId} has been cancelled.`);
    return;
  }

  // 步骤 3: 检查任务是否超过 30 天（数据可能已过期）
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  if (jobDetails.createdAt < thirtyDaysAgo) {
    await prisma.batchExport.update({
      where: { id: batchExportId, projectId },
      data: { status: BatchExportStatus.FAILED, finishedAt: new Date(), log: "..." },
    });
    return;
  }

  // 步骤 4: 更新状态为 PROCESSING
  await prisma.batchExport.update({
    where: { id: batchExportId, projectId },
    data: { status: BatchExportStatus.PROCESSING },
  });
```

#### 数据流构建（步骤 4-5）

根据表名选择不同的数据流：

```typescript
  // 解析查询条件
  const parsedQuery = BatchExportQuerySchema.safeParse(jobDetails.query);

  // 处理评论过滤器
  const commentObjectType = tableToCommentType[parsedQuery.data.tableName];
  let processedFilter = parsedQuery.data.filter ?? [];
  if (commentObjectType) {
    const { filterState, hasNoMatches } = await applyCommentFilters({...});
    if (hasNoMatches) {
      // 评论过滤无匹配，直接返回空结果
      processedFilter = [{ type: "stringOptions", operator: "any of", column: "id", value: [] }];
    } else {
      processedFilter = filterState;
    }
  }

  // 根据表名创建对应的数据流
  const dbReadStream =
    parsedQuery.data.tableName === BatchExportTableName.Observations
      ? await getObservationStream({...})
      : parsedQuery.data.tableName === BatchExportTableName.Traces
        ? await getTraceStream({...})
        : parsedQuery.data.tableName === BatchExportTableName.Events
          ? await getEventsStream({...})
          : await getDatabaseReadStreamPaginated({...});
```

#### 流式管线构建（步骤 6）

```typescript
  // 日志 Transform：每 5000 行记录一次进度
  const loggingTransform = new Transform({
    objectMode: true,
    transform(chunk, encoding, callback) {
      rowCount++;
      if (rowCount % 5000 === 0) {
        logger.info(`[BATCH EXPORT] ... processed ${rowCount} rows`);
      }
      callback(null, chunk);
    },
  });

  // 流式管线：DB 读取 → 日志 → 格式转换
  const fileStream = pipeline(
    dbReadStream,
    loggingTransform,
    streamTransformations[jobDetails.format as BatchExportFileFormat](),
    (err) => { /* 完成/错误回调 */ },
  );
```

### 4.3 数据库读取流（以 Observations 为例）

**文件：** `worker/src/features/database-read-stream/observation-stream.ts:34-395`

#### ClickHouse 查询构建

```typescript
const query = `
  WITH scores_agg AS (
    SELECT
      trace_id,
      observation_id,
      groupArrayIf(tuple(name, avg_value, data_type, string_value), ...) AS scores_avg,
      groupArrayIf(concat(name, ':', string_value), ...) AS score_categories,
      groupArrayIf(tuple(name, string_value, data_type), ...) AS score_categories_tuples
    FROM (
      SELECT trace_id, observation_id, name, avg(value) avg_value, ...
      FROM scores final
      WHERE ${appliedScoresFilter.query}
      GROUP BY trace_id, observation_id, name, ...
    ) tmp
    GROUP BY trace_id, observation_id
  )
  SELECT
    o.id as id, o.type as type, o.name as name,
    o.start_time as "start_time", o.end_time as "end_time",
    o.trace_id as "trace_id",
    o.input as input, o.output as output, o.metadata as metadata,
    t.name as traceName, t.tags as traceTags,
    s.scores_avg as scores_avg,
    s.score_categories_tuples as score_categories_tuples
  FROM observations o
    LEFT JOIN traces t ON t.id = o.trace_id AND t.project_id = o.project_id
    LEFT JOIN scores_agg s ON s.trace_id = o.trace_id AND s.observation_id = o.id
  WHERE ${appliedObservationsFilter.query} ${search.query}
  ${skipDedup ? "" : "LIMIT 1 BY o.id, o.project_id"}
  limit {rowLimit: Int64}
`;
```

**关键优化：**
- `scores_agg` CTE 预聚合评分数据，避免 N+1 查询
- `LIMIT 1 BY` 利用 ClickHouse 的去重能力
- `join_algorithm: "partial_merge"` 优化 JOIN 性能
- ClickHouse 超时设置为 3 分钟（`request_timeout: 180_000`）

#### 流式生成与批处理

```typescript
const asyncGenerator = queryClickhouseStream<ObservationRecordReadType>({...});

return Readable.from(
  (async function* () {
    let rowBuffer: ObservationRow[] = [];
    let observationIds: string[] = [];

    for await (const row of asyncGenerator) {
      rowBuffer.push(row);
      observationIds.push(row.id);

      // 每 1000 行（CSV）或 200 行（JSON）处理一批
      if (rowBuffer.length >= batchSize) {
        // 批量获取评论（PostgreSQL）
        const commentsByObservation = await fetchCommentsForExport(
          projectId, "OBSERVATION", observationIds
        );

        for (const bufferedRow of rowBuffer) {
          // 处理单行：模型信息 enrich、评分展平、评论合并
          yield await processObservationRow(bufferedRow, commentsByObservation);
        }

        rowBuffer = [];
        observationIds = [];
      }
    }
    // 处理剩余行...
  })(),
);
```

**批处理设计：** 评论数据存储在 PostgreSQL，批量获取避免 N+1 查询。

### 4.4 CSV 序列化 Transform

**文件：** `packages/shared/src/server/utils/transforms/transformStreamToCsv.ts:13-56`

```typescript
export function transformStreamToCsv(): Transform {
  let isFirstChunk = true;
  let headers: string[] = [];
  let processingTimeMs = 0;

  return new Transform({
    objectMode: true,
    transform(row: Record<string, any>, encoding, callback): void {
      const startTime = Date.now();

      if (isFirstChunk) {
        // 首行写入表头
        headers = Object.keys(row);
        this.push(headers.map(escapeCsvField).join(DELIMITER) + "\n");
        isFirstChunk = false;
      }

      // 序列化每一行
      const values: string[] = new Array(headers.length);
      for (let i = 0; i < headers.length; i++) {
        const field = row[headers[i]] ?? "";
        const str = stringifyForCsv(field, headers[i]);  // CSV 专用序列化
        values[i] = escapeCsvField(str);
      }

      this.push(values.join(DELIMITER) + "\n");

      processingTimeMs += Date.now() - startTime;

      // ⭐ 每 50ms 让出事件循环，避免阻塞
      if (processingTimeMs >= YIELD_INTERVAL_MS) {
        processingTimeMs = 0;
        setImmediate(callback);
      } else {
        callback();
      }
    },
  });
}
```

**CSV 序列化特点：**
1. **`stringifyForCsv`**：字符串字段直接返回，不做 JSON 编码，避免双引号嵌套
2. **`escapeCsvField`**：字段用双引号包裹，内部双引号转义为 `""`
3. **事件循环让出**：每处理 50ms 调用 `setImmediate` 让出 CPU，防止大导出任务阻塞其他任务

---

## 五、阶段四：对象存储上传与下载链接生成

### 5.1 流式上传

**文件：** `worker/src/features/batchExport/handleBatchExportJob.ts:238-277`

```typescript
  const fileDate = new Date().getTime();
  const fileExtension = exportOptions[jobDetails.format].extension;
  const fileName = `${env.LANGFUSE_S3_BATCH_EXPORT_PREFIX}${fileDate}-lf-${parsedQuery.data.tableName}-export-${projectId}.${fileExtension}`;
  const expiresInSeconds = env.BATCH_EXPORT_DOWNLOAD_LINK_EXPIRATION_HOURS * 3600;

  const storageParams = {
    bucketName: env.LANGFUSE_S3_BATCH_EXPORT_BUCKET,
    accessKeyId: env.LANGFUSE_S3_BATCH_EXPORT_ACCESS_KEY_ID,
    secretAccessKey: env.LANGFUSE_S3_BATCH_EXPORT_SECRET_ACCESS_KEY,
    endpoint: env.LANGFUSE_S3_BATCH_EXPORT_ENDPOINT,
    externalEndpoint: env.LANGFUSE_S3_BATCH_EXPORT_EXTERNAL_ENDPOINT,
    region: env.LANGFUSE_S3_BATCH_EXPORT_REGION,
    forcePathStyle: env.LANGFUSE_S3_BATCH_EXPORT_FORCE_PATH_STYLE === "true",
    awsSse: env.LANGFUSE_S3_BATCH_EXPORT_SSE,
    awsSseKmsKeyId: env.LANGFUSE_S3_BATCH_EXPORT_SSE_KMS_KEY_ID,
  };

  const storageService = StorageServiceFactory.getInstance(storageParams);

  // ⭐ 流式上传：边生成边上传，不占用本地磁盘
  await storageService.uploadFileBuffered({
    fileName,
    fileType: exportOptions[jobDetails.format].fileType,
    data: fileStream,  // 直接传入 Transform 流
    partSizeBytes: env.BATCH_EXPORT_S3_PART_SIZE_MIB * 1024 * 1024,
  });

  // 生成签名 URL
  const signedUrl = await storageService.getSignedUrl(
    fileName,
    expiresInSeconds,
  );
```

### 5.2 存储服务抽象

**文件：** `packages/shared/src/server/services/StorageService.ts:478-793`

`StorageServiceFactory` 支持多种后端：

```typescript
export class StorageServiceFactory {
  public static getInstance(params: {...}): StorageService {
    if (params.useAzureBlob) return new AzureBlobStorageService(params);
    if (params.useGoogleCloudStorage) return new GoogleCloudStorageService(params);
    if (params.useOCIObjectStorage) return new OCIObjectStorageService(params);
    return new S3StorageService(params);  // 默认 S3 兼容
  }
}
```

#### S3 签名 URL 生成

```typescript
class S3StorageService implements StorageService {
  public async getSignedUrl(
    fileName: string,
    ttlSeconds: number,
    asAttachment: boolean = true,
  ): Promise<string> {
    return getSignedUrl(
      this.signedUrlClient,  // 使用独立的 endpoint 客户端（支持 externalEndpoint）
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: fileName,
        ResponseContentDisposition: asAttachment
          ? `attachment; filename="${fileName}"`
          : undefined,
      }),
      { expiresIn: ttlSeconds },
    );
  }
}
```

**签名 URL 特点：**
- 有效期由 `BATCH_EXPORT_DOWNLOAD_LINK_EXPIRATION_HOURS` 控制（默认 1 小时）
- `Content-Disposition: attachment` 触发浏览器下载
- 支持 `externalEndpoint` 替换，适配内网部署 + 外网访问场景

### 5.3 任务完成与通知

```typescript
  // 更新任务状态
  await prisma.batchExport.update({
    where: { id: batchExportId, projectId },
    data: {
      status: BatchExportStatus.COMPLETED,
      url: signedUrl,
      finishedAt: new Date(),
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    },
  });

  // 发送邮件通知
  const user = await prisma.user.findFirst({ where: { id: jobDetails.userId } });
  if (user?.email) {
    await sendBatchExportSuccessEmail({
      env,
      receiverEmail: user.email,
      downloadLink: signedUrl,
      userName: user?.name || "",
      batchExportName: jobDetails.name,
    });
  }
```

---

## 六、失败重试机制详解

### 6.1 BullMQ 原生重试

**重试配置（来自队列定义）：**
```typescript
defaultJobOptions: {
  attempts: 8,                     // 最多 8 次尝试（含首次）
  backoff: {
    type: "exponential",           // 指数退避
    delay: 5000,                   // 首次重试延迟 5 秒
  },
}
```

**指数退避计算：**
| 尝试次数 | 延迟（秒） | 累计时间（分钟） |
|---------|-----------|----------------|
| 1（首次）| 0         | 0              |
| 2       | 5         | 0.08           |
| 3       | 10        | 0.25           |
| 4       | 20        | 0.58           |
| 5       | 40        | 1.25           |
| 6       | 80        | 2.58           |
| 7       | 160       | 5.25           |
| 8       | 320       | 10.58          |

**总重试窗口：约 10.5 分钟**

### 6.2 重试触发条件

在 `batchExportQueueProcessor` 中：
```typescript
try {
  await handleBatchExportJob(job.data.payload);
  return true;
} catch (e) {
  if (e instanceof LangfuseNotFoundError) {
    return true;  // 不重试
  }
  // 更新 DB 状态为 FAILED
  await prisma.batchExport.update({...status: FAILED...});
  throw e;  // ⭐ 抛出异常 → BullMQ 触发重试
}
```

**不重试的场景：**
1. `LangfuseNotFoundError`：任务记录已被删除
2. 任务状态为 `CANCELLED`：用户主动取消
3. 任务创建超过 30 天：数据可能已过期

**会重试的场景：**
- ClickHouse 查询超时（Code 209 等）
- S3 上传失败（网络波动、限流）
- 数据库连接异常
- 任何其他未被显式捕获的异常

### 6.3 重试时的状态检查

在 `handleBatchExportJob` 开头有状态检查：
```typescript
if (jobDetails.status !== BatchExportStatus.QUEUED) {
  logger.warn(`Job ${batchExportId} has invalid status: ${jobDetails.status}. Retrying anyway.`);
}
```

**设计说明：** 即使状态不是 `QUEUED`（比如之前的尝试已更新为 `FAILED`），仍然继续处理。这是因为：
1. 重试时任务可能已被标记为 FAILED（由前一次失败的 catch 块更新）
2. "Retrying anyway" 确保重试能够正常进行
3. 状态会在处理开始时再次更新为 `PROCESSING`

### 6.4 死信与监控

- **失败保留**：`removeOnFail: 10_000`，最多保留 10000 条失败任务
- **指标监控**：`batch_export_queue.failed` 和 `.error` 指标会被采集
- **异常追踪**：`traceException(e)` 将异常发送到 APM 系统

---

## 七、状态机与生命周期

### 7.1 BatchExportStatus 枚举

**文件：** `packages/shared/src/features/batchExport/types.ts:10-16`

```typescript
export enum BatchExportStatus {
  QUEUED = "QUEUED",        // 已排队，等待处理
  PROCESSING = "PROCESSING", // 正在处理
  COMPLETED = "COMPLETED",   // 成功完成
  FAILED = "FAILED",         // 失败（超过重试次数或不可恢复错误）
  CANCELLED = "CANCELLED",   // 用户取消
}
```

### 7.2 状态流转图

```
  用户触发
     │
     ▼
  ┌──────┐
  │QUEUED│───────┐
  └──┬───┘       │ 取消
     │           ▼
     │        ┌─────────┐
     │        │CANCELLED│
     │        └─────────┘
     ▼
  ┌──────────┐
  │PROCESSING│───────┐
  └──┬───────┘       │ 取消
     │               ▼
     │ 成功       ┌─────────┐
     ▼            │CANCELLED│
  ┌─────────┐     └─────────┘
  │COMPLETED│
  └─────────┘
     │
     │ 1 小时后 URL 过期
     ▼
  前端显示 "expired"
```

### 7.3 URL 过期处理

**文件：** `web/src/features/batch-exports/server/batchExport.ts:158-173`

```typescript
const exportsWithExpiration = exports.map((e) => {
  const { finishedAt, url, ...rest } = e;
  let isExpired = false;
  if (finishedAt) {
    const finishTime = new Date(finishedAt).getTime();
    const now = new Date().getTime();
    const oneHourInMs = 60 * 60 * 1000;
    isExpired = now - finishTime > oneHourInMs;  // ⭐ 1 小时过期
  }
  return {
    ...rest,
    finishedAt,
    url: isExpired ? "expired" : url,  // 过期返回 "expired" 字符串
    user: userMap.get(e.userId) ?? null,
  };
});
```

**注意：** 这里有双重过期控制：
1. S3 签名 URL 本身的有效期（`expiresInSeconds`）
2. 前端 API 根据 `finishedAt` 计算的 1 小时过期
3. 数据库中也存储了 `expiresAt` 字段

---

## 八、关键文件速查表

| 模块 | 文件路径 | 核心职责 |
|------|---------|---------|
| API 入口 | `web/src/features/batch-exports/server/batchExport.ts` | tRPC 路由、权限、任务入库、队列投递 |
| 队列定义 | `packages/shared/src/server/redis/batchExport.ts` | BullMQ Queue 单例、重试配置 |
| Worker 注册 | `worker/src/app.ts:291-300` | 队列处理器注册、并发/限流配置 |
| Worker 管理 | `worker/src/queues/workerManager.ts` | 指标包装、错误处理 |
| 队列处理器 | `worker/src/queues/batchExportQueue.ts` | 任务分发、异常捕获、重试触发 |
| 核心业务逻辑 | `worker/src/features/batchExport/handleBatchExportJob.ts` | 前置检查、流构建、上传、通知 |
| Observation 流 | `worker/src/features/database-read-stream/observation-stream.ts` | ClickHouse 查询、数据 enrich、批处理 |
| Trace 流 | `worker/src/features/database-read-stream/trace-stream.ts` | Trace 数据流式读取 |
| CSV 转换 | `packages/shared/src/server/utils/transforms/transformStreamToCsv.ts` | 对象流转 CSV 字符串流 |
| 存储服务 | `packages/shared/src/server/services/StorageService.ts` | 多后端存储抽象、签名 URL |
| 类型定义 | `packages/shared/src/features/batchExport/types.ts` | BatchExportStatus、Schema |
| 队列契约 | `packages/shared/src/server/queues.ts` | QueueName、QueueJobs、Job 类型 |

---

## 九、设计亮点与权衡

### 9.1 设计亮点

1. **全链路流式处理**：从 ClickHouse → Transform → S3 全程流式，内存占用稳定，支持大数据量导出
2. **事件循环友好**：CSV Transform 每 50ms 让出 CPU，避免阻塞事件循环
3. **严格限流**：`concurrency: 1` + `limiter: 1/5s` 保护数据库不被导出任务压垮
4. **多存储后端**：StorageService 抽象支持 S3/Azure/GCS/OCI
5. **完善的可观测性**：每个阶段都有日志、指标、异常追踪
6. **优雅的重试策略**：指数退避 + 8 次重试，兼顾成功率与资源占用
7. **双重过期控制**：签名 URL 过期 + 业务层过期检查

### 9.2 设计权衡

| 决策 | 优点 | 缺点 |
|-----|-----|-----|
| `concurrency: 1` 单任务执行 | 保护数据库，避免影响在线业务 | 导出任务排队时间长 |
| 每 50ms 让出事件循环 | 不阻塞其他轻量任务 | 导出任务耗时增加 ~1-2% |
| 评论批量获取（1000 行/批）| 减少 PostgreSQL 查询次数 | 内存占用增加，延迟略增 |
| 任务先落库再投递队列 | 确保任务不丢失，可重试 | 极端情况可能重复投递（但有去重） |
| 8 次指数退避重试 | 容忍临时故障（网络、限流） | 最终失败时用户等待时间较长 |

### 9.3 可观测性埋点

整个链路的关键日志 marker：

| 阶段 | 日志关键词 |
|-----|-----------|
| 任务创建 | `[BATCH EXPORT] Creating export job` |
| 开始执行 | `[BATCH EXPORT] Executing Batch Export Job` |
| 启动处理 | `[BATCH EXPORT] Starting batch export for` |
| 进度日志 | `processed X rows` (每 5000 行) |
| 完成处理 | `completed processing X total rows` |
| 上传完成 | `Batch export file ... uploaded` |
| 邮件通知 | `Email sent to user` |
| 任务完成 | `Finished Batch Export Job` |
| 任务失败 | `Failed Batch Export job for id` |
| 任务取消 | `has been cancelled. Skipping processing.` |
| 任务过期 | `is older than 30 days. Marked as failed` |

---

## 十、常见问题排查

### 10.1 导出任务一直是 QUEUED 状态

**可能原因：**
- Worker 未启动：检查 `QUEUE_CONSUMER_BATCH_EXPORT_QUEUE_IS_ENABLED` 环境变量
- 队列阻塞：检查 `batch_export_queue.length` 指标
- Redis 连接问题：查看 Worker 日志中的 Redis 错误

**排查命令：**
```bash
# 查看队列深度
kubectl exec -it <redis-pod> -- redis-cli LLEN bull:batch-export-queue:wait

# 查看活跃任务
kubectl exec -it <redis-pod> -- redis-cli HGETALL bull:batch-export-queue:active
```

### 10.2 导出任务 FAILED，日志显示 ClickHouse 超时

**常见错误：** `Code: 209, e.displayText() = DB::Exception: Timeout exceeded`

**可能原因：**
- 查询条件太宽泛，扫描数据量过大
- ClickHouse 负载过高
- 网络分区

**缓解措施：**
- 缩短导出时间范围
- 增加更精确的过滤条件
- 检查 ClickHouse 节点状态

### 10.3 下载链接点击后显示过期

**可能原因：**
- 链接生成已超过 1 小时
- 系统时间不同步
- `BATCH_EXPORT_DOWNLOAD_LINK_EXPIRATION_HOURS` 配置被修改

**解决：** 重新导出

### 10.4 S3 上传失败（AccessDenied）

**检查项：**
- `LANGFUSE_S3_BATCH_EXPORT_ACCESS_KEY_ID` / `SECRET_ACCESS_KEY` 权限
- Bucket Policy 是否允许 `s3:PutObject` 和 `s3:GetObject`
- `LANGFUSE_S3_BATCH_EXPORT_BUCKET` 名称正确性
- 服务端加密配置（`aws:kms` 需要 KMS 权限）

---

## 十一、容易误判的边界机制详解

### 11.1 create 接口队列实例缺失或入队失败时的真实行为

#### 代码证据

**文件：** `web/src/features/batch-exports/server/batchExport.ts:36-67`

```typescript
// 步骤 1: 先写入数据库
const exportJob = await ctx.prisma.batchExport.create({
  data: {
    projectId,
    userId: ctx.session.user.id,
    status: BatchExportStatus.QUEUED,  // ⚠️ 状态已设为 QUEUED
    name,
    format,
    query,
  },
});

// 步骤 2: 审计日志
await auditLog({ ... });

// 步骤 3: 投递队列（注意可选链 ?.）
await BatchExportQueue.getInstance()?.add(QueueJobs.BatchExportJob, {
  id: exportJob.id,
  name: QueueJobs.BatchExportJob,
  timestamp: new Date(),
  payload: { batchExportId: exportJob.id, projectId },
});
```

**关键代码细节：**
- `BatchExportQueue.getInstance()` 可能返回 `null`（Redis 连接失败时）
- 使用了可选链 `?.`，如果实例为 `null`，`add()` 不会被调用
- 但因为是 `await ...?.add()`，如果 `add` 没执行，整个表达式返回 `undefined`，不会抛出异常
- 只有当 `add()` 本身失败（如 Redis 命令超时）才会抛出异常

**catch 块行为（第 68-77 行）：**
```typescript
} catch (e) {
  logger.error("[BATCH EXPORT] Failed to create export job", e);
  if (e instanceof TRPCError) {
    throw e;
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Creating export job failed.",
  });
}
```

#### 真实行为分析

| 场景 | 数据库状态 | 前端反馈 | 后续行为 |
|------|-----------|---------|---------|
| **队列实例为 null（可选链短路）** | ✅ 已写入，status=QUEUED | ✅ 显示成功，任务在列表中 | ⚠️ 任务永远卡在 QUEUED，不会被处理 |
| **入队失败（Redis 命令异常）** | ✅ 已写入，status=QUEUED | ❌ 显示"创建导出任务失败" | ⚠️ DB 中存在僵尸任务，前端看不到 |
| **正常路径** | ✅ 已写入，status=QUEUED | ✅ 显示成功 | ✅ Worker 正常处理 |

#### 用户可见影响

1. **静默失败（最危险）**：当 `getInstance()` 返回 null 时，前端显示"创建成功"，任务列表中显示状态为 QUEUED，但实际上任务永远不会被处理。用户会一直等待，直到手动取消或重新导出。

2. **僵尸任务**：当入队失败并抛出异常时，前端显示失败，但数据库中已经存在一条 status=QUEUED 的记录。这条记录不会出现在前端的错误提示中，但会一直留在数据库里。

3. **诊断困难**：需要查看 Web 容器的日志才能发现 `[BATCH EXPORT] Failed to create export job`，但如果是可选链短路的情况，连错误日志都没有！

---

### 11.2 处理中点击取消后的状态竞争与最终落库状态

#### 代码证据

**取消接口（web 侧）：** `web/src/features/batch-exports/server/batchExport.ts:79-97`

```typescript
cancel: protectedProjectProcedure
  .input(z.object({ projectId: z.string(), batchExportId: z.string() }))
  .mutation(async ({ input, ctx }) => {
    // ...权限校验
    await ctx.prisma.batchExport.update({
      where: { id: input.batchExportId, projectId: input.projectId },
      data: { status: BatchExportStatus.CANCELLED },  // ⚠️ 无条件更新
    });
  }),
```

**处理前检查（worker 侧）：** `worker/src/features/batchExport/handleBatchExportJob.ts:72-78`

```typescript
// Check if the batch export has been cancelled
if (jobDetails.status === BatchExportStatus.CANCELLED) {
  logger.info(`[BATCH EXPORT] Batch export ${batchExportId} has been cancelled.`);
  return; // Exit early without processing
}
```

**状态更新为 PROCESSING：** `worker/src/features/batchExport/handleBatchExportJob.ts:114-123`

```typescript
// Set job status to processing
await prisma.batchExport.update({
  where: { id: batchExportId, projectId },
  data: { status: BatchExportStatus.PROCESSING },  // ⚠️ 会覆盖 CANCELLED 状态
});
```

#### 状态竞争时序分析

**场景 1：取消发生在处理前（正常）**

```
时序：
  T1: Worker 查询 DB → status=QUEUED ✓
  T2: 用户点击取消 → DB status=CANCELLED
  T3: Worker 执行取消检查 → status=CANCELLED → 退出 ✓

最终状态：CANCELLED ✓
```

**场景 2：取消发生在"查询后、更新前"（竞态窗口）**

```
时序：
  T1: Worker 查询 DB → status=QUEUED（内存中）
  T2: 用户点击取消 → DB status=CANCELLED  ✅ 取消生效
  T3: Worker 执行取消检查 → 检查的是 T1 读取的旧值 QUEUED ❌
  T4: Worker 更新 DB → status=PROCESSING  🚨 覆盖了 CANCELLED
  T5: Worker 开始流式处理...

最终状态：PROCESSING（然后 COMPLETED/FAILED），取消操作被静默覆盖
```

**场景 3：取消发生在处理中（流式阶段）**

```
时序：
  T1: Worker 已更新为 PROCESSING，正在流式读取 ClickHouse
  T2: 用户点击取消 → DB status=CANCELLED
  T3: Worker 继续处理...（流式处理中无取消检查点）
  T4: Worker 上传 S3 成功 → 更新为 COMPLETED 🚨

最终状态：COMPLETED，用户看到取消无效
```

#### 用户可见影响

1. **取消不生效**：用户点击取消后，任务可能仍继续执行并最终完成，用户会困惑为什么取消没起作用。

2. **状态闪变**：用户可能短暂看到状态变为"已取消"，但很快又变回"处理中"或"已完成"。

3. **资源浪费**：即使取消了，ClickHouse 查询、S3 上传等资源消耗仍然发生。

4. **无检查点**：流式处理过程中（可能持续数分钟）没有任何取消检测点，一旦开始就无法中断。

---

### 11.3 失败重试时 FAILED 和 PROCESSING 的状态切换

#### 代码证据

**队列处理器（失败路径）：** `worker/src/queues/batchExportQueue.ts:24-52`

```typescript
try {
  await handleBatchExportJob(job.data.payload);
  return true;
} catch (e) {
  if (e instanceof LangfuseNotFoundError) { return true; }

  // ⚠️ 步骤 1: 更新为 FAILED
  await prisma.batchExport.update({
    where: { id: batchExportId, projectId },
    data: {
      status: BatchExportStatus.FAILED,
      finishedAt: new Date(),
      log: displayError,
    },
  });

  traceException(e);
  throw e;  // ⚠️ 步骤 2: 抛出异常触发 BullMQ 重试
}
```

**重试时的状态检查：** `worker/src/features/batchExport/handleBatchExportJob.ts:108-123`

```typescript
// ⚠️ 状态不是 QUEUED 也继续
if (jobDetails.status !== BatchExportStatus.QUEUED) {
  logger.warn(`Job ${batchExportId} has invalid status: ${jobDetails.status}. Retrying anyway.`);
}

// ⚠️ 强制更新为 PROCESSING
await prisma.batchExport.update({
  where: { id: batchExportId, projectId },
  data: { status: BatchExportStatus.PROCESSING },
});
```

#### 状态切换时序图

```
首次尝试：
  QUEUED → PROCESSING → [失败] → FAILED  (第 N 次尝试)
                                    ↓
                              BullMQ 等待退避延迟
                                    ↓
重试开始：
  FAILED → [读取到 FAILED 打 warn] → PROCESSING → [重试] → ...

完整的 8 次尝试状态序列：
  QUEUED → PROCESSING → FAILED → PROCESSING → FAILED → PROCESSING → FAILED →
  PROCESSING → FAILED → PROCESSING → FAILED → PROCESSING → FAILED → PROCESSING →
  FAILED → PROCESSING → FAILED
```

#### 关键观察

1. **状态回滚**：每次重试都会从 FAILED 变回 PROCESSING，用户看到状态在"失败"和"处理中"之间来回跳。

2. **finishedAt 被多次更新**：每次失败都会设置 `finishedAt: new Date()`，但重试成功时又会被覆盖。

3. **warn 日志的误导**：`"has invalid status: FAILED. Retrying anyway."` 这条日志容易让人误以为有 bug，但这是预期行为。

4. **最终状态**：只有第 8 次失败后，状态停留在 FAILED，不再变化。

#### 用户可见影响

1. **状态抖动**：用户在重试期间可能看到状态在 FAILED 和 PROCESSING 之间切换，造成困惑。

2. **日志误导**：如果用户查看系统日志，会看到 "invalid status" 的警告，但这是正常的重试流程。

3. **finishedAt 不准确**：在重试过程中，`finishedAt` 会被多次设置和覆盖，不代表最终完成时间。

4. **重试透明性**：用户不知道系统正在重试，只看到任务一直在"处理中"，或者偶尔闪现为"失败"。

---

### 11.4 下载链接过期判定在 worker 与 web 侧的口径差异

#### 代码证据

**Worker 侧写入 expiresAt：** `worker/src/features/batchExport/handleBatchExportJob.ts:286-291`

```typescript
const expiresInSeconds = env.BATCH_EXPORT_DOWNLOAD_LINK_EXPIRATION_HOURS * 3600;

await prisma.batchExport.update({
  where: { id: batchExportId, projectId },
  data: {
    status: BatchExportStatus.COMPLETED,
    url: signedUrl,
    finishedAt: new Date(),
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000),  // ✅ 基于配置计算
  },
});
```

**Web 侧过期判定：** `web/src/features/batch-exports/server/batchExport.ts:158-175`

```typescript
const exportsWithExpiration = exports.map((e) => {
  const { finishedAt, url, expiresAt, ...rest } = e;  // ⚠️ 解构了 expiresAt 但没使用！

  let isExpired = false;
  if (finishedAt) {
    const finishTime = new Date(finishedAt).getTime();
    const now = new Date().getTime();
    const oneHourInMs = 60 * 60 * 1000;  // ⚠️ 硬编码 1 小时！
    isExpired = now - finishTime > oneHourInMs;
  }

  return {
    ...rest,
    finishedAt,
    // expiresAt 字段没有返回给前端！
    url: isExpired ? "expired" : url,
    user: userMap.get(e.userId) ?? null,
  };
});
```

#### 口径差异对比

| 维度 | Worker 侧（写入时） | Web 侧（读取时） |
|------|-------------------|----------------|
| **过期时间基准** | `Date.now() + expiresInSeconds` | `finishedAt + 1小时` |
| **配置来源** | `BATCH_EXPORT_DOWNLOAD_LINK_EXPIRATION_HOURS` | 硬编码 `60 * 60 * 1000` |
| **使用字段** | 写入 `expiresAt` 字段 | 忽略 `expiresAt`，使用 `finishedAt` |
| **精度** | 上传完成时的精确时间 | finishedAt（可能略早于上传完成） |

#### 不一致场景

**当 `BATCH_EXPORT_DOWNLOAD_LINK_EXPIRATION_HOURS` ≠ 1 时：**

```
假设配置为 24 小时：
  Worker: expiresAt = 完成时间 + 24h
  Web:    认为过期 = 完成时间 + 1h

结果：
  - 1小时后，Web 显示 "expired"，但实际 S3 签名 URL 还有 23 小时有效期
  - 用户看到"已过期"但点击链接其实还能下载（直到 S3 URL 真正过期）
```

**当配置小于 1 小时（如 30 分钟）：**

```
Worker: expiresAt = 完成时间 + 30min
Web:    认为过期 = 完成时间 + 1h

结果：
  - 30min ~ 1h 之间：Web 显示"可下载"，但 S3 URL 实际上已过期
  - 用户点击"下载"会得到 S3 访问拒绝错误
```

#### 额外发现

1. **字段未返回**：`expiresAt` 在 Web API 的响应中被解构后丢弃了，前端无法获取真实的过期时间。

2. **双重过期**：
   - 第一层：S3 签名 URL 本身的过期时间
   - 第二层：Web 侧基于 finishedAt 的 1 小时判定
   - 两者独立，可能不一致

3. **历史兼容性问题**：如果修改 `BATCH_EXPORT_DOWNLOAD_LINK_EXPIRATION_HOURS` 配置，历史导出记录的过期判定会出错。

#### 用户可见影响

1. **提前显示过期**：配置 > 1 小时时，用户看到"已过期"但实际还能下载。

2. **过期后仍显示可下载**：配置 < 1 小时时，用户点击下载得到 S3 错误，体验很差。

3. **配置修改陷阱**：管理员修改过期配置后，不会对 Web 侧的硬编码逻辑产生影响，造成认知偏差。

---

## 总结

Langfuse 的 CSV 导出链路是一个**全异步、全流式、高容错**的设计：

1. **触发层**：tRPC API 确保安全、审计、幂等
2. **队列层**：BullMQ 提供可靠的异步执行、指数退避重试
3. **处理层**：Node.js Stream 实现低内存占用的大数据处理
4. **存储层**：对象存储 + 签名 URL 实现安全的大文件分发
5. **可观测性**：全链路日志、指标、异常追踪确保可运维性

整个设计在**数据完整性**、**系统稳定性**、**用户体验**三者之间取得了良好的平衡。
