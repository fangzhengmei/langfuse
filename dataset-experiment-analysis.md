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

**文件**：`packages/shared/src/domain/dataset-items.ts`

```typescript
// 检查数据集条目输入是否包含所有必需的变量
export function validateDatasetItem(
  input: Prisma.JsonValue | null | undefined,
  variables: string[],
): boolean {
  // 没有变量 = 始终有效
  if (variables.length === 0) return true;

  // 字符串输入：只需一个变量，且输入是字符串
  if (variables.length === 1) {
    return typeof input === "string" && input.length > 0;
  }

  // 对象输入：检查是否包含所有必需的键
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return variables.every((variable) => variable in input);
  }

  return false;
}
```

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

实验运行过程中有两条主要的失败分支：

| 失败类型 | 触发时机 | 影响范围 | 是否重试 |
|---------|---------|---------|---------|
| **A. 实验配置异常** | `validateAndSetupExperiment` 阶段 | 整个实验所有条目 | 否，直接创建错误记录 |
| **B. 单条目输入校验不通过** | `getItemsToProcess` 阶段 | 单个数据集条目 | 否，跳过该条目 |

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
     │ (所有条目标记)   │     └────────┬─────────┘
     └──────────────────┘              │
                              ┌─────────┴─────────┐
                              │ 逐条校验输入格式 │
                              └─────────┬─────────┘
                              ┌─────────┴─────────┐
                              │  通过   │  不通过  │
                              ▼         ▼         │
                        ┌──────────┐ ┌──────────┐  │
                        │ LLM 调用 │ │  跳过    │  │
                        └────┬─────┘ └──────────┘  │
                             │                      │
                             └──────────────────────┘
```

---

### 4.2 失败分支 A：实验配置异常

**触发条件**：`validateAndSetupExperiment` 函数抛出异常

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
  // 1. 获取所有 ACTIVE 数据集条目
  const datasetItems = await getDatasetItems({
    projectId,
    filterState: createDatasetItemFilterState({
      datasetIds: [datasetId],
      status: "ACTIVE",
    }),
    includeIO: true,
  });

  // 2. 检查已存在的 runItem，避免重复创建
  const existingRunItemDatasetItemIds = 
    await getExistingRunItemDatasetItemIds(projectId, runId, datasetId);

  const newItems = datasetItems.filter(
    (item) => !existingRunItemDatasetItemIds.has(item.id),
  );

  // 3. 为每个新条目创建 3 个事件：DATASET_RUN_ITEM_CREATE + TRACE_CREATE + GENERATION_CREATE
  const events: IngestionEventType[] = newItems.flatMap((datasetItem) => {
    const traceId = v4();  // 注意：配置错误时 traceId 是随机的，不是确定性的
    const runItemId = v4();
    const generationId = v4();
    const timestamp = new Date().toISOString();

    return [
      // 事件1：DatasetRunItem 创建事件，带错误信息
      {
        id: runItemId,
        type: eventTypes.DATASET_RUN_ITEM_CREATE,
        timestamp,
        body: {
          id: runItemId,
          traceId,
          observationId: null,
          error: `Experiment configuration error: ${errorMessage}`,
          createdAt: timestamp,
          datasetId: datasetItem.datasetId,
          runId: runId,
          datasetItemId: datasetItem.id,
          datasetVersion: datasetItem.validFrom.toISOString(),
        },
      },
      // 事件2：Trace 创建事件
      {
        id: traceId,
        type: eventTypes.TRACE_CREATE,
        timestamp,
        body: {
          id: traceId,
          environment: LangfuseInternalTraceEnvironment.PromptExperiments,
          name: `dataset-run-item-${runItemId.slice(0, 5)}`,
          input: stringInput,  // 数据集条目的输入（JSON 序列化）
        },
      },
      // 事件3：Generation 创建事件（标记 ERROR 级别）
      {
        id: generationId,
        type: eventTypes.GENERATION_CREATE,
        timestamp,
        body: {
          id: generationId,
          environment: LangfuseInternalTraceEnvironment.PromptExperiments,
          traceId,
          input: stringInput,
          level: "ERROR" as const,  // 关键：标记为 ERROR 级别
          statusMessage: `Experiment configuration error: ${errorMessage}`,
        },
      },
    ];
  });

  // 4. 批量写入 ClickHouse
  if (events.length > 0) {
    await processEventBatch(
      events,
      { validKey: true, scope: { projectId, accessLevel: "project" } },
      { isLangfuseInternal: true },
    );
  }
}
```

**生成的记录特征**：

| 记录类型 | 状态/级别 | 错误信息位置 | 关键特征 |
|---------|---------|---------|---------|
| DatasetRunItem | - | `body.error` | 包含完整错误消息前缀 `Experiment configuration error:` |
| Trace | - | `body.input` | 只记录输入，无输出 |
| Generation (Observation) | `level: "ERROR"` | `body.statusMessage` | ERROR 级别，无 model、latency、cost 字段 |

**关键区别（配置错误 vs 正常执行）**：
1. **Trace ID 生成方式**：配置错误时使用随机 `v4()`，不是 `createW3CTraceId` 生成的确定性 ID
2. **Observation 级别**：配置错误时是 `ERROR`，正常执行是 `DEFAULT`
3. **字段完整性**：配置错误的 Generation 缺少 model、provider、usage 等 LLM 调用字段

---

### 4.3 失败分支 B：单条目输入校验不通过

**触发条件**：`validateDatasetItem(input, variables)` 返回 `false`

**校验失败的场景**：
1. **单变量 Prompt**：数据集条目输入不是字符串或为空
2. **多变量 Prompt**：数据集条目输入不是对象，或缺少某个必需的变量 key
3. **Placeholder 消息**：Chat Prompt 的 {placeholder} 对应的值不是有效消息数组

**处理逻辑**：

**文件**：`worker/src/features/experiments/experimentServiceClickhouse.ts:232-290`

```typescript
async function getItemsToProcess(projectId, datasetId, runId, config) {
  // 1. 获取所有数据集条目
  const datasetItems = await getDatasetItems({/* ... */});

  // 2. 过滤并验证：只保留输入格式匹配 Prompt 变量的条目
  const validatedDatasetItems = datasetItems
    .filter(({ input }) => {
      // validateDatasetItem 返回 false 的条目会被静默过滤
      return validateDatasetItem(input, config.allVariables);
    })
    .map((datasetItem) => {
      // 后续处理...
    });

  // 3. 校验不通过的条目被直接排除，不会进入 processItem 循环
  // 注意：这里不会为校验不通过的条目创建任何记录！

  return validatedDatasetItems;
}
```

**⚠️ 重要特征：输入校验不通过的条目不会创建任何记录**

与配置异常不同，输入校验不通过的数据集条目是**静默失败**，不会产生任何痕迹：
- ❌ 不创建 DatasetRunItem 记录
- ❌ 不创建 Trace 记录
- ❌ 不创建 Generation/Observation 记录
- ❌ 不在日志中记录该条目 ID（仅记录总数量）
- ✅ 该条目在实验结果中完全不显示

**日志记录**：
```typescript
logger.info(
  `Found ${validatedDatasetItems.length} valid items, 
   ${existingDatasetItemIds.size} already exist, 
   ${itemsToProcess.length} to process`
);
```
*通过对比数据集总条目数和 valid items 数，可以间接推断有多少条目标记为校验失败*

---

### 4.4 失败记录查询入口

#### 4.4.1 查询配置错误的实验运行

**前端入口**：项目 → 实验 → 具体实验运行详情页

**API 查询方式**：

```typescript
// 方式1：通过 experiment items API 查询（带过滤）
const items = await getExperimentItemsFromEvents({
  projectId: "project-id",
  baseExperimentId: "run-id",  // experimentId
  compExperimentIds: [],
  // 过滤 ERROR 级别的 observation
  filterByExperiment: [{
    experimentId: "run-id",
    filters: [{
      column: "level",
      operator: "=",
      value: "ERROR"
    }]
  }]
});

// 方式2：直接查询 ClickHouse（高级）
const errorRunItems = await queryClickhouse({
  query: `
    SELECT 
      dataset_item_id,
      trace_id,
      error
    FROM dataset_run_items_rmt
    WHERE 
      project_id = {projectId: String}
      AND dataset_run_id = {runId: String}
      AND error LIKE 'Experiment configuration error:%'
  `,
  params: { projectId, runId }
});
```

**在 UI 中识别配置错误**：
- 所有条目都显示错误状态（红色）
- Trace 详情中 Level 显示为 ERROR
- statusMessage 字段包含具体错误原因
- 无 LLM 调用相关的指标（latency、cost、usage 都为空）

#### 4.4.2 排查输入校验不通过的条目

由于校验不通过的条目不创建记录，需要通过排除法排查：

**步骤1：获取数据集总条目数**
```typescript
const totalItems = await getDatasetItemsCount({
  projectId,
  filterState: createDatasetItemFilterState({
    datasetIds: [datasetId],
    status: "ACTIVE"
  })
});
```

**步骤2：获取实验已创建的 runItem 数**
```typescript
const processedItemIds = await getExistingRunItemDatasetItemIds(
  projectId, runId, datasetId
);
const processedCount = processedItemIds.size;
```

**步骤3：计算校验不通过的条目数**
```
校验不通过数量 = 总 ACTIVE 条目数 - 已处理条目数
```

**步骤4：逐一验证具体条目（调试用）**
```typescript
const allItems = await getDatasetItems({
  projectId,
  filterState: createDatasetItemFilterState({
    datasetIds: [datasetId],
    status: "ACTIVE"
  }),
  includeIO: true
});

const variables = ["var1", "var2"]; // 从 Prompt 中提取的变量
const invalidItems = allItems.filter(
  item => !validateDatasetItem(item.input, variables)
);
```

#### 4.4.3 综合查询入口（tRPC Router）

**文件**：`web/src/features/experiments/server/router.ts`

| 查询函数 | 用途 | 是否包含失败记录 |
|---------|------|-----------------|
| `all` | 查询实验列表 | 是，所有实验都显示 |
| `byId` | 查询单个实验详情 | 是，包含 ERROR 级别的条目 |
| `items` | 查询实验条目列表 | 是，配置错误的条目会显示 |
| `metrics` | 查询实验指标 | 错误条目不计入 latency、cost 等指标 |
| `batchIO` | 查询批量输入输出 | 错误条目的 output 为空 |

**注意**：输入校验不通过的条目在上述所有 API 中都不会出现，因为它们从未被写入数据库。

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

## 6. 总结

从数据集条目到实验运行的完整链路具有以下特点：

1. **异步处理**：通过 BullMQ 队列异步执行，不阻塞用户请求
2. **幂等设计**：确定性 ID + 去重检查保证重试安全
3. **容错处理**：单个条目失败不影响整体实验
4. **完整追踪**：每个 LLM 调用都有完整的 trace/observation 记录
5. **事件驱动**：所有状态变更通过事件写入 ClickHouse
6. **可观测性**：内置日志和指标便于监控和调试

该架构确保了实验运行的可靠性、可扩展性，同时保留了完整的审计追踪能力。
