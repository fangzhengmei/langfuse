# Prompt 版本控制与 AB 实验实现报告

## 1. 版本存储机制

### 1.1 数据库模型
- **多版本共存**：同一个 prompt 名称下可以存在多个版本，每个版本拥有唯一的数字版本号 (`version`)
- **版本标识**：使用 `(projectId, name, version)` 三元组唯一标识一个 prompt 版本
- **存储表**：`Prompt` 表存储所有版本，`PromptDependency` 表存储 prompt 间的依赖关系

### 1.2 版本创建流程
在 `web/src/features/prompts/server/actions/createPrompt.ts` 中实现：

```typescript
// 1. 查询最新版本
const latestPrompt = await prisma.prompt.findFirst({
  where: { projectId, name },
  orderBy: [{ version: "desc" }],
});

// 2. 新版本号自动递增
version: latestPrompt?.version ? latestPrompt.version + 1 : 1

// 3. 新创建的 prompt 自动获得 'latest' 标签
const finalLabels = [...labels, LATEST_PROMPT_LABEL];
```

### 1.3 依赖关系处理
- 支持 prompt 嵌套引用，通过 `@@@langfusePrompt:name=xxx|version=xxx@@@` 标签语法
- 引用方式可通过版本号 (`version`) 或标签 (`label`)
- 依赖关系存储在 `promptDependency` 表中，支持递归解析

---

## 2. 标签系统详解

### 2.1 内置标签定义
在 `packages/shared/src/features/prompts/constants.ts` 中定义：

| 标签 | 用途 |
|------|------|
| `latest` | 始终指向最新创建的版本，新 prompt 自动获得此标签 |
| `production` | 生产环境默认使用的版本 |

### 2.2 标签唯一性约束
标签在同一 prompt 名称下具有唯一性，当为新版本添加标签时，系统会自动从旧版本移除该标签：

```typescript
// web/src/features/prompts/server/utils/updatePromptLabels.ts
const removeLabelsFromPreviousPromptVersions = async ({
  prisma,
  projectId,
  promptName,
  labelsToRemove,
}) => {
  // 从旧版本中移除标签以保证唯一性
  const previousLabeledPrompts = await prisma.prompt.findMany({
    where: {
      projectId,
      name: promptName,
      labels: { hasSome: labelsToRemove },
    },
  });
  
  // 返回更新操作...
};
```

### 2.3 自定义标签
- 用户可创建自定义标签（如 `experiment-a`、`canary`、`staging`）
- 标签格式限制：小写字母、数字、下划线、连字符、点号 (`/^[a-z0-9_\-.]+$/`)
- 标签最大长度：36 字符

### 2.4 受保护标签
- 支持将特定标签标记为"受保护"，需要特殊权限才能修改
- 存储在 `promptProtectedLabels` 表中
- 防止意外修改生产环境关键标签

---

## 3. Prompt 获取完整链路

### 3.1 公共 GET API 参数限制
API 端点位于 `web/src/pages/api/public/prompts.ts`：

```typescript
// 公共 GET 接口仅支持 name 和 version 参数
const searchParams = GetPromptSchema.parse(req.query);
const promptName = searchParams.name;
const version = searchParams.version ?? undefined;

const prompt = await getPromptByName({
  promptName,
  projectId,
  version,  // ⚠️ 公共接口不支持 label 参数
});
```

### 3.2 Schema 定义
位于 `packages/shared/src/features/prompts/types.ts`：

```typescript
// 公共 GET API 使用此 Schema，仅支持 name/version
export const GetPromptSchema = z.object({
  name: z.string().transform((v) => decodeURIComponent(v)),
  version: z.coerce.number().int().nullish(),
});

// 内部函数支持 label 参数（通过 TRPC/SDK 调用）
export const GetPromptByNameSchema = z.object({
  promptName: z.string(),
  version: z.coerce.number().int().nullish(),
  label: z.string().optional(),        // label 仅内部可用
  resolve: z.enum(["true", "false"])
    .nullish()
    .default("true")
    .transform((v) => v === "true"),
});
```

### 3.3 请求路由与优先级
请求转发到 `web/src/features/prompts/server/actions/getPromptByName.ts`：

```typescript
export const getPromptByName = async (params) => {
  const { promptName, projectId, version, label, resolve = true } = params;

  if (version && label)
    throw new InvalidRequestError("Cannot specify both version and label");

  const promptService = new PromptService(prisma, redis, recordIncrement);

  // 优先级 1: 若指定 version，按版本号精确获取
  if (version)
    return promptService.getPrompt({ 
      projectId, promptName, version, 
      label: undefined, resolve 
    });

  // 优先级 2: 若指定 label，按标签路由获取（⚠️ 仅内部调用可用）
  if (label)
    return promptService.getPrompt({ 
      projectId, promptName, label, 
      version: undefined, resolve 
    });

  // 优先级 3: 默认返回 production 标签版本
  return promptService.getPrompt({
    projectId, promptName,
    label: PRODUCTION_LABEL,
    version: undefined,
    resolve,
  });
};
```

### 3.4 PromptService 缓存与数据库查询
在 `packages/shared/src/server/services/PromptService/index.ts` 中：

```typescript
public async getPrompt(params: PromptParams): Promise<PromptResult | null> {
  // 1. 尝试从 Redis 缓存获取
  if (this.cacheEnabled) {
    const cachedPrompt = await this.getCachedPrompt(params);
    if (cachedPrompt) return cachedPrompt;
  }

  // 2. 缓存未命中，查询数据库
  const dbPrompt = await this.findPrompt(params);
  
  // 3. 解析依赖关系（如果启用）
  const resolvedPrompt = await this.resolvePrompt(dbPrompt);
  
  // 4. 回填缓存并返回
  if (this.cacheEnabled && resolvedPrompt) {
    await this.cachePrompt({ ...params, prompt: resolvedPrompt });
  }
  
  return resolvedPrompt;
}

// 底层数据库查询
private async findPrompt(params: PromptParams): Promise<Prompt | null> {
  const { projectId, promptName, version, label } = params;

  if (version) {
    return this.prisma.prompt.findFirst({
      where: { projectId, name: promptName, version },
    });
  }

  if (label) {
    return this.prisma.prompt.findFirst({
      where: { 
        projectId, 
        name: promptName, 
        labels: { has: label }  // 数组包含查询
      },
    });
  }

  return null;
}
```

### 3.5 依赖图递归解析
```typescript
public async buildAndResolvePromptGraph(params: {
  projectId: string;
  parentPrompt: PartialPrompt;
  dependencies?: ParsedPromptDependencyTag[];
}) {
  // 1. 递归检测循环依赖（防止死循环）
  // 2. 按依赖关系顺序递归解析子 prompt
  // 3. 将实际 prompt 内容替换占位符标签
  // 4. 返回完全解析后的 prompt + 依赖图结构
}
```

### 3.6 API 响应返回
在 `prompts.ts` 中最终返回：

```typescript
return res.status(200).json({
  ...prompt,
  isActive: prompt.labels.includes(PRODUCTION_LABEL), // 标记是否为生产版本
});
```

---

## 4. AB 实验架构与责任边界

### 4.1 实验配置方式
实验元数据 Schema 定义在 `packages/shared/src/server/llm/types.ts`：

```typescript
export const ExperimentMetadataSchema = z
  .object({
    prompt_id: z.string(),          // 使用的 prompt ID
    provider: z.string(),           // LLM 提供商
    model: z.string(),              // 模型名称
    model_params: ZodModelConfig,   // 模型参数
    structured_output_schema: LLMJSONSchema.optional(),
    experiment_name: z.string().optional(),    // 实验名称
    experiment_run_name: z.string().optional(), // 实验运行名称
    error: z.string().optional(),
    dataset_version: z.coerce.date().optional(),
  })
  .strict();
```

实验事件队列定义在 `packages/shared/src/server/queues.ts`：
```typescript
export const ExperimentCreateEventSchema = z.object({
  projectId: z.string(),
  datasetId: z.string(),
  runId: z.string(),
  description: z.string().optional(),
});
```

实验配置存储在 `datasetRuns.metadata` 字段中，通过实验队列异步执行。

### 4.2 实验执行流程
在 `worker/src/features/experiments/experimentServiceClickhouse.ts` 中实现：

1. **验证实验配置**：检查 prompt、API 密钥、数据集配置
2. **获取数据集项**：批量获取用于实验的测试用例
3. **变量替换**：将数据集中的变量值注入到 prompt 模板
4. **并行执行 LLM 调用**：为每个数据集项执行 prompt
5. **结果存储**：将实验结果存储到 ClickHouse 进行分析

### 4.3 流量切分策略与责任边界

| 责任方 | 职责 | 实现机制 |
|--------|------|----------|
| **业务应用侧** | 流量分流决策 | 基于用户 ID 哈希、白名单、灰度比例等选择版本号 |
| **业务应用侧** | 多版本 Prompt 获取 | 通过 SDK/TRPC 调用带 label 参数的内部接口 |
| **Langfuse 平台** | 版本号路由 | 根据 `version` 参数精确命中 prompt 版本 |
| **Langfuse 平台** | 标签路由 | 仅内部调用支持按 `label` 路由 |
| **Langfuse 平台** | 缓存管理 | 项目级 epoch 缓存版本控制，确保切换时一致性 |
| **Langfuse 平台** | 指标收集 | 自动关联 trace、observation、评分到 prompt 版本 |
| **业务应用侧** | 实验观测分析 | 通过 Langfuse UI 对比不同版本的质量、延迟、成本指标 |

> ⚠️ **重要更正**：公共 GET API (`/api/public/prompts`) **不支持 label 参数**。AB 实验需通过 SDK 或内部 TRPC 接口调用带 label 参数的 getPrompt 方法。

**基于版本号与标签的路由**是 Langfuse 实现 AB 实验的核心机制：

| 策略 | 实现方式 | 适用场景 |
|------|----------|----------|
| **版本号固定** | 直接指定版本号调用，确保实验期间 prompt 内容不变 | 对照实验、基准测试 |
| **标签路由（内部）** | 为不同版本分配标签（如 `variant-a`、`variant-b`），通过 SDK 按标签获取 | AB 测试、灰度发布 |
| **生产标签切换** | 将 `production` 标签从旧版本移动到新版本实现全量发布 | 正式发布、回滚 |

### 4.4 线上 AB 切流完整流程

```
业务应用                              Langfuse 平台
    |                                     |
    |-- 1. 用户请求到达 -----------------> |
    |                                     |
    |-- 2. 分流逻辑 ------------------>  |
    |   (基于 userId 哈希/白名单)         |
    |                                     |
    |-- 3. SDK 调用 getPrompt(name, label) |
    |   (⚠️ 仅 SDK/TRPC 支持 label 参数)   |
    |                                     |
    |                                     |-- 4. Redis 缓存查询
    |                                     |-- 5. 数据库按标签查找版本
    |                                     |-- 6. 递归解析依赖图
    |                                     |-- 7. 缓存回填
    |                                     |
    | <-- 8. 返回 prompt 内容 ------------ |
    |                                     |
    |-- 9. 调用 LLM --------------------> |
    |   (使用 prompt 内容)                 |
    |                                     |
    |-- 10. 上报 trace/observation ------> |
    |                                     |-- 11. 关联到 prompt 版本
    |                                     |-- 12. 指标聚合计算
    |                                     |
    |-- 13. 查看实验结果 ---------------> |
    |                                     |-- 14. 对比版本差异
```

---

## 5. PromptService 核心服务

### 5.1 缓存机制
在 `packages/shared/src/server/services/PromptService/index.ts` 中实现：

```typescript
// 使用 Redis 缓存 prompt，按项目维度设置 epoch 版本
// 缓存键格式：prompt:{projectId}:{epoch}:{promptName}:{version|label}

private async getCacheKey(params: PromptParams): Promise<string | null> {
  const epoch = await this.getOrCreateEpoch(params);
  const prefix = this.getCacheKeyPrefix(params, epoch);
  return `${prefix}:${params.version ?? params.label}`;
}

// 缓存失效：轮换 epoch token，旧缓存自然过期
public async invalidateCache(params: { projectId: string }): Promise<void> {
  await this.redis?.set(
    this.getEpochKey(params),
    this.newEpochToken(),
    "EX",
    this.epochTtlSeconds,
  );
}
```

### 5.2 依赖图构建与解析
```typescript
public async buildAndResolvePromptGraph(params: {
  projectId: string;
  parentPrompt: PartialPrompt;
  dependencies?: ParsedPromptDependencyTag[];
}) {
  // 1. 递归检测循环依赖
  // 2. 按依赖关系顺序解析
  // 3. 替换占位符标签为实际 prompt 内容
  // 4. 返回完全解析后的 prompt + 依赖图
}
```

---

## 6. 典型 AB 实验工作流

### 6.1 准备阶段
1. 创建 prompt 版本 A（当前 production）
2. 创建 prompt 版本 B（实验变体）
3. 为版本 B 添加标签 `experiment-b`

### 6.2 实验执行
1. **服务端分流**：在应用代码中根据用户 ID 哈希、流量比例等条件，通过 SDK 调用带 label 参数的接口
   ```typescript
   // SDK 调用示例（支持 label 参数）
   const label = userId.hashCode() % 100 < 20 ? "experiment-b" : "production";
   const prompt = await langfuse.getPrompt("my-prompt", { label });
   ```

2. **数据集实验**：使用 Langfuse 内置实验功能
   - 创建数据集包含测试用例
   - 创建 dataset run，分别配置 prompt 版本 A 和 B
   - 执行实验并对比结果指标

### 6.3 结果分析
1. 通过 Langfuse UI 查看不同 prompt 版本的使用统计
2. 关联观察指标（延迟、成本、质量评分）
3. 根据实验数据决定是否全量发布

### 6.4 全量发布
1. 将 `production` 标签从版本 A 移动到版本 B
2. 无需修改应用代码，所有流量自动切换
3. 保留版本 A 以便必要时回滚

---

## 7. 事件溯源与自动化

### 7.1 Prompt 变更事件
在 `web/src/features/prompts/server/promptChangeEventSourcing.ts` 中：
- 创建、更新、删除 prompt 时触发事件
- 事件包含完整 prompt 数据和操作类型
- 通过 entity change queue 异步处理

### 7.2 自动化集成
在 `worker/src/features/entityChange/promptVersionProcessor.ts` 中：
- 监听 prompt 版本变更事件
- 触发配置的自动化规则（如 webhook 通知）
- 支持基于标签和操作类型的过滤条件

---

## 8. 关键设计决策

### 8.1 标签 vs 分支
- **选择标签机制**而非传统分支模型
- **优点**：实现简单、查询高效、易于回滚
- **约束**：每个标签在同一 prompt 名称下只能指向一个版本

### 8.2 版本号单调递增
- 不支持语义化版本或自定义版本号
- 版本号仅用于标识先后顺序，避免版本命名冲突

### 8.3 生产环境默认约定
- 默认获取 `production` 标签版本，而非 `latest`
- 确保开发迭代不会意外影响生产流量
- 显式的标签提升操作确保发布可控

### 8.4 责任分离设计
- **平台不做流量决策**：Langfuse 只提供标签路由机制，分流逻辑由业务方控制
- **平台保证一致性**：相同标签始终返回相同 prompt 版本，直到标签被移动
- **平台负责可观测**：自动关联所有调用到对应版本，提供实验分析能力

### 8.5 API 分层设计
- **公共 API**：仅支持 `name` + `version`，保证简单稳定
- **SDK/TRPC**：支持 `label` 参数，满足 AB 实验等高级场景需求
- **默认 fallback**：无 version/label 时，自动路由到 production 标签版本

---

## 9. 核心文件索引

| 功能 | 文件路径 |
|------|----------|
| Prompt 创建逻辑 | `web/src/features/prompts/server/actions/createPrompt.ts` |
| Prompt 获取逻辑 | `web/src/features/prompts/server/actions/getPromptByName.ts` |
| Prompt 核心服务 | `packages/shared/src/server/services/PromptService/index.ts` |
| 公共 API 端点 | `web/src/pages/api/public/prompts.ts` |
| Prompt Schema 定义 | `packages/shared/src/features/prompts/types.ts` |
| 标签常量定义 | `packages/shared/src/features/prompts/constants.ts` |
| 实验元数据 Schema | `packages/shared/src/server/llm/types.ts` |
| 实验事件队列 | `packages/shared/src/server/queues.ts` |
| 实验服务 | `worker/src/features/experiments/experimentServiceClickhouse.ts` |
| 实验工具函数 | `worker/src/features/experiments/utils.ts` |
| Prompt 变更处理器 | `worker/src/features/entityChange/promptVersionProcessor.ts` |
