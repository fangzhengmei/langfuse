# Langfuse 评估管线分析报告

本报告详细分析了 Langfuse 平台中三种评估手段的完整管线：**人工打分（ANNOTATION）**、**自动评测（EVAL）** 和 **数据集回放（Dataset Run）**，并补充了 **Session 维度评分**的完整实现。

---

## 一、评分对象（Score Object）

### 1.1 完整的评分对象体系

Langfuse 评估系统采用**统一 Score 数据模型 + 多维度关联对象**的设计。Score 模型定义了四个关联字段，但每种评估手段支持的评分对象有明确边界，并非所有评估手段都支持四类对象。

#### 1.1.1 Score 核心数据模型

所有评估手段共享同一个 `Score` 数据模型，定义于 `packages/shared/src/domain/scores.ts`：

```typescript
{
  id: string;                    // 评分唯一ID
  projectId: string;             // 项目ID
  environment: string;           // 环境标识
  name: string;                  // 评分名称
  value: number;                 // 评分值（数值评分使用）
  source: ScoreSourceType;       // 来源：API | EVAL | ANNOTATION
  authorUserId: string | null;   // 作者用户ID（人工打分必填）
  comment: string | null;        // 评语/推理过程
  metadata: MetadataDomain;      // 元数据
  configId: string | null;       // 评分配置ID
  queueId: string | null;        // 评分队列ID（人工打分）
  executionTraceId: string | null; // 执行追踪ID（自动评测）
  createdAt: Date;               // 创建时间
  updatedAt: Date;               // 更新时间
  timestamp: Date;               // 评分时间戳
  
  // ========== 关联对象字段 - 数据模型层支持四种关联
  // ========== 注意：每种评估手段支持的评分对象有明确边界，详见1.1.3
  traceId: string | null;        // 关联Trace（单次调用链路）
  observationId: string | null;  // 关联Observation（单个LLM调用/步骤）
  sessionId: string | null;      // 关联Session（会话维度，多Trace聚合）
  datasetRunId: string | null;   // 关联数据集运行（评测回放）
  
  // ========== 数据类型 ==========
  dataType: ScoreDataTypeType;   // NUMERIC | CATEGORICAL | BOOLEAN | CORRECTION | TEXT
  stringValue: string | null;    // 分类/布尔/文本类型的值
  longStringValue: string;       // 长文本值
}
```

#### 1.1.2 评分对象字段定义说明

> **重要修正**：四个关联字段是数据模型层的定义，不代表"四者必居其一"的强制约束关系，实际使用时不同评估手段有明确的边界。

| 评分对象 | 关联字段 | 说明 |
|---------|---------|------|
| **Trace** | `traceId` | 单次调用链路级别评分 |
| **Observation** | `observationId` | 单个LLM调用/步骤级别评分（必须同时设置traceId） |
| **Session** | `sessionId` | 会话维度评分，多Trace聚合评分 |
| **Dataset Run** | `datasetRunId` | 数据集运行维度评分标识 |

#### 1.1.3 三套评估手段支持的评分对象边界

基于真实代码实现（见 `web/src/server/api/routers/scores.ts:568-569`）：

| 评分对象 | 人工打分（ANNOTATION） | 自动评测（EVAL） | 数据集回放（Dataset Run） |
|---------|-----------------------|-----------------|--------------------------|
| **Trace** | ✅ 支持 | ✅ 支持 | ✅ 支持（通过traceId关联） |
| **Observation** | ✅ 支持（必须同时设置traceId） | ✅ 支持（必须同时设置traceId） | ✅ 支持（通过observationId关联） |
| **Session** | ✅ 支持 | ❌ 不支持 | ❌ 不支持 |
| **Dataset Run** | ❌ 不支持（代码中硬编码`datasetRunId: null`） | ❌ 不支持（通过traceId间接关联） | ✅ 仅用于结果聚合标识，不直接评分 |

**关键代码证据**：
```typescript
// web/src/server/api/routers/scores.ts:568-569
// only trace and session scores are supported for annotation
datasetRunId: null,  // 人工打分硬编码不支持datasetRunId
```

#### 1.1.3 评分来源区分

| 来源类型 | source值 | 特点 | 典型应用场景 |
|---------|---------|------|-------------|
| API 打分 | `API` | 通过SDK或API直接提交 | 业务系统集成、自定义评估逻辑 |
| 自动评测 | `EVAL` | 系统自动执行，带执行追踪 | LLM-as-Judge、规则评估器 |
| 人工打分 | `ANNOTATION` | 人工审核提交，关联队列 | 人工审核、标注任务、质量检查 |

#### 1.1.4 自动评测目标对象（EvalTargetObject）

自动评测配置通过 `EvalTargetObject` 区分评估目标类型，定义于 `packages/shared/src/features/evals/types.ts`：

```typescript
export const EvalTargetObject = {
  TRACE: "trace",        // Trace级别评估
  DATASET: "dataset",    // 数据集级别评估
  EVENT: "event",        // Observation级别评估（events表）
  EXPERIMENT: "experiment", // 实验项级别评估
} as const;
```

### 1.2 会话维度评分（Session-level Scoring）

会话维度评分支持对包含多轮对话的完整会话进行质量评估，是人工打分的重要应用场景。

#### 1.2.1 会话评分特点

- **聚合粒度**：一个 Session 包含多个 Trace，评分针对整个会话
- **上下文感知**：标注人员可查看完整对话历史
- **适用场景**：对话系统质量评估、多轮任务完成度评估

#### 1.2.2 会话标注处理器

定义于 `web/src/features/annotation-queues/components/processors/SessionAnnotationProcessor.tsx`：

```typescript
// 会话标注左侧面板展示
- 分页加载会话内的所有Traces（默认PAGE_SIZE=10）
- 展示每个Trace的输入输出、时间戳
- 支持查看完整对话上下文
- 显示会话ID、环境、Trace总数等元信息

// 会话标注右侧面板（AnnotationDrawerSection）
- 评分目标类型: { type: "session", sessionId: item.objectId }
- 支持多维度评分（基于队列关联的ScoreConfig）
- 支持添加评语和标签
```

#### 1.2.3 会话评分提交Payload

```typescript
{
  source: ScoreSourceEnum.ANNOTATION,
  authorUserId: ctx.session.user.id,
  sessionId: item.objectId,        // 会话ID（Trace/Observation留空）
  queueId: queueId,                // 关联队列
  configId: scoreConfigId,         // 评分配置
  name: scoreConfigName,
  value: scoreValue,
  dataType: scoreDataType,
  comment: annotationComment,
  environment: sessionEnvironment,
}
```

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

**AnnotationQueueObjectType 枚举：**
```typescript
export const AnnotationQueueObjectType = {
  TRACE: "trace",
  OBSERVATION: "observation",
  SESSION: "session",  // 会话维度
} as const;
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
    sessionId: input.sessionId,        // 会话ID（新增）
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

1. **UI直接打分**：
   - Trace详情页：针对单次调用链路评分
   - Observation详情页：针对单个LLM调用/步骤评分
   - Session详情页：针对完整多轮会话评分

2. **评分队列任务**：
   - Trace队列：从队列领取Trace标注任务
   - Observation队列：从队列领取Observation标注任务
   - Session队列：从队列领取会话标注任务（`objectType: "SESSION"`）

3. **数据集标注面板**：在Dataset Run详情页的Annotation Panel中评分

4. **API/SDK提交**：通过公共API手动提交ANNOTATION类型分数（支持Trace/Observation/Session三种维度，不支持Dataset Run）

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

    // 4. deduplication：跳过已存在的Job
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
│     └── body: 完整Score数据（含source标记和sessionId）       │
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

> **重要修正**：自动评测不直接设置 `datasetRunId`，仅通过 `traceId`/`observationId` 关联。Dataset Run 查询时通过 `dataset_run_items` 表关联 Trace ID 实现聚合。

```typescript
// 真实代码函数签名（无 datasetRunId 参数）
export function buildEvalScoreWritePayloads(params: {
  outputResult: EvalOutputResult;
  primaryScoreId: string;
  traceId: string | null;
  observationId: string | null;
  scoreName: string;
  environment: string;
  executionTraceId: string;
  metadata: Record<string, string>;
}): EvalScoreWritePayload[] {
  const commonParams = {
    traceId: params.traceId,
    observationId: params.observationId,
    scoreName: params.scoreName,
    reasoning: params.outputResult.reasoning,
    environment: params.environment,
    executionTraceId: params.executionTraceId,
    metadata: params.metadata,  // 含 jobExecutionId, jobConfigurationId, targetDatasetItemId 等
    source: ScoreSourceEnum.EVAL,
  };

  // NUMERIC/BOOLEAN类型：单Score
  if (params.outputResult.dataType === ScoreDataTypeEnum.NUMERIC) {
    return [buildScoreWritePayload({ ...commonParams, scoreId: params.primaryScoreId, scoreValue: params.outputResult.score })];
  }

  // CATEGORICAL类型：可能多Score（多标签）
  return params.outputResult.matches.map((scoreValue, index) =>
    buildScoreWritePayload({
      ...commonParams,
      scoreId: index === 0 ? params.primaryScoreId : randomUUID(),
      scoreValue,
      dataType: ScoreDataTypeEnum.CATEGORICAL,
    })
  );
}
```

**关联关系说明**：
- Score → Trace ID → Dataset Run Item → Dataset Run
- 查询Dataset Run评分列表时，通过 `dataset_run_items` 表JOIN关联查询获得

#### 3.2.2 人工打分Payload构建

定义于 `web/src/server/api/routers/scores.ts`：

```typescript
{
  source: ScoreSourceEnum.ANNOTATION,
  authorUserId: ctx.session.user.id,  // 必须：标注者身份
  queueId: input.queueId,             // 可选：关联的评分队列
  sessionId: input.sessionId,         // 可选：关联会话
  comment: input.comment,             // 评语
  configId: input.configId,           // 关联评分配置
}
```

### 3.3 数据库持久化

#### 3.3.1 ClickHouse 存储（主存储）

Score最终写入 `scores` 表，支持：
- 按 `source` 字段筛选（EVAL/ANNOTATION/API）
- 按 `traceId/observationId/sessionId/datasetRunId` 关联查询
- 按 `configId` 聚合统计
- 按 `authorUserId` 统计人工标注工作量

#### 3.3.2 Postgres 关联表

| 表名 | 用途 | 关联字段 |
|-----|------|---------|
| `job_executions` | 自动评测执行记录 | `jobOutputScoreId` → `scores.id` |
| `annotation_queue_items` | 人工评分任务 | `objectId` → `traceId/observationId/sessionId` |
| `dataset_run_items` | 数据集运行项 | `traceId` → `scores.traceId` |
| `score_configs` | 评分配置 | `configId` → `scores.configId` |

### 3.4 结果展示与聚合

#### 3.4.1 Trace/Observation详情页
- 展示所有关联Score（EVAL+ANNOTATION+API）
- 区分来源标签："Auto" / "Human" / "API"
- 显示评分人头像和名称（人工打分）
- 显示评估器名称（自动评测）

#### 3.4.2 Session详情页
- 展示会话内所有Trace及其评分
- 聚合显示整个会话的平均得分
- 支持会话级别的人工标注评分

#### 3.4.3 数据集运行结果页
- 展示每个Dataset Item的执行结果
- 并排展示Expected Output vs Actual Output
- 聚合显示所有评估分数（自动+人工）
- 支持按Score过滤、排序、对比

#### 3.4.4 评分分析面板
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
| **支持的评分对象** | **Trace / Observation / Session**<br>（不支持Dataset Run） | **Trace / Observation**<br>（不支持Session、不支持Dataset Run直接关联） | 生成Trace/Observation后通过自动评测间接评分 |
| **关键约束** | `datasetRunId`硬编码为`null` | 仅通过`traceId`/`observationId`关联 | 通过Dataset Run Item关联Trace/Observation |
| **执行者** | 真实用户 | LLM / 规则引擎 | 目标应用 + 自动评测 |
| **Source标记** | `ANNOTATION` | `EVAL` | `EVAL`（评测结果） |
| **必填字段** | `authorUserId` | `executionTraceId`, `metadata.jobExecutionId` | `datasetRunId`仅用于聚合查询 |
| **执行状态** | 即时完成 | PENDING → IN_PROGRESS → COMPLETED/ERROR | RUNNING → COMPLETED |
| **队列** | Annotation Queue（TRACE/OBSERVATION/SESSION） | TraceUpsert / CreateEvalQueue / EvaluationExecution / ObservationEval | ExperimentCreate / DatasetRunItemUpsert |
| **结果写入** | 直接S3+IngestionQueue | 评测完成后S3+IngestionQueue | 执行完成后触发评测写入 |
| **幂等性** | 用户多次提交创建多个Score | 同一Job配置+目标仅创建一次Job | 同Dataset Run可重跑 |
| **防循环** | 无需 | 跳过`langfuse-*`环境的内部Trace | 依赖自动评测防循环 |

---

## 五、评估管线完整串联关系

### 5.1 三大评估手段的依赖与联动

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Langfuse 评估管线全景图                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐  │
│  │   人工打分       │     │   自动评测       │     │  数据集回放       │  │
│  │  (ANNOTATION)    │     │    (EVAL)       │     │ (Dataset Run)    │  │
│  └────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘  │
│           │                         │                         │            │
│           │                         │                         │            │
│           ▼                         ▼                         ▼            │
│  ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐  │
│  │ Annotation Queue  │     │ Evaluation Config  │     │  Dataset Items   │  │
│  │  - TRACE          │     │  - TRACE目标      │     │  - Input          │  │
│  │  - OBSERVATION    │────▶│  - DATASET目标    │◀────│  - Expected Output│  │
│  │  - SESSION         │     │  - EVENT目标       │     │  - Metadata       │  │
│  └──────────────────┘     └──────────────────┘     └──────────────────┘  │
│                                    │                                    │
│                                    ▼                                    │
│                              ┌──────────────────┐                           │
│                              │  Unified Score  │◀──────────────────────────┘  │
│                              │     Model      │                              │
│                              │  - traceId     │                              │
│                              │  - observationId│                              │
│                              │  - sessionId  │                              │
│                              │  - datasetRunId│                             │
│                              └──────────────────┘                              │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 自动评测与其他流程串联

#### 5.2.1 Trace 级别自动评测触发链

```
1. 数据接入
    │
    ▼
2. TraceUpsert 事件入队
    │
    ▼
3. evalJobTraceCreatorQueueProcessor 执行
    ├─ 拉取 ACTIVE 状态的 EVAL 配置（targetObject=TRACE）
    ├─ 检查 Trace 环境（跳过 langfuse-* 内部 Trace
    ├─ 应用 filter 条件匹配
    ├─ 应用 sampling 采样
    └─ 去重检查（避免重复创建Job）
    │
    ▼
4. 创建 JobExecution (PENDING 状态)
    │
    ▼
5. 加入 EvaluationExecution 队列（支持 delay 延迟执行）
    │
    ▼
6. evalJobExecutorQueueProcessor 执行
    ├─ 提取变量（通过 variableMapping 从 Trace/Observation 提取）
    ├─ 编译评估 Prompt
    ├─ 调用 LLM 执行评估（生成内部 Trace，环境=langfuse-llm-judge）
    ├─ 解析 LLM 输出（结构化输出校验）
    ├─ 构建 Score Event
    │  ├─ source = EVAL
    │  ├─ executionTraceId = 内部 Trace ID
    │  └─ metadata = { jobExecutionId, jobConfigurationId 等
    │
    └─ 写入 S3 + 加入 IngestionQueue
    │
    ▼
7. 更新 JobExecution 状态（COMPLETED/ERROR）
    │
    ▼
8. Score 持久化到 ClickHouse scores 表
```

#### 5.2.2 数据集回放自动评测触发链

```
1. 用户点击"运行数据集"
    │
    ▼
2. 创建 Experiment（Dataset Run）
    │
    ▼
3. 加入 ExperimentCreate 队列
    │
    ▼
4. 遍历所有 Dataset Item
    ├─ 调用配置的模型端点
    ├─ 生成 Trace 和 Observation
    └─ 创建 DatasetRunItem 记录
    │
    ▼
5. 触发 DatasetRunItemUpsert 事件入队
    │
    ▼
6. evalJobDatasetCreatorQueueProcessor 执行
    ├─ 拉取 ACTIVE 状态的 EVAL 配置（targetObject=DATASET）
    ├─ 匹配数据集 filter 条件
    └─ 创建 JobExecution
    │
    ▼
7. 后续流程同 Trace 级别自动评测（步骤 5-8）
    │
    ▼
8. Score 通过 Trace ID 关联 Dataset Run（查询时通过 Dataset Run Item 关联）
```

#### 5.2.3 Observation 级别自动评测触发链

```
1. Observation 数据写入（events 表
    │
    ▼
2. scheduleObservationEvals 调度
    ├─ 拉取 ACTIVE 状态的 EVAL 配置（targetObject=EVENT/EXPERIMENT）
    ├─ 匹配 observationType 匹配（generation/span等
    └─ 创建 JobExecution
    │
    ▼
3. 加入 ObservationEval 队列
    │
    ▼
4. 后续变量映射（无需 objectName，直接从 Observation 提取）
    │
    ▼
5. 执行 LLM 评估并写入 Score
```

### 5.3 人工打分完整流程

#### 5.3.1 基于队列的人工打分流程

```
1. 创建 Annotation Queue
    ├─ 关联多个 ScoreConfig（评分维度配置）
    └─ 配置队列元数据（名称、描述等）
    │
    ▼
2. 批量添加待标注任务
    ├─ 按 Trace 查询筛选
    ├─ 按 Session 批量添加到队列
    ├─ 按 Observation 批量添加到队列
    └─ 按筛选结果批量添加到队列
    │
    ▼
3. 标注人员领取任务（fetchAndLockNext）
    ├─ 查询 PENDING 状态的队列项
    ├─ 锁定（lockedAt, lockedByUserId
    └─ 5分钟超时自动释放
    │
    ▼
4. 标注界面展示
    ├─ Trace/Observation/Session 详情
    ├─ 关联的输入输出上下文
    └─ 多维度评分表单（基于 ScoreConfig）
    │
    ▼
5. 提交评分
    ├─ source = ANNOTATION
    ├─ authorUserId = 当前用户ID
    ├─ queueId = 队列ID
    └─ configId = 评分配置ID
    │
    ▼
6. 写入 S3 + 加入 IngestionQueue
    │
    ▼
7. 更新 AnnotationQueueItem 状态为 COMPLETED
```

### 5.4 数据流动与关联关系

#### 5.4.1 核心数据表关联关系

```
scores 表
  │
  ├─ traceId ──────┐
  ├─ observationId ───┤
  ├─ sessionId ─────┤
  └─ datasetRunId ────┘
                     │
  traces 表 ◄──────────┘
    │
    ├─ sessionId ────────┐
    └─ userId
                     │
  observations 表 ◄────────┘
    │
    └─ traceId
                     │
  sessions 表 ◄──────────┘
    │
    └─ 包含多个 traces（通过 traces.sessionId 关联）
                     │
  dataset_run_items 表 ◄───┘
    │
    ├─ datasetRunId
    ├─ datasetItemId
    ├─ traceId
    └─ observationId
                     │
  job_executions 表 ◄─────────────────────────┘
    │
    ├─ jobConfigurationId
    ├─ jobInputTraceId
    ├─ jobInputObservationId
    ├─ jobInputDatasetItemId
    └─ jobOutputScoreId ───────────────────────────────────────────────► scores.id
```

#### 5.4.2 annotation_queue_items 表关联

```
annotation_queue_items
  │
  ├─ queueId ──────────► annotation_queues.id
  ├─ objectType ───────► TRACE / OBSERVATION / SESSION
  ├─ objectId ────────► traces.id / observations.id / sessions.id
  ├─ status ───────────► PENDING / LOCKED / COMPLETED / CANCELLED
  ├─ lockedAt
  └─ lockedByUserId
```

### 5.5 三种评估手段的协同场景组合使用

#### 5.5.1 典型组合模式

| 组合模式 | 适用场景 | 实现方式 |
|---------|---------|
| **自动评测为主，人工抽检为辅 | 评测效率与自动评测质量 | 1. 自动评测全量运行，2. 按 Score 筛选低分自动加入人工标注队列抽检 |
| **数据集冷启动 | 新功能上线前基准测试 | 1. 准备标注数据集构建 golden set，2. 人工标注基准，3. 运行数据集回放，4. 迭代 Prompt |
| **多模型对比实验 | 新旧模型版本迭代验证 | 1. 同一数据集跑多个模型版本，2. 自动评测多维度评分，3. 人工对比排序 |
| **持续学习闭环 | 生产环境质量监控 | 1. 生产Trace自动评测，2. 低分自动加入人工标注队列，3. 人工标注结果反馈优化 Prompt |

#### 5.5.2 统一评分的联动示例

```
生产环境
     │
     ▼
Trace 实时上报
     │
     ▼
自动评测（EVAL）
     │
     ├─ Score >= 4分 ──► 正常通过
     │
     └─ Score < 3分 ──► 自动加入 Annotation Queue
                             │
                             ▼
                        人工标注审核（ANNOTATION）
                             │
                             ▼
                        标注结果分析
                             │
                             ▼
                        优化评估 Prompt / 模型微调
                             │
                             ▼
                        更新 Evaluation Config
```

---

## 六、关键设计要点

### 6.1 防止无限评估循环

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

### 6.2 延迟执行与状态管理

自动评测支持 `delay` 配置（毫秒），目的：
1. 等待Trace完整上报（LLM流式输出可能耗时）
2. 避免Ingestion和Evaluation资源竞争
3. 削峰填谷，平滑系统负载

### 6.3 观察级别（Observation-level）评估

支持针对特定Observation（如单个LLM调用）评估：
- 通过 `variableMapping.objectName` 指定要提取的Observation名称
- 支持按Observation类型筛选
- Dataset Run Item可直接关联到Observation级别

### 6.4 采样机制

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

## 七、代码入口索引

| 功能模块 | 文件路径 | 核心函数/组件 |
|---------|---------|-------------|
| 评分域模型 | `packages/shared/src/domain/scores.ts` | `ScoreSchema`, `ScoreSourceEnum` |
| 评估目标对象类型 | `packages/shared/src/features/evals/types.ts` | `EvalTargetObject`, `variableMapping` |
| 评估服务 | `worker/src/features/evaluation/evalService.ts` | `createEvalJobs()`, `evaluate()`, `executeLLMAsJudgeEvaluation()` |
| Observation级别评估 | `worker/src/features/evaluation/observationEval/` | `scheduleObservationEvals()`, `processObservationEval()` |
| 评分事件构建 | `worker/src/features/evaluation/evalScoreEvent.ts` | `buildEvalScoreWritePayloads()` |
| 评估队列处理器 | `worker/src/queues/evalQueue.ts` | `evalJobTraceCreatorQueueProcessor()`, `evalJobDatasetCreatorQueueProcessor()`, `evalJobExecutorQueueProcessorBuilder()` |
| 人工评分队列API | `web/src/features/annotation-queues/server/annotationQueuesRouter.ts` | `create()`, `fetchAndLockNext`, `update` |
| 人工评分队列项API | `web/src/features/annotation-queues/server/annotationQueueItemsRouter.ts` | `all()`, `add()`, `byId()` |
| 分数API | `web/src/server/api/routers/scores.ts` | `createAnnotation`, `delete`, `all()` |
| 会话标注处理器 | `web/src/features/annotation-queues/components/processors/SessionAnnotationProcessor.tsx` | `SessionAnnotationProcessor` |
| 数据集运行项模型 | `packages/shared/src/domain/dataset-run-items.ts` | `DatasetRunItemSchema` |
| 实验队列处理器 | `worker/src/queues/experimentQueue.ts` | `experimentCreateQueueProcessor()` |
| 会话API | `web/src/server/api/routers/sessions.ts` | `all()`, `byId()`, `allFromEvents()` |

---

*报告生成时间：2026年*
*基于 Langfuse 代码库分析*
