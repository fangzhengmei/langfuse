# Score 与 Eval 任务关联逻辑分析

## 一、概述

本文档详细分析了 Langfuse 系统中评分（Score）与评估任务（Eval）之间的关联逻辑，包括数据模型、执行流程、查询关联等各个层面的实现机制。

## 二、数据模型关联

### 2.1 数据库表结构关系

#### 2.1.1 JobExecution 表（PostgreSQL）

JobExecution 表是 Eval 任务执行的记录，通过 `jobOutputScoreId` 字段与 Score 建立关联：

```prisma
model JobExecution {
  id                  String              @id @default(cuid())
  projectId           String              @map("project_id")
  jobConfigurationId  String              @map("job_configuration_id")
  jobInputTraceId     String?             @map("job_input_trace_id")
  jobInputObservationId String?          @map("job_input_observation_id")
  jobInputDatasetItemId String?          @map("job_input_dataset_item_id")
  jobOutputScoreId    String?             @map("job_output_score_id")  // 关键关联字段
  status              JobExecutionStatus  @default(PENDING)
  startTime           DateTime?           @map("start_time")
  endTime             DateTime?           @map("end_time")
  error               String?
  executionTraceId    String?             @map("execution_trace_id")
  createdAt           DateTime            @default(now()) @map("created_at")
  updatedAt           DateTime            @default(now()) @updatedAt @map("updated_at")
  
  project            Project             @relation(fields: [projectId], references: [id], onDelete: Cascade)
  jobConfiguration   JobConfiguration    @relation(fields: [jobConfigurationId], references: [id], onDelete: Cascade)
  
  @@index([projectId, id])
  @@map("job_executions")
}
```

**关键关联字段说明**：
- `jobOutputScoreId`: 存储该 Eval 任务生成的 Score ID，建立从 Eval 执行到 Score 的关联

#### 2.1.2 JobConfiguration 表（PostgreSQL）

JobConfiguration 表是 Eval 任务的配置，定义了评分的名称：

```prisma
model JobConfiguration {
  id              String              @id @default(cuid())
  projectId       String              @map("project_id")
  jobType         JobType             @map("job_type")
  status          JobConfigState      @default(ACTIVE)
  evalTemplateId  String?             @map("eval_template_id")
  scoreName       String              @map("score_name")  // 评分名称
  filter          Json
  targetObject    String              @map("target_object")
  variableMapping Json                @map("variable_mapping")
  sampling        Decimal
  
  project         Project             @relation(fields: [projectId], references: [id], onDelete: Cascade)
  evalTemplate    EvalTemplate?       @relation(fields: [evalTemplateId], references: [id], onDelete: SetNull)
  jobExecutions   JobExecution[]
  
  @@index([projectId, id])
  @@map("job_configurations")
}
```

**关键关联字段说明**：
- `scoreName`: 指定该 Eval 配置生成的评分名称

#### 2.1.3 Score 数据（ClickHouse）

Score 实际存储在 ClickHouse 中，包含来源标识和元数据：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String | Score 唯一标识 |
| `project_id` | String | 项目 ID |
| `source` | String | 评分来源，`EVAL` 表示来自评估任务 |
| `name` | String | 评分名称，与 `JobConfiguration.scoreName` 对应 |
| `metadata` | Map | 包含 `job_execution_id`、`job_configuration_id` 等关联信息 |

### 2.2 关联关系图

```
┌───────────────────┐
│  JobConfiguration │
├───────────────────┤
│  id               │
│  scoreName        │───┐
│  evalTemplateId   │   │
└───────────────────┘   │
          │              │
          │ 1:N          │
          ▼              │
┌───────────────────┐   │
│   JobExecution    │   │
├───────────────────┤   │
│  id               │   │
│  jobConfigurationId  │
│  jobOutputScoreId │◀──┘
│  status           │
└───────────────────┘
          │
          │ 1:1 (via jobOutputScoreId)
          ▼
┌───────────────────┐
│      Score        │
├───────────────────┤
│  id               │
│  source = 'EVAL'  │
│  name             │
│  metadata.job_execution_id │
│  metadata.job_configuration_id │
└───────────────────┘
```

## 三、执行流程关联

### 3.1 Eval 执行核心流程

文件位置：`worker/src/features/evaluation/evalService.ts`

`executeLLMAsJudgeEvaluation` 函数是 LLM 评估执行的核心逻辑，负责从变量提取、LLM 调用到 Score 持久化的完整流程。

#### 3.1.1 关键执行步骤

```typescript
export async function executeLLMAsJudgeEvaluation({
  projectId,
  jobExecutionId,
  job,
  config,
  template,
  extractedVariables,
  environment,
  deps = createProductionEvalExecutionDependencies(),
}): Promise<void> {
  // 1. 编译 prompt
  const prompt = compileEvalPrompt({
    templatePrompt: template.prompt,
    variables: extractedVariables,
  });

  // 2. 生成 Score ID
  const primaryScoreId = randomUUID();

  // 3. 构建执行元数据（关键关联信息）
  const executionMetadata = buildEvalExecutionMetadata({
    jobExecutionId,           // JobExecution ID
    jobConfigurationId: job.jobConfigurationId,  // JobConfiguration ID
    targetTraceId: job.jobInputTraceId,
    targetObservationId: job.jobInputObservationId,
    targetDatasetItemId: job.jobInputDatasetItemId,
  });

  // 4. 调用 LLM 获取评分结果
  const llmOutput = await deps.callLLM(...);

  // 5. 构建 Score 写入载荷
  const scoreWritePayloads = buildEvalScoreWritePayloads({
    outputResult: parsedLLMOutput,
    primaryScoreId,
    traceId: job.jobInputTraceId,
    observationId: job.jobInputObservationId,
    scoreName: config.scoreName,
    environment,
    executionTraceId,
    metadata: executionMetadata,  // 关联元数据
  });

  // 6. 写入 Score 到 S3 并入队到 ingestion
  await Promise.all(
    scoreWritePayloads.map(async ({ scoreId, eventId, event }) => {
      await deps.uploadScore({
        projectId,
        scoreId,
        eventId,
        event,
      });
      await deps.enqueueScoreIngestion({
        projectId,
        scoreId,
        eventId,
      });
    }),
  );

  // 7. 更新 JobExecution 状态，关联 Score ID
  await deps.updateJobExecution({
    id: jobExecutionId,
    projectId,
    data: {
      status: JobExecutionStatus.COMPLETED,
      endTime: new Date(),
      jobOutputScoreId: primaryScoreId,  // 关键：将 Score ID 关联到 JobExecution
      executionTraceId,
    },
  });
}
```

### 3.2 Score 事件构建

文件位置：`worker/src/features/evaluation/evalScoreEvent.ts`

#### 3.2.1 `buildEvalScoreWritePayloads` 函数

该函数负责将 Eval 输出转换为 Score 写入载荷，包含关联元数据：

```typescript
export function buildEvalScoreWritePayloads(params: {
  outputResult: EvalOutputResult;
  primaryScoreId: string;
  traceId: string | null;
  observationId: string | null;
  scoreName: string;
  environment: string;
  executionTraceId: string;
  metadata: Record<string, string>;  // 包含 job_execution_id 等
}): EvalScoreWritePayload[] {
  const commonParams = {
    traceId: params.traceId,
    observationId: params.observationId,
    scoreName: params.scoreName,
    reasoning: params.outputResult.reasoning,
    environment: params.environment,
    executionTraceId: params.executionTraceId,
    metadata: params.metadata,  // 关联元数据传递
  };

  // 根据数据类型构建不同的 Score 载荷
  if (params.outputResult.dataType === ScoreDataTypeEnum.NUMERIC) {
    return [
      buildScoreWritePayload({
        ...commonParams,
        scoreId: params.primaryScoreId,
        scoreValue: params.outputResult.score,
        dataType: ScoreDataTypeEnum.NUMERIC,
      }),
    ];
  }

  // ... BOOLEAN 和 CATEGORICAL 类型处理
}
```

#### 3.2.2 `buildScoreEvent` 函数

构建完整的 Score 事件，设置来源为 `EVAL`：

```typescript
export function buildScoreEvent(params: BuildScoreEventParams): ScoreEventType {
  const bodyBase = {
    id: params.scoreId,
    traceId: params.traceId,
    observationId: params.observationId,
    name: params.scoreName,
    comment: params.reasoning,
    source: ScoreSourceEnum.EVAL,  // 关键：标记为 EVAL 来源
    environment: params.environment,
    executionTraceId: params.executionTraceId,
    metadata: params.metadata,      // 包含 Eval 关联信息
  };

  // ... 根据数据类型构建具体 Score
}
```

## 四、查询层面的关联

文件位置：`web/src/server/api/routers/scores.ts`

### 4.1 Score 列表查询时的 Job 关联

在查询 Score 列表时，通过 `jobOutputScoreId` 反向查找对应的 Job 信息：

```typescript
all: protectedProjectProcedure
  .input(ScoreAllOptions)
  .query(async ({ input, ctx }) => {
    // 1. 从 ClickHouse 查询 Score 数据
    const clickhouseScoreData = await getScoresUiTable({
      projectId: input.projectId,
      // ... 查询参数
    });

    // 2. 批量查询 JobExecution，通过 jobOutputScoreId 关联
    const [jobExecutions, users] = await Promise.all([
      ctx.prisma.jobExecution.findMany({
        where: {
          projectId: input.projectId,
          jobOutputScoreId: {
            in: clickhouseScoreData.map((score) => score.id),  // 通过 Score ID 反向查找
          },
        },
        select: {
          id: true,
          jobConfigurationId: true,
          jobOutputScoreId: true,
        },
      }),
      // ... 其他查询
    ]);

    // 3. 关联 jobConfigurationId 到 Score 结果
    return {
      scores: clickhouseScoreData.map<AllScoresReturnType>((score) => {
        const jobExecution = jobExecutions.find(
          (je) => je.jobOutputScoreId === score.id,
        );
        return {
          ...score,
          jobConfigurationId: jobExecution?.jobConfigurationId ?? null,
          // ... 其他字段
        };
      }),
    };
  }),
```

### 4.2 Score 元数据中的 Eval 信息

Score 的 metadata 字段存储了完整的 Eval 关联信息：

```typescript
// metadata 结构示例
{
  "job_execution_id": "job_exec_123",
  "job_configuration_id": "job_config_456",
  "target_trace_id": "trace_789",
  "target_observation_id": "obs_abc",
  "target_dataset_item_id": "dataset_item_def"
}
```

这些元数据可以通过 `getScoreMetadataById` 查询获取：

```typescript
getScoreMetadataById: protectedProjectProcedure
  .input(z.object({ projectId: z.string(), id: z.string() }))
  .query(async ({ input }) => {
    return (await getScoreMetadataById(input.projectId, input.id)) ?? null;
  }),
```

## 五、关联链路总结

### 5.1 Score → Eval 正向链路

```
1. JobConfiguration 创建
   ↓ scoreName
2. JobExecution 创建（PENDING）
   ↓ jobConfigurationId
3. executeLLMAsJudgeEvaluation 执行
   ├─ 生成 primaryScoreId
   ├─ 构建 metadata（包含 job_execution_id、job_configuration_id）
   ├─ buildEvalScoreWritePayloads 构建 Score
   ├─ 写入 Score 到 ClickHouse（source = EVAL）
   ↓
4. 更新 JobExecution.jobOutputScoreId = primaryScoreId
   ↓
5. Score.metadata 包含完整的 Eval 关联信息
```

### 5.2 Eval → Score 反向查询链路

```
1. 查询 Score 列表（ClickHouse）
   ↓ id
2. 查询 JobExecution（PostgreSQL）
   where jobOutputScoreId IN (score ids)
   ↓ jobConfigurationId
3. 结果中附加 jobConfigurationId
   ↓
4. 前端可通过 jobConfigurationId 跳转到 Eval 详情页
```

## 六、关键设计要点

### 6.1 双数据源关联策略

- **Score 数据**：存储在 ClickHouse（高性能、列式存储）
- **Job 元数据**：存储在 PostgreSQL（关系型、事务性）
- **关联机制**：通过 `jobOutputScoreId` 和 Score metadata 实现跨数据库关联

### 6.2 元数据冗余设计

Score metadata 中冗余存储了 Job 关联信息，目的是：
1. 减少查询时的 JOIN 操作（特别是在 ClickHouse 中）
2. 支持在 JobExecution 被删除后仍能追溯来源
3. 便于快速过滤和聚合 Eval 来源的 Score

### 6.3 最终一致性保证

由于 Score 写入是异步的（通过 S3 + ingestion 队列），JobExecution 更新时可能存在短暂的不一致窗口，但通过以下方式保证最终一致：
1. Score ID 在执行前预先生成（primaryScoreId）
2. JobExecution 更新是幂等操作
3. Score metadata 包含完整关联信息，即使 JobExecution 查询失败也不影响 Score 本身的可用性

## 七、代码文件索引

| 功能模块 | 文件路径 | 关键函数/类 |
|---------|---------|------------|
| Eval 执行核心 | `worker/src/features/evaluation/evalService.ts` | `executeLLMAsJudgeEvaluation` |
| Score 事件构建 | `worker/src/features/evaluation/evalScoreEvent.ts` | `buildEvalScoreWritePayloads`, `buildScoreEvent` |
| Score 查询路由 | `web/src/server/api/routers/scores.ts` | `all`, `allFromEvents`, `getScoreMetadataById` |
| 数据模型 | `packages/shared/prisma/schema.prisma` | `JobExecution`, `JobConfiguration` |
