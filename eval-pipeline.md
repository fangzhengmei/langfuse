# Langfuse 评估管线分析报告

本报告详细分析了 Langfuse 平台中三种评估手段的完整管线：**人工打分（ANNOTATION）**、**自动评测（EVAL）** 和 **数据集回放（Dataset Run）**。

---

## 一、评分对象（Score Object）

### 1.1 统一的数据模型

所有三种评估手段共享同一个 `Score` 数据模型，定义于 `packages/shared/src/domain/scores.ts`：

```typescript
{
  id: string;                    // 评分唯一ID
  projectId: string;             // 项目ID
  environment: string;           // 环境标识
  name: string;                  // 评分名称
  value: number;                 // 评分值
  source: ScoreSourceType;       // 来源：API | EVAL | ANNOTATION
  authorUserId: string | null;   // 作者用户ID（人工打分必填）
  comment: string | null;        // 评语/推理过程
  metadata: MetadataDomain;      // 元数据
  configId: string | null;       // 评分配置ID
  queueId: string | null;        // 评分队列ID（人工打分）
  executionTraceId: string | null; // 执行追踪ID（自动评测）
  
  // 关联对象 - 三者必居其一
  traceId: string | null;        // 关联Trace
  observationId: string | null;  // 关联Observation
  datasetRunId: string | null;   // 关联数据集运行
  
  // 数据类型
  dataType: ScoreDataTypeType;   // NUMERIC | CATEGORICAL | BOOLEAN | CORRECTION | TEXT
  stringValue: string | null;    // 分类/布尔/文本类型的值
}
```

### 1.2 评分来源区分

| 来源类型 | source值 | 特点 | 典型应用场景 |
|---------|---------|------|-------------|
| API 打分 | `API` | 通过SDK或API直接提交 | 业务系统集成、自定义评估逻辑 |
| 自动评测 | `EVAL` | 系统自动执行，带执行追踪 | LLM-as-Judge、规则评估器 |
| 人工打分 | `ANNOTATION` | 人工审核提交，关联队列 | 人工审核、标注任务、质量检查 |

### 1.3 数据集运行项（Dataset Run Item）

数据集回放有专门的关联对象，定义于 `packages/shared/src/domain/dataset-run-items.ts`：

```typescript
{
  id: string;
  projectId: string;
  datasetRunId: string;          // 数据集运行ID
  datasetItemId: string;         // 数据集项ID
  datasetId: string;             // 数据集ID
  traceId: string;               // 执行产生的Trace ID
  observationId: string | null;  // 执行产生的Observation ID
  error: string | null;          // 执行错误信息
  
  // 数据集快照
  datasetItemInput: JSON;        // 输入快照
  datasetItemExpectedOutput: JSON; // 期望输出快照
  datasetItemMetadata: MetadataDomain;
}
```

---

## 二、评估触发机制

### 2.1 人工打分（ANNOTATION）触发流程

#### 2.1.1 人工评分队列机制

人工打分通过 **Annotation Queue** 机制管理，定义于 `web/src/features/annotation-queues/server/annotationQueuesRouter.ts`：

**队列管理：**
- `create()`: 创建评分队列，关联多个 ScoreConfig
- `update()`: 更新队列配置
- `delete()`: 删除队列
- `all()`: 查询所有队列，含待处理和已完成统计

**任务分发与锁定：**
```typescript
// fetchAndLockNext 核心逻辑
const item = await prisma.annotationQueueItem.findFirst({
  where: {
    queueId: input.queueId,
    status: AnnotationQueueStatus.PENDING,
    OR: [
      { lockedAt: null },                    // 未锁定
      { lockedAt: { lt: fiveMinutesAgo } },  // 锁定超时（5分钟）
      { lockedByUserId: ctx.session.user.id }, // 自己锁定的
    ],
    NOT: { id: { in: input.seenItemIds } },  // 跳过已看过的
  },
  orderBy: { createdAt: "asc" },
});

// 原子性锁定
await prisma.annotationQueueItem.update({
  where: { id: item.id, projectId: input.projectId },
  data: {
    lockedAt: now,
    lockedByUserId: ctx.session.user.id,
  },
});
```

#### 2.1.2 人工评分提交

通过分数API提交，定义于 `web/src/server/api/routers/scores.ts`：

```typescript
// 创建ANNOTATION类型分数
const scoreId = randomUUID();
const scoreEvent = {
  id: scoreId,
  timestamp: new Date().toISOString(),
  type: eventTypes.SCORE_CREATE,
  body: {
    id: scoreId,
    traceId: input.traceId,
    observationId: input.observationId,
    name: input.name,
    value: input.value,
    dataType: input.dataType,
    stringValue: input.stringValue,
    source: ScoreSourceEnum.ANNOTATION,  // 标记为人工来源
    authorUserId: ctx.session.user.id,   // 记录作者
    comment: input.comment,
    configId: input.configId,
    queueId: input.queueId,              // 关联队列
    environment: input.environment,
  },
};

// 写入S3并入队处理
await uploadScore({ projectId, scoreId, eventId: v4(), event: scoreEvent });
await enqueueScoreIngestion({ projectId, scoreId, eventId: v4() });
```

#### 2.1.3 触发时机

1. **UI直接打分**：用户在Trace详情页或Observation详情页点击"评分"
2. **评分队列任务**：用户从队列领取待评分任务后提交
3. **数据集标注面板**：在Dataset Run详情页的Annotation Panel中评分
4. **API/SDK提交**：通过公共API手动提交ANNOTATION类型分数

---

### 2.2 自动评测（EVAL）触发流程

#### 2.2.1 评估配置（Job Configuration）

自动评测基于预配置的评估规则，包含：
- `targetObject`: 目标类型（TRACE/OBSERVATION/DATASET）
- `filter`: 筛选条件（哪些Trace/Observation需要评估）
- `evalTemplateId`: 评估模板（Prompt和模型配置）
- `variableMapping`: 变量映射配置
- `sampling`: 采样率（0-1，控制评估范围）
- `delay`: 延迟执行时间（毫秒）

#### 2.2.2 三大触发入口

自动评测通过三个队列触发，定义于 `worker/src/queues/evalQueue.ts`：

| 触发队列 | 触发时机 |  enforcedTimeScope | 目标对象 |
|---------|---------|-------------------|---------|
| `TraceUpsert` | Trace插入/更新时实时触发 | `NEW`（仅新数据） | Trace级别评估 |
| `DatasetRunItemUpsert` | 数据集运行项创建时触发 | `NEW` | 数据集回放评估 |
| `CreateEvalQueue` | 用户在UI点击"回溯评估" | 无限制（全量历史） | 批量历史数据评估 |

**核心创建逻辑**（`worker/src/features/evaluation/evalService.ts`）：

```typescript
async function createEvalJobs({ event, sourceEventType, jobTimestamp, enforcedJobTimeScope }) {
  // 1. 获取项目所有ACTIVE状态的评估配置
  const configs = await prisma.jobConfiguration.findMany({
    where: {
      jobType: "EVAL",
      projectId: event.projectId,
      status: "ACTIVE",
      blockedAt: null,
      targetObject: { in: [EvalTargetObject.TRACE, EvalTargetObject.DATASET] },
      ...(enforcedJobTimeScope ? { timeScope: { has: enforcedJobTimeScope } } : {}),
    },
  });

  // 2. 防循环：跳过内部Langfuse traces（避免eval->eval->eval无限循环）
  if (sourceEventType === "trace-upsert" && event.traceEnvironment?.startsWith("langfuse")) {
    return;
  }

  // 3. 对每个配置执行匹配检查
  for (const config of configs) {
    // 检查Trace是否存在且匹配筛选条件
    const traceExists = await checkTraceExistsAndGetTimestamp({
      projectId: event.projectId,
      traceId: event.traceId,
      filter: config.targetObject === TRACE ? validatedFilter : [],
    });

    // 数据集配置额外检查数据集项
    if (isDatasetConfig) {
      const datasetItem = await getDatasetItemIdsByTraceIdCh({ ... });
      // 检查是否应为Observation级别评估
      if (sourceEventType === "trace-upsert" && datasetItem.observationId) {
        continue; // Trace级别触发器跳过Observation级别的数据集项
      }
    }

    // 4.  deduplication：跳过已存在的Job
    const existingJob = await findMatchingJob(config.id, datasetItemId, observationId);
    
    // 5. 采样过滤
    if (Number(config.sampling) !== 1) {
      const random = Math.random();
      if (random > Number(config.sampling)) continue;
    }

    // 6. 创建JobExecution并入队执行
    const jobExecutionId = randomUUID();
    await prisma.jobExecution.create({
      id: jobExecutionId,
      projectId: event.projectId,
      jobConfigurationId: config.id,
      jobInputTraceId: event.traceId,
      jobInputDatasetItemId: datasetItem?.id,
      jobInputObservationId: observationId,
      status: "PENDING",
      startTime: new Date(),
    });

    // 7. 加入EvaluationExecution队列（支持延迟执行）
    await EvalExecutionQueue.getInstance().add(
      QueueName.EvaluationExecution,
      {
        name: QueueJobs.EvaluationExecution,
        payload: { projectId, jobExecutionId, delay: config.delay },
      },
      { delay: config.delay }
    );
  }
}
```

#### 2.2.3 执行阶段（LLM-as-Judge）

```typescript
async function executeLLMAsJudgeEvaluation({ projectId, jobExecutionId, config, template }) {
  // 1. 变量提取：从Trace/Observation/数据集提取Prompt变量
  const extractedVariables = await extractVariablesFromTracingData({
    projectId,
    variables: template.vars,
    traceId: job.jobInputTraceId,
    variableMapping: parsedVariableMapping,
  });

  // 2. 编译评估Prompt
  const prompt = compileEvalPrompt({
    templatePrompt: template.prompt,
    variables: extractedVariables,
  });

  // 3. 调用LLM（结构化输出）
  const llmOutput = await callLLM({
    messages: buildEvalMessages(prompt),
    structuredOutputSchema: compiledOutputDefinition.outputResultSchema,
    traceSinkParams: {
      traceId: createW3CTraceId(jobExecutionId),
      traceName: `Execute evaluator: ${template.name}`,
      environment: LangfuseInternalTraceEnvironment.LLMJudge, // 内部追踪，避免循环
    },
  });

  // 4. 构建并写入Score
  const scoreWritePayloads = buildEvalScoreWritePayloads({
    outputResult: parsedLLMOutput,
    primaryScoreId: randomUUID(),
    traceId: job.jobInputTraceId,
    observationId: job.jobInputObservationId,
    scoreName: config.scoreName,
    source: ScoreSourceEnum.EVAL,  // 标记为自动评测来源
    executionTraceId: internalTraceId,
    metadata: buildEvalExecutionMetadata(...),
  });

  // 5. 批量写入S3并入队
  await Promise.all(scoreWritePayloads.map(async ({ scoreId, event }) => {
    await uploadScore({ projectId, scoreId, eventId: v4(), event });
    await enqueueScoreIngestion({ projectId, scoreId, eventId: v4() });
  }));

  // 6. 更新Job状态为COMPLETED
  await prisma.jobExecution.update({
    where: { id: jobExecutionId, projectId },
    data: {
      status: JobExecutionStatus.COMPLETED,
      endTime: new Date(),
      jobOutputScoreId: primaryScoreId,
      executionTraceId: internalTraceId,
    },
  });
}
```

---

### 2.3 数据集回放（Dataset Run）触发流程

#### 2.3.1 数据集运行创建

数据集回放通过 `ExperimentCreateQueue` 触发，定义于 `worker/src/queues/experimentQueue.ts`：

```typescript
// 核心流程
async function createExperimentJobClickhouse({ event }) {
  // 1. 获取数据集所有item
  // 2. 为每个item创建dataset run item
  // 3. 调用应用执行（通过配置的LLM端点）
  // 4. 记录执行Trace和Observation
  // 5. 触发DatasetRunItemUpsert事件 → 触发自动评测
}
```

#### 2.3.2 数据集运行与自动评测的联动

数据集回放完成后，**自动触发关联的评估配置**：
- Dataset Run创建时，每个Dataset Run Item会触发 `DatasetRunItemUpsert` 队列事件
- 该事件被 evalService 消费，匹配 `targetObject: DATASET` 的评估配置
- 为每个匹配的配置创建 JobExecution，执行自动评测

**数据流：**
```
用户点击"运行数据集" 
  → 创建 DatasetRun
  → 逐个执行 DatasetItem → 生成 Trace/Observation
  → 创建 DatasetRunItem（关联 Trace ID）
  → 触发 DatasetRunItemUpsert 队列事件
  → EvalService 匹配 DATASET 目标的评估配置
  → 创建 JobExecution 并入队执行
  → 生成 EVAL 类型的 Score
```

---

## 三、结果回写机制

### 3.1 统一的Score写入流程

三种评估手段最终都通过相同的S3+队列机制写入，定义于 `packages/shared/src/server/repositories/scores.ts`：

```
┌─────────────────────────────────────────────────────────────┐
│                    Score 写入统一流程                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 构建 ScoreEvent                                         │
│     ├── id: score UUID                                      │
│     ├── timestamp: 创建时间                                  │
│     ├── type: SCORE_CREATE                                  │
│     └── body: 完整Score数据（含source标记）                  │
│                                                             │
│  2. 上传到 S3 (MinIO)                                       │
│     └── 路径: scores/{projectId}/{scoreId}.json             │
│                                                             │
│  3. 加入 IngestionQueue                                     │
│     └── Worker异步消费写入Clickhouse                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 写入Payload构建

#### 3.2.1 自动评测Payload构建

定义于 `worker/src/features/evaluation/evalScoreEvent.ts`：

```typescript
function buildEvalScoreWritePayloads({ outputResult, primaryScoreId, ... }) {
  const commonParams = {
    traceId,
    observationId,
    scoreName,
    reasoning: outputResult.reasoning,
    source: ScoreSourceEnum.EVAL,
    executionTraceId,
    metadata: {
      jobExecutionId,
      jobConfigurationId,
      targetTraceId,
      targetObservationId,
      targetDatasetItemId,
    },
  };

  // NUMERIC/BOOLEAN类型：单Score
  if (outputResult.dataType === ScoreDataTypeEnum.NUMERIC) {
    return [buildScoreWritePayload({ ...commonParams, value: outputResult.score })];
  }

  // CATEGORICAL类型：可能多Score（多标签）
  return outputResult.matches.map((match, index) =>
    buildScoreWritePayload({
      ...commonParams,
      scoreId: index === 0 ? primaryScoreId : randomUUID(),
      stringValue: match,
      dataType: ScoreDataTypeEnum.CATEGORICAL,
    })
  );
}
```

#### 3.2.2 人工打分Payload构建

定义于 `web/src/server/api/routers/scores.ts`：

```typescript
{
  source: ScoreSourceEnum.ANNOTATION,
  authorUserId: ctx.session.user.id,  // 必须：标注者身份
  queueId: input.queueId,             // 可选：关联的评分队列
  comment: input.comment,             // 评语
  configId: input.configId,           // 关联评分配置
}
```

### 3.3 数据库持久化

#### 3.3.1 ClickHouse 存储（主存储）

Score最终写入 `scores` 表，支持：
- 按 `source` 字段筛选（EVAL/ANNOTATION/API）
- 按 `traceId/observationId/datasetRunId` 关联查询
- 按 `configId` 聚合统计
- 按 `authorUserId` 统计人工标注工作量

#### 3.3.2 Postgres 关联表

| 表名 | 用途 | 关联字段 |
|-----|------|---------|
| `job_executions` | 自动评测执行记录 | `jobOutputScoreId` → `scores.id` |
| `annotation_queue_items` | 人工评分任务 | `objectId` → `traceId/observationId` |
| `dataset_run_items` | 数据集运行项 | `traceId` → `scores.traceId` |
| `score_configs` | 评分配置 | `configId` → `scores.configId` |

### 3.4 结果展示与聚合

#### 3.4.1 Trace/Observation详情页
- 展示所有关联Score（EVAL+ANNOTATION+API）
- 区分来源标签："Auto" / "Human" / "API"
- 显示评分人头像和名称（人工打分）
- 显示评估器名称（自动评测）

#### 3.4.2 数据集运行结果页
- 展示每个Dataset Item的执行结果
- 并排展示Expected Output vs Actual Output
- 聚合显示所有评估分数（自动+人工）
- 支持按Score过滤、排序、对比

#### 3.4.3 评分分析面板
- 按来源分布统计（EVAL vs ANNOTATION vs API）
- 评分名称、数值分布
- 时间趋势分析
- 标注者工作统计（人工打分）

---

## 四、完整管线对比

| 维度 | 人工打分（ANNOTATION） | 自动评测（EVAL） | 数据集回放（Dataset Run） |
|-----|-----------------------|-----------------|--------------------------|
| **触发源** | 用户主动操作 / 队列领取 | 实时事件 / 回溯任务 | 数据集运行执行 |
| **触发时机** | 按需、手动 | 实时/近实时、自动 | 批量、执行后自动触发 |
| **评分对象** | Trace / Observation | Trace / Observation | Dataset Item（关联Trace） |
| **执行者** | 真实用户 | LLM / 规则引擎 | 目标应用 + 自动评测 |
| **Source标记** | `ANNOTATION` | `EVAL` | `EVAL`（评测结果） |
| **必填字段** | `authorUserId` | `executionTraceId`, `metadata.jobExecutionId` | `datasetRunId` |
| **执行状态** | 即时完成 | PENDING → IN_PROGRESS → COMPLETED/ERROR | RUNNING → COMPLETED |
| **队列** | Annotation Queue | TraceUpsert / CreateEvalQueue / EvaluationExecution | ExperimentCreate / DatasetRunItemUpsert |
| **结果写入** | 直接S3+IngestionQueue | 评测完成后S3+IngestionQueue | 执行完成后触发评测写入 |
| **幂等性** | 用户多次提交创建多个Score | 同一Job配置+目标仅创建一次Job | 同Dataset Run可重跑 |
| **防循环** | 无需 | 跳过`langfuse-*`环境的内部Trace | 依赖自动评测防循环 |

---

## 五、关键设计要点

### 5.1 防止无限评估循环

**问题**：自动评测本身也会产生Trace，如果不加限制会导致：
```
用户Trace → 评测 → 评测Trace → 再评测 → 无限循环...
```

**解决方案**：
```typescript
// worker/src/features/evaluation/evalService.ts
if (sourceEventType === "trace-upsert" && 
    event.traceEnvironment?.startsWith("langfuse")) {
  logger.debug("Skipping eval for internal Langfuse trace");
  return;
}
```

内部执行Trace使用特殊环境前缀：
- `LangfuseInternalTraceEnvironment.LLMJudge` = "langfuse-llm-judge"

### 5.2 延迟执行与状态管理

自动评测支持 `delay` 配置（毫秒），目的：
1. 等待Trace完整上报（LLM流式输出可能耗时）
2. 避免Ingestion和Evaluation资源竞争
3. 削峰填谷，平滑系统负载

### 5.3 观察级别（Observation-level）评估

支持针对特定Observation（如单个LLM调用）评估：
- 通过 `variableMapping.objectName` 指定要提取的Observation名称
- 支持按Observation类型筛选
- Dataset Run Item可直接关联到Observation级别

### 5.4 采样机制

通过 `config.sampling` 字段控制评估覆盖率：
- 1 = 100% 评估（默认）
- 0.1 = 10% 采样评估
- 0 = 暂停评估

采样使用简单随机数：
```typescript
const random = Math.random();
if (random > Number(config.sampling)) continue;
```

---

## 六、代码入口索引

| 功能模块 | 文件路径 | 核心函数 |
|---------|---------|---------|
| 评分域模型 | `packages/shared/src/domain/scores.ts` | `ScoreSchema`, `ScoreSourceEnum` |
| 评估服务 | `worker/src/features/evaluation/evalService.ts` | `createEvalJobs()`, `evaluate()`, `executeLLMAsJudgeEvaluation()` |
| 评分事件构建 | `worker/src/features/evaluation/evalScoreEvent.ts` | `buildEvalScoreWritePayloads()` |
| 评估队列处理器 | `worker/src/queues/evalQueue.ts` | `evalJobTraceCreatorQueueProcessor()`, `evalJobExecutorQueueProcessorBuilder()` |
| 人工评分队列API | `web/src/features/annotation-queues/server/annotationQueuesRouter.ts` | `fetchAndLockNext`, `create`, `update` |
| 分数API | `web/src/server/api/routers/scores.ts` | `createAnnotation`, `delete`, `all` |
| 数据集运行项模型 | `packages/shared/src/domain/dataset-run-items.ts` | `DatasetRunItemSchema` |
| 实验队列处理器 | `worker/src/queues/experimentQueue.ts` | `experimentCreateQueueProcessor()` |

---

*报告生成时间：2026年*
*基于 Langfuse 代码库分析*
