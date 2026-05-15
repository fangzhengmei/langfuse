# Dataset to Experiment Run - 链路分析

## 概述

本文档详细分析了 Langfuse 平台中从数据集条目（Dataset Item）发起一次实验运行（Experiment Run）的完整链路。该链路涉及多个组件和服务，包括前端 UI、tRPC API、队列处理器、ClickHouse 事件存储等。

---

## 1. 架构总览

```
用户在 UI 创建实验
    ↓
web/src/features/experiments/server/router.ts (tRPC)
    ↓
PostgreSQL: 创建 dataset_runs 记录
    ↓
ExperimentCreateQueue (BullMQ + Redis)
    ↓
worker/src/queues/experimentQueue.ts (队列处理器)
    ↓
worker/src/features/experiments/experimentServiceClickhouse.ts (核心服务)
    ↓
├── 获取数据集条目 (getDatasetItems)
├── 处理每个数据集条目 (processItem)
│   ├── 创建 dataset_run_item 事件
│   └── 调用 LLM (fetchLLMCompletion)
└── 触发自动评估 (DatasetRunItemUpsertQueue)
    ↓
ClickHouse: 存储 trace + observation + dataset_run_item 事件
```

---

## 2. 链路详解

### 2.1 第一步：前端发起实验创建请求

**文件**：`web/src/features/experiments/components/CreateExperimentsForm.tsx`

用户通过前端表单配置实验，包括：
- 实验名称
- 运行名称
- 选择的 Prompt
- 选择的数据集
- 模型配置（provider、model、model_params）
- 可选的结构化输出 schema

### 2.2 第二步：tRPC API 处理创建请求

**文件**：`web/src/features/experiments/server/router.ts:206-288`

核心函数：`createExperiment`

**关键步骤**：

1. **RBAC 权限检查**：验证用户是否有 `promptExperiments:CUD` 权限
   
2. **创建 DatasetRun 记录（PostgreSQL）**：
   ```typescript
   const datasetRun = await ctx.prisma.datasetRuns.create({
     data: {
       name: input.runName,
       description: input.description,
       datasetId: input.datasetId,
       metadata: {
         ...metadata, // 包含 prompt_id, provider, model, model_params 等
         experiment_name: input.name,
         experiment_run_name: input.runName,
       },
       projectId: input.projectId,
     },
   });
   ```

3. **加入实验创建队列**：
   ```typescript
   const queue = ExperimentCreateQueue.getInstance();
   await queue.add(QueueName.ExperimentCreate, {
     name: QueueJobs.ExperimentCreateJob,
     id: randomUUID(),
     timestamp: new Date(),
     payload: {
       projectId: input.projectId,
       datasetId: input.datasetId,
       runId: datasetRun.id,
       description: input.description,
     },
     // ...
   });
   ```

**关键数据结构**：
- `runId` 即 `experimentId`，贯穿整个链路
- metadata 存储实验配置，后续 worker 从 PostgreSQL 读取

---

### 2.3 第三步：Worker 队列处理器

**文件**：`worker/src/queues/experimentQueue.ts:16-49`

核心函数：`experimentCreateQueueProcessor`

```typescript
export const experimentCreateQueueProcessor = async (
  job: Job<TQueueJobTypes[QueueName.ExperimentCreate]>,
) => {
  try {
    await createExperimentJobClickhouse({
      event: job.data.payload,
    });
    return true;
  } catch (e) {
    // 错误处理和重试逻辑
    // ...
  }
};
```

---

### 2.4 第四步：核心实验服务执行

**文件**：`worker/src/features/experiments/experimentServiceClickhouse.ts:292-367`

核心函数：`createExperimentJobClickhouse`

**执行流程**：

#### 2.4.1 输入验证与配置设置

调用 `validateAndSetupExperiment` 函数验证并准备实验配置：

**文件**：`worker/src/features/experiments/utils.ts:163-243`

```typescript
export async function validateAndSetupExperiment(event) {
  // 1. 验证 dataset run 存在
  const datasetRun = await fetchDatasetRun(runId, projectId);
  
  // 2. 验证实验 metadata (PromptExperimentConfig)
  const validatedRunMetadata = ExperimentMetadataSchema.safeParse(
    datasetRun.metadata,
  );
  
  // 3. 获取并验证 Prompt
  const prompt = await fetchPrompt(prompt_id, projectId);
  
  // 4. 获取并验证 LLM API Key
  const apiKey = await prisma.llmApiKeys.findFirst({
    where: { projectId, provider },
  });
  
  // 5. 提取 Prompt 中的变量
  const extractedVariables = extractVariables(/* ... */);
  const placeholderNames = extractPlaceholderNames(/* ... */);
  
  return {
    datasetRun,
    prompt,
    validatedPrompt,
    validatedApiKey,
    provider,
    model,
    model_params,
    allVariables: [...extractedVariables, ...placeholderNames],
    // ... 其他配置
  };
}
```

#### 2.4.2 获取并验证数据集条目

**文件**：`worker/src/features/experiments/experimentServiceClickhouse.ts:232-290`

核心函数：`getItemsToProcess`

```typescript
async function getItemsToProcess(projectId, datasetId, runId, config) {
  // 1. 获取数据集所有 ACTIVE 条目
  const datasetItems = await getDatasetItems({
    projectId,
    filterState: createDatasetItemFilterState({
      datasetIds: [datasetId],
      status: "ACTIVE",
    }),
    version: config.datasetVersion,
    includeIO: true,
  });

  // 2. 验证数据集条目输入格式是否匹配 Prompt 变量
  const validatedDatasetItems = datasetItems
    .filter(({ input }) => validateDatasetItem(input, config.allVariables))
    .map((datasetItem) => {
      // 规范化输入格式
      const normalizedInput = normalizeDatasetItemInput(
        datasetItem.input,
        config.allVariables,
      );
      return {
        ...datasetItem,
        input: parseDatasetItemInput(normalizedInput, config.allVariables),
      };
    });

  // 3. 去重：跳过已处理的条目（用于失败重试场景）
  const existingDatasetItemIds = await getExistingRunItemDatasetItemIds(
    projectId, runId, datasetId,
  );
  
  return validatedDatasetItems.filter(
    (item) => !existingDatasetItemIds.has(item.id),
  );
}
```

**数据集条目验证逻辑**：

**文件**：`packages/shared/src/features/experiments/utils.ts:29-50`

```typescript
// 检查数据集条目输入是否匹配至少一个 Prompt 变量
export const validateDatasetItem = (
  itemInput: Prisma.JsonValue,
  variables: string[],
): boolean => {
  // 单变量场景：字符串输入即可通过
  if (
    typeof itemInput === "string" &&
    itemInput !== "" &&
    variables.length === 1
  ) {
    return true;
  }

  // 对象输入：只需包含至少一个匹配的变量键（不是必须全部）
  if (!isValidPrismaJsonObject(itemInput)) {
    return false;
  }

  // 使用 some 而非 every：命中任一变量即可通过
  return variables.some((variable) =>
    datasetItemMatchesVariable(itemInput, variable),
  );
};
```

**验证规则说明**：
- ✅ **单变量 Prompt**：输入为非空字符串即通过
- ✅ **多变量 Prompt**：输入对象中只需包含任一 Prompt 变量（不是必须全部包含）
- ❌ 输入既不是字符串也不是有效对象时验证失败

#### 2.4.3 处理每个数据集条目

**文件**：`worker/src/features/experiments/experimentServiceClickhouse.ts:73-157`

核心函数：`processItem`

```typescript
async function processItem(projectId, datasetItem, config) {
  // 1. 生成确定性 trace ID（用于幂等性）
  const newTraceId = createW3CTraceId(`${config.runId}-${datasetItem.id}`);
  const runItemId = v4();

  // 2. 创建 DATASET_RUN_ITEM_CREATE 事件（写入 ClickHouse）
  const event = {
    id: runItemId,
    type: eventTypes.DATASET_RUN_ITEM_CREATE,
    timestamp: new Date().toISOString(),
    body: {
      id: runItemId,
      traceId: newTraceId,
      observationId: null,
      error: null,
      datasetId: datasetItem.datasetId,
      runId: config.runId,
      datasetItemId: datasetItem.id,
      datasetVersion: datasetItem.validFrom.toISOString(),
    },
  };

  await processEventBatch([event], {/* auth */}, { isLangfuseInternal: true });

  // 3. 调用 LLM 模型
  const llmResult = await processLLMCall(
    runItemId, newTraceId, datasetItem, config,
  );

  // 4. 触发异步评估（如果 Redis 可用）
  if (redis) {
    const queue = DatasetRunItemUpsertQueue.getInstance();
    if (queue) {
      await queue.add(QueueJobs.DatasetRunItemUpsert, {
        payload: {
          projectId,
          datasetItemId: datasetItem.id,
          datasetItemValidFrom: datasetItem.validFrom,
          traceId: newTraceId,
        },
        // ...
      });
    }
  }

  return { success: true };
}
```

#### 2.4.4 LLM 调用处理

**文件**：`worker/src/features/experiments/experimentServiceClickhouse.ts:159-230`

核心函数：`processLLMCall`

```typescript
async function processLLMCall(runItemId, traceId, datasetItem, config) {
  // 1. 替换 Prompt 中的变量
  const messages = replaceVariablesInPrompt(
    config.validatedPrompt,
    datasetItem.input,
    config.allVariables,
    config.placeholderNames,
  );

  // 2. 配置 trace sink（用于记录 LLM 调用的完整 trace）
  const traceSinkParams: TraceSinkParams = {
    environment: LangfuseInternalTraceEnvironment.PromptExperiments,
    traceName: `dataset-run-item-${runItemId.slice(0, 5)}`,
    traceId,
    targetProjectId: config.projectId,
    metadata: {
      dataset_id: datasetItem.datasetId,
      dataset_item_id: datasetItem.id,
      experiment_name: config.experimentName,
      experiment_run_name: config.experimentRunName,
    },
    prompt: config.prompt,
    eventsWriter: createInternalEventsWriter({
      experimentContext: {
        id: config.runId,
        name: config.datasetRun.name,
        // ... 实验元数据
      },
      // 当根事件记录准备好时，调度自动评估
      onRootEventRecordReady: async (rootEventRecord) => {
        await scheduleExperimentObservationEvals({
          observation: convertEventRecordToObservationForEval(rootEventRecord),
        });
      },
    }),
  };

  // 3. 执行 LLM 调用（非流式）
  await fetchLLMCompletion({
    streaming: false,
    llmConnection: config.validatedApiKey,
    messages,
    modelParams: {
      provider: config.provider,
      model: config.model,
      adapter: config.validatedApiKey.adapter,
      ...config.model_params,
    },
    structuredOutputSchema: config.structuredOutputSchema,
    traceSinkParams,
  });

  return { success: true };
}
```

**变量替换逻辑**：

**文件**：`worker/src/features/experiments/utils.ts:73-158`

```typescript
export const replaceVariablesInPrompt = (
  prompt: PromptContent,
  itemInput: Record<string, any> | null,
  variables: string[],
  placeholderNames: string[] = [],
): ChatMessage[] => {
  // 处理字符串类型的 Prompt（Text Prompt）
  if (typeof prompt === "string") {
    return [{
      role: ChatMessageRole.System,
      content: processContent(prompt), // 使用 compileTemplateString 替换 {{var}}
      type: ChatMessageType.System,
    }];
  }

  // 处理消息占位符（Chat Prompt 中的 {placeholder}）
  const placeholderValues: MessagePlaceholderValues = {};
  for (const placeholderName of placeholderNames) {
    // 从 itemInput 中读取消息数组
    placeholderValues[placeholderName] = actualValue.map((msg) => ({
      ...msg,
      type: ChatMessageType.PublicAPICreated,
    }));
  }

  // 编译聊天消息
  const compiledMessages = compileChatMessages(
    prompt as PromptMessage[],
    placeholderValues,
    {},
  );

  // 替换每条消息内容中的模板变量 {{var}}
  return compiledMessages.map((message) => ({
    ...message,
    ...(typeof message.content === "string" && {
      content: processContent(message.content),
    }),
    type: ChatMessageType.PublicAPICreated,
  }));
};
```

---

### 2.5 第五步：事件写入与 Trace 记录

**LLM 调用过程中自动生成以下事件**：

1. **TRACE_CREATE**：创建 trace 记录
2. **GENERATION_CREATE**：记录 LLM 调用（observation）
   - 包含 input/output
   - 包含 latency、cost 等指标
   - 包含 model、provider 信息
3. **DATASET_RUN_ITEM_CREATE**：关联数据集条目与 trace

所有事件通过 `processEventBatch` 写入 ClickHouse。

---

### 2.6 第六步：实验结果查询

**文件**：`web/src/features/experiments/server/router.ts:289-309`

核心函数：`all`、`byId`、`items`

```typescript
// 查询实验列表
const experiments = await getExperimentsFromEvents({
  projectId: input.projectId,
  filter: input.filter ?? [],
  orderBy: input.orderBy,
  page: input.page,
  limit: input.limit,
});

// 查询实验条目（跨多个实验进行对比）
const items = await getExperimentItemsFromEvents({
  projectId: input.projectId,
  baseExperimentId: input.baseExperimentId,
  compExperimentIds: input.compExperimentIds,
  // ...
});
```

---

## 3. 关键数据结构关联

### 3.1 实体关系图

```
Dataset (数据集)
  └── DatasetItem (数据集条目) - N个
        └── DatasetRun (实验运行) - M个
              └── DatasetRunItem (实验运行条目) - N个
                    ├── Trace (调用链路) - 1个
                    │   └── Generation/Observation (LLM调用) - 1个
                    └── Scores (评估分数) - 0..N个
```

### 3.2 关键 ID 关联

| ID 类型 | 说明 | 生成位置 |
|---------|------|---------|
| `datasetId` | 数据集 ID | 创建数据集时 |
| `datasetItem.id` | 数据集条目 ID | 创建条目时 |
| `runId / experimentId` | 实验运行 ID | `createExperiment` 中生成 |
| `traceId` | 调用链路 ID | `processItem` 中确定性生成 |
| `runItemId` | 实验运行条目 ID | `processItem` 中生成 |
| `observationId` | LLM 调用 ID | `fetchLLMCompletion` 中生成 |

---

### 3.3 DatasetItem ID 字段映射表

下表详细说明 `datasetItem.id` 如何传递和映射到各层数据结构：

| 实体类型 | 字段名 | 取值来源 | 说明 | 存储位置 |
|---------|---------|---------|------|---------|
| **DatasetRunItem** | `dataset_item_id` | `datasetItem.id` | 直接引用数据集条目 ID | ClickHouse `dataset_run_items_rmt` 表 |
| | `id` (runItemId) | `uuid.v4()` | 实验运行条目自身 ID，独立生成 | ClickHouse `events` 表 |
| | `trace_id` | `createW3CTraceId(`${runId}-${datasetItem.id}`)` | 确定性生成，用 runId + datasetItem.id 哈希生成 | ClickHouse `traces` 表 |
| | `observation_id` | `fetchLLMCompletion` 内部生成 | LLM 调用 observation ID，成功调用后回填 | ClickHouse `observations` 表 |
| | `dataset_id` | `datasetItem.datasetId` | 数据集 ID | ClickHouse |
| | `dataset_version` | `datasetItem.validFrom.toISOString()` | 数据集条目版本时间戳 | ClickHouse |
| **Trace** | `id` | `createW3CTraceId(`${runId}-${datasetItem.id}`)` | 与 DatasetRunItem.trace_id 相同 | ClickHouse `traces` 表 |
| | `name` | `dataset-run-item-${runItemId.slice(0, 5)}` | Trace 名称包含 runItemId 前缀 | ClickHouse |
| | `metadata.dataset_item_id` | `datasetItem.id` | Trace metadata 中存储数据集条目 ID | ClickHouse |
| **Observation (Generation)** | `id` | `uuid.v4()` | LLM 调用自身 ID | ClickHouse `observations` 表 |
| | `trace_id` | 同上 traceId | 关联到对应 Trace | ClickHouse |
| | `prompt_id` | `config.prompt.id` | 关联到使用的 Prompt | ClickHouse |

**字段映射关系图：**
```
datasetItem.id
    ├─→ DatasetRunItem.dataset_item_id (直接复制)
    ├─→ 参与生成 traceId = hash(runId + ':' + datasetItem.id)
    │       ├─→ DatasetRunItem.trace_id
    │       └─→ Trace.id
    │               └─→ Observation.trace_id
    └─→ Trace.metadata.dataset_item_id
```

---

## 4. 失败分支详解

### 4.1 失败分支总览

实验运行过程中有三条主要的失败分支：

| 失败类型 | 触发阶段 | 影响范围 | 失败行为 |
|---------|---------|---------|---------|
| **A. 实验配置异常** | `validateAndSetupExperiment` 阶段 | 整个实验所有条目 | 为所有条目创建 ERROR 级别的记录 |
| **B. 输入校验不通过（条目级）** | `getItemsToProcess` 阶段 | 单个数据集条目 | 静默跳过，不创建任何记录 |
| **C. 变量替换失败（条目级）** | `processLLMCall` 阶段 | 单个数据集条目 | 已创建 DatasetRunItem，但 Trace/Observation 不完整 |

```
                              实验启动
                                 │
                                 ▼
                       ┌─────────────────────┐
                       │  验证实验配置        │
                       └─────────┬───────────┘
                                 │
                    ┌────────────┴────────────┐
                    │ 失败                  成功 │
                    ▼                         ▼
           ┌──────────────────┐     ┌──────────────────┐
           │ 配置异常分支     │     │ 获取数据集条目   │
           │ 所有条目创建 ERROR │     └────────┬─────────┘
           │ 级别的 Trace      │              │
           └──────────────────┘              │
                                    ┌─────────┴─────────┐
                                    │  输入校验过滤     │
                                    │ (validateDatasetItem) │
                                    └─────────┬─────────┘
                                    ┌─────────┴─────────┐
                                    │  通过   │  不通过  │
                                    ▼         ▼         │
                           ┌─────────────┐  ┌─────────┐  │
                           │  创建       │  │  静默   │  │
                           │ DatasetRunItem│  │  跳过   │  │
                           └──────┬──────┘  └─────────┘  │
                                  │                      │
                           ┌──────┴──────┐               │
                           │ 变量替换    │               │
                           │ replaceVariablesInPrompt│    │
                           └───┬────┬───┘               │
                               │    │                   │
                          ┌────▼──┐┌▼────┐             │
                          │ 成功  ││失败 │             │
                          └───┬───┘└────┬┘             │
                              │         │              │
                              ▼         ▼              │
                    ┌─────────────┐ ┌─────────────┐    │
                    │ 执行 LLM 调用│ │ Trace 不完整│    │
                    └─────────────┘ └─────────────┘    │
                              │                         │
                              └─────────────────────────┘
```

---

### 4.2 失败分支 A：实验配置异常（全局）

**触发时机**：`createExperimentJobClickhouse` → `validateAndSetupExperiment` 抛出异常

**可能的异常原因**：
1. DatasetRun 记录不存在（PostgreSQL 查询失败）
2. metadata 格式验证失败（缺少 prompt_id、provider、model 等必填字段）
3. Prompt 不存在或格式无效
4. LLM API Key 不存在或配置错误

**处理逻辑**：

**文件**：`worker/src/features/experiments/experimentServiceClickhouse.ts:372-479`

核心函数：`createAllDatasetRunItemsWithConfigError`

```typescript
async function createAllDatasetRunItemsWithConfigError(
  projectId: string,
  datasetId: string,
  runId: string,
  errorMessage: string,
) {
  // 为每个数据集条目创建带 ERROR 标记的 3 个事件
  // DatasetRunItem_CREATE + Trace_CREATE + Generation_CREATE
  // ...
}
```

**生成的记录特征**：
- DatasetRunItem: `error` 字段包含 `Experiment configuration error:` 前缀
- Trace: 只记录输入，无输出
- Generation: `level = "ERROR"`，包含 `statusMessage`，无 LLM 调用字段

---

### 4.3 失败分支 B：输入校验不通过（条目级，静默跳过）

**触发时机**：`getItemsToProcess` 阶段的 `filter` 操作

**触发条件**：`validateDatasetItem(input, variables)` 返回 `false`

**校验失败的场景**：
1. **单变量 Prompt**：数据集条目输入不是字符串或为空
2. **多变量 Prompt**：数据集条目输入不是有效 JSON 对象

**校验规则说明（代码事实）**：
> **不是必须覆盖全部变量，而是命中任一变量即可通过**
> - 代码使用 `variables.some(...)` 而非 `variables.every(...)`
> - 只要输入对象中存在任一 Prompt 变量的 key，就通过校验
> - 即使缺少其他变量也不会导致校验失败
> - 单变量 Prompt 可以直接传入字符串，会被自动包装为对象

---

#### 🔍 **分类边界：输入校验失败 vs 变量替换失败**

| 维度 | **B类 - 输入校验失败** | **C类 - 变量替换失败** |
|-----|-----------------------|----------------------|
| **执行阶段** | `getItemsToProcess` 阶段（filter） | `processLLMCall` 阶段（try/catch） |
| **检查对象** | 输入的**类型和基本格式** | 输入值的**内容有效性** |
| **Prompt 变量规则** | 命中任一变量即可通过（some） | 需要全部变量正确替换 |
| **Placeholder 处理** | ❌ **不检查** placeholder（placeholder 不是 `validateDatasetItem` 的参数） | ✅ **完整检查**：存在性、JSON解析、数组格式、消息对象有效性 |
| **错误记录方式** | 完全静默（filter 掉，无任何 DB 记录） | 半成功（DatasetRunItem 已创建，错误只写日志） |

> **关键结论**：Placeholder 值格式错误**不属于**输入校验失败，而是在变量替换阶段才会被检测到。因为 `validateDatasetItem` 函数根本不接收 `placeholderNames` 参数，只接收 `variables` 参数。
>
> ```typescript
> // 函数签名：只有 variables，没有 placeholderNames
> export const validateDatasetItem = (
>   itemInput: Prisma.JsonValue,
>   variables: string[],  // ← 只检查 variables，不检查 placeholders
> ): boolean => { ... }
> ```

```typescript
// 实际校验逻辑（packages/shared/src/features/experiments/utils.ts:29-50）
export const validateDatasetItem = (itemInput, variables) => {
  // 单变量场景：字符串输入即可通过
  if (typeof itemInput === "string" && itemInput !== "" && variables.length === 1) {
    return true;
  }
  
  // 对象场景：命中任一变量即可通过（some，不是 every）
  return variables.some(variable => 
    datasetItemMatchesVariable(itemInput, variable)
  );
};
```

**失败行为**：⚠️ **完全静默，不创建任何记录**
- ❌ 不创建 DatasetRunItem 记录
- ❌ 不创建 Trace 记录
- ❌ 不创建 Generation/Observation 记录
- ❌ 日志中不记录具体条目 ID，只显示总数

**排障方式**：总条目数 - 已处理条目数 = 校验不通过条目数

---

### 4.4 失败分支 C：变量替换失败（条目级，半成功状态）

**触发时机**：`processLLMCall` 阶段的 `replaceVariablesInPrompt` 抛出异常

**触发条件**：
1. **缺少 placeholder 值**：Chat Prompt 需要的 {placeholder} 在输入中不存在
2. **Placeholder 格式错误**：
   - 值是字符串但无法解析为 JSON 数组
   - 值不是数组类型
   - 数组中的消息不是有效对象
3. **模板变量替换错误**：`compileTemplateString` 执行失败

**处理逻辑**：

**文件**：`worker/src/features/experiments/utils.ts:106-139`

```typescript
export const replaceVariablesInPrompt = (prompt, itemInput, variables, placeholderNames) => {
  // 处理消息 placeholder
  for (const placeholderName of placeholderNames) {
    if (!(placeholderName in itemInput)) {
      throw new Error(`Missing placeholder value for '${placeholderName}'`);
    }
    // 验证 JSON 可解析
    // 验证是数组类型
    // 验证数组元素是有效对象
  }
  // ...
};
```

**在 processLLMCall 中的错误处理**：
```typescript
try {
  messages = replaceVariablesInPrompt(...);
} catch (error) {
  logger.error(
    `Failed to replace variables in prompt for dataset item ${datasetItem.id}`,
    error,
  );
  return { success: false };  // 直接返回，不执行 LLM 调用
}
```

**失败行为**：⚠️ **半成功状态，记录不完整**
- ✅ **已创建** DatasetRunItem 记录（在 processItem 开头创建）
  - `traceId` 已设置（确定性 ID）
  - `observationId = null`
  - `error = null`（错误只在日志中，不写入数据库）
- ❌ **未创建** Trace 记录（LLM 调用未执行）
- ❌ **未创建** Generation/Observation 记录
- ✅ **有日志**：包含具体 datasetItem ID 和错误原因

**生成的记录特征**：
| 记录类型 | 是否存在 | 关键特征 |
|---------|---------|---------|
| DatasetRunItem | ✅ | `observationId = null`，`error = null` |
| Trace | ❌ | 无对应记录 |
| Generation/Observation | ❌ | 无对应记录 |

---

### 4.5 失败记录查询入口

#### 4.5.1 三类失败状态汇总表

| 失败类型 | 前端可见性 | DatasetRunItem | Trace/Observation | 排障方式 |
|---------|-----------|---------------|-------------------|---------|
| **A. 配置异常** | ✅ 完全可见 | ✅ 带错误信息 | ✅ ERROR 级别 | UI 中直接看到红色错误状态 |
| **B. 输入校验不通过** | ❌ 完全不可见 | ❌ 不存在 | ❌ 不存在 | 总数对比法 |
| **C. 变量替换失败** | ⚠️ 半可见（只有 runItem） | ✅ 存在但无关联 | ❌ 不存在 | 查询 `observationId IS NULL` 的 runItem |

#### 4.5.2 查询配置异常的实验（A 类）

**前端入口**：项目 → 实验 → 具体实验运行详情页

**特征**：所有条目都显示错误状态（红色），Level 为 ERROR

**API 查询方式**：
```typescript
// 过滤 ERROR 级别的条目
const items = await getExperimentItemsFromEvents({
  projectId: "project-id",
  baseExperimentId: "run-id",
  compExperimentIds: [],
  filterByExperiment: [{
    experimentId: "run-id",
    filters: [{ column: "level", operator: "=", value: "ERROR" }]
  }]
});
```

#### 4.5.3 排查输入校验不通过的条目（B 类）

由于完全不创建记录，只能通过**排除法**：

```typescript
// 步骤1：获取数据集 ACTIVE 条目总数
const totalItems = await getDatasetItemsCount({
  projectId, datasetId, status: "ACTIVE"
});

// 步骤2：获取实验已创建的 runItem 数
const processedCount = (await getExistingRunItemDatasetItemIds(
  projectId, runId, datasetId
)).size;

// 步骤3：计算校验不通过数量
const skippedCount = totalItems - processedCount;
```

#### 4.5.4 排查变量替换失败的条目（C 类）

通过查询 `observationId IS NULL` 的 DatasetRunItem：

```sql
-- ClickHouse 直接查询
SELECT 
  dataset_item_id,
  trace_id
FROM dataset_run_items_rmt
WHERE 
  project_id = {projectId: String}
  AND dataset_run_id = {runId: String}
  AND observation_id IS NULL;
```

**然后查 worker 日志**：
- 搜索 `Failed to replace variables in prompt for dataset item ${itemId}`
- 日志包含具体错误原因（缺少 placeholder、JSON 解析失败等）

#### 4.5.5 综合查询入口（tRPC Router）

| 查询函数 | 配置异常(A) | 校验不通过(B) | 变量替换失败(C) |
|---------|------------|--------------|-----------------|
| `all` | ✅ 实验会显示 | ❌ | ⚠️ 实验显示，但条目数偏少 |
| `byId` | ✅ | ❌ | ✅ 但指标异常 |
| `items` | ✅ 显示为 ERROR | ❌ 不显示 | ✅ 显示但 observationId 为空 |
| `metrics` | ❌ 不计入统计 | ❌ | ❌ 不计入统计 |
| `batchIO` | ✅ 但 output 为空 | ❌ | ✅ 但 output 为空 |

---

## 5. 幂等性与失败处理

### 4.1 幂等性保证

1. **确定性 Trace ID**：
   ```typescript
   const newTraceId = createW3CTraceId(`${config.runId}-${datasetItem.id}`);
   ```
   同一实验同一条目始终生成相同的 traceId，避免重复执行时产生重复记录。

2. **去重检查**：
   在处理前查询已存在的 `dataset_run_items`，跳过已处理的条目：
   ```typescript
   const existingDatasetItemIds = await getExistingRunItemDatasetItemIds(
     projectId, runId, datasetId,
   );
   ```

### 4.2 错误处理策略

1. **配置错误**：
   - 无法验证 Prompt、API Key 等配置
   - 为所有数据集条目创建带错误信息的 run item，不进行 LLM 调用
   - `createAllDatasetRunItemsWithConfigError` 函数

2. **单条目失败**：
   - 单个数据集条目处理失败不影响其他条目
   - 失败条目记录错误日志
   - 重试时会跳过已成功的条目

3. **队列重试**：
   - BullMQ 提供重试机制
   - LLM 速率限制错误有特殊处理逻辑

---

## 5. 相关文件索引

| 功能模块 | 文件路径 |
|---------|---------|
| 实验 tRPC Router | `web/src/features/experiments/server/router.ts` |
| 实验队列处理器 | `worker/src/queues/experimentQueue.ts` |
| 实验核心服务 | `worker/src/features/experiments/experimentServiceClickhouse.ts` |
| 实验工具函数 | `worker/src/features/experiments/utils.ts` |
| 数据集条目 Repository | `packages/shared/src/server/repositories/dataset-items.ts` |
| 实验 Repository | `packages/shared/src/server/repositories/experiments.ts` |
| 数据集领域模型 | `packages/shared/src/domain/dataset-items.ts` |
| 前端创建表单 | `web/src/features/experiments/components/CreateExperimentsForm.tsx` |

---

## 7. 总结

从数据集条目到实验运行的完整链路具有以下特点：

1. **异步处理**：通过 BullMQ 队列异步执行，不阻塞用户请求
2. **幂等设计**：确定性 ID + 去重检查保证重试安全
3. **容错处理**：单个条目失败不影响整体实验
4. **完整追踪**：每个 LLM 调用都有完整的 trace/observation 记录
5. **事件驱动**：所有状态变更通过事件写入 ClickHouse
6. **可观测性**：内置日志和指标便于监控和调试

该架构确保了实验运行的可靠性、可扩展性，同时保留了完整的审计追踪能力。
