# Project 删除流程梳理

本文从代码实现角度梳理 **删除一个 Project 时，哪些数据会被清掉、哪些会保留**，以及
删除入口、级联范围、与后台任务的衔接关系。所有结论均以仓库当下的实现为准。

## 1. 删除入口

Project 的删除有 **三个** 入口，它们走的是同一套「先软删、再异步真正清理」的流程：

| 入口 | 位置 | 适用场景 |
| --- | --- | --- |
| tRPC `projects.delete` | `web/src/features/projects/server/projectsRouter.ts:159` | UI 上用户在「项目设置」里点 Delete |
| Admin API `handleDeleteProject` | `web/src/ee/features/admin-api/server/projects/projectById/index.ts:115` | 企业版管理后台直接删项目 |
| 软删后的项目还可以被 Org 删除拦住 | `web/src/features/organizations/server/organizationRouter.ts:178` | 删除 Org 之前必须先删掉 / 软删完所有 Project |

前两个入口做的事情基本一致：

1. 检查 RBAC 权限（`project:delete` 作用域）。
2. **立即**从 Redis 缓存里失效掉该 Project 下所有 API key（`ApiAuthService.invalidateCachedProjectApiKeys`），
   防止在真正删除之前 key 还被用到。
3. **立即**从 Postgres 里把 `scope = PROJECT` 的 API key 删掉
   (`prisma.apiKey.deleteMany({ where: { projectId, scope: "PROJECT" } })`)。
   注意：`ORGANIZATION` 作用域的 key 不删，它们不属于任何单个项目。
4. 只把 Project 本身 **软删**：`prisma.project.update({ where: { id, orgId }, data: { deletedAt: new Date() } })`。
   这是 `Project.deletedAt` 这个字段存在的意义——在整个系统里它是 **唯一被做成软删的模型**
   (schema.prisma 中只有 `Project` 有 `deletedAt` 列)。
5. 写一条审计日志（`resourceType = "project", action = "delete"`）。
6. 往 `QueueName.ProjectDelete` (BullMQ) 队列里塞一个 `{ projectId, orgId }` 的 Job，
   由 worker 异步执行真正的级联清理。

> 这也是为什么 UI / API 返回给用户「删除成功」时，Postgres 里 `projects` 行只是 `deletedAt` 被打上了时间戳，
> 真正的数据清理要等 worker 消费完 ProjectDelete 任务才算完成。

### Org 删除的前置校验

`organizations.delete` (organizationRouter.ts:178) 在真正删 Org 之前会 **二次校验**：

- 要求 `countNonDeletedProjects == 0`：不允许在还有活跃 Project 的情况下删 Org。
- 要求 `countAllProjects == 0`：即所有 Project 必须已经走到「`ProjectDelete` 任务消费完毕、
  PG 行真的被 `prisma.project.delete(...)` 删掉」那一步，软删但还残留的也不被允许。

换句话说：**要删 Org，必须先完成 Project 的整条删除链路**。

## 2. 异步清理（ProjectDelete 队列处理器）

队列名：`QueueName.ProjectDelete = "project-drop"`（`packages/shared/src/server/queues.ts:325`）
处理器：`worker/src/queues/projectDelete.ts:21` —— `projectDeleteProcessor`
注册：`worker/src/app.ts:218`
开关：`QUEUE_CONSUMER_PROJECT_DELETE_QUEUE_IS_ENABLED`
限流：`LANGFUSE_PROJECT_DELETE_CONCURRENCY` / `LANGFUSE_CLICKHOUSE_PROJECT_DELETION_CONCURRENCY_DURATION_MS`

处理器里按顺序做 4 件事，**任何一步都可能超时 / OOM**，所以下面第 3 节里的
三个 `Batch*Cleaner` 是它的补偿层。

### 步骤 A：S3 媒体

- 仅当 `LANGFUSE_S3_MEDIA_UPLOAD_BUCKET` 配置了才做。
- `findAllMediaByProjectId({ projectId })`（`packages/shared/src/server/media-deletion.ts:15`）
  查出 `media` 表里所有 PG 行。
- `deleteMediaFiles(...)`（同文件 :51）按 10,000 一批：
  1. 调 S3 `deleteFiles` 删对象；
  2. `prisma.media.deleteMany({ where: { id: { in: ... }, projectId } })` 删 PG 行。
  先删 S3 再删 PG，是为了避免 PG 成功、S3 失败时留下孤儿对象；重试可幂等。

> 注意这里只清了 `Media` 表。`TraceMedia`、`ObservationMedia` 这些 PG 表的清理
> 走的是 **步骤 D 的 Prisma 级联**（它们在 schema 里 `onDelete: Cascade`）。
> 它们指向的 S3 对象路径在 `Media.bucketPath` 里，所以 S3 这一步覆盖了。

### 步骤 B：ClickHouse 主数据（并行删 5~6 张表）

用 `Promise.all` 并行执行以下仓库函数（全在 `packages/shared/src/server/repositories/*`）：

| 函数 | 目标表 | 开关 / 备注 |
| --- | --- | --- |
| `deleteTracesByProjectId(projectId)` | `traces` | 总是执行，内部先用 `hasAnyTrace` 探测 |
| `deleteObservationsByProjectId(projectId)` | `observations` | 总是执行 |
| `deleteScoresByProjectId(projectId)` | `scores` | 总是执行 |
| `deleteEventsByProjectId(projectId)` | `events_full` / `events_core` | 仅当 `LANGFUSE_EXPERIMENT_INSERT_INTO_EVENTS_TABLE === "true"` |
| `removeIngestionEventsFromS3AndDeleteClickhouseRefsForProject(projectId, undefined)` | `blob_storage_file_log` + S3 ingestion 归档 | 仅当 `LANGFUSE_ENABLE_BLOB_STORAGE_FILE_LOG === "true"`，内部按 500 一批软删 |

执行模式：每一个函数都先发一个 `SELECT 1 ... WHERE project_id = ? LIMIT 1`
(`hasAnyTrace` 类) 确认还有数据，再发一个同步 `DELETE FROM <table> WHERE project_id = ?`。
`request_timeout` 取 `LANGFUSE_CLICKHOUSE_DELETION_TIMEOUT_MS`。

### 步骤 C：Dataset Run Items

`deleteDatasetRunItemsByProjectId(projectId)` 单独 `await`，清 ClickHouse 里的
`dataset_run_items_rmt` 表。

之所以不跟 B 放在一起，是因为这条 DELETE 走的是 **ReplacingMergeTree**
路径（表名带 `_rmt`），跟主表的存储策略不同，并且它也被 Dataset 自己的删除路径复用。

### 步骤 D：Postgres 级联删除（整个 Project 的「真删」）

```ts
prisma.project.delete({ where: { id: projectId, orgId } })
```

这一步借助 Prisma 在 schema 里对 `Project` 所有子模型声明的 `onDelete`，
由 Postgres 的外键约束负责清理。

#### 会被 Cascade 删掉的 PG 表

（从 `packages/shared/prisma/schema.prisma` 中所有带 `@relation(... onDelete: Cascade)`
且指向 `Project` 的模型反推出来，顺序按 schema 里出现的位置）：

- 鉴权 / 成员：`ApiKey` (仅 project 作用域；ORG 作用域因为 `projectId` 是可空，不在级联里)、
  `ProjectMembership`、`LlmApiKeys`
- 观测 / 分析：`TraceSession`、`LegacyPrismaTrace`、`LegacyPrismaObservation`、
  `LegacyPrismaScore`、`ScoreConfig`
- 注释 / 标注队列：`Comment`、`CommentReaction`、`AnnotationQueue`、
  `AnnotationQueueItem`、`AnnotationQueueAssignment`
- Dataset：`Dataset`、`DatasetItem`、`DatasetRuns`
- Prompt / Eval：`Prompt`、`PromptDependency`、`PromptProtectedLabels`、
  `LlmSchema`、`LlmTool`、`EvalTemplate`、`JobConfiguration`、`JobExecution`
- 模型与定价：`Model`、`Price`、`DefaultLlmModel`
- 集成 / 自动化：`PosthogIntegration`、`MixpanelIntegration`、
  `BlobStorageIntegration`、`SlackIntegration`、`BatchExport`、`BatchAction`、
  `Trigger`、`Action`、`Automation`、`AutomationExecution`
- 看板：`Dashboard`、`DashboardWidget`、`TableViewPreset`、`DefaultView`
- 媒体 / 通知：`Media`、`TraceMedia`、`ObservationMedia`、`NotificationPreference`
- 杂项：`PendingDeletion`

#### 会被 SetNull（保留）而不是删掉的 PG 表

- `MembershipInvitation.project` (schema.prisma:285) —— Project 删了，
  邀请函上的 `projectId` 被置 NULL，Org 级别的邀请依然有效。
- `LegacyPrismaScore.scoreConfig` (schema.prisma:447) —— ScoreConfig 本身在上面的 Cascade 里被删掉，
  但如果 Score 行被保留时它的 `configId` 会被置空（这个路径在 Project 删除时不会触发，
  因为 Score 自己也 Cascade 掉了）。

#### 明确**不在** Project 级联里的表

这些表虽然有和 Project 相关的列，但没有外键 `onDelete`，或者引用方向相反：

- `Organization` 本身（Project 属于 Org，但 Org 有自己的删除流程，见上）。
- `User`（ProjectMembership、AnnotationQueueItem 的 `user` 是 `onDelete: Cascade`，
  但 `User` 表本身不动）。
- `AuditLog`：它用 `resourceType + resourceId` 引用 Project，**不是外键**，
  所以 Project 删掉后 audit log 仍然保留（合规需求）。
- `CronJobs` / `BackgroundMigration`：全局表，不关联项目。
- ClickHouse 中所有表：CH 没有外键，所以 PG 这一步不碰 CH，必须靠步骤 B/C 手动删。
- Blob Storage 的 S3 导出文件：`removeIngestionEventsFromS3AndDeleteClickhouseRefsForProject`
  会清 `blob_storage_file_log` 表里对应的 CH 行，但 S3 上已经导出的 Parquet / JSON 文件
  不在这个流程里（它们在导出时就跟 Project 解耦了，走的是 BlobStorageIntegration 自己的保留期）。
- 业务指标 / S3 billing 归档：`s3_ingestion_usage` 之类的 Cloud 侧计量数据在本仓库不涉及。

> 小结：**审计日志、Org 级别的邀请、以及 CH 之外的导出对象是删除 Project 后会残留的数据。**

#### 错误处理

- `P2025` / `P2016`（记录不存在）被当成幂等，打 warn 日志后返回。
- 其它 Prisma 错误重新抛出，让 BullMQ 重试。

## 3. 后台补偿任务（删除链路的兜底）

`ProjectDelete` 是一个**同步执行很多 DELETE** 的 Job，数据量大时会被部署重启、OOM、CH 超时
打断。worker 里因此有 3 个 `PeriodicExclusiveRunner` 形式的后台补偿任务，它们只扫描
**软删了 (`deletedAt IS NOT NULL`) 但还没真删** 的 Project，并且都拿 Redis 分布式锁
防止多副本重复干活。

这些任务的开关与注册都在 `worker/src/app.ts:618` 之后的区段。

### 3.1 `BatchProjectCleaner`（`worker/src/features/batch-project-cleaner/index.ts`）

- 开关：`LANGFUSE_BATCH_PROJECT_CLEANER_ENABLED === "true"`。
- 一个实例负责一张表，表清单：
  `traces, observations, scores, events_full, events_core, dataset_run_items_rmt`
  (`BATCH_DELETION_TABLES` 在同文件 :10)。
  其中 `events_full` / `events_core` 只有在
  `LANGFUSE_EXPERIMENT_INSERT_INTO_EVENTS_TABLE === "true"` 时才会启动对应实例。
- 流程：
  1. `getDeletedProjects(LIMIT)`：从 PG 取 `deletedAt IS NOT NULL` 的 Project（廉价读，不加锁）。
  2. 对每张 CH 表发 `SELECT project_id, count() ... GROUP BY project_id`。
  3. 只对 count > 0 的 Project 发 `DELETE FROM <table> WHERE project_id IN (...)`，
     DELETE 放在 Redis 锁里执行，超时 = `LANGFUSE_BATCH_PROJECT_CLEANER_DELETE_TIMEOUT_MS`。
  4. 失败时再查一次 count，判定「部分成功」并打 `langfuse.batch_project_cleaner.incomplete_cleanups` 指标。
- 关键点：它并不关心 `ProjectDelete` Job 成败，只是不断从 PG 里「有没有软删的 Project」
  这一信号驱动，所以既能兜底失败的 Job，也能加速成功 Job 里那些慢 CH 表的收尾。

### 3.2 `BatchProjectMediaCleaner`（`worker/src/features/batch-project-media-cleaner/index.ts`）

- 开关：`LANGFUSE_BATCH_PROJECT_CLEANER_ENABLED === "true"` 且配置了 `LANGFUSE_S3_MEDIA_UPLOAD_BUCKET`。
- 语义：找出「**还有媒体残留** 的最老的软删 Project」(`getDeletedProjectWithMedia`
  在 `packages/shared/src/server/media-deletion.ts:97`，用 `Media: { some: {} }` + `orderBy: { deletedAt: asc }`)，
  每轮从 S3 和 PG 各删 `LANGFUSE_BATCH_PROJECT_MEDIA_CLEANER_BATCH_SIZE` 条。
- 跟 `ProjectDelete` 步骤 A 的区别：步骤 A 是一次性拉全量 `findAllMediaByProjectId`，
  没 limit；这个是分批啃掉。两者幂等，谁先干都行。

### 3.3 `BatchProjectBlobCleaner`（`worker/src/features/batch-project-blob-cleaner/index.ts`）

- 开关：`LANGFUSE_BATCH_PROJECT_CLEANER_ENABLED === "true"` 且
  `LANGFUSE_ENABLE_BLOB_STORAGE_FILE_LOG === "true"`。
- 语义：从软删 Project 中挑 `blob_storage_file_log` 里还没清的那个
  (用 `countIf(is_deleted = 0) - countIf(is_deleted = 1)` 估算 CH 侧的剩余量)，
  调 `removeIngestionEventsFromS3AndDeleteClickhouseRefsForProject(projectId, undefined)`
  做全量 blob 清理。
- 内部：`removeIngestionEventsFromS3AndDeleteClickhouseRefsForProject` 自身会按 500 一批
  对 `blob_storage_file_log` 做 CH 软删，并在删 CH 前先调 S3 `deleteFiles`。
  中途被打断是安全的——已经软删的行在下一次合并时会真正消失。

### 3.4 这些补偿之间的分工一览

| 任务 | 覆盖范围 | 粒度 |
| --- | --- | --- |
| `ProjectDelete` Job | S3 媒体 + CH 主表 + Dataset run items + PG 级联 | 全量，一次清完 |
| `BatchProjectCleaner` | CH 的 5~6 张主表 | 按表并行，按 Project 批量 DELETE |
| `BatchProjectMediaCleaner` | S3 + PG 里的 `Media` | 选最老 Project，每轮删 `BATCH_SIZE` 条 |
| `BatchProjectBlobCleaner` | `blob_storage_file_log` + S3 ingestion 归档 | 选剩余 blob 最多的 Project，一次清全量 |

## 4. 删除链路的整体时序

```
用户点 Delete / 调 admin API
   │
   ▼
projectsRouter.delete / handleDeleteProject
   ├─ 1. invalidateCachedProjectApiKeys             （Redis）
   ├─ 2. prisma.apiKey.deleteMany(scope=PROJECT)    （PG）
   ├─ 3. prisma.project.update({ deletedAt: now })  （PG，软删）
   ├─ 4. auditLog("project", "delete")
   └─ 5. enqueue ProjectDelete(projectId, orgId)    （BullMQ）

   ▼
worker 消费 ProjectDelete
   ├─ A. S3 + PG Media 全量清理
   ├─ B. CH traces/observations/scores/events*/blob_storage_file_log 并行 DELETE
   ├─ C. CH dataset_run_items_rmt DELETE
   └─ D. prisma.project.delete()                     （PG，真删）
         └─ 依赖 onDelete 级联清掉第 2 节 D 小节列出的所有 PG 子表

   ▲
   │ 兜底：PeriodicExclusiveRunner 后台任务
   │  ├─ BatchProjectCleaner       扫软删 Project，批量清 CH 主表
   │  ├─ BatchProjectMediaCleaner  啃 Media 残留
   │  └─ BatchProjectBlobCleaner   啃 blob_storage_file_log 残留
   │
   ▼
organizations.delete（可选）
   └─ 校验 countAllProjects == 0，否则拒绝删除 Org
```

## 5. 保留 vs. 清理总览

| 数据 / 存储位置 | 删除 Project 后结果 | 原因 |
| --- | --- | --- |
| CH `traces` / `observations` / `scores` | 清理 | `ProjectDelete` 步骤 B + `BatchProjectCleaner` |
| CH `events_full` / `events_core` | 清理（实验开关打开时） | 同上，但受 `LANGFUSE_EXPERIMENT_INSERT_INTO_EVENTS_TABLE` 控制 |
| CH `dataset_run_items_rmt` | 清理 | 步骤 C |
| CH `blob_storage_file_log` | 清理（blob 开关打开时） | 步骤 B 中的 `removeIngestionEventsFromS3AndDeleteClickhouseRefsForProject` + `BatchProjectBlobCleaner` |
| S3 媒体对象 | 清理 | 步骤 A + `BatchProjectMediaCleaner` |
| S3 ingestion 归档对象 | 清理（blob 开关打开时） | 同上 `removeIngestionEventsFromS3AndDeleteClickhouseRefsForProject` |
| S3 已导出的 Blob Storage 导出文件 | **保留** | 不在 Project 级联里；导出时已把项目 ID 固化到对象路径，但删除链路不会反查这些对象 |
| PG `Media` / `TraceMedia` / `ObservationMedia` | 清理 | 步骤 A（Media）+ 步骤 D 级联（另外两张） |
| PG `Project` 及所有子表（清单见 2.D） | 清理 | 步骤 D Prisma Cascade |
| PG `ApiKey` (scope = PROJECT) | 清理 | 入口里就显式删 + 步骤 D Cascade 双保险 |
| PG `ApiKey` (scope = ORGANIZATION) | **保留** | 不归属于单个 Project |
| PG `MembershipInvitation`（projectId 为具体项目） | **SetNull** | `onDelete: SetNull`，Org 级邀请还在 |
| PG `AuditLog` | **保留** | 软关联（`resourceType` + `resourceId` 字符串，不是 FK），审计需求 |
| PG `Organization`、`User`、`CronJobs`、`BackgroundMigration` | **保留** | 与 Project 不存在直接外键依赖或引用方向相反 |
| Redis API key 缓存 | 清理 | 入口立即 `invalidateCachedProjectApiKeys` |

## 6. 容易被忽视的几个设计要点

1. **两步删除（软删 → 真删）**：入口只打 `deletedAt`，真删交给异步任务。
   好处是 UI / API 能快速响应；坏处是 Org 删除、Admin 侧统计等必须同时考虑
   `deletedAt IS NULL` 和 `deletedAt IS NOT NULL` 两种状态（见 `organizations.delete`）。
2. **CH 没有外键**，所有 CH 删除靠业务层显式发 DELETE；`BatchProjectCleaner`
   用「PG 里还有软删 Project」这个信号做兜底，所以一旦 PG 的 `project.delete(...)`
   成功，CH 侧的补偿就失去动力——这要求 `ProjectDelete` 步骤 B/C 必须在步骤 D **之前**完成。
3. **Media 清理是 S3 先行、PG 后删**（`media-deletion.ts:67-75`），防止孤儿 S3 对象；
   但这意味着如果 PG 回滚，S3 已经删了——重试时会幂等。
4. **审计日志不删**，是刻意的合规选择。写审计日志的那一条发生在入口处（软删时），
   指向的 Project 会在步骤 D 被删掉，但日志行本身保留，`resourceId` 变成悬空字符串。
5. **环境开关导致的差异**：
   - `LANGFUSE_S3_MEDIA_UPLOAD_BUCKET` 未配置 → 媒体相关步骤全部跳过。
   - `LANGFUSE_ENABLE_BLOB_STORAGE_FILE_LOG` 未开 → `blob_storage_file_log` 不走删除链路。
   - `LANGFUSE_EXPERIMENT_INSERT_INTO_EVENTS_TABLE` 未开 → `events_full` / `events_core`
     不会被 `ProjectDelete` 直接清理，但 `BatchProjectCleaner` 也不会启动这两张表的实例，
     等价于「不存在」。
   - `LANGFUSE_BATCH_PROJECT_CLEANER_ENABLED` 关掉后，所有补偿任务都不跑；
     如果 `ProjectDelete` Job 失败，PG 里就会留下 `deletedAt IS NOT NULL` 的 Project 永远不真删。
6. **Org 级联删除不会触发 Project 删除**：`organizations.delete` 反而要求所有 Project
   已经被清干净。如果要做 Org 级级联，需要先独立走完 Project 的删除链路。
