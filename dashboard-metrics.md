# Dashboard Metrics 数据通路架构

## 核心洞察：两条查询路径

Langfuse 看板系统同时存在两条独立的查询路径，最终都汇入 ClickHouse，但共享权限和缓存机制。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           两条查询路径总览                                    │
├───────────────────────────────────────────┬─────────────────────────────────┤
│           🔵 默认图表路径                  │       🟢 自定义指标卡片路径       │
│  (Built-in Dashboard Widgets)             │  (Custom Query Cards)           │
├───────────────────────────────────────────┼─────────────────────────────────┤
│ • Score Aggregate                         │ • 维度选择 + 指标选择           │
│ • Cost by Type by Time                   │ • 可视化类型配置                 │
│ • Usage by Type by Time                   │ • 过滤条件组合                  │
├───────────────────────────────────────────┴─────────────────────────────────┤
│                    共享层：React Query 缓存 + 权限 + ClickHouse                │
│   useScheduledDashboardExecuteQuery → protectedProjectProcedure → executeQuery │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 一、前端缓存策略：分档与时间桶归一化

### 1.1 缓存分档规则 (staleTime / gcTime)

**位置**：`web/src/hooks/useDashboardQueryScheduler.tsx:308`

```typescript
const getDashboardExecuteQueryCachePolicy = (input) => {
  const durationMs = toMs - fromMs;

  // 按查询时间范围分档
  if (durationMs <= 30 * MINUTE_MS) {
    return { staleTime: 15 * SECOND_MS, gcTime: 5 * MINUTE_MS };     // ≤30分钟
  }
  if (durationMs <= DAY_MS) {
    return { staleTime: 30 * SECOND_MS, gcTime: 10 * MINUTE_MS };    // ≤1天
  }
  if (durationMs <= 7 * DAY_MS) {
    return { staleTime: 2 * MINUTE_MS, gcTime: 20 * MINUTE_MS };      // ≤7天
  }
  if (durationMs <= 30 * DAY_MS) {
    return { staleTime: 5 * MINUTE_MS, gcTime: 30 * MINUTE_MS };      // ≤30天
  }
  return { staleTime: 10 * MINUTE_MS, gcTime: 60 * MINUTE_MS };        // >30天
};
```

| 时间范围 | staleTime (保鲜期) | gcTime (垃圾回收) | 设计意图 |
|---------|-------------------|------------------|---------|
| ≤30分钟 | 15秒 | 5分钟 | 实时性要求高，频繁刷新 |
| ≤1天 | 30秒 | 10分钟 | 平衡实时性与性能 |
| ≤7天 | 2分钟 | 20分钟 | 中长周期分析 |
| ≤30天 | 5分钟 | 30分钟 | 月度报表 |
| >30天 | 10分钟 | 60分钟 | 长周期趋势分析 |

### 1.2 时间桶归一化 (Bucket Normalization)

**位置**：`web/src/hooks/useDashboardQueryScheduler.tsx:357`

```typescript
// 将时间戳归一化到最近的桶边界（对齐 staleTime）
const normalizeIsoTimestampByBucket = (value, bucketMs) => {
  if (typeof value !== "string") return value;
  const parsedMs = Date.parse(value);
  if (Number.isNaN(parsedMs)) return value;

  const effectiveBucketMs = Math.max(1, Math.floor(bucketMs));
  const normalizedMs =
    Math.floor(parsedMs / effectiveBucketMs) * effectiveBucketMs;
  return new Date(normalizedMs).toISOString();
};

// 缓存键生成：对 from/to 进行桶归一化后再 hash
const cacheKeyInput = shouldBucketQueriesByTimeRange
  ? normalizeDashboardExecuteQueryInputForCache(input, cachePolicy.staleTime)
  : input;

const queryCacheKey = ["dashboard.executeQuery", cacheKeyInput, refreshKey ?? null];
const effectiveRunKey = hashKey(queryCacheKey);
```

**归一化作用**：
- 30秒 staleTime → from/to 按30秒对齐
- 相邻查询（只差几秒）共享同一缓存键
- 减少重复查询，提高缓存命中率

### 1.3 QueryCacheKey 组成

```
[
  "dashboard.executeQuery",        // 命名空间
  cacheKeyInput,                  // 归一化后的查询对象（含 from/to 桶对齐）
  refreshKey ?? null              // 手动刷新键（可选）
]
```

**cacheKeyInput 深度结构**：
```typescript
{
  projectId: string,
  query: {
    view: string,
    dimensions: Array<{ field: string }>,
    metrics: Array<{ measure: string, aggregation: string }>,
    filters: FilterState,
    timeDimension: { granularity: string } | null,
    fromTimestamp: ISO8601String,  // ✅ 已桶对齐
    toTimestamp: ISO8601String,    // ✅ 已桶对齐
    orderBy: Array<{ field: string, direction: string }> | null,
    chartConfig: { type: string, bins?: number, row_limit?: number }
  },
  version: "v1" | "v2"
}
```

---

## 二、端到端时序流：缓存命中 → 权限 → 隔离 → 执行

### 2.1 完整时序图

```
时间轴 →

0ms    ┌─────────────────────────────────────────────────────────┐
       │  1. useScheduledDashboardExecuteQuery 调用                │
       │     ├─ 计算 cachePolicy (staleTime/gcTime)                │
       │     ├─ from/to 时间桶归一化                                │
       │     ├─ 生成 queryCacheKey + effectiveRunKey               │
       │     └─ 注册到 scheduler（优先级队列）                       │
       └──────────────────┬───────────────────────────────────────┘
                          │
10ms   ┌──────────────────▼───────────────────────────────────────┐
       │  2. React Query 缓存命中判断                               │
       │                                                             │
       │     ┌────────────────────────────────────────────────────┐ │
       │     │ cacheKey 命中?                                       │ │
       │     ├─ ✅ YES → 返回缓存数据 → 跳至 步骤 11               │ │
       │     │      条件: staleTime 未过期                          │ │
       │     └─ ❌ NO → 继续执行                                    │ │
       └──────────────────┬───────────────────────────────────────┘
                          │
20ms   ┌──────────────────▼───────────────────────────────────────┐
       │  3. Scheduler 并发控制                                     │
       │                                                             │
       │  maxConcurrent 按时间范围动态调整:                          │
       │    ≥90天 → 2并发 | ≥30天 → 4并发 | ≥7天 → 6并发           │
       │                                                             │
       │  调度状态流转: queued → running → done                      │
       └──────────────────┬───────────────────────────────────────┘
                          │
30ms   ┌──────────────────▼───────────────────────────────────────┐
       │  4. tRPC 中间件: protectedProjectProcedure                │
       │     (web/src/server/api/trpc.ts:271)                      │
       │                                                             │
       │     ├─ 解析 JWT Session → user.id                         │
       │     ├─ 提取 input.projectId                                │
       │     ├─ 验证用户是否为项目成员                               │
       │     │    session.user.organizations                        │
       │     │      → flatMap → find project.id === input.projectId│
       │     ├─ Admin 用户旁路放行                                   │
       │     └─ ❌ 非成员 → throw TRPCError(code="UNAUTHORIZED")    │
       └──────────────────┬───────────────────────────────────────┘
                          │
50ms   ┌──────────────────▼───────────────────────────────────────┐
       │  5. 参数校验: validateQuery                                │
       │                                                             │
       │     ├─ 检查 view 是否在允许列表中                          │
       │     ├─ 检查 dimensions 每个 field 是否在 view.dimensions  │
       │     ├─ 检查 metrics.measure 是否在 view.measures           │
       │     ├─ 检查 metrics.aggregation 是否与 measure.type 兼容   │
       │     └─ ❌ 非法 → InvalidRequestError                       │
       └──────────────────┬───────────────────────────────────────┘
                          │
80ms   ┌──────────────────▼───────────────────────────────────────┐
       │  6. QueryBuilder SQL 构建                                  │
       │     (web/src/features/query/server/queryBuilder.ts:419)   │
       │                                                             │
       │     ┌────────────────────────────────────────────────────┐ │
       │     │ ✅ 关键安全操作: 强制注入 project_id 过滤            │ │
       │     └────────────────────────────────────────────────────┘ │
       │                                                             │
       │     ├─ 解析视图定义 view = viewDeclarations[v][view]      │
       │     ├─ 映射维度 → appliedDimensions                       │
       │     ├─ 映射指标 → appliedMetrics                          │
       │     ├─ 自动注入依赖维度（requiresDimension）              │
       │     ├─ 收集关联表 JOINs                                    │
       │     ├─ 构建 ARRAY JOIN（PairExpand 维度）                 │
       │     ├─ 处理过滤器 → WHERE 条件                             │
       │     ├─ 自动注入: AND project_id = {input.projectId}       │
       │     ├─ 决策: 单级 vs 两级聚合                              │
       │     ├─ 构建时间维度 WITH FILL                              │
       │     └─ 最终 SQL 字符串 + parameters 对象                   │
       └──────────────────┬───────────────────────────────────────┘
                          │
150ms  ┌──────────────────▼───────────────────────────────────────┐
       │  7. ClickHouse 路由 + 服务端缓存配置                        │
       │                                                             │
       │  preferredClickhouseService =                              │
       │    view.baseCte.includes("events_")                       │
       │      ? "EventsReadOnly"  ← 读副本，分担主库压力           │
       │      : undefined                                             │
       │                                                             │
       │  clickhouseSettings: {                                      │
       │    date_time_output_format: "iso",                         │
       │    ...(CLICKHOUSE_USE_QUERY_CONDITION_CACHE === "true"    │
       │      ? { use_query_condition_cache: "true" } : {})        │
       │                  ↖️  ClickHouse 服务端缓存开关              │
       │                  (环境变量控制，默认关闭)                  │
       │  }                                                          │
       └──────────────────┬───────────────────────────────────────┘
                          │
200ms  ┌──────────────────▼───────────────────────────────────────┐
       │  8. ClickHouse 查询执行                                     │
       │     (packages/shared/src/server/repositories/clickhouse.ts:388)│
       │                                                             │
       │  backoff 重试策略:                                          │
       │    numOfAttempts = CLICKHOUSE_QUERY_MAX_ATTEMPTS          │
       │    仅重试网络错误（socket hang up、broken pipe）          │
       │                                                             │
       │  ClickHouse 端:                                             │
       │    ├─ 如果 use_query_condition_cache=true                  │
       │    │   └─ 相同 WHERE 条件块的中间结果可复用（CH 内部）     │
       │    ├─ 预聚合数据块处理                                       │
       │    ├─ 合并聚合结果                                          │
       │    └─ WITH FILL 填充时间间隙                                │
       └──────────────────┬───────────────────────────────────────┘
                          │
350ms  ┌──────────────────▼───────────────────────────────────────┐
       │  9. 结果返回 + 写入 React Query 缓存                        │
       │                                                             │
       │  queryClient.setQueryData(queryCacheKey, result)          │
       │  staleTime 计时器启动                                        │
       └──────────────────┬───────────────────────────────────────┘
                          │
360ms  ┌──────────────────▼───────────────────────────────────────┐
       │  10. Scheduler 标记完成                                     │
       │     markDone(queryId) → 下一个 queued → running           │
       └──────────────────┬───────────────────────────────────────┘
                          │
370ms  ┌──────────────────▼───────────────────────────────────────┐
       │  11. 渲染组件                                               │
       │     Chart / Table / Metric Card                           │
       └────────────────────────────────────────────────────────────┘
```

### 2.2 缓存失效触发条件汇总

| 层级 | 触发条件 | 失效范围 |
|-----|---------|---------|
| **React Query 前端缓存** | `staleTime` 过期 | 单个 queryCacheKey |
| | `gcTime` 过期 | 单个 queryCacheKey |
| | `refreshKey` 变化 | 单个查询 |
| | 窗口聚焦 (refetchOnWindowFocus) | 所有可见查询（默认关闭） |
| | 重新连接 (refetchOnReconnect) | 所有查询（默认关闭） |
| | 组件挂载 (refetchOnMount) | 单个查询（默认关闭） |
| **Scheduler 执行队列** | `effectiveRunKey` 变化（cacheKey 变化） | 单个查询重新排队 |
| | `resetKey` 变化（全局时间范围改变） | 整个看板所有查询重置 |
| **ClickHouse 服务端缓存** | `CLICKHOUSE_USE_QUERY_CONDITION_CACHE` 环境变量关闭 | 全局 |
| | 内存压力淘汰 LRU | 不常用的 WHERE 块 |

---

## 三、权限与数据隔离：三层防线

### 3.1 L1: 项目成员资格验证

**位置**：`web/src/server/api/trpc.ts:271`

```typescript
const enforceUserIsAuthedAndProjectMember = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  // 1. 验证已登录
  if (!ctx.session || !ctx.session.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  // 2. 提取 projectId
  const actualInput = await opts.getRawInput();
  const parsedInput = inputProjectSchema.parse(actualInput);
  const projectId = parsedInput.projectId;

  // 3. 验证用户是否为项目成员
  const sessionProject = ctx.session.user.organizations
    .flatMap((org) => org.projects)
    .find((project) => project.id === projectId);

  // 4. Admin 用户旁路
  if (!sessionProject) {
    if (ctx.session.user.admin === true) {
      // 管理员：查询数据库获取 orgId，发送 Admin 访问 Webhook
      const dbProject = await prisma.project.findFirst({...});
      sendAdminAccessWebhook({ email: ctx.session.user.email, projectId });
      return next({ ctx: { ..., projectRole: Role.OWNER } });
    }
    // 普通用户：非成员 → 拒绝
    logger.warn(`User is not a member of project ${projectId}`);
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  // 5. 正常成员：注入 projectRole 到 context
  return next({ ctx: { session: { ..., projectRole: sessionProject.role } } });
});
```

### 3.2 L2: Dashboard RBAC Scope 检查

**位置**：`web/src/features/dashboard/server/dashboard-router.ts`

```typescript
// 注意：仅元数据操作（CRUD）检查 RBAC Scope
// executeQuery 本身不做额外 RBAC 检查，仅依赖 L1 项目成员验证

createDashboard: protectedProjectProcedure
  .mutation(async ({ ctx, input }) => {
    // ✅ 额外检查 dashboards:CUD scope
    throwIfNoProjectAccess({
      session: ctx.session,
      projectId: input.projectId,
      scope: "dashboards:CUD",
    });
    return DashboardService.createDashboard(input);
  });

executeQuery: protectedProjectProcedure
  .query(async ({ input }) => {
    // ❌ 无额外 RBAC 检查
    // 仅依赖 L1 项目成员验证 + L3 project_id 强制注入
    const validation = validateQuery(input.query, input.version);
    return executeQuery(...);
  });
```

### 3.3 L3: QueryBuilder 强制 project_id 注入

**位置**：`web/src/features/query/server/queryBuilder.ts:444`

```typescript
// 构建 WHERE 条件时自动追加 project_id 过滤
private buildFilterList(...) {
  // ... 其他过滤条件处理

  // 强制注入 project_id 过滤 - 这是最后一道安全防线
  const projectIdFilter = createFilterFromFilterState(
    [
      {
        column: "project_id",
        type: "string",
        operator: "=",
        value: projectId,  // 来自路由参数，用户无法篡改
      },
    ],
    [projectIdMapping],
  );

  // 合并到最终 WHERE 条件
  filterList.push(...projectIdFilter, ...fromFilter, ...toFilter);

  // 生成 SQL: WHERE ... AND project_id = 'proj_xxx' AND timestamp >= ...
}
```

**安全设计要点**：
- `projectId` 来自 tRPC procedure 的 `input.projectId`，而非 query 对象内部
- 用户无法通过构造恶意查询绕过此过滤
- 即使前端被攻破，后端始终强制注入正确的 project_id

---

## 四、自定义指标定义层：声明式契约

### 4.1 视图定义核心结构

**位置**：`web/src/features/query/dataModel.ts`

```typescript
interface ViewDeclaration {
  name: string;
  description: string;

  // 基础表：v1 使用 observations FINAL，v2 使用 events_core
  baseCte: string;

  // 维度定义
  dimensions: Record<string, {
    sql: string;
    alias?: string;
    type?: string;
    pairExpand?: { valuesSql: string; valueAlias: string };
    aggregationFunction?: string;
  }>;

  // 指标定义
  measures: Record<string, {
    sql: string;
    alias?: string;
    type?: string;
    aggs?: Record<string, string>;      // 聚合模板映射
    requiresDimension?: string;         // 自动依赖的维度
  }>;

  // JOIN 关系定义
  tableRelations: Record<string, {
    name: string;
    joinConditionSql: string;
  }>;

  // 内置常量过滤
  segments: Filter[];

  // 时间列名（用于 WITH FILL）
  timeDimension: string;
}
```

### 4.2 PairExpand 自动依赖注入

```typescript
// 指标定义示例：按模型的成本
measures: {
  costByType: {
    sql: "cost_value",
    alias: "costByType",
    type: "decimal",
    unit: "USD",
    requiresDimension: "costType",  // ✅ 声明依赖
  }
}

// QueryBuilder 自动处理
private mapMetrics(metrics, view) {
  return metrics.map(m => {
    const measureDef = view.measures[m.measure];

    // 自动注入依赖维度
    if (measureDef.requiresDimension &&
        !currentDimensions.includes(measureDef.requiresDimension)) {
      this.applyAutoDimension(measureDef.requiresDimension);
    }
  });
}
```

---

## 五、关键文件索引

| 模块 | 文件路径 | 核心职责 |
|------|---------|---------|
| **前端缓存调度** | `web/src/hooks/useDashboardQueryScheduler.tsx` | staleTime/gcTime 分档、时间桶归一化、并发控制 |
| **入口路由** | `web/src/features/dashboard/server/dashboard-router.ts` | API 路由、v1/v2 分流、RBAC Scope 检查 |
| **权限中间件** | `web/src/server/api/trpc.ts:271` | protectedProjectProcedure、项目成员验证 |
| **参数校验** | `web/src/features/query/validateQuery.ts` | QueryType 合法性校验 |
| **查询执行** | `web/src/features/query/server/queryExecutor.ts` | ClickHouse 路由、参数绑定 |
| **SQL 构建** | `web/src/features/query/server/queryBuilder.ts` | 维度/指标映射、JOIN 生成、**project_id 强制注入** |
| **指标定义** | `web/src/features/query/dataModel.ts` | 视图声明、维度/指标契约 |
| **ClickHouse 查询** | `packages/shared/src/server/repositories/clickhouse.ts:388` | 底层查询执行、重试策略 |
| **看板 CRUD** | `packages/shared/src/server/services/DashboardService/DashboardService.ts` | 看板元数据存储 |
