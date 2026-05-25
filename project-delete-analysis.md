# Project 删除流程梳理（第三轮代码理解）

本文从代码实现角度梳理 **删除一个 Project 时，哪些数据会被清掉、哪些会保留**，以及
删除入口、级联范围、与后台任务的衔接关系。所有结论均以仓库当下的实现为准。

> 本版本为第三轮代码理解，重点修正了：（1）Redis API key 缓存失效的真实键模式和执行路径；
> （2）`blob_storage_file_log` 的软删除机制（INSERT 而非 ALTER UPDATE）；（3）tRPC 组织删除与
> Admin API 组织删除在 API key 缓存失效方面的不对称性及风险评估。

---

## 1. 删除入口（完整枚举）

### 1.1 真正触发 `ProjectDelete` 入队的删除入口（2 个）

通过搜索 `ProjectDeleteQueue.add(QueueJobs.ProjectDelete, ...)`，
仓库里只有 **2 处** 真正往 BullMQ 队列里塞 `ProjectDelete` Job：

| # | 入口 | 位置 | 适用场景 | 鉴权方式 |
| --- | --- | --- | --- | --- |
| 1 | tRPC `projects.delete` mutation | `web/src/features/projects/server/projectsRouter.ts:159`（入队在 :213） | UI 上用户在「项目设置」里点 Delete | `throwIfNoProjectAccess` + RBAC `project:delete` scope |
| 2 | EE Admin API `handleDeleteProject` | `web/src/ee/features/admin-api/server/projects/projectById/index.ts:115`（入队在 :166） | 企业版管理后台（Admin API）直接删项目 | Admin API scope 鉴权 |

两个入队点的同步处理逻辑完全一致：

```
输入: projectId, orgId
  │
  ├─ 1. RBAC 鉴权（两个入口各有各的鉴权逻辑）
  ├─ 2. invalidateCachedProjectApiKeys(projectId)
  │     └─ 从 PG 查 API key → 取 fastHashedSecretKey → Redis DEL api-key:${hash}
  ├─ 3. prisma.apiKey.deleteMany({ where: { projectId, scope: PROJECT } })
  │     └─ 从 PG 里物理删掉 scope=PROJECT 的 API key
  ├─ 4. prisma.project.update({ data: { deletedAt: now() } })   ← 软删
  ├─ 5. auditLog({ resourceType: "project", action: "delete" })
  └─ 6. projectDeleteQueue.add(QueueJobs.ProjectDelete, { projectId, orgId })
```

> 注意：**公共 API 没有 Project 删除接口**。搜索了 `web/src/features/public-api/**`，
> 只有 traces、datasets、models、llm-connections、annotation-queues 等有 DELETE 端点，
> 没有 /projects/{projectId} 的 DELETE 路由。

### 1.2 仅作为前置门禁的校验点（2 个，不入队）

组织删除的两条路径**只做校验、不触发 `ProjectDelete` 入队**：

| # | 校验点 | 位置 | 校验逻辑 |
| --- | --- | --- | --- |
| 1 | tRPC `organizations.delete` mutation | `web/src/features/organizations/server/organizationRouter.ts:178` | `countNonDeletedProjects == 0` **且** `countAllProjects == 0` |
| 2 | EE Admin API `handleDeleteOrganization` | `web/src/ee/features/admin-api/server/organizations/organizationById.ts:148` | 完全相同的两次 count 校验 |

两次 count 的语义：

- `countNonDeletedProjects`：`where: { orgId, deletedAt: null }`
  —— 还有**活跃**项目就不让删 Org
- `countAllProjects`：`where: { orgId }`（不区分 `deletedAt`）
  —— 还有**任何**项目行（哪怕已经软删）也不让删 Org

> 这意味着：要删 Org，必须等 `ProjectDelete` 任务走完、PG 里的 project 行被
> `prisma.project.delete(...)` 真正物理删掉才行。

### 1.3 为何组织删除仅作为前置门禁而非直接删除入口

这是一个有意的设计选择，原因有四层：

1. **职责分离 + 幂等性简单**
   组织删除是一个同步操作。如果在里面循环触发 N 个项目的删除入队，那么一个
   "删组织"请求就会扇出 N 个异步任务。失败重试、幂等控制、部分成功时的状态
   管理都会变得很复杂。让用户先逐个（或通过其他脚本）删完所有项目，再删组织，
   逻辑最直白。

2. **一致性要求更强**
   组织删除要求 `countAllProjects == 0`——即 PG 里的 project 行必须**真的被物理删掉**
   （而不只是 `deletedAt` 被打上时间戳）。如果组织删除自己去触发项目删除，它要么
   得同步等待所有 `ProjectDelete` 任务完成（会长时间阻塞 HTTP 请求），要么得接受
   "异步最终一致"（组织删了但项目数据还在后台清理）。选择前置校验可以避免这种
   两难。

3. **安全边界**
   删组织是最高风险的操作。把"必须先显式处理完所有项目"作为硬性前置，相当于多了
   一道"确认"关卡，防止误操作。

4. **数据库级级联被故意绕开**
   `packages/shared/prisma/schema.prisma:125` 中 `Project.organization` 关系定义了
   `onDelete: Cascade`，它的语义是"**如果 Organization 被删了，Project 也会被级联删**"。
   但代码在走到数据库这一层之前就用校验拦住了——因为数据库级级联只会删 PG 里的行，
   不会触发 ClickHouse、S3、Redis 的清理，会留下大量孤儿数据。

---

## 2. 异步清理（`ProjectDelete` 队列处理器）

队列名：`QueueName.ProjectDelete = "project-delete"`（`packages/shared/src/server/queues.ts:325`）
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
| `removeIngestionEventsFromS3AndDeleteClickhouseRefsForProject(projectId, undefined)` | `blob_storage_file_log` + S3 ingestion 归档 | 仅当 `LANGFUSE_ENABLE_BLOB_STORAGE_FILE_LOG === "true"`，内部按 500 一批**INSERT 新的软删行**（非 ALTER UPDATE） |

执行模式：除 `blob_storage_file_log` 外，每一个函数都先发一个 `SELECT 1 ... WHERE project_id = ? LIMIT 1`
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

---

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
  对 `blob_storage_file_log` 做 CH 软删（INSERT 新行，设置 `is_deleted="1"`），
  并在删 CH 前先调 S3 `deleteFiles`。中途被打断是安全的——已经软删的行在下一次合并时会真正消失。

### 3.4 这些补偿之间的分工一览

| 任务 | 覆盖范围 | 粒度 |
| --- | --- | --- |
| `ProjectDelete` Job | S3 媒体 + CH 主表 + Dataset run items + PG 级联 | 全量，一次清完 |
| `BatchProjectCleaner` | CH 的 5~6 张主表 | 按表并行，按 Project 批量 DELETE |
| `BatchProjectMediaCleaner` | S3 + PG 里的 `Media` | 选最老 Project，每轮删 `BATCH_SIZE` 条 |
| `BatchProjectBlobCleaner` | `blob_storage_file_log` + S3 ingestion 归档 | 选剩余 blob 最多的 Project，一次清全量 |

---

## 4. 六维数据清理对照表（PG / CH / S3 / Redis）

下表按 **数据类型 → 数据对象 → 清理动作 → 触发位置 → 开关条件 → 失败后补偿**
六个维度梳理，覆盖所有被影响的数据：

### 4.1 Redis

| 数据对象 | 清理动作 | 触发位置 | 开关条件 | 失败后补偿 |
| --- | --- | --- | --- | --- |
| **API key 缓存**（键名模式：`api-key:${fastHashedSecretKey}`） | 1. 从 PG 查询该 projectId 的所有 `scope=PROJECT` 的 API key；<br>2. 提取每个 key 的 `fastHashedSecretKey` 字段；<br>3. 用 `safeMultiDel` 逐个 Redis `DEL api-key:${hash}`（集群模式避免 CROSSSLOT） | `packages/shared/src/server/auth/invalidateApiKeys.ts:100`（`invalidateCachedProjectApiKeys`），在 `projectsRouter.ts:173` 和 `projectById/index.ts:123` 被调用（入口同步执行） | Always（无 env 开关） | 下一次 API 请求时 `ApiAuthService` 会从 PG 重新读取并覆盖缓存；长期则靠缓存 TTL 自失效 |
| `BatchProjectCleaner` 等分布式锁 | Redis `SET` 带 TTL，结束后自动释放 | 各 `PeriodicExclusiveRunner` 内部 | 对应 cleaner 开了才有锁 | 锁自带 TTL（= DELETE timeout + 5min），worker 挂掉也会超时自动释放 |

> **修正说明**：之前的版本错误地描述为"前缀匹配失效"。实际实现是**先查 DB 得到具体的 key 哈希值，再精确删除对应的 Redis 键**，
> 不是 `api_auth:api_keys:${projectId}:*` 这种前缀模式。

### 4.2 PostgreSQL

| 数据对象 | 清理动作 | 触发位置 | 开关条件 | 失败后补偿 |
| --- | --- | --- | --- | --- |
| `api_keys` (scope = PROJECT) | `DELETE FROM api_keys WHERE project_id = ? AND scope = 'PROJECT'` | `projectsRouter.ts:179`、`projectById/index.ts:128`（入口同步执行） | Always | 步骤 D Cascade 双保险；BullMQ 重试 |
| `projects` 行本身 | 先 `UPDATE SET deleted_at = now()`（软删），最后 `DELETE`（真删） | 软删：`projectsRouter.ts:186` / `projectById/index.ts:136`<br>真删：`projectDelete.ts:94`（步骤 D） | Always | 真删失败：BullMQ 重试（`P2025` / `P2016` 幂等通过） |
| `project_memberships`、`llm_api_keys`、`trace_sessions` | `ON DELETE CASCADE`（由 PG 外键触发） | `projectDelete.ts:94`（步骤 D `prisma.project.delete`） | Always | BullMQ 重试 |
| `traces`、`observations`、`scores`（legacy PG 表） | `ON DELETE CASCADE` | 同上 | Always | BullMQ 重试 |
| `score_configs`、`annotation_queues`、`annotation_queue_items`、`annotation_queue_assignments` | `ON DELETE CASCADE` | 同上 | Always | BullMQ 重试 |
| `datasets`、`dataset_items`、`dataset_runs` | `ON DELETE CASCADE` | 同上 | Always | BullMQ 重试 |
| `prompts`、`prompt_dependencies`、`prompt_protected_labels`、`llm_schemas`、`llm_tools` | `ON DELETE CASCADE` | 同上 | Always | BullMQ 重试 |
| `eval_templates`、`job_configurations`、`job_executions` | `ON DELETE CASCADE` | 同上 | Always | BullMQ 重试 |
| `models`、`prices`、`default_llm_models` | `ON DELETE CASCADE` | 同上 | Always | BullMQ 重试 |
| `posthog_integrations`、`mixpanel_integrations`、`blob_storage_integrations`、`slack_integrations` | `ON DELETE CASCADE` | 同上 | Always | BullMQ 重试 |
| `batch_exports`、`batch_actions`、`triggers`、`actions`、`automations`、`automation_executions` | `ON DELETE CASCADE` | 同上 | Always | BullMQ 重试 |
| `dashboards`、`dashboard_widgets`、`table_view_presets`、`default_views` | `ON DELETE CASCADE` | 同上 | Always | BullMQ 重试 |
| `comments`、`comment_reactions` | `ON DELETE CASCADE` | 同上 | Always | BullMQ 重试 |
| `media`、`trace_media`、`observation_media` | ① `media` 先在步骤 A 分批次 `DELETE`<br>② `trace_media` / `observation_media` 靠步骤 D `ON DELETE CASCADE` | ① `projectDelete.ts:44-51`（步骤 A）<br>② `projectDelete.ts:94`（步骤 D） | 步骤 A 仅当 `LANGFUSE_S3_MEDIA_UPLOAD_BUCKET` 配置；步骤 D Always | BullMQ 重试 + `BatchProjectMediaCleaner` 兜底啃残留 |
| `notification_preferences`、`pending_deletions` | `ON DELETE CASCADE` | `projectDelete.ts:94`（步骤 D） | Always | BullMQ 重试 |
| `membership_invitations.project_id` | `ON DELETE SET NULL`（只清空 projectId 列，行保留） | 同上（PG 外键自动触发） | Always | 无（刻意保留 Org 级邀请） |
| `audit_logs` | **不清理**（软关联，不是外键） | —— | —— | 合规需求，刻意保留 |
| `api_keys` (scope = ORGANIZATION) | **不清理**（不归属于单个 Project） | —— | —— | Org 级 key 随 Org 删除才会被级联 |
| `organizations`、`users`、`cron_jobs`、`background_migrations` | **不清理**（引用方向相反或全局表） | —— | —— | 这些表是 Project 的父节点或全局节点 |

### 4.3 ClickHouse

| 数据对象 | 清理动作 | 触发位置 | 开关条件 | 失败后补偿 |
| --- | --- | --- | --- | --- |
| `traces` | `ALTER TABLE traces DELETE WHERE project_id = ?`（同步 DELETE） | `projectDelete.ts:66`（步骤 B，调用 `deleteTracesByProjectId` 在 `repositories/traces.ts:1074`） | Always | BullMQ 重试 + `BatchProjectCleaner` 兜底 |
| `observations` | `ALTER TABLE observations DELETE WHERE project_id = ?` | `projectDelete.ts:67`（步骤 B，`repositories/observations.ts:1324`） | Always | 同上 |
| `scores` | `ALTER TABLE scores DELETE WHERE project_id = ?` | `projectDelete.ts:68`（步骤 B，`repositories/scores.ts:1676`） | Always | 同上 |
| `dataset_run_items_rmt` | `ALTER TABLE dataset_run_items_rmt DELETE WHERE project_id = ?` | `projectDelete.ts:75`（步骤 C，`repositories/dataset-run-items.ts:1108`） | Always | 同上 + `BatchProjectCleaner`（它在 `BATCH_DELETION_TABLES` 里） |
| `events_full` / `events_core` | `ALTER TABLE events_* DELETE WHERE project_id = ?` | `projectDelete.ts:69-71`（步骤 B，`repositories/events.ts:2477`） | `LANGFUSE_EXPERIMENT_INSERT_INTO_EVENTS_TABLE === "true"` | 同上 + `BatchProjectCleaner`（仅当开关打开时才启动 events 表的 cleaner 实例） |
| **`blob_storage_file_log`** | 表引擎是 `ReplacingMergeTree(event_ts, is_deleted)`，按 500 一批循环：<br>1. 查询待删行（`is_deleted=0`）；<br>2. 调 S3 `DeleteObjects` 删对象；<br>3. **INSERT 新行**到 CH，复制所有字段但设置 `is_deleted="1"`、`event_ts=now()`、`updated_at=now()`；<br>4. CH 后台合并时自动丢弃旧版本（软删生效） | `projectDelete.ts:60-65`（步骤 B），调用 `packages/shared/src/server/data-deletion/ingestionFileDeletion.ts:95` 的 `softDeleteInClickhouse` | `LANGFUSE_ENABLE_BLOB_STORAGE_FILE_LOG === "true"` | BullMQ 重试 + `BatchProjectBlobCleaner` 兜底 |
| CH 物化视图 / 其他衍生表 | 不单独清理（依赖 CH 合并树的异步清理，或已通过主表 DELETE 级联到 MV） | —— | —— | CH 自身机制；`BatchProjectCleaner` 只清理主表 |

> **修正说明**：之前的版本错误地描述为"ALTER TABLE ... UPDATE"。实际实现是 **INSERT 新的软删行**，
> 利用 `ReplacingMergeTree(event_ts, is_deleted)` 引擎的去重特性——主键相同时取 `event_ts` 最大的版本，
> 如果该版本的 `is_deleted=1` 则在合并时被视为"已删除"。这是 ClickHouse 的标准软删除模式。

### 4.4 S3

| 数据对象 | 清理动作 | 触发位置 | 开关条件 | 失败后补偿 |
| --- | --- | --- | --- | --- |
| 媒体对象（路径 = `Media.bucketPath`） | S3 `DeleteObjects`（批量，最多 1000 个 key / 请求），然后删 PG `media` 行 | `projectDelete.ts:44-51`（步骤 A，调用 `media-deletion.ts:51` `deleteMediaFiles`） | `LANGFUSE_S3_MEDIA_UPLOAD_BUCKET` 已配置 | BullMQ 重试 + `BatchProjectMediaCleaner` 分批啃 |
| Ingestion 归档对象（路径由 `blob_storage_file_log.bucket_path` 记录） | S3 `DeleteObjects` 按 500 一批删，然后 CH INSERT 软删行 | `projectDelete.ts:60-65`（步骤 B，`ingestionFileDeletion.ts:42`） | `LANGFUSE_ENABLE_BLOB_STORAGE_FILE_LOG === "true"` | BullMQ 重试 + `BatchProjectBlobCleaner` 兜底 |
| Blob Storage 导出文件（用户配置的导出 bucket 里的 Parquet / JSON） | **不清理** | —— | —— | 导出时已与 Project 解耦，走 BlobStorageIntegration 自己的保留期或用户手动管理 |
| S3 billing / usage 计量归档 | **不清理**（本仓库不涉及） | —— | —— | Cloud 侧独立管理 |

---

## 5. 组织删除的 API key 缓存失效：不对称性与风险评估

### 5.1 tRPC 组织删除 vs Admin API 组织删除对比

| 维度 | tRPC `organizations.delete` | EE Admin API `handleDeleteOrganization` |
| --- | --- | --- |
| 位置 | `organizationRouter.ts:178` | `organizationById.ts:148` |
| 项目前置校验 | `countNonDeletedProjects == 0` 且 `countAllProjects == 0` | 完全相同 |
| Stripe 订阅取消 | Cloud 环境会先 `cancelImmediatelyAndInvoice` | 无（Admin API 不处理 billing） |
| **API key 缓存失效** | ✅ 删除组织后调用 `invalidateCachedOrgApiKeys(orgId)`（`organizationRouter.ts:245`） | ❌ **没有调用**（直接 `prisma.organization.delete()` 后返回） |
| 审计日志 | ✅ 写 audit log | ✅ 写 audit log |

### 5.2 技术细节：`invalidateCachedOrgApiKeys` 的工作原理

```ts
// packages/shared/src/server/auth/invalidateApiKeys.ts:58
export async function invalidateCachedOrgApiKeys(
  orgId: string,
  redisClient: Redis | Cluster | null = redis,
): Promise<void> {
  // 查询属于该 Org 的所有 API key：
  //   OR: [ { project: { orgId } }, { orgId } ]
  // 即包含 Org 级 key 和该 Org 下所有 Project 的 key
  const apiKeys = await prisma.apiKey.findMany({
    where: { OR: [{ project: { orgId } }, { orgId }] },
  });

  // 精确删除 api-key:${fastHashedSecretKey}
  const keysToDelete = apiKeys
    .map((key) => key.fastHashedSecretKey)
    .filter(Boolean)
    .map((hash) => `api-key:${hash}`);

  await safeMultiDel(redisClient, keysToDelete);
}
```

### 5.3 风险评估：这是设计选择还是潜在 bug？

**结论：这是一个需要修复的** 潜在安全风险 **，不是有意的设计选择。**

代码依据：

1. tRPC 路径里的注释明确说明了意图：
   > `organizationRouter.ts:244` 的代码注释：`// the api keys contain which org they belong to, so we need to remove them from Redis`

2. Admin API 路径删除组织的逻辑完全一样（先校验项目、再 `prisma.organization.delete()`、再写 audit log），
   唯独缺了这一行 `invalidateCachedOrgApiKeys`。

3. **安全影响**：如果用 Admin API 删除了一个组织，那么：
   - PG 里的 `api_keys` 行会被外键级联删掉（因为 `ApiKey.organization` 是 `onDelete: Cascade`）
   - 但 Redis 里的 `api-key:${hash}` 缓存**不会被清除**
   - 在缓存 TTL 到期之前，攻击者还能用已撤销的 API key 访问（前提是缓存还在）

4. 虽然 API key 在鉴权时最终会从 DB 重新验证（缓存 miss 时），但：
   - 如果缓存命中，会直接使用缓存的 key 信息
   - 缓存 TTL 通常是分钟级，这就有了一个攻击窗口

> 建议修复：在 `web/src/ee/features/admin-api/server/organizations/organizationById.ts` 的
> `prisma.organization.delete()` 之后，增加一行：
> `await invalidateCachedOrgApiKeys(organizationId, redis)`。

---

## 6. 删除链路的整体时序

```
用户点 Delete / 调 admin API
   │
   ▼
projectsRouter.delete / handleDeleteProject
   ├─ 1. invalidateCachedProjectApiKeys(projectId)  （Redis，同步：查 PG → 取 hash → DEL api-key:${hash}）
   ├─ 2. prisma.apiKey.deleteMany(scope=PROJECT)     （PG，同步）
   ├─ 3. prisma.project.update({ deletedAt: now })   （PG，软删，同步）
   ├─ 4. auditLog("project", "delete")               （PG，同步）
   └─ 5. enqueue ProjectDelete(projectId, orgId)     （BullMQ，异步）

   ▼
worker 消费 ProjectDelete
   ├─ A. S3 + PG Media 全量清理（10,000/批）
   ├─ B. CH traces / observations / scores / events* 并行 DELETE
   │    └─ blob_storage_file_log：按 500 一批 S3 Delete + CH INSERT is_deleted=1
   ├─ C. CH dataset_run_items_rmt DELETE
   └─ D. prisma.project.delete()                      （PG，真删）
         └─ 依赖 onDelete 级联清掉所有 PG 子表

   ▲
   │ 兜底：PeriodicExclusiveRunner 后台任务（持续运行）
   │  ├─ BatchProjectCleaner       扫软删 Project，批量清 CH 主表
   │  ├─ BatchProjectMediaCleaner  啃 Media 残留（按 BATCH_SIZE）
   │  └─ BatchProjectBlobCleaner   啃 blob_storage_file_log 残留
   │
   ▼
organizations.delete（可选，两条路径）
   ├─ 校验 countNonDeletedProjects == 0 （活跃项目必须为 0）
   ├─ 校验 countAllProjects == 0      （软删项目也必须清完）
   ├─ prisma.organization.delete()
   ├─ [tRPC 专有] invalidateCachedOrgApiKeys(orgId)  ← Admin API 缺失这一步！⚠️
   └─ auditLog("organization", "delete")
```

---

## 7. 容易被忽视的几个设计要点

1. **两步删除（软删 → 真删）**：入口只打 `deletedAt`，真删交给异步任务。
   好处是 UI / API 能快速响应；坏处是 Org 删除、Admin 侧统计等必须同时考虑
   `deletedAt IS NULL` 和 `deletedAt IS NOT NULL` 两种状态（见 `organizations.delete`）。

2. **CH 没有外键**，所有 CH 删除靠业务层显式发 DELETE；`BatchProjectCleaner`
   用「PG 里还有软删 Project」这个信号做兜底，所以一旦 PG 的 `project.delete(...)`
   成功，CH 侧的补偿就失去动力——这要求 `ProjectDelete` 步骤 B/C 必须在步骤 D **之前**完成。

3. **Media 清理是 S3 先行、PG 后删**（`media-deletion.ts:67-75`），防止孤儿 S3 对象；
   但这意味着如果 PG 回滚，S3 已经删了——重试时会幂等。

4. **`blob_storage_file_log` 的软删除是 INSERT 不是 ALTER UPDATE**：
   利用 `ReplacingMergeTree(event_ts, is_deleted)` 的去重特性，写入一条相同主键但
   `is_deleted="1"` 的新行，CH 后台合并时自动丢弃旧版本。这是 ClickHouse 的标准软删除模式，
   避免了 ALTER UPDATE 的重写开销。

5. **Redis API key 失效是精确删除，不是前缀匹配**：先从 PG 查询具体的 key，
   取 `fastHashedSecretKey`，再逐个 DEL `api-key:${hash}`。集群模式下用 `safeMultiDel`
   避免 CROSSSLOT 错误。

6. **审计日志不删**，是刻意的合规选择。写审计日志的那一条发生在入口处（软删时），
   指向的 Project 会在步骤 D 被删掉，但日志行本身保留，`resourceId` 变成悬空字符串。

7. **组织删除的 API key 缓存失效不对称**：tRPC 路径调用了 `invalidateCachedOrgApiKeys`，
   但 Admin API 路径没有。这是一个潜在的安全风险，建议修复（见第 5 节）。

8. **环境开关导致的差异**：
   - `LANGFUSE_S3_MEDIA_UPLOAD_BUCKET` 未配置 → 媒体相关步骤全部跳过。
   - `LANGFUSE_ENABLE_BLOB_STORAGE_FILE_LOG` 未开 → `blob_storage_file_log` 不走删除链路。
   - `LANGFUSE_EXPERIMENT_INSERT_INTO_EVENTS_TABLE` 未开 → `events_full` / `events_core`
     不会被 `ProjectDelete` 直接清理，但 `BatchProjectCleaner` 也不会启动这两张表的实例，
     等价于「不存在」。
   - `LANGFUSE_BATCH_PROJECT_CLEANER_ENABLED` 关掉后，所有补偿任务都不跑；
     如果 `ProjectDelete` Job 失败，PG 里就会留下 `deletedAt IS NOT NULL` 的 Project 永远不真删。

9. **Org 级联删除不会触发 Project 删除**：`organizations.delete` 反而要求所有 Project
   已经被清干净。如果要做 Org 级级联，需要先独立走完 Project 的删除链路。

10. **入队点只有 2 个**：只有 tRPC `projects.delete` 和 EE Admin API `handleDeleteProject`
    真正调用 `ProjectDeleteQueue.add(QueueJobs.ProjectDelete, ...)`。组织删除只是门禁，
    公共 API 没有项目删除接口。
