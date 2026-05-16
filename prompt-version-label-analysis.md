# Langfuse 提示词版本标签链路深度分析

## 目录

1. [数据模型与核心字段定义](#1-数据模型与核心字段定义)
2. [时序一：创建写入流程](#2-时序一创建写入流程)
3. [时序二：标签互斥更新流程](#3-时序二标签互斥更新流程)
4. [时序三：按版本/标签查询流程](#4-时序三按版本标签查询流程)
5. [时序四：前端展示映射流程](#5-时序四前端展示映射流程)
6. [Labels 与 Tags 处理差异对比](#6-labels-与-tags-处理差异对比)
7. [缓存失效触发点汇总](#7-缓存失效触发点汇总)
8. [异常分支处理机制](#8-异常分支处理机制)

---

## 1. 数据模型与核心字段定义

### 1.1 数据库表结构

**表名：`prompts`**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String | 主键， cuid |
| `project_id` | String | 项目ID，外键 |
| `name` | String | 提示词名称，支持路径格式 `folder/prompt-name` |
| `version` | Int | 版本号，与 `name` 组成唯一约束 |
| `type` | String | `text` \| `chat` |
| `prompt` | Json | 提示词内容 |
| `config` | Json | 配置参数 |
| `tags` | String[] | **分类标签数组**，跨版本共享 |
| `labels` | String[] | **版本标记数组**，版本间互斥 |
| `commit_message` | String | 提交信息 |
| `created_by` | String | 创建者 |
| `created_at` | DateTime | 创建时间 |
| `updated_at` | DateTime | 更新时间 |

**表名：`prompt_dependencies`**

| 字段 | 类型 | 说明 |
|------|------|------|
| `parent_id` | String | 父提示词ID |
| `child_name` | String | 子提示词名称 |
| `child_version` | Int \| null | 按版本号引用 |
| `child_label` | String \| null | 按标签引用 |

**表名：`prompt_protected_labels`**

| 字段 | 类型 | 说明 |
|------|------|------|
| `project_id` | String | 项目ID |
| `label` | String | 受保护标签名称，唯一约束 |

### 1.2 常量定义

**文件位置：** `packages/shared/src/constants/prompts.ts`

```typescript
export const PRODUCTION_LABEL = "production";
export const LATEST_PROMPT_LABEL = "latest";
export const MAX_PROMPT_NESTING_DEPTH = 5;
```

---

## 2. 时序一：创建写入流程

### 2.1 完整时序图

```
┌─────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ 前端/API │───▶│  tRPC 路由层  │───▶│  createPrompt │───▶│  PromptService │
└─────────┘    └──────────────┘    └──────────────┘    └──────────────┘
                                                     │
                                                     ▼
                                           ┌───────────────────┐
                                           │  1. 获取最新版本    │
                                           │  findFirst + DESC  │
                                           └─────────┬─────────┘
                                                     │
                                                     ▼
                                           ┌───────────────────┐
                                           │  2. 标签处理        │
                                           │  + LATEST 标签     │
                                           └─────────┬─────────┘
                                                     │
                                                     ▼
                                           ┌───────────────────┐
                                           │  3. Tags 继承       │
                                           │  继承或使用传入值   │
                                           └─────────┬─────────┘
                                                     │
                                                     ▼
                                           ┌───────────────────┐
                                           │  4. 依赖解析        │
                                           │  parsePromptDependencyTags │
                                           └─────────┬─────────┘
                                                     │
                                                     ▼
                                           ┌───────────────────┐
                                           │  5. 依赖图验证      │
                                           │  buildAndResolvePromptGraph │
                                           └─────────┬─────────┘
                                                     │
                                                     ▼
                                           ┌───────────────────┐
                                           │  6. 原子事务执行    │
                                           │  - 创建提示词       │
                                           │  - 创建依赖记录      │
                                           │  - 移除旧版本标签    │
                                           │  - 更新所有版本Tags  │
                                           └─────────┬─────────┘
                                                     │
                                                     ▼
                                           ┌───────────────────┐
                                           │  7. 缓存失效        │
                                           │  invalidateCache   │
                                           └─────────┬─────────┘
                                                     │
                                                     ▼
                                           ┌───────────────────┐
                                           │  8. 事件触发        │
                                           │  promptChangeEventSourcing │
                                           └───────────────────┘
```

### 2.2 关键实现位置与数据字段

**步骤 1-3：获取最新版本、标签处理、Tags 继承**

**文件位置：** `web/src/features/prompts/server/actions/createPrompt.ts:74-114`

```typescript
// 获取最新版本
const latestPrompt = await prisma.prompt.findFirst({
  where: { projectId, name },
  orderBy: [{ version: "desc" }],
});

// 新创建的提示词自动标记为 'latest'
const finalLabels = [...labels, LATEST_PROMPT_LABEL];

// Tags 继承逻辑：未传入则继承最新版本的 Tags
const finalTags = [...new Set(tags ?? latestPrompt?.tags ?? [])];
```

**关键数据字段：**
- 输入：`labels[]`, `tags[]`
- 处理后：`finalLabels[]` (包含 `LATEST_PROMPT_LABEL`), `finalTags[]`

**步骤 4：依赖标签解析**

**文件位置：** `packages/shared/src/features/prompts/parsePromptDependencyTags.ts`

```typescript
export function parsePromptDependencyTags(
  content: string | object,
): ParsedPromptDependencyTag[] {
  // 标签格式：
  // @@@langfusePrompt:name=prompt-name|version=1@@@
  // @@@langfusePrompt:name=prompt-name|label=production@@@
  
  const matchedTags = JSON.stringify(content).match(/@@@langfusePrompt:(.*?)@@@/g);
  
  for (const match of new Set(matchedTags ?? [])) {
    const innerContent = match.replace(/^@@@langfusePrompt:|@@@$/g, "");
    const parts = innerContent.split("|");
    
    // name 必须是第一个参数
    if (!parts[0] || !parts[0].startsWith("name=")) continue;
    
    // 只能有两个部分
    if (parts.length !== 2) continue;
    
    // 解析为 version 或 label 类型
    if (params.version) {
      return { name: params.name, type: "version", version: Number(params.version) };
    } else {
      return { name: params.name, type: "label", label: params.label };
    }
  }
}
```

**关键数据字段：**
- 输出：`{ name: string, type: "version" | "label", version?: number, label?: string }[]`

**步骤 5：依赖图验证**

**文件位置：** `packages/shared/src/server/services/PromptService/index.ts:234-379`

```typescript
public async buildAndResolvePromptGraph(params: {
  projectId: string;
  parentPrompt: PartialPrompt;
  dependencies?: ParsedPromptDependencyTag[];
}) {
  const resolve = async (currentPrompt, deps, level) => {
    // 1. 嵌套深度检查 (MAX_PROMPT_NESTING_DEPTH = 5)
    if (level >= MAX_PROMPT_NESTING_DEPTH) throw Error(...);
    
    // 2. 循环依赖检查
    if (seen.has(currentPrompt.id)) throw Error(...);
    
    // 3. 递归查找依赖（按 version 或 label）
    const depPrompt = await this.prisma.prompt.findFirst({
      where: {
        projectId,
        name: dep.name,
        ...(dep.type === "version"
          ? { version: dep.version }
          : { labels: { has: dep.label } }),
      },
    });
    
    // 4. 递归解析子依赖
    const resolvedDepPrompt = await resolve(depPrompt, undefined, level + 1);
  };
}
```

**关键数据字段：**
- 检查项：`level` (嵌套深度), `seen` (已访问ID集合)
- 查询条件：按 `version` 或 `labels.has` 查找

**步骤 6：原子事务执行**

**文件位置：** `web/src/features/prompts/server/actions/createPrompt.ts:141-206`

```typescript
const create = [
  // 6.1 创建提示词版本
  prisma.prompt.create({
    data: {
      id: newPromptId,
      prompt,
      name,
      createdBy,
      labels: [...new Set(finalLabels)], // 确保标签唯一
      type,
      tags: finalTags,
      version: latestPrompt?.version ? latestPrompt.version + 1 : 1,
      project: { connect: { id: projectId } },
      config: jsonSchema.parse(config),
      commitMessage,
    },
  }),
  // 6.2 创建依赖记录
  ...promptDependencies.map((dep) =>
    prisma.promptDependency.create({
      data: {
        projectId,
        parentId: newPromptId,
        childName: dep.name,
        ...(dep.type === "version"
          ? { childVersion: dep.version }
          : { childLabel: dep.label }),
      },
    }),
  ),
];

// 6.3 从旧版本移除新分配的 labels（互斥性保证）
if (finalLabels.length > 0) {
  const { touchedPromptIds, updates } =
    await removeLabelsFromPreviousPromptVersions({
      prisma,
      projectId,
      promptName: name,
      labelsToRemove: finalLabels,
    });
  create.push(...updates);
}

// 6.4 Tags 更新到所有版本
const haveTagsChanged = JSON.stringify([...new Set(finalTags)].sort()) !==
  JSON.stringify([...new Set(latestPrompt?.tags)].sort());

if (haveTagsChanged) {
  const { touchedPromptIds, updates } =
    await updatePromptTagsOnAllVersions({
      prisma,
      projectId,
      promptName: name,
      tags: finalTags,
    });
  create.push(...updates);
}

// 6.5 事务提交
const [createdPrompt] = (await prisma.$transaction(create)) as [Prompt, ...];
```

**关键数据字段：**
- 事务操作数组：`create[]` (包含创建、标签移除、Tags更新)
- 受影响版本ID：`touchedPromptIds[]`

**步骤 7-8：缓存失效与事件触发**

**文件位置：** `web/src/features/prompts/server/actions/createPrompt.ts:208-233`

```typescript
// 7. 缓存失效（项目级 Epoch 轮转）
await promptService.invalidateCache({ projectId });

// 8. 触发 Webhook 事件
const updatedPrompts = await prisma.prompt.findMany({
  where: { id: { in: touchedPromptIds }, projectId },
});

await Promise.all([
  ...updatedPrompts.map(async (prompt) =>
    promptChangeEventSourcing(
      await promptService.resolvePrompt(prompt),
      "updated",
      user,
    ),
  ),
  promptChangeEventSourcing(
    await promptService.resolvePrompt(createdPrompt),
    "created",
    user,
  ),
]);
```

---

## 3. 时序二：标签互斥更新流程

### 3.1 完整时序图

```
┌─────────────────┐    ┌──────────────┐    ┌──────────────┐
│ SetPromptLabels │───▶│  setLabels   │───▶│  行级锁查询   │
│    组件         │    │   路由       │    │  FOR UPDATE  │
└─────────────────┘    └──────────────┘    └──────┬───────┘
                                                    │
                                                    ▼
                                          ┌───────────────────┐
                                          │  1. 计算标签变更    │
                                          │  - removedLabels[] │
                                          │  - addedLabels[]   │
                                          └─────────┬─────────┘
                                                    │
                                                    ▼
                                          ┌───────────────────┐
                                          │  2. 受保护标签检查  │
                                          │  checkHasProtectedLabels │
                                          └─────────┬─────────┘
                                                    │
                                                    ▼
                                          ┌───────────────────┐
                                          │  3. 依赖保护检查    │
                                          │  被其他 prompt 依赖? │
                                          └─────────┬─────────┘
                                                    │
                                                    ▼
                                          ┌───────────────────┐
                                          │  4. 旧版本标签移除  │
                                          │  removeLabelsFromPreviousPromptVersions │
                                          └─────────┬─────────┘
                                                    │
                                                    ▼
                                          ┌───────────────────┐
                                          │  5. 设置新版本标签  │
                                          │  UPDATE SET labels  │
                                          └─────────┬─────────┘
                                                    │
                                                    ▼
                                          ┌───────────────────┐
                                          │  6. 缓存失效        │
                                          └─────────┬─────────┘
                                                    │
                                                    ▼
                                          ┌───────────────────┐
                                          │  7. 触发更新事件    │
                                          └───────────────────┘
```

### 3.2 关键实现位置与数据字段

**步骤 0：行级锁 - 并发安全保证**

**文件位置：** `web/src/features/prompts/server/actions/updatePrompts.ts:25-49`

```typescript
const result = await prisma.$transaction(async (tx) => {
  const prompt = (
    await tx.$queryRaw<...>`
      SELECT * FROM prompts
      WHERE project_id = ${projectId}
        AND name = ${promptName}
        AND version = ${promptVersion}
      FOR UPDATE  -- 关键：行级锁防止并发更新冲突
    `
  )[0];
});
```

**步骤 1：计算标签变更**

**文件位置：** `web/src/features/prompts/server/actions/updatePrompts.ts:51-62`

```typescript
const newLabelsSet = new Set([...newLabels, ...prompt.labels]);
const removedLabels = [];

// 找出被移除的标签
for (const oldLabel of prompt.labels) {
  if (!newLabelsSet.has(oldLabel)) {
    removedLabels.push(oldLabel);
  }
}

// addedLabels 在调用 removeLabelsFromPreviousPromptVersions 时隐式计算
```

**步骤 2：受保护标签权限检查**

**文件位置：** `web/src/features/prompts/server/routers/promptRouter.ts:851-865`

```typescript
const { hasProtectedLabels, protectedLabels } =
  await checkHasProtectedLabels({
    prisma: ctx.prisma,
    projectId: input.projectId,
    labelsToCheck: [...addedLabels, ...removedLabels],
  });

if (hasProtectedLabels) {
  throwIfNoProjectAccess({
    session: ctx.session,
    projectId: input.projectId,
    scope: "promptProtectedLabels:CUD", // 需要特殊权限
    forbiddenErrorMessage: `Protected labels: ${protectedLabels.join(", ")}`,
  });
}
```

**关键数据字段：**
- 权限 scope：`promptProtectedLabels:CUD`
- 检查范围：`addedLabels[]` + `removedLabels[]`

**步骤 3：依赖保护检查**

**文件位置：** `web/src/features/prompts/server/actions/updatePrompts.ts:64-100`

```typescript
if (removedLabels.length > 0) {
  const dependents = await tx.$queryRaw<...>`
    SELECT
      p."name" AS "parent_name",
      p."version" AS "parent_version",
      pd."child_version" AS "child_version",
      pd."child_label" AS "child_label"
    FROM prompt_dependencies pd
    INNER JOIN prompts p ON p.id = pd.parent_id
    WHERE
      p.project_id = ${projectId}
      AND pd.project_id = ${projectId}
      AND pd.child_name = ${promptName}
      AND pd."child_label" IS NOT NULL
      AND pd."child_label" IN (${Prisma.join(removedLabels)})
  `;

  if (dependents.length > 0) {
    throw new InvalidRequestError(
      `Other prompts are depending on the prompt label you are trying to remove`,
    );
  }
}
```

**关键数据字段：**
- 查询条件：`child_label IN (removedLabels)`
- 依赖信息：`parent_name`, `parent_version`, `child_label`

**步骤 4：旧版本标签移除（互斥性核心实现）**

**文件位置：** `web/src/features/prompts/server/utils/updatePromptLabels.ts`

```typescript
export const removeLabelsFromPreviousPromptVersions = async ({
  prisma, projectId, promptName, labelsToRemove,
}) => {
  // 查找所有已带有这些标签的版本
  const previouslyLabeledPrompts = await prisma.prompt.findMany({
    where: {
      projectId,
      name: promptName,
      labels: { hasSome: labelsToRemove }, // 包含任一待移除标签
    },
    orderBy: [{ version: "desc" }],
  });

  const touchedPromptIds = previouslyLabeledPrompts.map((p) => p.id);

  return {
    touchedPromptIds,
    updates: previouslyLabeledPrompts.map((prevPrompt) =>
      prisma.prompt.update({
        where: { id: prevPrompt.id },
        data: {
          labels: prevPrompt.labels.filter(
            (prevLabel) => !labelsToRemove.includes(prevLabel),
          ),
        },
      }),
    ),
  };
};
```

**关键数据字段：**
- 查询条件：`labels.hasSome: labelsToRemove`
- 更新操作：数组过滤 `labels.filter()`

**步骤 5：设置新版本标签**

**文件位置：** `web/src/features/prompts/server/actions/updatePrompts.ts:118-135`

```typescript
const result = await Promise.all([
  // 先移除其他版本的标签
  ...labelUpdates,
  // 再更新当前版本标签
  tx.prompt.update({
    where: { id: prompt.id, projectId },
    data: {
      labels: { set: Array.from(newLabelsSet) }, // set 操作覆盖原有值
    },
  }),
]);
```

---

## 4. 时序三：按版本/标签查询流程

### 4.1 完整时序图

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  SDK/API     │───▶│ getPromptByName│───▶│ PromptService│
│  调用方      │    │              │    │   getPrompt  │
└──────────────┘    └──────────────┘    └──────┬───────┘
                                                │
                                                ▼
                                      ┌───────────────────┐
                                      │  1. 缓存查询        │
                                      │  getCachedPrompt   │
                                      │  (Epoch + 键)      │
                                      └─────────┬─────────┘
                                                │
                                      ┌─────────┴─────────┐
                                      │                   │
                                ┌─────▼─────┐       ┌─────▼─────┐
                                │  缓存命中  │       │  缓存未命中  │
                                │  直接返回  │       │  查询DB    │
                                └───────────┘       └─────┬─────┘
                                                          │
                                                          ▼
                                                ┌───────────────────┐
                                                │  2. 按版本/标签查询 │
                                                │  findFirst        │
                                                └─────────┬─────────┘
                                                          │
                                                          ▼
                                                ┌───────────────────┐
                                                │  3. 依赖图解析      │
                                                │  resolvePrompt     │
                                                └─────────┬─────────┘
                                                          │
                                                          ▼
                                                ┌───────────────────┐
                                                │  4. 写入缓存        │
                                                │  set + TTL         │
                                                └─────────┬─────────┘
                                                          │
                                                          ▼
                                                ┌───────────────────┐
                                                │  5. 返回结果        │
                                                └───────────────────┘
```

### 4.2 关键实现位置与数据字段

**入口：按名称获取提示词**

**文件位置：** `web/src/features/prompts/server/actions/getPromptByName.ts`

```typescript
export const getPromptByName = async (params: {
  promptName: string;
  projectId: string;
  version?: number | null;
  label?: string;
  resolve?: boolean;
}) => {
  // 不能同时指定 version 和 label
  if (version && label)
    throw new InvalidRequestError("Cannot specify both version and label");

  if (version)
    return promptService.getPrompt({
      projectId, promptName, version, label: undefined, resolve,
    });

  if (label)
    return promptService.getPrompt({
      projectId, promptName, label, version: undefined, resolve,
    });

  // 默认返回 production 标签版本
  return promptService.getPrompt({
    projectId, promptName, label: PRODUCTION_LABEL, version: undefined, resolve,
  });
};
```

**步骤 1：缓存查询**

**文件位置：** `packages/shared/src/server/services/PromptService/index.ts:47-79`

```typescript
public async getPrompt(params: PromptParams): Promise<PromptResult | null> {
  if (params.resolve === false) return this.getRawPrompt(params);

  if (this.cacheEnabled) {
    const cachedPrompt = await this.getCachedPrompt(params);
    if (cachedPrompt) return cachedPrompt;
  }

  const dbPrompt = await this.getDbPrompt(params);
  if (this.cacheEnabled && dbPrompt) await this.cachePrompt({ ...params, prompt: dbPrompt });

  return dbPrompt;
}
```

**缓存键生成逻辑**

**文件位置：** `packages/shared/src/server/services/PromptService/index.ts:192-232`

```typescript
// Epoch 是项目级别的，因为提示词依赖可能跨多个 prompt name
private getEpochKey(params: { projectId: string }): string {
  return `prompt_cache_epoch:${params.projectId}`;
}

// 缓存键格式：prompt:{projectId}:{epoch}:{promptName}:{version|label}
private async getCacheKey(params: PromptParams): Promise<string | null> {
  const epoch = await this.getOrCreateEpoch(params);
  const prefix = this.getCacheKeyPrefix(params, epoch);
  return `${prefix}:${params.version ?? params.label}`;
}

private getCacheKeyPrefix(params, epoch: string): string {
  return `prompt:${params.projectId}:${epoch}:${params.promptName}`;
}

private async getOrCreateEpoch(params: { projectId: string }): Promise<string | null> {
  const epochKey = this.getEpochKey(params);
  const currentEpoch = await this.redis?.get(epochKey);
  if (currentEpoch) return currentEpoch;

  const newEpoch = this.newEpochToken(); // 48 bits entropy, base64url
  await this.redis?.set(epochKey, newEpoch, "EX", this.epochTtlSeconds, "NX");
  return (await this.redis?.get(epochKey)) ?? newEpoch;
}
```

**关键数据字段：**
- Epoch TTL：`epochTtlSeconds = 7 * 24 * 60 * 60` (7天)
- 缓存键：`prompt:{projectId}:{epoch}:{promptName}:{version|label}`
- Prompt TTL：`LANGFUSE_CACHE_PROMPT_TTL_SECONDS`

**步骤 2：按版本/标签数据库查询**

**文件位置：** `packages/shared/src/server/services/PromptService/index.ts:100-128`

```typescript
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
        labels: { has: label }, // PostgreSQL array contains 操作
      },
    });
  }

  return null;
}
```

**关键数据字段：**
- 按 label 查询条件：`labels: { has: label }`

**步骤 3：依赖图递归解析**

**文件位置：** `packages/shared/src/server/services/PromptService/index.ts:130-145, 234-379`

```typescript
public async resolvePrompt(prompt: Prompt | null) {
  if (!prompt) return null;

  const promptGraph = await this.buildAndResolvePromptGraph({
    projectId: prompt.projectId,
    parentPrompt: prompt,
  });

  return {
    ...prompt,
    prompt: promptGraph.resolvedPrompt, // 已解析内容
    resolutionGraph: promptGraph.graph, // 依赖关系图
  };
}
```

**递归解析中的标签替换**

```typescript
// 构建替换正则：同时匹配 version 和所有 labels 格式
const versionPattern = `@@@langfusePrompt:name=${escapeRegex(depPrompt.name)}\\|version=${escapeRegex(depPrompt.version)}@@@`;
const labelPatterns = depPrompt.labels.map(
  (label) => `@@@langfusePrompt:name=${escapeRegex(depPrompt.name)}\\|label=${escapeRegex(label)}@@@`,
);
const combinedPattern = [versionPattern, ...labelPatterns].join("|");
const regex = new RegExp(combinedPattern, "g");

resolvedPrompt = resolvedPrompt.replace(regex, replaceValue);
```

---

## 5. 时序四：前端展示映射流程

### 5.1 完整时序图

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  PromptDetail   │───▶│ SetPromptVersion│───▶│  TagPromptPopover│
│  (标签展示)     │    │    Labels       │    │  (Tags 编辑)    │
└─────────────────┘    └────────┬────────┘    └────────┬────────┘
                                 │                       │
                                 ▼                       ▼
                       ┌───────────────────┐   ┌───────────────────┐
                       │  1. 获取所有标签    │   │  1. 乐观更新 UI    │
                       │  allLabels 查询    │   │  onMutate 取消请求 │
                       └─────────┬─────────┘   └─────────┬─────────┘
                                 │                       │
                                 ▼                       ▼
                       ┌───────────────────┐   ┌───────────────────┐
                       │  2. 检测 production│   │  2. 错误回滚       │
                       │  晋升/降级 显示样式 │   │  onError 恢复数据  │
                       └─────────┬─────────┘   └─────────┬─────────┘
                                 │                       │
                                 ▼                       ▼
                       ┌───────────────────┐   ┌───────────────────┐
                       │  3. 创建新标签验证  │   │  3. 成功后刷新缓存 │
                       │  PromptLabelSchema│   │  onSettled        │
                       └─────────┬─────────┘   └───────────────────┘
                                 │
                                 ▼
                       ┌───────────────────┐
                       │  4. 全选/清除标签    │
                       │  批量操作优化       │
                       └───────────────────┘
```

### 5.2 关键实现位置与数据字段

**Labels 前端展示组件**

**文件位置：** `web/src/features/prompts/components/SetPromptVersionLabels/index.tsx:1-344`

```typescript
export function SetPromptVersionLabels({
  promptLabels, prompt, isOpen, setIsOpen, title,
  showOnlyOnHover = false, maxVisibleLabels = 8,
}) {
  // 1. 获取项目中所有已使用的标签（用于自动补全）
  const usedLabelsInProject = api.prompts.allLabels.useQuery(
    { projectId }, { enabled: Boolean(projectId) },
  );

  // 2. 检测 production 标签变化（用于按钮样式）
  const isPromotingToProduction =
    !prompt.labels.includes(PRODUCTION_LABEL) &&
    selectedLabels.includes(PRODUCTION_LABEL);

  const isDemotingFromProduction =
    prompt.labels.includes(PRODUCTION_LABEL) &&
    !selectedLabels.includes(PRODUCTION_LABEL);

  // 3. 标签变更提交
  const mutatePromptVersionLabels = api.prompts.setLabels.useMutation({
    onSuccess: () => void utils.prompts.invalidate(),
  });

  // 4. 创建新标签验证
  const isValidNewLabel =
    trimmedSearch.length > 0 &&
    !isReservedPromptLabel(trimmedSearch) &&
    PromptLabelSchema.safeParse(trimmedSearch).success &&
    !labels.includes(trimmedSearch);

  // 5. 全选/清除操作
  const filteredCustomLabels = customLabels.filter((l) =>
    l.toLowerCase().includes(normalizedSearchValue),
  );
  
  // 全选
  setSelectedLabels((prev) => [
    ...new Set([...prev, ...filteredCustomLabels]),
  ]);
  
  // 清除（保留 reserved 标签）
  setSelectedLabels((prev) =>
    prev.filter((l) => isReservedPromptLabel(l) || !filteredCustomLabelSet.has(l)),
  );

  // 6. 提交按钮样式变化
  <Button
    variant={
      isPromotingToProduction || isDemotingFromProduction
        ? "destructive"  // 涉及 production 用警告样式
        : "default"
    }
    loading={mutatePromptVersionLabels.isPending}
    disabled={!labelsChanged}
  >
    {isPromotingToProduction
      ? "Save and promote to production"
      : isDemotingFromProduction
        ? "Save and remove from production"
        : "Save"}
  </Button>
}
```

**Tags 前端展示组件（乐观更新）**

**文件位置：** `web/src/features/tag/components/TagPromptPopover.tsx`

```typescript
export function TagPromptPopover({ tags, availableTags, projectId, promptName, promptsFilter }) {
  const utils = api.useUtils();
  const mutTags = api.prompts.updateTags.useMutation({
    // 1. 乐观更新：更新前取消正在进行的请求
    onMutate: async () => {
      await utils.prompts.all.cancel();
      setIsLoading(true);
      const prevPrompt = utils.prompts.all.getData(promptsFilter);
      return { prevPrompt };
    },
    // 2. 错误回滚
    onError: (err, _newTags, context) => {
      utils.prompts.all.setData(promptsFilter, context?.prevPrompt);
      trpcErrorToast(err);
      setIsLoading(false);
    },
    // 3. 成功后更新本地缓存（避免重刷新）
    onSettled: (data, error, { name, tags }) => {
      utils.prompts.all.setData(
        promptsFilter,
        (oldQueryData) => {
          const updatedPrompts = oldQueryData
            ? oldQueryData.prompts.map((prompt) => {
                return prompt.name === name ? { ...prompt, tags } : prompt;
              })
            : [];
          return { prompts: updatedPrompts, totalCount: updatedPrompts.length };
        },
      );
      setIsLoading(false);
    },
  });

  function mutateTags(newTags: string[]) {
    void mutTags.mutateAsync({ projectId, name: promptName, tags: newTags });
  }
}
```

**提示词列表中的展示映射**

**文件位置：** `web/src/features/prompts/components/prompts-table.tsx:33-199`

```typescript
type PromptTableRow = {
  id: string;
  name: string;
  fullPath: string;
  type: "folder" | "text" | "chat";
  version?: number;
  createdAt?: Date;
  labels?: string[];  // 版本标记显示
  tags?: string[];    // 分类标签显示
  numberOfObservations?: number;
};

// 后端返回 folder representative（只显示最新版本）
const processedRowData = useMemo(() => {
  if (!promptsRowData.rows) return { ...promptsRowData, rows: [] };

  const combinedRows: PromptTableRow[] = [];
  for (const prompt of promptsRowData.rows) {
    const isFolder = prompt.row_type === "folder";
    combinedRows.push(
      createRow({
        id: `${type}-${fullPath}`,
        name: itemName,
        fullPath,
        type,
        ...(isFolder
          ? {}
          : {
              version: prompt.version,
              createdAt: prompt.createdAt,
              labels: prompt.labels,
              tags: prompt.tags,
              numberOfObservations: Number(prompt.observationCount ?? 0),
            }),
      }),
    );
  }
  return { ...promptsRowData, rows: combinedRows };
}, [promptsRowData]);
```

---

## 6. Labels 与 Tags 处理差异对比

### 6.1 核心差异矩阵

| 维度 | Labels (版本标记) | Tags (分类标签) |
|------|-------------------|-----------------|
| **作用范围** | 特定版本独有 | 跨所有同名版本共享 |
| **唯一性约束** | 同一 name 下，一个 label 只能分配给一个版本 | 无约束，可以分配给所有版本 |
| **自动更新机制** | 创建新版本时，自动从旧版本移除并添加到新版本 | 创建新版本时如果 tags 变化，更新所有版本的 tags |
| **后端更新粒度** | 单个版本更新 | 批量更新所有版本 |
| **前端编辑入口** | 版本详情页，每个版本独立编辑 | 列表页/详情页，一次编辑作用于所有版本 |
| **乐观更新** | 不支持（直接 invalidate） | 支持完整乐观更新（onMutate/onError/onSettled） |
| **权限控制** | 有受保护标签机制，需要 `promptProtectedLabels:CUD` | 普通 `objects:tag` 权限 |
| **依赖保护** | 删除前检查是否被其他 prompt 依赖 | 无依赖保护 |
| **缓存失效粒度** | 项目级 Epoch 轮转 | 项目级 Epoch 轮转 |
| **筛选支持** | 支持筛选 | 支持筛选 |

### 6.2 更新机制对比代码

**Labels 更新（单个版本 + 互斥移除）**

```typescript
// 位置：web/src/features/prompts/server/utils/updatePromptLabels.ts

// 只从包含这些标签的版本中移除
const previouslyLabeledPrompts = await prisma.prompt.findMany({
  where: {
    projectId,
    name: promptName,
    labels: { hasSome: labelsToRemove }, // 只找有这些标签的版本
  },
});

// 每个版本独立更新
previouslyLabeledPrompts.map((prevPrompt) =>
  prisma.prompt.update({
    where: { id: prevPrompt.id },
    data: {
      labels: prevPrompt.labels.filter(...), // 从该版本数组中移除
    },
  }),
);
```

**Tags 更新（所有版本批量更新）**

```typescript
// 位置：web/src/features/prompts/server/utils/updatePromptTags.ts

// 找出所有同名版本
const previousVersions = await prisma.prompt.findMany({
  where: { projectId, name: promptName },
});

// 所有版本统一设置为相同 tags
previousVersions.map((prevVersion) =>
  prisma.prompt.update({
    where: { id: prevVersion.id },
    data: {
      tags: [...new Set(tags)], // 覆盖设置，确保唯一
    },
  }),
);
```

### 6.3 路由层差异

**Labels 路由**

**文件位置：** `web/src/features/prompts/server/routers/promptRouter.ts:800-994`

```typescript
setLabels: protectedProjectProcedure
  .input(z.object({
    promptId: z.string(),
    projectId: z.string(),
    labels: z.array(z.string()),
  }))
  .mutation(async ({ input, ctx }) => {
    // 1. 受保护标签检查
    // 2. 依赖保护检查
    // 3. 事务更新（移除旧版本标签 + 设置新版本标签）
    // 4. 缓存失效
    // 5. 触发更新事件
  });
```

**Tags 路由**

**文件位置：** `web/src/features/prompts/server/routers/promptRouter.ts:1078-1144`

```typescript
updateTags: protectedProjectProcedure
  .input(z.object({
    projectId: z.string(),
    name: z.string(), // 提示词名称，不是版本ID
    tags: z.array(z.string()),
  }))
  .mutation(async ({ input, ctx }) => {
    // 1. 直接批量更新所有版本
    await ctx.prisma.prompt.updateMany({
      where: { name: promptName, projectId },
      data: { tags: { set: input.tags } },
    });
    
    // 2. 缓存失效
    await promptService.invalidateCache({ projectId });
    
    // 3. 触发所有版本更新事件
    const prompts = await ctx.prisma.prompt.findMany({
      where: { projectId, name: promptName },
    });
    await Promise.all(prompts.map(... promptChangeEventSourcing ...));
  });
```

---

## 7. 缓存失效触发点汇总

### 7.1 所有触发点位置与场景

| 触发点位置 | 场景 | 影响范围 |
|-----------|------|---------|
| `createPrompt.ts:209` | 创建新提示词版本 | 项目级 |
| `updatePrompts.ts:138` | 更新提示词标签 | 项目级 |
| `promptRouter.ts:622` | 删除提示词（按 name） | 项目级 |
| `promptRouter.ts:783` | 删除单个提示词版本 | 项目级 |
| `promptRouter.ts:966` | 设置版本标签 | 项目级 |
| `promptRouter.ts:1119` | 更新 Tags | 项目级 |

### 7.2 缓存失效实现机制

**文件位置：** `packages/shared/src/server/services/PromptService/index.ts:177-190`

```typescript
public async invalidateCache(params: { projectId: string }): Promise<void> {
  if (!this.cacheEnabled) return;

  // 通过轮转 Epoch 令牌使所有缓存失效
  // 旧键保持不变，自然过期
  await this.redis?.set(
    this.getEpochKey(params),
    this.newEpochToken(), // 生成新的随机 token
    "EX",
    this.epochTtlSeconds, // 7天
  );
}
```

**设计优势：**
1. **原子性**：Redis SET 操作是原子的，避免竞态条件
2. **性能**：无需遍历删除所有缓存键，单次操作即可
3. **容错**：旧缓存不会立即删除，新请求使用新 Epoch，旧请求自然过期
4. **跨提示词依赖**：项目级 Epoch 确保跨 prompt name 的依赖也能正确失效

---

## 8. 异常分支处理机制

### 8.1 异常分支汇总

| 异常场景 | 检查位置 | 抛出错误 |
|---------|---------|---------|
| **创建流程异常** | | |
| 版本类型不匹配 | `createPrompt.ts:92-96` | InvalidRequestError |
| 变量与占位符命名冲突 | `createPrompt.ts:99-107` | InvalidRequestError |
| 同时指定 version 和 label | `getPromptByName.ts:26-27` | InvalidRequestError |
| 嵌套深度超过 5 层 | `PromptService/index.ts:258-262` | Error |
| 循环依赖检测 | `PromptService/index.ts:265-273` | Error |
| 依赖提示词不存在 | `PromptService/index.ts:321-322` | Error |
| 依赖提示词不是 text 类型 | `PromptService/index.ts:323-324` | Error |
| **标签更新异常** | | |
| 受保护标签无权限 | `promptRouter.ts:858-865` | ForbiddenError |
| 标签被其他 prompt 依赖 | `updatePrompts.ts:88-100` | InvalidRequestError |
| **删除流程异常** | | |
| 版本被其他 prompt 依赖（按 version） | `promptRouter.ts:715-727` | TRPCError CONFLICT |
| 版本被其他 prompt 依赖（按 label） | `promptRouter.ts:715-727` | TRPCError CONFLICT |
| 删除带受保护标签的版本 | `promptRouter.ts:780-785` | ForbiddenError |
| **公共 API 异常** | | |
| 认证失败 | `prompts.ts:36` | UnauthorizedError |
| 不是项目级 access token | `prompts.ts:37-44` | ForbiddenError |
| 提示词不存在 | `prompts.ts:71` | LangfuseNotFoundError |
| Zod 验证失败 | `prompts.ts:127-131` | 400 Bad Request |
| Prisma 异常 | `prompts.ts:121-125` | 500 Internal Server Error |

### 8.2 关键异常处理代码

**依赖保护 - 删除版本时检查**

**文件位置：** `web/src/features/prompts/server/routers/promptRouter.ts:687-727`

```typescript
if (labels.length > 0) {
  const dependents = await ctx.prisma.$queryRaw<...>`
    SELECT
      p."name" AS "parent_name",
      p."version" AS "parent_version",
      pd."child_version" AS "child_version",
      pd."child_label" AS "child_label"
    FROM prompt_dependencies pd
    INNER JOIN prompts p ON p.id = pd.parent_id
    WHERE
      p.project_id = ${projectId}
      AND pd.project_id = ${projectId}
      AND pd.child_name = ${promptName}
      AND (
        (pd."child_version" IS NOT NULL AND pd."child_version" = ${version})
        OR
        (pd."child_label" IS NOT NULL AND pd."child_label" IN (${Prisma.join(labels)}))
      )
  `;

  if (dependents.length > 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Other prompts are depending on the prompt version you are trying to delete`,
    });
  }
}
```

**受保护标签 - 删除时检查**

**文件位置：** `web/src/features/prompts/server/routers/promptRouter.ts:780-794`

```typescript
const { hasProtectedLabels, protectedLabels } =
  await checkHasProtectedLabels({
    prisma: ctx.prisma,
    projectId: input.projectId,
    labelsToCheck: promptVersion.labels, // 检查该版本的所有标签
  });

if (hasProtectedLabels) {
  throwIfNoProjectAccess({
    session: ctx.session,
    projectId: input.projectId,
    scope: "promptProtectedLabels:CUD",
    forbiddenErrorMessage: `You don't have permission to delete a prompt with a protected label. Protected labels: ${protectedLabels.join(", ")}`,
  });
}
```

**公共 API 错误处理中间件**

**文件位置：** `web/src/pages/api/public/prompts.ts:110-138`

```typescript
try {
  // ... 业务逻辑
} catch (error: unknown) {
  logger.error(error);
  traceException(error);

  // 1. 业务自定义错误
  if (error instanceof BaseError) {
    return res.status(error.httpCode).json({
      error: error.name,
      message: error.message,
    });
  }

  // 2. Prisma 数据库错误
  if (isPrismaException(error)) {
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }

  // 3. 请求参数验证错误
  if (error instanceof z.ZodError) {
    return res.status(400).json({
      message: "Invalid request data",
      error: error.issues,
    });
  }

  // 4. 兜底未知错误
  return res.status(500).json({
    message: "Invalid request data",
    error: error instanceof Error ? error.message : "An unknown error occurred",
  });
}
```

---

## 附录：关键文件索引

| 文件路径 | 主要职责 |
|---------|---------|
| `packages/shared/prisma/schema.prisma` | 数据模型定义 |
| `packages/shared/src/domain/prompts.ts` | Prompt Domain Schema |
| `packages/shared/src/features/prompts/parsePromptDependencyTags.ts` | 依赖标签解析 |
| `packages/shared/src/server/services/PromptService/index.ts` | 核心服务（查询、缓存、依赖解析） |
| `web/src/features/prompts/server/actions/createPrompt.ts` | 创建版本逻辑 |
| `web/src/features/prompts/server/actions/updatePrompts.ts` | 更新标签逻辑 |
| `web/src/features/prompts/server/actions/getPromptByName.ts` | 获取提示词入口 |
| `web/src/features/prompts/server/actions/deletePrompt.ts` | 删除提示词逻辑 |
| `web/src/features/prompts/server/utils/updatePromptLabels.ts` | 标签互斥移除工具 |
| `web/src/features/prompts/server/utils/updatePromptTags.ts` | Tags 跨版本更新工具 |
| `web/src/features/prompts/server/routers/promptRouter.ts` | tRPC 路由定义 |
| `web/src/features/prompts/components/SetPromptVersionLabels/index.tsx` | Labels 前端编辑组件 |
| `web/src/features/tag/components/TagPromptPopover.tsx` | Tags 前端编辑组件 |
| `web/src/pages/api/public/prompts.ts` | 公共 REST API 端点 |
