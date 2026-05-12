# Dashboard Metrics 数据通路架构

## 核心洞察：两条独立的查询链路

Langfuse 看板系统存在**两条完全独立**的查询链路，在默认图表中甚至混合使用。

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           两条查询链路总览                                │
├─────────────────────────────────────┬───────────────────────────────────┤
│        🔵 链路 A: 传统 Chart API      │    🟢 链路 B: 调度器 ExecuteQuery  │
│  api.dashboard.chart.useQuery       │  useScheduledDashboardExecuteQuery│
├─────────────────────────────────────┼───────────────────────────────────┤
│  调用入口: DashboardRouter.chart     │  调用入口: DashboardRouter.executeQuery│
│  前端缓存: tRPC React Query 原生     │  前端缓存: React Query + Scheduler│
│  后端: getScoreAggregate() 硬编码   │  后端: QueryBuilder 声明式构建    │
│  手动 project_id 注入                │  QueryBuilder 自动 project_id 注入│
│  无并发控制                          │  动态并发限制 + 优先级队列        │
└─────────────────────────────────────┴───────────────────────────────────┘
```

---

## 一、链路 A：api.dashboard.chart.useQuery（传统链路）

### 1.1 使用场景：哪些默认图表走这条链路？

**位置**：`web/src/features/dashboard/components/ModelUsageChart.tsx:125`

```typescript
// 在同一个 ModelUsageChart 组件中，同时使用了两条链路！
// ─── 链路 A: 传统 Chart API ───
// Tab 2: Cost by type
const queryCostByType = api.dashboard.chart.useQuery({
  projectId,
  from: "traces_observations",
  select: [
    { column: "totalTokens", agg: "SUM" },
    { column: "calculatedTotalCost", agg: "SUM" },
    { column: "model" },
  ],
  filter: [...globalFilterState, { type: "generation" }],
  groupBy: [
    { type: "datetime", column: "startTime", temporalUnit: "day" },
    { type: "string", column: "model" },
  ],
  orderBy: [{ column: "calculatedTotalCost", direction: "DESC", agg: "SUM" }],
  queryName: "observations-cost-by-type-timeseries",  // 关键！命名查询
  version: metricsVersion,
});

// Tab 4: Usage by type
const queryUsageByType = api.dashboard.chart.useQuery({
  // ... 类似结构
  queryName: "observations-usage-by-type-timeseries",
});
```

**使用此链路的默认图表**：
| 组件 | Tab | queryName |
|------|-----|-----------|
| ModelUsageChart | Cost by type | `observations-cost-by-type-timeseries` |
| ModelUsageChart | Usage by type | `observations-usage-by-type-timeseries` |
| ScoresTable | Score Aggregate | `score-aggregate` |

### 1.2 前端缓存键构成（tRPC 原生）

```typescript
// tRPC 自动生成的 queryKey
[
  ["dashboard", "chart"],  // procedure path
  {
    projectId: "proj_xxx",
    queryName: "observations-cost-by-type-timeseries",
    filter: [...],
    from: "traces_observations",
    select: [...],
    groupBy: [...],
    orderBy: [...],
    version: "v1" | "v2",
    fromTimestamp: "2024-01-01T00:00:00.000Z",  // ⚠️ 不归一化
    toTimestamp: "2024-01-31T23:59:59.999Z",    // ⚠️ 不归一化
  }
]
```

**关键特征**：
- ❌ **无时间桶归一化**：from/to 精确到毫秒，相邻查询不共享缓存
- ❌ **无分档 staleTime/gcTime**：使用 tRPC 默认值
- ✅ 标准 tRPC React Query 行为

### 1.3 后端调用入口

**位置**：`web/src/features/dashboard/server/dashboard-router.ts:298`

```typescript
chart: protectedProjectProcedure
  .input(z.object({
    queryName: z.enum([          // ✅ 白名单限制，只能调用预设查询
      "score-aggregate",
      "observations-cost-by-type-timeseries",
      "observations-usage-by-type-timeseries",
    ]),
    filter: FilterState,
    version: z.enum(["v1", "v2"]).default("v1"),
    // ... 其他字段
  }))
  .query(async ({ input, ctx }) => {
    switch (input.queryName) {
      // ─── v1 版本：硬编码 SQL ───
      case "score-aggregate":
        return input.version === "v2"
          ? getScoreAggregateV2(input)
          : getScoreAggregate(input);  // 手写 SQL

      case "observations-cost-by-type-timeseries":
        return input.version === "v2"
          ? getObservationsCostByTypeV2(input)  // ✅ 汇入 QueryBuilder
          : getObservationCostByTypeByTime(input);  // 手写 SQL

      // ... 其他命名查询
    }
  });
```

### 1.4 v1 硬编码 SQL 实现

**位置**：`packages/shared/src/server/repositories/dashboards.ts`

```typescript
async function getObservationCostByTypeByTime(params): Promise<any> {
  // 手动构建 SQL，绕过 QueryBuilder
  const observationsQuery = sql
    .select([
      sql.raw(
        `toStartOfInterval(start_time, INTERVAL ${bucketSeconds} SECOND) AS start_time`,
      ),
      sql.raw(
        `groupArray(tuple(cost_details_key, cost_details_sum_0)) AS costs`,
      ),
    ])
    .from(
      // 子查询：先按时间 + 类型聚合，再按时间聚合
      sql
        .select([
          sql.raw("start_time"),
          sql.raw("cost_details_key"),
          sql.raw("SUM(cost_details_sum_0) AS cost_details_sum_0"),
        ])
        .from((db) => db("observations").as("o"))
        .leftJoin(...)
        .where("project_id", sql.raw(`{projectId: String}`))  // ✅ 手动注入
        .where(...)
        .groupBy(["start_time", "cost_details_key"]),
    )
    .groupBy(["start_time"]);

  // 使用参数化查询防止 SQL 注入
  const queryWithParams = observationsQuery
    .toParams({ placeholderCharacter: "$", startParamIndex: 1 });
  const response = await clickhouseClient.query({
    query: queryWithParams.sql,
    query_params: {
      ...queryWithParams.params,
      projectId: params.projectId,  // ✅ 参数绑定
    },
  });
  return response.json();
}
```

### 1.5 链路 A 权限校验

| 层级 | 校验点 | 实现方式 |
|-----|--------|---------|
| **L1** | 项目成员验证 | `protectedProjectProcedure` 中间件 |
| **L2** | 查询白名单 | `queryName` enum 限制，用户无法调用任意查询 |
| **L3 (v1)** | project_id 隔离 | 手动在 SQL 中注入 `WHERE project_id = $projectId` |
| **L3 (v2)** | project_id 隔离 | QueryBuilder 自动注入 |

---

## 二、链路 B：useScheduledDashboardExecuteQuery + dashboard.executeQuery（调度器链路）

### 2.1 使用场景：哪些组件走这条链路？

**场景 1：自定义指标卡片（DashboardWidget）**

**位置**：`web/src/features/widgets/components/DashboardWidget.tsx:132`

```typescript
// 从数据库读取 widget 配置，动态构建 QueryType
const widgetQuery: QueryType = useMemo(() => {
  return {
    view: widget.data.view,                    // 来自数据库
    dimensions: widget.data.dimensions,        // 来自数据库
    metrics: widget.data.metrics.map(m => ({   // 来自数据库
      measure: m.measure,
      aggregation: m.agg,
    })),
    filters: [
      ...mapLegacyUiTableFilterToView(widget.data.view, widget.data.filters),
      ...mapLegacyUiTableFilterToView(widget.data.view, filterState),
    ],
    timeDimension: isTimeSeries ? { granularity: "auto" } : null,
    fromTimestamp: dateRange.from.toISOString(),
    toTimestamp: dateRange.to.toISOString(),
    orderBy: buildWidgetOrderBy(...),
    chartConfig: toQueryChartConfig(widget.data.chartConfig),
  };
}, [widget.data, filterState, dateRange]);

// 通过调度器执行
const data = useScheduledDashboardExecuteQuery(
  { projectId, query: widgetQuery, version: metricsVersion },
  {
    enabled: widget.isSuccess && queryValidation.valid,
    queryId: `widget:${placement.id}`,
    priority: 1000,
  },
);
```

**场景 2：默认图表（部分 Tab）**

**位置**：`web/src/features/dashboard/components/ModelUsageChart.tsx:107`

```typescript
// ModelUsageChart Tab 1: Cost by model
const queryResult = useScheduledDashboardExecuteQuery(
  {
    projectId,
    query: {
      view: "observations",
      dimensions: [{ field: "providedModelName" }],
      metrics: [
        { measure: "totalCost", aggregation: "sum" },
        { measure: "totalTokens", aggregation: "sum" },
      ],
      filters: [...userAndEnvFilterState, { type: "generation" }],
      timeDimension: { granularity: "day" },
      fromTimestamp: fromTimestamp.toISOString(),
      toTimestamp: toTimestamp.toISOString(),
      orderBy: null,
    },
    version: metricsVersion,
  },
  {
    enabled: isModelUsageEnabled,
    queryId: `${schedulerId ?? "home:model-usage"}:timeseries`,
    priority: 1001,
  },
);
```

**使用此链路的组件**：

| 组件 | 说明 |
|------|------|
| `DashboardWidget` | 所有自定义指标卡片 |
| `ModelUsageChart` | Tab 1 (Cost by model), Tab 3 (Usage by model) |
| `TracesBarListChart` | 全部 Tab |
| `TracesTimeSeriesChart` | 全部 Tab |
| `LatencyChart` | 全部 Tab |
| `LatencyTables` | 全部 Tab |
| `UserChart` | 全部 Tab |
| `NumericScoreTimeSeriesChart` | 全部 Tab |
| `CategoricalScoreChart` | 全部 Tab |
| `ModelCostTable` | 全部 Tab |

**⚠️ 关键发现**：`ModelUsageChart` 一个组件内同时使用了两条链路！
- Tab 1/3 → 链路 B（调度器）
- Tab 2/4 → 链路 A（传统 Chart API）

### 2.2 前端缓存键构成（调度器）

**位置**：`web/src/hooks/useDashboardQueryScheduler.tsx:357`

```typescript
// ─── 第一步：时间桶归一化 ───
const normalizeIsoTimestampByBucket = (value, bucketMs) => {
  const parsedMs = Date.parse(value);
  const normalizedMs =
    Math.floor(parsedMs / effectiveBucketMs) * effectiveBucketMs;
  return new Date(normalizedMs).toISOString();
};

// ─── 第二步：按时间范围分档 staleTime/gcTime ───
const getDashboardExecuteQueryCachePolicy = (input) => {
  const durationMs = toMs - fromMs;
  if (durationMs <= 30 * MINUTE_MS) {
    return { staleTime: 15 * SECOND_MS, gcTime: 5 * MINUTE_MS };   // ≤30分钟
  }
  if (durationMs <= DAY_MS) {
    return { staleTime: 30 * SECOND_MS, gcTime: 10 * MINUTE_MS };  // ≤1天
  }
  if (durationMs <= 7 * DAY_MS) {
    return { staleTime: 2 * MINUTE_MS, gcTime: 20 * MINUTE_MS };    // ≤7天
  }
  if (durationMs <= 30 * DAY_MS) {
    return { staleTime: 5 * MINUTE_MS, gcTime: 30 * MINUTE_MS };    // ≤30天
  }
  return { staleTime: 10 * MINUTE_MS, gcTime: 60 * MINUTE_MS };      // >30天
};

// ─── 第三步：生成缓存键 ───
const cacheKeyInput = shouldBucketQueriesByTimeRange
  ? normalizeDashboardExecuteQueryInputForCache(input, cachePolicy.staleTime)
  : input;

// 最终 queryKey（React Query）
const queryCacheKey = [
  "dashboard.executeQuery",       // 命名空间
  cacheKeyInput,                 // ✅ from/to 已归一化
  refreshKey ?? null,            // 手动刷新键
];

// 调度器内部运行键（去重）
const effectiveRunKey = hashKey(queryCacheKey);
```

**归一化效果示例**：
```
原始 from/to (毫秒级): 2024-01-01T00:00:03.123Z → 2024-01-31T23:59:59.999Z
30秒 staleTime 归一化: 2024-01-01T00:00:00.000Z → 2024-01-31T23:59:30.000Z
✅ 相邻查询（差几秒）共享同一缓存键
```

### 2.3 调度器并发控制

```typescript
// 按时间范围动态调整并发数
const maxConcurrent = useMemo(() => {
  if (durationHours >= 90 * 24) return 2;   // ≥90天 → 2并发
  if (durationHours >= 30 * 24) return 4;   // ≥30天 → 4并发
  if (durationHours >= 7 * 24) return 6;    // ≥7天 → 6并发
  return 8;                                  // 默认 8并发
}, [durationHours]);

// 优先级队列：数字越小优先级越高
const priority = input.options?.priority ?? DEFAULT_PRIORITY;
// DashboardWidget: priority = 1000
// ModelUsageChart: priority = 1001
```

### 2.4 后端调用入口

**位置**：`web/src/features/dashboard/server/dashboard-router.ts:420`

```typescript
executeQuery: protectedProjectProcedure
  .input(z.object({
    projectId: z.string(),
    query: QueryTypeSchema,    // ✅ 完整查询表达式，前端构造
    version: z.enum(["v1", "v2"]).default("v1"),
  }))
  .query(async ({ input }) => {
    // ─── 参数校验：维度/指标必须在视图定义中存在 ───
    const validation = validateQuery(input.query, input.version);
    if (!validation.valid) {
      throw new InvalidRequestError(validation.reason);
    }

    // ─── 汇入统一执行器 ───
    return executeQuery(
      input.projectId,
      input.query,
      input.version,
      input.version === "v2",  // enableSingleLevelOptimization
    );
  });
```

### 2.5 链路 B 权限校验

| 层级 | 校验点 | 实现方式 |
|-----|--------|---------|
| **L1** | 项目成员验证 | `protectedProjectProcedure` 中间件 |
| **L2** | 查询合法性校验 | `validateQuery()` 确保维度/指标/过滤字段都在视图白名单中 |
| **L3** | project_id 隔离 | `QueryBuilder.buildFilterList()` **自动强制注入** WHERE 条件 |

**QueryBuilder 强制注入实现**（最后安全防线）：

**位置**：`web/src/features/query/server/queryBuilder.ts:444`

```typescript
private buildFilterList(...) {
  // ... 用户过滤器处理

  // ✅ 强制注入 project_id 过滤 - 用户无法绕过
  const projectIdFilter = createFilterFromFilterState(
    [
      {
        column: "project_id",
        type: "string",
        operator: "=",
        value: projectId,  // 来自 input.projectId，不是 query 对象内部
      },
    ],
    [projectIdMapping],
  );

  // 合并到最终 WHERE
  filterList.push(...projectIdFilter, ...fromFilter, ...toFilter);

  // 生成 SQL: WHERE ... AND project_id = 'proj_xxx' AND timestamp >= ...
}
```

---

## 三、两条链路对比总表

| 维度 | 🔵 链路 A: api.dashboard.chart | 🟢 链路 B: useScheduledDashboardExecuteQuery |
|-----|-------------------------------|--------------------------------------------|
| **前端 Hook** | `api.dashboard.chart.useQuery` | `useScheduledDashboardExecuteQuery` |
| **后端 Procedure** | `dashboardRouter.chart` | `dashboardRouter.executeQuery` |
| **查询表达方式** | `queryName` 枚举（白名单） | 完整 `QueryType` 对象 |
| **前端缓存键归一化** | ❌ 无，精确到毫秒 | ✅ 按 staleTime 桶对齐 |
| **staleTime/gcTime 分档** | ❌ 使用 tRPC 默认 | ✅ 5 档按时间范围动态 |
| **并发控制** | ❌ 无 | ✅ 动态并发 + 优先级队列 |
| **v1 后端实现** | 硬编码手写 SQL | QueryBuilder 声明式 |
| **v2 后端实现** | 部分汇入 QueryBuilder | 统一 QueryBuilder |
| **project_id 注入方式** | 手动（v1） / 自动（v2） | QueryBuilder 自动强制注入 |
| **扩展性** | 差，新增需改后端代码 | 好，前端可自由组合维度指标 |
| **使用组件** | ModelUsageChart (Tab 2/4), ScoresTable | DashboardWidget + 大多数默认图表 |

---

## 四、与 ClickHouse 条件缓存的关联

### 4.1 ClickHouse 服务端查询条件缓存

**位置**：`web/src/features/query/server/queryExecutor.ts`

```typescript
const clickhouseSettings = {
  use_query_condition_cache: env.CLICKHOUSE_USE_QUERY_CONDITION_CACHE === "true",
  // 默认为 false，环境变量控制
};
```

### 4.2 两条链路与 ClickHouse 缓存的关系

| 链路 | 是否使用 ClickHouse 条件缓存 | 条件 |
|-----|---------------------------|------|
| 链路 A (chart) | ✅ v2 版本 | `version === "v2"` 且环境变量开启 |
| 链路 A (chart) | ❌ v1 版本 | 硬编码 SQL 不经过 queryExecutor |
| 链路 B (executeQuery) | ✅ 全部 | 统一经过 queryExecutor，环境变量开启 |

---

## 五、端到端时序流（两条链路并排）

```
时间轴 →

┌─────────────────────────────────────────┬─────────────────────────────────────────┐
│     🔵 链路 A: api.dashboard.chart      │    🟢 链路 B: useScheduledDashboardExecuteQuery│
├─────────────────────────────────────────┼─────────────────────────────────────────┤
│  0ms: 调用 api.dashboard.chart.useQuery│  0ms: 调用 useScheduledDashboardExecuteQuery│
│     queryName: "observations-cost-by-   │     ├─ 计算 cachePolicy (5档分档)       │
│       type-timeseries"                  │     ├─ from/to 时间桶归一化              │
│                                         │     ├─ 生成 effectiveRunKey              │
│  1ms: React Query 缓存命中检查           │     └─ 加入调度器队列                    │
│     ❌ 无归一化，相邻查询 miss          │                                         │
│                                         │  10ms: React Query 缓存命中检查          │
│  5ms: tRPC 批处理（skipBatch=false）    │     ✅ 归一化后相邻查询可能 hit          │
│                                         │                                         │
│                                         │  20ms: Scheduler 调度                   │
│                                         │     ├─ 优先级排序                        │
│                                         │     └─ 并发限制检查                      │
│                                         │                                         │
│  30ms: HTTP 请求发出                    │  30ms: HTTP 请求发出                    │
│                                         │                                         │
│  ═══════════════ 服务端 ═══════════════│  ═══════════════ 服务端 ═══════════════│
│                                         │                                         │
│  40ms: protectedProjectProcedure        │  40ms: protectedProjectProcedure        │
│         项目成员验证                      │         项目成员验证                      │
│                                         │                                         │
│  50ms: switch (queryName)               │  50ms: validateQuery()                  │
│         白名单匹配                        │         维度/指标/过滤器白名单校验       │
│                                         │                                         │
│  60ms: v1 → 硬编码 SQL                  │  60ms: QueryBuilder.build()             │
│         WHERE project_id = 'xxx'        │         ✅ 自动注入 project_id           │
│       v2 → getScoreAggregateV2          │         维度映射 → 指标映射 → JOIN       │
│                                         │                                         │
│  150ms: ClickHouse 查询执行             │  150ms: ClickHouse 查询执行             │
│         手动参数绑定                      │         queryExecutor 参数绑定           │
│         (v1 不经过 CH 缓存层)           │         ✅ use_query_condition_cache     │
│                                         │                                         │
│  ═══════════════ 前端 ═════════════════│  ═══════════════ 前端 ═════════════════│
│                                         │                                         │
│  350ms: 结果返回                        │  350ms: 结果返回                        │
│         写入 React Query 缓存            │         写入 React Query 缓存            │
│                                         │         标记 Scheduler completed        │
│                                         │                                         │
│  360ms: 组件渲染                        │  360ms: 组件渲染                        │
└─────────────────────────────────────────┴─────────────────────────────────────────┘
```

---

## 六、关键文件索引

| 模块 | 文件路径 | 核心职责 |
|------|---------|---------|
| **调度器 Hook** | `web/src/hooks/useDashboardQueryScheduler.tsx` | staleTime 分档、时间桶归一化、并发控制、优先级队列 |
| **前端 Chart API** | `web/src/features/dashboard/components/ModelUsageChart.tsx` | 两条链路混用的典型示例 |
| **前端自定义 Widget** | `web/src/features/widgets/components/DashboardWidget.tsx` | 链路 B 的典型用法，数据库驱动查询 |
| **路由入口** | `web/src/features/dashboard/server/dashboard-router.ts` | chart / executeQuery 两个 procedure 定义 |
| **权限中间件** | `web/src/server/api/trpc.ts:271` | protectedProjectProcedure 项目成员验证 |
| **参数校验** | `web/src/features/query/validateQuery.ts` | QueryType 维度/指标/过滤器白名单校验 |
| **查询执行器** | `web/src/features/query/server/queryExecutor.ts` | ClickHouse 路由、参数绑定 |
| **SQL 构建** | `web/src/features/query/server/queryBuilder.ts` | QueryBuilder 声明式构建、**project_id 强制注入** |
| **指标定义** | `web/src/features/query/dataModel.ts` | 视图声明、维度/指标契约 |
| **v1 硬编码** | `packages/shared/src/server/repositories/dashboards.ts` | 链路 A v1 版本手写 SQL 实现 |
| **看板元数据** | `packages/shared/src/server/services/DashboardService/DashboardService.ts` | Widget/Dashboard 数据库 CRUD |
