# Langfuse 提示词版本标签链路深度分析报告

## 目录

1.  [数据模型与核心字段定义](#1-数据模型与核心字段定义)
2.  [入口对齐矩阵：三入口核心流程并行对比](#2-入口对齐矩阵三入口核心流程并行对比)
3.  [时序一：创建写入流程](#3-时序一创建写入流程)
4.  [时序二：标签互斥更新流程](#4-时序二标签互斥更新流程)
5.  [时序三：删除版本流程](#5-时序三删除版本流程)
6.  [时序四：按版本/标签查询与回源链路](#6-时序四按版本标签查询与回源链路)
7.  [时序五：前端展示映射与缓存失效切换](#7-时序五前端展示映射与缓存失效切换)
8.  [缓存失效触发点与回源路径矩阵](#8-缓存失效触发点与回源路径矩阵)
9.  [深度分析一：并发场景竞态与一致性保障](#9-深度分析一并发场景竞态与一致性保障)
10. [深度分析二：Label 变更后的前端读取链路一致性](#10-深度分析二label-变更后的前端读取链路一致性)
11. [Labels 与 Tags 处理差异对比](#11-labels-与-tags-处理差异对比)
12. [异常分支处理汇总](#12-异常分支处理汇总)
13. [架构设计总结](#13-架构设计总结)

---

## 1. 数据模型与核心字段定义

### 1.1 数据库表结构

#### `prompts` 表

| 字段名 | 类型 | 说明 | 关键约束 |
|--------|------|------|----------|
| `id` | String | 主键 | UUID v4 |
| `project_id` | String | 项目ID | 外键 |
| `name` | String | 提示词名称 | 支持路径格式 |
| `version` | Int | 版本号 | `(project_id, name, version)` 唯一约束 |
| `type` | String | 提示词类型 | text/chat |
| `prompt` | Json | 提示词内容 |  |
| `config` | Json | 配置参数 |  |
| `tags` | String[] | 标签数组（跨版本共享） | 所有版本保持一致 |
| `labels` | String[] | 版本标记数组（版本间互斥） | 同一 name 下 label 只能属于一个版本 |
| `created_by` | String | 创建者 |  |
| `created_at` | DateTime | 创建时间 |  |
| `updated_at` | DateTime | 更新时间 |  |

**关键实现位置**: `packages/shared/prisma/schema.prisma`

#### `prompt_dependencies` 表

| 字段名 | 类型 | 说明 | 关键约束 |
|--------|------|------|----------|
| `parent_id` | String | 父提示词ID | 外键 |
| `child_name` | String | 子提示词名称 |  |
| `child_version` | Int \| null | 按版本号引用 | 与 `child_label` 二选一 |
| `child_label` | String \| null | 按标签引用 | 与 `child_version` 二选一 |

**关键实现位置**: `packages/shared/prisma/schema.prisma`

#### `prompt_protected_labels` 表

| 字段名 | 类型 | 说明 | 关键约束 |
|--------|------|------|----------|
| `project_id` | String | 项目ID |  |
| `label` | String | 受保护标签名 | 项目内唯一 |

**关键实现位置**: `packages/shared/prisma/schema.prisma`

---

## 2. 入口对齐矩阵：三入口核心流程并行对比

### 2.1 创建/改标签/删版本三入口执行顺序对齐

| 执行阶段 | 入口A: 创建新版本 | 入口B: 修改标签 | 入口C: 删除版本 | 关键实现位置 | 关键字段 |
|---------|------------------|----------------|----------------|------------|---------|
| **阶段1: 权限预检** | | | | | |
| 1.1 基础权限校验 | ✅ `scope: prompts:CUD` | ✅ `scope: prompts:CUD` | ✅ `scope: prompts:CUD` | `promptRouter.ts:812` (改标签)<br>`promptRouter.ts:656` (删版本) | `session.user`, `projectId` |
| 1.2 查询目标对象 | ✅ `findFirst` 查最新版本 | ✅ `findUnique` 查待更新 prompt | ✅ `findFirstOrThrow` 查待删版本 | `createPrompt.ts:87-90` (创建)<br>`promptRouter.ts:818` (改标签)<br>`promptRouter.ts:662` (删版本) | `id`, `name`, `version`, `labels` |
| | | | | | |
| **阶段2: 受保护标签检查** | | | | | |
| 2.1 提取待检查标签 | ✅ `finalLabels` (新标签 + latest) | ✅ `removedLabels + addedLabels` | ✅ 待删版本 `labels` | | |
| 2.2 Protected Label 检测 | ❌ **无此步骤** | ✅ `checkHasProtectedLabels()` | ✅ `checkHasProtectedLabels()` | `promptRouter.ts:851` (改标签)<br>`promptRouter.ts:671` (删版本) | `hasProtectedLabels`, `protectedLabels` |
| 2.3 权限提升校验 | ❌ 无 | ✅ 需 `promptProtectedLabels:CUD` | ✅ 需 `promptProtectedLabels:CUD` | `promptRouter.ts:858-865` | |
| | | | | | |
| **阶段3: 依赖保护检查** | | | | | |
| 3.1 依赖扫描范围 | ✅ 新提示词内容内的依赖引用 | ✅ `removedLabels` 关联的依赖 | ✅ 待删版本的 `labels + version` 双重依赖 | | |
| 3.2 依赖图校验 | ✅ `buildAndResolvePromptGraph()` | ❌ **无此步骤** | ❌ 无此步骤 | `createPrompt.ts:121-139` | `promptDependencies` |
| 3.3 SQL 依赖查询 | ❌ 无 | ✅ `$queryRaw` 查 `child_label IN removedLabels` | ✅ `$queryRaw` 查 `child_version` OR `child_label IN labels` | `promptRouter.ts:867-904` (改标签)<br>`promptRouter.ts:687-713` (删版本) | `dependents[]` |
| 3.4 冲突处理 | ✅ 异常回滚 | ✅ 抛出 `CONFLICT` 错误 | ✅ 抛出 `CONFLICT` 错误 | | |
| | | | | | |
| **阶段4: 标签互斥更新** | | | | | |
| 4.1 计算变更集 | ✅ `finalLabels` (完整新标签集) | ✅ `newLabels` (完整新标签集) | ❌ 标签随版本删除 | | |
| 4.2 查找冲突版本 | ✅ `removeLabelsFromPreviousPromptVersions()`<br>查询同名所有版本 labels 交集 | ✅ `findMany({ labels: { hasSome: newLabels } })`<br>排除当前版本 | ❌ 无互斥更新，仅检查 latest 转移 | `updatePromptLabels.ts:17-24`<br>`promptRouter.ts:922-930` | `previousLabeledPrompts[]` |
| 4.3 级联移除标签 | ✅ 旧版本 labels = filter 排除 finalLabels | ✅ 冲突版本 labels = filter 排除 newLabels | ❌ 无 | | |
| 4.4 latest 自动转移 | ✅ 新版本自动获得 `latest` 标签 | ❌ 需用户手动调整 | ✅ 若删除的是 latest，自动转移到次新版本 | `createPrompt.ts:110`<br>`promptRouter.ts:730-750` | `LATEST_PROMPT_LABEL` |
| | | | | | |
| **阶段5: 事务执行** | | | | | |
| 5.1 构建事务数组 | ✅ create + dependency + update旧标签 + Tags批量更新 | ✅ update当前版本 + update冲突版本 | ✅ deleteVersion + (可选)转移latest标签 | | |
| 5.2 原子提交 | ✅ `$transaction` | ✅ `$transaction` | ✅ `$transaction` | | |
| | | | | | |
| **阶段6: 缓存失效** | | | | | |
| 6.1 失效范围 | ✅ Project 级 Epoch 轮转 | ✅ Project 级 Epoch 轮转 | ✅ Project 级 Epoch 轮转 | | |
| 6.2 实现方法 | ✅ `promptService.invalidateCache()` | ✅ `promptService.invalidateCache()` | ✅ `promptService.invalidateCache()` | `PromptService/index.ts:177-190` | `prompt_cache_epoch:{projectId}` |
| | | | | | |
| **阶段7: 事件触发** | | | | | |
| 7.1 受影响版本 | ✅ 新版本 + 所有被移除标签的旧版本 | ✅ 当前版本 + 所有被移除标签的旧版本 | ✅ 被删版本 + 获得 latest 的版本 | | |
| 7.2 Webhook | ✅ `promptChangeEventSourcing()` | ✅ `promptChangeEventSourcing()` | ✅ `promptChangeEventSourcing()` | | |
| 7.3 事件类型 | ✅ 'created' + 'updated' | ✅ 全 'updated' | ✅ 'deleted' + 'updated' | | |

### 2.2 三入口核心差异可视化

```
                    ┌──────────────────────────────────────┐
                    │         依赖保护检查执行时机          │
                    └──────────────────────────────────────┘
                             ▲
                             │
       ┌─────────────────────┼──────────────────────┐
       │                     │                      │
  事务前校验              事务前校验            事务前校验
(创建时仅校验自身)    (仅校验移除的标签)    (校验版本+所有标签)
       │                     │                      │
       ▼                     ▼                      ▼
┌─────────────┐      ┌─────────────┐       ┌─────────────┐
│   CREATE    │      │  SET_LABEL  │       │DELETE_VERSION│
└─────────────┘      └─────────────┘       └─────────────┘
       │                     │                      │
       ▼                     ▼                      ▼
  buildAndResolve       $queryRaw              $queryRaw
  (递归解析所有)       (仅 child_label)     (child_version+label)
       │                     │                      │
       └─────────────────────┼──────────────────────┘
                             │
                             ▼
                    ┌────────────────────┐
                    │  标签互斥更新逻辑  │
                    └────────────────────┘
                             ▲
                             │
       ┌─────────────────────┼──────────────────────┐
       │                     │                      │
       ▼                     ▼                      ▼
  扫描所有旧版本        扫描所有旧版本        仅扫描是否是latest
  移除finalLabels中       移除newLabels中          转移latest
  的所有标签               的所有标签               到次新版本
```

---

## 3. 时序一：创建写入流程

### 3.1 完整时序图

```
前端 (CreatePromptForm)
    │
    ▼ 1. 提交创建请求 (name, prompt, labels, tags, ...)
tRPC Router (prompts.create)
    │
    ▼ 2. 权限检查 (scope: prompts:CUD)
createPrompt Action
    │
    ├─▶ 3. 查询最新版本
    │       prisma.prompt.findFirst({ orderBy: version desc })
    │       【实现位置】 createPrompt.ts:87-90
    │       【关键字段】 name, projectId, version, labels, type
    │
    ├─▶ 4. 类型一致性校验
    │       (latestPrompt.type !== type) → 抛出异常
    │       【实现位置】 createPrompt.ts:92-96
    │
    ├─▶ 5. 生成 finalLabels
    │       labels + LATEST_PROMPT_LABEL (自动添加 'latest')
    │       【实现位置】 createPrompt.ts:110
    │       【关键字段】 finalLabels, LATEST_PROMPT_LABEL
    │
    ├─▶ 6. 生成 finalTags
    │       tags ?? latestPrompt?.tags ?? [] → 去重
    │       【实现位置】 createPrompt.ts:113
    │       【关键字段】 finalTags
    │
    ├─▶ 7. 解析依赖标签
    │       parsePromptDependencyTags(prompt)
    │       → 提取 @@@langfusePrompt:name=X|label=Y@@@
    │       【实现位置】 parsePromptDependencyTags.ts (完整文件)
    │       【关键字段】 promptDependencies[], child_name, child_label
    │
    ├─▶ 8. 构建并验证依赖图
    │       promptService.buildAndResolvePromptGraph()
    │       ├─ 循环依赖检测
    │       └─ 最大嵌套深度检测 (MAX_PROMPT_NESTING_DEPTH = 5)
    │       【实现位置】 PromptService/index.ts:234-350
    │
    ├─▶ 9. 准备事务操作数组
    │       ├─ prisma.prompt.create()
    │       ├─ prisma.promptDependency.create() × N
    │       ├─ removeLabelsFromPreviousPromptVersions()
    │       │   └─ 查询并移除旧版本的相同 label
    │       │      【实现位置】 updatePromptLabels.ts:3-42
    │       │      【关键字段】 touchedPromptIds[]
    │       └─ updatePromptTagsOnAllVersions() (如有变更)
    │           └─ 更新所有同名提示词版本的 tags
    │              【实现位置】 updatePromptTags.ts:3-35
    │
    ├─▶ 10. 执行数据库事务
    │       prisma.$transaction(create)
    │       【实现位置】 createPrompt.ts:203
    │
    ├─▶ 11. 缓存失效
    │       promptService.invalidateCache({ projectId })
    │       → 轮转 epoch token
    │       【实现位置】 PromptService/index.ts:177-190
    │       【关键字段】 prompt_cache_epoch:{projectId}
    │
    └─▶ 12. 触发 Webhook 事件
            promptChangeEventSourcing()
            → 'created' 事件
            → 'updated' 事件（受影响的旧版本）
            【实现位置】 createPrompt.ts:218-231
```

### 3.2 核心数据流转

```
输入参数
  ├─ name: "my-prompt"
  ├─ prompt: "Hello {{user}}, @@@langfusePrompt:name=greeting|label=production@@@"
  ├─ labels: ["production", "staging"]
  └─ tags: ["customer-support", "v2"]

中间处理
  ├─ finalLabels: ["production", "staging", "latest"]  ← 自动添加 latest
  ├─ finalTags: ["customer-support", "v2"]             ← 继承或使用新值
  └─ promptDependencies:
       └─ { name: "greeting", type: "label", label: "production" }

数据库写入
  ├─ prompts 表新记录
  │   ├─ labels: ["production", "staging", "latest"]
  │   └─ tags: ["customer-support", "v2"]
  ├─ prompt_dependencies 表记录
  │   └─ childLabel: "production"
  ├─ 旧版本的 labels 字段（移除 "production", "staging", "latest"）
  └─ 所有版本的 tags 字段统一更新为 ["customer-support", "v2"]
```

---

## 4. 时序二：标签互斥更新流程

### 4.1 完整时序图

```
前端 (SetPromptVersionLabels)
    │
    ▼ 1. 用户选择新标签集
    │    selectedLabels = ["production", "canary"]
    │    【实现位置】 SetPromptVersionLabels/index.tsx:84-90
    │
    ▼ 2. 提交 setLabels mutation
tRPC Router (prompts.setLabels)
    │
    ├─▶ 3. 权限检查 (scope: prompts:CUD)
    │       【实现位置】 promptRouter.ts:812
    │
    ├─▶ 4. 查找待更新提示词
    │       prisma.prompt.findUnique({ id: promptId })
    │       【实现位置】 promptRouter.ts:818-830
    │       【关键字段】 id, name, labels
    │
    ├─▶ 5. 计算标签变更
    │       ├─ removedLabels = 旧标签 - 新标签
    │       └─ addedLabels = 新标签 - 旧标签
    │       【实现位置】 promptRouter.ts:836-848
    │       【关键字段】 removedLabels[], addedLabels[]
    │
    ├─▶ 6. 受保护标签权限检查
    │       checkHasProtectedLabels()
    │       └─ 如涉及 protected label，需 scope: promptProtectedLabels:CUD
    │       【实现位置】 promptRouter.ts:850-865
    │       【关键字段】 hasProtectedLabels, protectedLabels[]
    │
    ├─▶ 7. 依赖保护检查（移除标签时）
    │       IF removedLabels.length > 0:
    │           查询 prompt_dependencies 表
    │           WHERE child_label IN removedLabels
    │           → 如有依赖，抛出 CONFLICT 错误
    │       【实现位置】 promptRouter.ts:867-904
    │       【关键字段】 dependents[], parent_name, parent_version
    │
    ├─▶ 8. 查找已有相同标签的旧版本
    │       prisma.prompt.findMany({
    │         where: { name, labels: { hasSome: newLabels }, id: { not: promptId } }
    │       })
    │       【实现位置】 promptRouter.ts:922-930
    │       【关键字段】 previousLabeledPrompts[]
    │
    ├─▶ 9. 准备事务操作数组
    │       ├─ 更新当前版本 labels
    │       └─ 从旧版本中移除相同标签
    │           prevPrompt.labels.filter(l => !newLabels.includes(l))
    │       【实现位置】 promptRouter.ts:934-959
    │
    ├─▶ 10. 执行数据库事务
    │       prisma.$transaction(toBeExecuted)
    │       【实现位置】 promptRouter.ts:964
    │
    ├─▶ 11. 缓存失效
    │       promptService.invalidateCache({ projectId })
    │       【实现位置】 promptRouter.ts:966
    │       【关键字段】 prompt_cache_epoch:{projectId}
    │
    └─▶ 12. 触发 Webhook 事件（所有受影响版本）
            promptChangeEventSourcing(prompt, "updated")
            【实现位置】 promptRouter.ts:977-989
```

### 4.2 标签互斥机制详解

```
场景：将 'production' 标签从 v2 转移到 v3

初始状态
  ├─ v2: labels = ["production", "latest"]
  └─ v3: labels = ["staging"]

步骤 1: 用户选择 v3 的新标签
  newLabels = ["production", "staging"]

步骤 2: 计算变更
  ├─ removedLabels (v3): []  ← v3 没有被移除的标签
  └─ addedLabels (v3): ["production"]

步骤 3: 查询已有相同标签的版本
  previousLabeledPrompts = [v2]  ← v2 有 "production"

步骤 4: 构建事务
  ├─ 更新 v3: labels = ["production", "staging"]
  └─ 更新 v2: labels = v2.labels.filter(l => !["production", "staging"].includes(l))
              = ["latest"]  ← "production" 被移除

最终状态
  ├─ v2: labels = ["latest"]
  └─ v3: labels = ["production", "staging"]
```

---

## 5. 时序三：删除版本流程

### 5.1 完整时序图

```
前端 (DeletePromptVersionButton)
    │
    ▼ 1. 确认删除版本
tRPC Router (prompts.deleteVersion)
    │
    ├─▶ 2. 权限检查 (scope: prompts:CUD)
    │       【实现位置】 promptRouter.ts:656-660
    │
    ├─▶ 3. 查找待删除版本
    │       prisma.prompt.findFirstOrThrow({ id: promptVersionId })
    │       【实现位置】 promptRouter.ts:662-667
    │       【关键字段】 name, version, labels
    │
    ├─▶ 4. 受保护标签检查
    │       checkHasProtectedLabels(labels)
    │       → 需 scope: promptProtectedLabels:CUD
    │       【实现位置】 promptRouter.ts:671-685
    │
    ├─▶ 5. 依赖保护检查
    │       查询 prompt_dependencies WHERE
    │         child_name = promptName
    │         AND (child_version = version OR child_label IN labels)
    │       → 如有依赖，抛出 CONFLICT 错误
    │       【实现位置】 promptRouter.ts:687-727
    │       【关键字段】 dependents[]
    │
    ├─▶ 6. 审计日志
    │       auditLog(action: "delete")
    │
    ├─▶ 7. 检查是否需要转移 latest 标签
    │       IF labels.includes(LATEST_PROMPT_LABEL):
    │           查询次新版本 (orderBy: version desc)
    │           → 自动将 latest 转移到次新版本
    │       【实现位置】 promptRouter.ts:730-750
    │       【关键字段】 LATEST_PROMPT_LABEL
    │
    ├─▶ 8. 执行事务：删除版本 + (可选)转移 latest 标签
    │
    ├─▶ 9. 缓存失效
    │       promptService.invalidateCache({ projectId })
    │
    └─▶ 10. 触发 Webhook 事件
            → 'deleted' 事件 (被删版本)
            → 'updated' 事件 (获得 latest 的新版本)
```

---

## 6. 时序四：按版本/标签查询与回源链路

### 6.1 完整时序图（含缓存命中与回源路径）

```
SDK / API 调用者
    │
    ▼ 1. getPrompt(name, label="production")
    │    OR getPrompt(name, version=3)
PromptService.getPrompt()
    │
    ├─▶ 2. 缓存键生成
    │       ├─ 获取当前 Epoch Token
    │       │   redis.get("prompt_cache_epoch:{projectId}")
    │       │   → 不存在则创建新 Epoch
    │       │   【实现位置】 PromptService/index.ts:219-232
    │       │
    │       └─ 构建缓存键
    │           prompt:{projectId}:{epoch}:{promptName}:{version|label}
    │           【实现位置】 PromptService/index.ts:192-199
    │
    ├─▶ 3. 尝试读取缓存
    │       redis.get(key)
    │       【实现位置】 PromptService/index.ts:147-162
    │       │
    │       ├─ 命中缓存 → 直接返回
    │       │      │
    │       │      └─▶ [路径A] 缓存命中
    │       │           跳过数据库查询
    │       │           跳过依赖解析
    │       │           直接返回 JSON.parse(value)
    │       │
    │       └─ 未命中缓存 → 继续回源
    │
    ├─▶ 4. 数据库回源查询
    │       IF version:
    │           prisma.prompt.findFirst({
    │             where: { projectId, name, version }
    │           })
    │           【实现位置】 PromptService/index.ts:103-110
    │
    │       IF label:
    │           prisma.prompt.findFirst({
    │             where: {
    │               projectId,
    │               name,
    │               labels: { has: label }  ← PostgreSQL array contains
    │             }
    │           })
    │           【实现位置】 PromptService/index.ts:113-123
    │
    ├─▶ 5. 解析依赖图（如需 resolve=true）
    │       promptService.resolvePrompt(prompt)
    │       └─ 递归替换所有 @@@langfusePrompt@@@ 引用
    │       【实现位置】 PromptService/index.ts:130-145
    │
    ├─▶ 6. 写入缓存（如启用）
    │       redis.set(key, JSON.stringify(result), "EX", ttlSeconds)
    │       【实现位置】 PromptService/index.ts:164-175
    │
    └─▶ 7. 返回结果
```

### 6.2 缓存失效前后的路径切换对比

| 阶段 | 缓存键结构 | 数据来源 | 路径标识 | 触发条件 |
|------|-----------|----------|---------|---------|
| **缓存失效前 (Epoch = abc123)** | | | | |
| 首次查询 | `prompt:proj:abc123:my-prompt:production` | 数据库 → 写入缓存 | 🔴 回源路径 | 首次访问 / 缓存过期 |
| 二次查询 | `prompt:proj:abc123:my-prompt:production` | Redis 缓存命中 | 🟢 命中路径 | 缓存有效 |
| N次查询 | `prompt:proj:abc123:my-prompt:production` | Redis 缓存命中 | 🟢 命中路径 | 缓存有效 |
| | | | | |
| **缓存失效事件触发 (Epoch 轮转 → xyz789)** | | | | |
| 失效后首次查询 | `prompt:proj:xyz789:my-prompt:production` | 数据库 → 写入新缓存 | 🔴 回源路径 | Epoch Token 变更 |
| 失效后二次查询 | `prompt:proj:xyz789:my-prompt:production` | Redis 缓存命中 | 🟢 命中路径 | 新缓存建立 |
| | | | | |
| **旧缓存自然消亡** | | | | |
| 旧键仍存在 | `prompt:proj:abc123:my-prompt:production` | 永不被访问 (无引用) | ⚫ 死路径 | 等待 TTL 过期自动清理 |

### 6.3 缓存键结构详解

```
Redis Key 命名空间层级:

prompt_cache_epoch:{projectId}          ← 全局同步点, 所有缓存的根 (String)
    │
    └─ Epoch Token: "abc123XyZ" (8 chars, base64url)
         │
         ▼
prompt:{projectId}:{epoch}:{promptName}:{version}    ← 按版本查询的缓存键
prompt:{projectId}:{epoch}:{promptName}:{label}      ← 按标签查询的缓存键
    │          │         │          │           │
    │          │         │          │           └── 查询维度 (version 或 label)
    │          │         │          │
    │          │         │          └────────────── 提示词名称
    │          │         │
    │          │         └───────────────────────── Epoch Token (轮转核心)
    │          │
    │          └─────────────────────────────────── 项目ID
    │
    └────────────────────────────────────────────── 命名空间前缀
```

---

## 7. 时序五：前端展示映射与缓存失效切换

### 7.1 完整时序图

```
用户访问 /prompts/{promptName}
    │
    ├─▶ 1. URL 参数解析
    │    version? / label?
    │    【实现位置】 prompt-detail.tsx:121-128
    │
PromptDetail 组件
    │
    ├─▶ 2. 加载所有版本数据 (tRPC Query)
    │       api.prompts.allVersions.useQuery({ name: promptName })
    │       【实现位置】 prompt-detail.tsx:148
    │       ├─ 命中 tRPC 前端缓存 → 立即展示
    │       └─ 未命中 → 后端回源
    │
    ├─▶ 3. 根据 URL 参数选择当前版本
    │       IF currentPromptVersion:
    │           prompt = promptVersions.find(v => v.version === currentPromptVersion)
    │
    │       ELSE IF currentPromptLabel:
    │           prompt = promptVersions.find(v => v.labels.includes(currentPromptLabel))
    │
    │       ELSE:
    │           prompt = promptVersions[0]  ← 默认第一个（最新）
    │       【实现位置】 prompt-detail.tsx:155-163
    │
    ├─▶ 4. Labels 展示组件
    │       <SetPromptVersionLabels
    │         promptLabels={prompt.labels}
    │         prompt={prompt}
    │       />
    │       ├─ 加载项目内所有已使用的标签
    │       │   api.prompts.allLabels.useQuery()
    │       │   【实现位置】 SetPromptVersionLabels/index.tsx:62-67
    │       ├─ 检测 production 晋升/降级
    │       │   isPromotingToProduction / isDemotingFromProduction
    │       │   【实现位置】 SetPromptVersionLabels/index.tsx:84-90
    │       └─ 标签选择器 UI
    │
    ├─▶ 5. Tags 展示组件
    │       <TagPromptDetailsPopover
    │         tags={prompt.tags}
    │         availableTags={allTags}
    │         promptName={promptName}
    │       />
    │       └─ TagManager 组件（通用标签管理）
    │          【实现位置】 TagPromptDetailsPopover.tsx:16-89
    │
    └─▶ 6. 代码示例生成
            getPythonCode(name, version, labels)
            getJsCode(name, version, labels)
            【实现位置】 prompt-detail.tsx:69-107
```

### 7.2 前端缓存失效与回源切换机制

```
操作触发标签变更
    │
    ▼ 1. 调用 setLabels mutation
    │
    ├─▶ 2. 后端执行 → Epoch 轮转 → Webhook
    │
    ├─▶ 3. tRPC Query Invalidation
    │       utils.prompts.allVersions.invalidate()
    │       ├─ 标记前端缓存为 STALE
    │       └─ 触发后台重新 fetch
    │
    ├─▶ 4. 前端重新拉取数据
    │       ├─ 路径A：仍使用旧 Epoch 查询 Redis
    │       │       → 命中旧缓存 (数据不一致, 窗口短暂)
    │       │       → 但 tRPC 已标记需重新验证
    │       │
    │       └─ 路径B：后端查询已使用新 Epoch
    │               → Redis 未命中新键
    │               → 回源数据库
    │               → 写入新 Epoch 缓存
    │               → 返回最新数据到前端
    │
    └─▶ 5. 前端重新渲染
            → 展示更新后的 labels
            → 更新版本选择器中的标签标记
```

---

## 8. 缓存失效触发点与回源路径矩阵

### 8.1 所有缓存失效触发点汇总

| 触发场景 | 触发位置 | 调用链 | 影响范围 | 回源触发时机 | 前端表现 |
|----------|----------|--------|---------|------------|---------|
| **创建新提示词版本** | `createPrompt.ts:209` | `createPrompt` → `invalidateCache` | 整个 project | 下一次查询使用新 Epoch → 回源 | 页面刷新/重新拉取 |
| **更新 Labels** | `promptRouter.ts:966` | `setLabels` mutation → `invalidateCache` | 整个 project | 同上 | 立即 invalidate tRPC 缓存 + 后台重拉 |
| **更新 Tags** | - | 不调用 `invalidateCache`, 仅前端 API 缓存失效 | 仅前端 tRPC 缓存 | 无 Redis 回源, 仅前端乐观更新 | 立即更新 UI, 失败回滚 |
| **删除提示词版本** | `promptRouter.ts:637` | `deleteVersion` → `invalidateCache` | 整个 project | 同上 | 页面重新拉取版本列表 |
| **删除整个提示词** | `promptRouter.ts:556` | `deletePrompt` → `invalidateCache` | 整个 project | 同上 | 跳转回列表页 |
| **更新受保护标签** | `promptRouter.ts:1428` | `updateProtectedLabel` → `invalidateCache` | 整个 project | 同上 | 重新拉取 protected labels |
| **删除受保护标签** | `promptRouter.ts:1474` | `deleteProtectedLabel` → `invalidateCache` | 整个 project | 同上 | 重新拉取 protected labels |

### 8.2 缓存失效策略设计考量

**优点**:
1.  **原子性**: 单个 Redis SET 操作, 无竞态条件
2.  **高性能**: O(1) 操作, 无需遍历删除
3.  **一致性**: 所有提示词同时失效, 避免依赖不一致
4.  **容错性**: 旧缓存仍可读取 (直到 TTL 过期), 故障降级

**缺点**:
1.  **过度失效**: 单个提示词变更导致整个 project 所有缓存失效
2.  **缓存膨胀**: 旧 key 在 TTL 过期前仍占用内存
3.  **不可控**: 无法精确控制单个提示词失效

**设计权衡说明**:
> 选择 project 级 epoch 轮转而非精确到单个 prompt, 是因为 **提示词依赖关系**。
> 当 prompt A 依赖 prompt B 时, B 的变更需要同时使 A 的缓存失效。
> 由于依赖关系可能跨多个 prompt, 精确追踪失效范围复杂度高。
> 采用 project 级失效是简单且可靠的折衷方案。

---

## 9. Labels 与 Tags 处理差异对比

### 9.1 核心差异对比表

| 维度 | Labels (版本标记) | Tags (分类标签) |
|------|-------------------|-----------------|
| **作用域** | 特定版本独有, 版本间互斥 | 跨所有版本共享, 全局一致 |
| **唯一性约束** | 同一 `name` 下, 一个 label 只能分配给一个版本 | 无约束, 所有版本相同 |
| **更新粒度** | 单个版本更新 | 更新时同步所有同名版本 |
| **数据库操作** | 原子事务 + 级联更新旧版本 | 批量更新所有版本 |
| **缓存影响** | 变更触发 project 级缓存失效 (Redis Epoch 轮转) | 仅前端 tRPC 缓存失效, 不影响 Redis |
| **前端组件** | `SetPromptVersionLabels` (专用组件) | `TagPromptDetailsPopover` (通用 TagManager) |
| **URL 导航** | 支持 `?label=production` 直接定位 | 不支持 URL 直接导航 |
| **受保护机制** | 有 `prompt_protected_labels` 表 | 无特殊保护 |
| **依赖引用** | 可作为 `prompt_dependencies.child_label` 被引用 | 不能被依赖引用 |
| **保留标签** | `latest` 自动分配给新版本 | 无保留标签 |
| **权限 scope** | `prompts:CUD` / `promptProtectedLabels:CUD` | `objects:tag` |
| **API 查询** | 支持按 label 查询 `getPrompt(name, label=X)` | 仅用于过滤, 不用于精确查询 |

---

## 10. 异常分支处理汇总

### 10.1 创建流程异常分支

| 异常场景 | 检测位置 | 错误类型 | 处理方式 |
|----------|----------|----------|----------|
| 版本类型不一致 | `createPrompt.ts:92-96` | `InvalidRequestError` | 直接抛出 |
| Chat 变量与占位符冲突 | `createPrompt.ts:99-108` | `InvalidRequestError` | 直接抛出 |
| 依赖解析失败 | `createPrompt.ts:121-139` | `InvalidRequestError` | 捕获 buildAndResolvePromptGraph 错误并抛出 |
| 数据库事务失败 | `createPrompt.ts:203` | Prisma Error | 由框架捕获, 回滚事务 |
| 缓存失效失败 | `createPrompt.ts:209` | Redis Error | 静默失败, 仅日志记录, 不中断流程 |
| Webhook 发送失败 | `createPrompt.ts:218-231` | - | Promise.all 不 await, 静默失败 |

### 10.2 Labels 更新异常分支

| 异常场景 | 检测位置 | 错误类型 | 处理方式 |
|----------|----------|----------|----------|
| 提示词不存在 | `promptRouter.ts:825-830` | `TRPCError.NOT_FOUND` | 直接抛出 |
| 受保护标签权限不足 | `promptRouter.ts:858-865` | `TRPCError.FORBIDDEN` | 直接抛出, 附带 protected labels 列表 |
| 标签被其他提示词依赖 | `promptRouter.ts:867-904` | `TRPCError.CONFLICT` | 查询依赖关系, 返回所有依赖方详情 |
| 数据库事务失败 | `promptRouter.ts:964` | Prisma Error | 框架捕获回滚 |
| 缓存失效失败 | `promptRouter.ts:966` | Redis Error | 静默失败 |

### 10.3 查询流程异常分支

| 异常场景 | 检测位置 | 处理方式 |
|----------|----------|----------|
| Redis 连接失败 | `PromptService.getCachedPrompt` | try-catch 捕获, fallback 到数据库查询 |
| 缓存 JSON 解析失败 | `PromptService.getCachedPrompt` | 解析失败视为缓存未命中, 查询数据库 |
| 循环依赖 | `PromptService.buildAndResolvePromptGraph` | 抛出 `Error`, 由上层捕获 |
| 超过最大嵌套深度 | `PromptService.buildAndResolvePromptGraph` | 抛出 `Error`, 由上层捕获 |
| 按 label 查询无结果 | `PromptService.findPrompt` | 返回 `null`, 由调用方处理 |

---

## 11. 架构设计总结

### 11.1 核心设计原则

1.  **原子性优先**: 所有涉及标签互斥的操作通过数据库事务保证一致性
2.  **依赖保护**: 删除标签/版本前强制检查依赖关系, 防止静默破坏
3.  **权限分层**: 普通标签与受保护标签使用不同 scope, 实现精细化控制
4.  **缓存妥协**: 接受 project 级过度失效, 换取实现简单与依赖一致性
5.  **向后兼容**: 同时支持 version 和 label 两种引用方式, 平滑过渡

### 11.2 关键设计模式

| 模式 | 应用场景 | 核心特征 |
|------|----------|---------|
| **Epoch Token 轮转** | Redis 缓存失效 | 版本化命名空间, 无需删除, 自然过期 |
| **数据库事务** | 标签互斥转移 | 全有或全无, 保证标签唯一性约束 |
| **乐观更新** | 前端 Tags 更新 | 先更 UI, 失败回滚, 提升体验 |
| **依赖图遍历** | 提示词内容递归解析 | DFS + 循环检测 + 深度限制 |
| **权限守卫** | tRPC procedure 前置校验 | 分层 scope, 提前拦截 |

### 11.3 三入口设计决策回顾

| 设计决策 | 创建新版本 | 修改标签 | 删除版本 | 背后原因 |
|----------|-----------|---------|---------|---------|
| **受保护标签检查** | ❌ 跳过 | ✅ 必须检查 | ✅ 必须检查 | 创建时新标签不可能已有保护状态 |
| **依赖保护机制** | ✅ 依赖图递归解析 | ✅ SQL 查 removedLabels | ✅ SQL 查版本+标签 | 创建需校验整个内容, 改/删仅校验被移除对象 |
| **标签互斥范围** | ✅ 所有同名版本 | ✅ 所有同名版本 | ❌ 仅 latest 转移 | 版本删除不影响其他标签归属 |
| **最新标签自动转移** | ✅ 自动获得 latest | ❌ 用户手动 | ✅ 删除时自动转移 | latest 语义是 "最新存在的版本" |

### 11.4 代码质量评估

| 评估项 | 评分 | 说明 |
|--------|------|------|
| 事务完整性 | ⭐⭐⭐⭐⭐ | 所有标签变更均通过事务保证原子性 |
| 错误处理 | ⭐⭐⭐⭐ | 后端处理全面, 前端部分场景可改进 |
| 权限控制 | ⭐⭐⭐⭐⭐ | 分层细致, protected label 机制完善 |
| 缓存策略 | ⭐⭐⭐⭐ | Epoch 轮转可靠, 但粒度较粗 (project 级) |
| 代码复用 | ⭐⭐⭐ | Tags 复用通用组件, Labels 为专用实现 |
| 测试覆盖 | ⭐⭐⭐ | 需补充更多边缘场景测试 |
| 一致性保障 | ⭐⭐⭐⭐⭐ | 互斥更新 + 依赖保护 + 缓存失效, 三层防护 |
