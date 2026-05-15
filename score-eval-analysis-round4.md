# Score 与 Eval 任务关联链路分析 - 第四轮

## 重要说明：Prisma 字段名与数据库真实列名的区别

在查阅代码和编写 SQL 查询时，请注意以下命名区别：

| 上下文 | 命名风格 | 示例 |
|-------|---------|------|
| **Prisma 字段名**（TypeScript 代码中使用） | camelCase | `jobOutputScoreId` |
| **数据库真实列名**（SQL 查询中使用） | snake_case | `job_output_score_id` |

**示例对比：**
```prisma
// schema.prisma 中的定义
model JobExecution {
  jobOutputScoreId String? @map("job_output_score_id")
  // ↑ Prisma 字段名 (camelCase)    ↑ 数据库列名 (snake_case)
}
```

本文档中所有 SQL 查询示例均使用数据库真实列名（snake_case）。

---

## 一、核心架构总览

### 1.1 关联关系全景图

```
┌─────────────────────┐
│  JobConfiguration   │
│  (Eval 配置)        │
├─────────────────────┤
│  id                 │
│  scoreName          │
│  evalTemplateId     │
│  ...                │
└───────────┬─────────┘
            │ 1:N
            ▼
┌─────────────────────┐
│    JobExecution     │
│  (Eval 执行实例)    │
├─────────────────────┤
│  id                 │
│  jobConfigurationId │
│  job_output_score_id│◀────┐  ← 只有首条 Score ID（数据库列名）
│  status             │      │
│  ...                │      │
└───────────┬─────────┘      │
            │                │
            │ 1:N            │
            ▼                │
┌─────────────────────────────────────────┐
│          Scores (ClickHouse)            │
├─────────────────────────────────────────┤
│  id (score_0: primaryScoreId)  ─────────┘  ← 首条 Score 与 Job 关联
│  id (score_1: randomUUID)               ← 后续 Score 独立存储
│  id (score_2: randomUUID)
│  ...
│  source = 'EVAL'
│  name = JobConfiguration.scoreName
│  metadata (Map(String, String)):        ← 所有 Score 都包含完整关联信息
│    - job_execution_id
│    - job_configuration_id
│    - target_trace_id
│    - target_observation_id
│    - target_dataset_item_id
└─────────────────────────────────────────┘
```

### 1.2 不同数据类型的 Score 产出数量对比

| 评估类型 (dataType) | Score 产出数量 | 说明 |
|---------------------|---------------|------|
| **NUMERIC** | 1 | 只产出一条数值型评分 |
| **BOOLEAN** | 1 | 只产出一条布尔型评分 |
| **CATEGORICAL** | N | 根据 `matches` 数组长度产出 N 条分类评分，N ≥ 1 |

---

## 二、分类评估（CATEGORICAL）多 Score 产出机制

### 2.1 核心代码实现

文件位置：`worker/src/features/evaluation/evalScoreEvent.ts:208-215`

```typescript
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
    metadata: params.metadata,  // 所有 Score 共享相同的 metadata
  };

  // ... NUMERIC 和 BOOLEAN 类型：只返回 1 条 Score

  // CATEGORICAL 类型：遍历 matches 数组，每条生成一个 Score
  return params.outputResult.matches.map((scoreValue, index) =>
    buildScoreWritePayload({
      ...commonParams,
      // 关键：只有 index === 0 的首条 Score 使用 primaryScoreId
      // 后续 Score 生成新的随机 UUID
      scoreId: index === 0 ? params.primaryScoreId : randomUUID(),
      scoreValue,
      dataType: ScoreDataTypeEnum.CATEGORICAL,
    }),
  );
}
```

### 2.2 EvalOutputResult 类型定义

文件位置：`packages/shared/src/features/evals/outputDefinition.ts:163-178`

```typescript
export type EvalOutputResult =
  | {
      dataType: typeof ScoreDataTypeEnum.NUMERIC;
      score: number;      // 单个数值
      reasoning: string;
    }
  | {
      dataType: typeof ScoreDataTypeEnum.BOOLEAN;
      score: boolean;     // 单个布尔值
      reasoning: string;
    }
  | {
      dataType: typeof ScoreDataTypeEnum.CATEGORICAL;
      matches: string[];  // 分类匹配结果数组，可能有多个值
      reasoning: string;
    };
```

**关键点**：
- 当 `shouldAllowMultipleMatches: true` 时，`matches` 数组可能包含多个分类值
- 数组中的每个值都会生成一条独立的 Score 记录
- 所有这些 Score 共享相同的 `reasoning`、`metadata` 等元数据

### 2.3 多 Score 产出的归一化处理

文件位置：`packages/shared/src/features/evals/outputDefinition.ts:349-376`

```typescript
function normalizeValidatedEvalOutputResult(
  result: RawEvalOutputResult,
  resolvedOutputDefinition: ResolvedEvalOutputDefinition,
): EvalOutputResult {
  // ... NUMERIC 和 BOOLEAN 处理

  return {
    dataType: ScoreDataTypeEnum.CATEGORICAL,
    // 关键：确保总是数组形式，即使单匹配也转为 [score]
    matches: Array.isArray(result.score)
      ? result.score
      : [result.score as string],
    reasoning: result.reasoning,
  };
}
```

---

## 三、job_output_score_id 回填机制

### 3.1 回填时机与代码位置

文件位置：`worker/src/features/evaluation/evalService.ts:999-1005`

```typescript
export async function executeLLMAsJudgeEvaluation({
  projectId,
  jobExecutionId,
  // ... 其他参数
}): Promise<void> {
  // 1. 预先生成 primaryScoreId（在 LLM 调用之前）
  const primaryScoreId = randomUUID();

  // 2. 构建包含关联信息的 metadata
  const executionMetadata = buildEvalExecutionMetadata({
    jobExecutionId,           // JobExecution ID
    jobConfigurationId: job.jobConfigurationId,  // JobConfiguration ID
    targetTraceId: job.jobInputTraceId,
    targetObservationId: job.jobInputObservationId,
    targetDatasetItemId: job.jobInputDatasetItemId,
  });

  // 3. 调用 LLM 并生成 Score 载荷（可能多条）
  const scoreWritePayloads = buildEvalScoreWritePayloads({
    outputResult: parsedLLMOutput.data,
    primaryScoreId,  // 传入预生成的 ID
    // ... 其他参数
    metadata: executionMetadata,
  });

  // 4. 写入所有 Score 到 ClickHouse（包括首条和后续条）

  // 5. 关键：只将首条 Score 的 ID 回填到 JobExecution
  await deps.updateJobExecution({
    id: jobExecutionId,
    projectId,
    data: {
      status: JobExecutionStatus.COMPLETED,
      endTime: new Date(),
      jobOutputScoreId: primaryScoreId,  // Prisma 字段名，对应数据库列名 job_output_score_id
      executionTraceId,
    },
  });
}
```

### 3.2 回填规则总结

| 条件 | 回填行为（Prisma 字段名） | 数据库列名 |
|------|---------------------------|-----------|
| NUMERIC 类型 | `jobOutputScoreId = primaryScoreId` | `job_output_score_id` |
| BOOLEAN 类型 | `jobOutputScoreId = primaryScoreId` | `job_output_score_id` |
| CATEGORICAL 类型 | `jobOutputScoreId = primaryScoreId`（只回填 matches[0] 对应的 Score） | `job_output_score_id` |
| 所有类型的后续 Score | 不回填到 JobExecution，只存储在 ClickHouse | - |

### 3.3 为什么只回填首条？

设计决策的合理性：
1. **1:1 关系约束**：PostgreSQL 的 JobExecution 表只有一个 `job_output_score_id` 字段，无法存储多个 ID
2. **主键唯一性**：JobExecution 作为执行实例，需要唯一的"主 Score"标识
3. **Metadata 冗余设计**：所有 Score 的 metadata 中都包含关联信息，即使不回填也能反向追溯

---

## 四、Score 侧反向追溯机制

### 4.1 通过 metadata 反查的完整路径

#### 4.1.1 Score Metadata 结构（ClickHouse Map 类型）

所有由 Eval 产生的 Score（包括首条和后续条）都在 `metadata` 字段中存储完整的关联信息。在 ClickHouse 中，metadata 是 `Map(String, String)` 类型，使用 map 方式访问：

```typescript
// Score.metadata（ClickHouse Map(String, String) 类型）
{
  job_execution_id: "job_exec_abc123",      // 可直接查询 JobExecution
  job_configuration_id: "job_config_xyz789", // 可直接查询 JobConfiguration
  target_trace_id: "trace_123",              // 评估的目标 Trace
  target_observation_id: "obs_456",          // 评估的目标 Observation
  target_dataset_item_id: "dataset_789"      // 评估的目标 Dataset Item（可选）
}
```

#### 4.1.2 反查执行流程图

```
已知：Score ID（任意一条，包括首条和后续条）
       ↓
步骤1：从 ClickHouse 查询 Score
       SELECT s.id, s.metadata FROM scores s WHERE s.id = {scoreId: String}
       ↓
步骤2：从 metadata map 中提取关联 ID（ClickHouse map 访问语法）
       s.metadata['job_execution_id'] AS job_execution_id
       s.metadata['job_configuration_id'] AS job_configuration_id
       ↓
步骤3：从 PostgreSQL 查询 JobExecution（可选）
       SELECT * FROM job_executions WHERE id = 'je_123'
       ↓
步骤4：从 PostgreSQL 查询 JobConfiguration（可选）
       SELECT * FROM job_configurations WHERE id = 'jc_456'
```

### 4.2 代码中的反查实现示例

#### 4.2.1 Score 列表查询时关联 JobExecution

文件位置：`web/src/server/api/routers/scores.ts`

```typescript
all: protectedProjectProcedure
  .input(ScoreAllOptions)
  .query(async ({ input, ctx }) => {
    // 1. 从 ClickHouse 批量查询 Score
    const clickhouseScoreData = await getScoresUiTable({
      projectId: input.projectId,
      // ... 查询参数
    });

    // 2. 提取所有 Score ID
    const scoreIds = clickhouseScoreData.map(score => score.id);

    // 3. 批量查询 JobExecution，通过 job_output_score_id 反向匹配
    const jobExecutions = await ctx.prisma.jobExecution.findMany({
      where: {
        projectId: input.projectId,
        jobOutputScoreId: {  // Prisma 字段名，对应数据库列名 job_output_score_id
          in: scoreIds,     // 注意：只匹配首条 Score
        },
      },
      select: {
        id: true,
        jobConfigurationId: true,
        jobOutputScoreId: true,  // Prisma 字段名
      },
    });

    // 4. 将 Job 信息关联回 Score
    return {
      scores: clickhouseScoreData.map(score => {
        const jobExecution = jobExecutions.find(
          je => je.jobOutputScoreId === score.id  // Prisma 字段名
        );
        return {
          ...score,
          jobConfigurationId: jobExecution?.jobConfigurationId ?? null,
          // 注意：非首条 Score 的 jobConfigurationId 会是 null！
          // 需要通过 metadata 另行查询
        };
      }),
    };
  }),
```

**重要提示**：上述查询只能找到首条 Score 对应的 JobExecution。对于非首条 Score，需要通过 metadata 单独查询。

#### 4.2.2 单条 Score 详情查询（完整关联）

```typescript
// 伪代码：获取 Score 完整关联信息
async function getScoreWithEvalInfo(scoreId: string, projectId: string) {
  // 1. 从 ClickHouse 获取 Score，包括 metadata
  const score = await getScoreById({ projectId, scoreId });

  if (!score || !score.metadata) {
    return score;
  }

  // 2. 从 metadata map 提取关联 ID
  const jobExecutionId = score.metadata['job_execution_id'];
  const jobConfigurationId = score.metadata['job_configuration_id'];

  // 3. 并行查询 JobExecution 和 JobConfiguration
  const [jobExecution, jobConfiguration] = await Promise.all([
    jobExecutionId
      ? prisma.jobExecution.findUnique({
          where: { id: jobExecutionId, projectId },
        })
      : null,
    jobConfigurationId
      ? prisma.jobConfiguration.findUnique({
          where: { id: jobConfigurationId, projectId },
        })
      : null,
  ]);

  return {
    ...score,
    jobExecution,
    jobConfiguration,
  };
}
```

### 4.3 两种反查方式对比

| 反查方式 | 适用场景 | 优点 | 缺点 |
|---------|---------|------|------|
| **通过 job_output_score_id** | 首条 Score、批量查询 | JOIN 效率高、SQL 简单 | 只能找到首条 Score，后续条找不到 |
| **通过 Score.metadata map** | 所有 Score（首条 + 后续条） | 所有 Score 都能追溯、不依赖 Postgres 字段、ClickHouse 原生 map 访问 | 需要单独查询、不适合大规模批量 JOIN |

### 4.4 首条 Score 与后续 Score 反查对照示例

#### 场景说明：一次 CATEGORICAL 类型 Eval 产出 3 条 Score

```
一次 Eval 执行
  JobExecution ID: je_123
  JobConfiguration ID: jc_456
  primaryScoreId: score_primary_abc
  matches: ["positive", "confident", "helpful"]
   ↓
  产出 3 条 Scores：
   - Score_0: id = score_primary_abc (首条)
   - Score_1: id = random_uuid_xyz (后续)
   - Score_2: id = random_uuid_123 (后续)
```

---

#### 示例 1：首条 Score（Score_0）反查

| 反查方式 | 具体操作 | 结果 |
|---------|---------|------|
| **方式 1：通过 job_output_score_id** | `SELECT * FROM job_executions WHERE job_output_score_id = 'score_primary_abc'` | ✓ 成功，找到 JobExecution je_123 |
| **方式 2：通过 metadata map** | 从 `score.metadata['job_execution_id']` 提取 'je_123'，再查询 | ✓ 成功，找到 JobExecution je_123 |

**代码示例：**
```typescript
// 首条 Score：两种方式都可用
const score0 = await getScoreById({ projectId: 'proj_123', scoreId: 'score_primary_abc' });

// 方式 1：通过 job_output_score_id（适合批量）
// Prisma 代码：使用字段名 jobOutputScoreId
const jobExec1 = await prisma.jobExecution.findFirst({
  where: { projectId: 'proj_123', jobOutputScoreId: 'score_primary_abc' }
});

// 方式 2：通过 metadata（首条和后续条通用）
const jobExecId = score0.metadata['job_execution_id'];
const jobExec2 = await prisma.jobExecution.findUnique({
  where: { id: jobExecId, projectId: 'proj_123' }
});

// 结果相同：jobExec1.id === jobExec2.id === 'je_123'
```

---

#### 示例 2：后续 Score（Score_1）反查

| 反查方式 | 具体操作 | 结果 |
|---------|---------|------|
| **方式 1：通过 job_output_score_id** | `SELECT * FROM job_executions WHERE job_output_score_id = 'random_uuid_xyz'` | ✗ 失败，无结果（job_output_score_id 存储的是首条 ID） |
| **方式 2：通过 metadata map** | 从 `score.metadata['job_execution_id']` 提取 'je_123'，再查询 | ✓ 成功，找到 JobExecution je_123 |

**代码示例：**
```typescript
// 后续 Score：只能通过 metadata 方式反查
const score1 = await getScoreById({ projectId: 'proj_123', scoreId: 'random_uuid_xyz' });

// ✗ 方式 1 失败：job_output_score_id 不匹配
const jobExecFail = await prisma.jobExecution.findFirst({
  where: { projectId: 'proj_123', jobOutputScoreId: 'random_uuid_xyz' }
});
// jobExecFail === null

// ✓ 方式 2 成功：通过 metadata map 访问
const jobExecId = score1.metadata['job_execution_id'];  // 'je_123'
const jobConfigId = score1.metadata['job_configuration_id'];  // 'jc_456'

const [jobExecution, jobConfiguration] = await Promise.all([
  prisma.jobExecution.findUnique({ where: { id: jobExecId, projectId: 'proj_123' } }),
  prisma.jobConfiguration.findUnique({ where: { id: jobConfigId, projectId: 'proj_123' } }),
]);

// 成功获取完整的 Eval 上下文
```

---

#### 示例 3：查询同一 Eval 产出的所有 Score（包括首条和后续条）

```sql
-- ClickHouse SQL：通过 metadata map 过滤查询同一 Eval 产出的所有 Score
SELECT
  s.id,
  s.name,
  s.data_type,
  s.value,
  s.metadata['job_execution_id'] AS job_execution_id,
  s.metadata['job_configuration_id'] AS job_configuration_id
FROM scores s
WHERE s.project_id = {projectId: String}
  AND s.metadata['job_execution_id'] = {jobExecutionId: String}
ORDER BY s.timestamp DESC;
```

**代码示例：**
```typescript
// 查询同一 Eval 产出的所有 Score（包括首条和后续条）
async function getAllScoresByJobExecutionId(projectId: string, jobExecutionId: string) {
  const query = `
    SELECT *
    FROM scores s
    WHERE s.project_id = {projectId: String}
      AND s.metadata['job_execution_id'] = {jobExecutionId: String}
    ORDER BY s.timestamp DESC
  `;

  return queryClickhouse({
    query,
    params: { projectId, jobExecutionId },
  });
}

// 使用方式
const scores = await getAllScoresByJobExecutionId('proj_123', 'je_123');
// scores 包含所有 3 条 Score（首条 Score_0 + 后续 Score_1 + Score_2）
```

### 4.5 多 Score 场景下的反查注意事项

在分类评估产出多条 Score 的场景下：

```
一次 Eval 执行
   ↓
产出 3 条 Scores (matches 有 3 个分类值)
   │
   ├─ Score_0 (ID = primaryScoreId)
   │     ↓
   │   ✓ 可通过 job_output_score_id 反查到 JobExecution
   │   ✓ 可通过 metadata map 反查
   │
   ├─ Score_1 (ID = randomUUID)
   │     ↓
   │   ✗ 无法通过 job_output_score_id 反查（字段值不匹配）
   │   ✓ 可通过 metadata map 反查
   │
   └─ Score_2 (ID = randomUUID)
         ↓
       ✗ 无法通过 job_output_score_id 反查
       ✓ 可通过 metadata map 反查
```

**关键结论**：metadata 是所有 Score 都可以依赖的可靠反查途径。

---

## 五、完整关联链路总结

### 5.1 正向链路（Eval → Score）

```
1. 创建 JobConfiguration
   │  scoreName: "sentiment"
   │  evalTemplate: { dataType: CATEGORICAL, ... }
   ↓
2. 创建 JobExecution（PENDING 状态）
   │  jobConfigurationId: "jc_123"
   │  job_output_score_id: null
   ↓
3. 执行 executeLLMAsJudgeEvaluation
   │
   ├─ 生成 primaryScoreId: "score_primary_abc"
   │
   ├─ LLM 返回 matches: ["positive", "confident"]  ← 2 个分类值
   │
   ├─ buildEvalScoreWritePayloads
   │   ├─ Score 0
   │   │   ├─ id: "score_primary_abc"  ← index=0，用 primary
   │   │   ├─ value: "positive"
   │   │   └─ metadata: { job_execution_id, job_configuration_id, ... }
   │   │
   │   └─ Score 1
   │       ├─ id: "random_uuid_xyz"     ← index=1，生成新 ID
   │       ├─ value: "confident"
   │       └─ metadata: { job_execution_id, job_configuration_id, ... }
   │
   ├─ 写入 2 条 Score 到 ClickHouse
   │
   └─ 更新 JobExecution
       ├─ status: COMPLETED
       └─ job_output_score_id: "score_primary_abc"  ← 只回填首条 ID
```

### 5.2 反向链路（Score → Eval）

#### 5.2.1 首条 Score 反向追溯

```
已知：Score.id = "score_primary_abc"
         ↓
   方法 1：通过 job_output_score_id
         SELECT * FROM job_executions
         WHERE job_output_score_id = "score_primary_abc"
         ↓
         得到 JobExecution，包含 job_configuration_id
         ↓
         得到 JobConfiguration

   方法 2：通过 metadata map（与方法 1 结果一致）
         从 Score.metadata['job_execution_id'] 提取 je_123
         ↓
         查询 JobExecution 和 JobConfiguration
```

#### 5.2.2 后续 Score 反向追溯（仅 metadata 方式）

```
已知：Score.id = "random_uuid_xyz"
         ↓
   ✗ 方法 1：通过 job_output_score_id 失败
         SELECT * FROM job_executions
         WHERE job_output_score_id = "random_uuid_xyz"
         → 无结果（job_output_score_id 存储的是首条 ID）

   ✓ 方法 2：通过 metadata map（唯一可用方式）
         从 Score.metadata['job_execution_id'] 提取 je_123
         ↓
         SELECT * FROM job_executions WHERE id = "je_123"
         ↓
         得到 JobExecution，包含 job_configuration_id = "jc_456"
         ↓
         SELECT * FROM job_configurations WHERE id = "jc_456"
         ↓
         得到完整的 Eval 上下文
```

---

## 六、设计要点与最佳实践

### 6.1 Metadata 冗余设计的价值

1. **跨数据库关联**：Score 在 ClickHouse，Job 在 PostgreSQL，metadata 提供了无需 JOIN 的关联能力
2. **全量可追溯**：即使是非首条 Score，即使 JobExecution 被删除，仍能保留关联信息
3. **查询性能**：在 ClickHouse 中直接使用 map 语法 `s.metadata['key']` 过滤，性能高且语法简洁
4. **审计能力**：保留了评估时的完整上下文信息

### 6.2 开发与调试建议

1. **查询多条 Score 时**：不要只依赖 `job_output_score_id`，需要同时检查 metadata
2. **需要关联同一 Eval 的所有 Score 时**：通过 `s.metadata['job_execution_id']` 在 ClickHouse 中过滤查询
3. **调试 Eval 问题时**：优先从 metadata 提取 ID，再去 PostgreSQL 查询详细状态
4. **ClickHouse 查询习惯**：使用 `s.metadata['key']` 的 map 访问语法，而非 JSON 提取函数
5. **命名区分**：在代码中使用 Prisma 字段名（camelCase），在 SQL 中使用数据库列名（snake_case）

### 6.3 典型查询示例（使用 ClickHouse Map 访问语法）

```sql
-- 查询某个 JobExecution 产出的所有 Score（包括首条和后续条）
SELECT
  s.id,
  s.name,
  s.data_type,
  s.value,
  s.timestamp
FROM scores s
WHERE s.project_id = {projectId: String}
  AND s.metadata['job_execution_id'] = {jobExecutionId: String}
ORDER BY s.timestamp DESC;

-- 查询某个 JobConfiguration 下的所有历史 Score
SELECT
  s.id,
  s.name,
  s.data_type,
  s.value,
  s.timestamp,
  s.metadata['job_execution_id'] AS job_execution_id
FROM scores s
WHERE s.project_id = {projectId: String}
  AND s.metadata['job_configuration_id'] = {jobConfigurationId: String}
ORDER BY s.timestamp DESC;

-- 检查 Score 是否有 metadata
SELECT
  length(mapKeys(s.metadata)) > 0 AS has_metadata
FROM scores s
WHERE s.id = {scoreId: String};
```

---

## 七、代码文件索引

| 功能模块 | 文件路径 | 关键行号 |
|---------|---------|---------|
| 多 Score 产出逻辑 | `worker/src/features/evaluation/evalScoreEvent.ts` | 208-215 |
| jobOutputScoreId 回填 | `worker/src/features/evaluation/evalService.ts` | 1002 |
| EvalOutputResult 类型定义 | `packages/shared/src/features/evals/outputDefinition.ts` | 163-178 |
| 分类结果归一化 | `packages/shared/src/features/evals/outputDefinition.ts` | 349-376 |
| Score 列表关联查询 | `web/src/server/api/routers/scores.ts` | all procedure |
| ClickHouse Score Metadata 访问 | `packages/shared/src/server/repositories/scores.ts` | metadata['key'] 语法 |
| 数据模型定义 | `packages/shared/prisma/schema.prisma` | JobExecution, JobConfiguration |
