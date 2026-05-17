# Langfuse Realtime Tail 查询路径分析报告

## 概述

Langfuse 的 Realtime Tail（实时追踪）功能通过**基于时间轮询的刷新机制**实现，而非传统的游标或流推送模式。该系统主要用于 Traces、Observations、Scores、Sessions 等数据表的实时更新展示。

---

## 一、架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                        前端 (React)                              │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  1. 用户配置刷新间隔 (Off/30s/1m/5m/15m)                   │  │
│  │  2. setInterval 定时触发 refreshTick 递增                   │  │
│  │  3. 触发时间范围重计算 → 触发 tRPC 查询                    │  │
│  └───────────────────────────────────────────────────────────┘  │
└───────────────────────────────────┬─────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                       tRPC API 层                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  traces.all / traces.countAll / traces.metrics             │  │
│  │  events.all / events.countAll / events.filterOptions        │  │
│  │  ... 其他表同理                                              │  │
│  └───────────────────────────────────────────────────────────┘  │
└───────────────────────────────────┬─────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Shared 服务层 (ClickHouse)                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Traces: getTracesTable → getTracesTableGeneric → CTE       │  │
│  │  Events: getEventList → getObservationsWithModelDataFromEventsTable  │  │
│  │        → getObservationsFromEventsTableInternal → EventsQueryBuilder  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、前端刷新机制（游标推进逻辑）

### 2.1 核心组件位置

**文件**：`web/src/components/table/use-cases/traces.tsx`（及 observations 等其他表）

### 2.2 刷新间隔配置

```typescript
// 刷新间隔选项定义: web/src/components/table/data-table-refresh-button.tsx
export const REFRESH_INTERVALS = [
  { label: "Off", value: null },
  { label: "30s", value: 30_000 },
  { label: "1m", value: 60_000 },
  { label: "5m", value: 300_000 },
  { label: "15m", value: 900_000 },
] as const;

// 刷新间隔存储: 使用 sessionStorage 持久化用户选择
const [rawRefreshInterval, setRawRefreshInterval] =
  useSessionStorage<RefreshInterval>(
    `tableRefreshInterval-${projectId}`,
    null,
  );
```

### 2.3 定时触发机制

```typescript
// 刷新计数器: 每次递增触发时间范围重计算
const [refreshTick, setRefreshTick] = useState(0);
const [manualRefreshTrigger, setManualRefreshTrigger] = useState(0);

// 自动刷新: 使用 setInterval 定期触发 tick 递增
useEffect(() => {
  if (!refreshInterval) return;
  const id = setInterval(() => {
    setRefreshTick((t) => t + 1);
  }, refreshInterval);
  return () => clearInterval(id);
}, [refreshInterval, manualRefreshTrigger]);

// 手动刷新: 同时递增两个触发器
const handleRefresh = useCallback(() => {
  setRefreshTick((t) => t + 1);
  setManualRefreshTrigger((t) => t + 1);
  void Promise.all([
    utils.traces.all.invalidate(),
    utils.traces.metrics.invalidate(),
    utils.traces.countAll.invalidate(),
    // ... 其他查询失效
  ]);
}, [utils]);
```

### 2.4 时间范围游标推进（核心逻辑）

**关键概念**：Langfuse 不使用数据库游标（cursor），而是通过**动态时间范围重计算**实现"游标推进"效果。

```typescript
// 时间范围钩子: web/src/hooks/useTableDateRange.tsx
const { timeRange, setTimeRange } = useTableDateRange(projectId);

// refreshTick 变化时强制重新计算绝对时间范围
const tableDateRange = useMemo(() => {
  return toAbsoluteTimeRange(timeRange) ?? undefined;
  // refreshTick 作为依赖项，每次递增都会触发重计算
}, [timeRange, refreshTick]);

// 例如: 用户选择 "Last 1 hour"
// - 第一次查询: from = now() - 1h, to = now()
// - 30秒后刷新: from = now() - 1h, to = now() (时间窗口向前滑动)
// - 这就是 Langfuse 的"游标推进"机制
```

**时间范围转换**：`web/src/utils/date-range-utils.ts` 中的 `toAbsoluteTimeRange` 函数将相对时间（如"Last 1 hour"）转换为绝对时间戳。

---

## 三、筛选条件传递链路

### 3.1 前端筛选状态管理

**文件**：`web/src/features/filters/hooks/useSidebarFilterState.ts`

筛选条件来源包括：
1. **日期范围筛选**：从 `useTableDateRange` 获取，转换为 FilterState
2. **用户ID筛选**：外部传入的 userId 参数
3. **侧边栏筛选**：用户在 UI 中选择的各种筛选条件
4. **搜索查询**：全文搜索关键词和搜索类型

```typescript
// 筛选条件组装示例 (traces.tsx)
const dateRangeFilter: FilterState = dateRange
  ? [
      {
        column: "timestamp",
        type: "datetime",
        operator: ">=",
        value: dateRange.from,
      },
      // ... to 日期范围
    ]
  : [];

const userIdFilter: FilterState = userId
  ? [
      {
        column: "User ID",
        type: "string",
        operator: "=",
        value: userId,
      },
    ]
  : [];

// 合并所有筛选条件
const filterState: FilterState = useMemo(() => {
  return [
    ...dateRangeFilter,
    ...userIdFilter,
    ...sidebarFilterState,
    // ... 其他筛选
  ];
}, [dateRangeFilter, userIdFilter, sidebarFilterState]);
```

### 3.2 tRPC 查询参数传递

#### Traces 查询链路

**文件**：`web/src/server/api/routers/traces.ts`

```typescript
// 输入 Schema 定义
const TraceFilterOptions = z.object({
  projectId: z.string(),
  searchQuery: z.string().nullable(),
  searchType: z.array(TracingSearchType),
  filter: z.array(singleFilter).nullable(),
  orderBy: orderBy,
  ...paginationZod, // page, limit
});

// traces.all 路由
all: protectedProjectProcedure
  .input(TraceFilterOptions)
  .query(async ({ input, ctx }) => {
    // 1. 应用评论筛选（用于注解队列）
    const { filterState, hasNoMatches } = await applyCommentFilters({
      filterState: input.filter ?? [],
      prisma: ctx.prisma,
      projectId: ctx.session.projectId,
      objectType: "TRACE",
    });

    if (hasNoMatches) return { traces: [] };

    // 2. 调用共享服务层查询
    const traces = await getTracesTable({
      projectId: ctx.session.projectId,
      filter: filterState,
      searchQuery: input.searchQuery ?? undefined,
      searchType: input.searchType ?? ["id"],
      orderBy: normalizeOrderByForTable({
        orderBy: input.orderBy,
        expectedTimeColumn: "timestamp",
      }),
      limit: input.limit,
      page: input.page,
    });
    return { traces };
  }),
```

#### Events 查询链路

**文件**：`web/src/features/events/server/eventsRouter.ts`

```typescript
const GetAllEventsInput = EventsTableOptions.extend({
  ...paginationZod,
});

// events.all 路由
all: protectedProjectProcedure
  .input(GetAllEventsInput)
  .query(async ({ input, ctx }) => {
    // 1. 应用评论筛选
    const { filterState, hasNoMatches } = await applyCommentFilters({
      filterState: input.filter ?? [],
      prisma: ctx.prisma,
      projectId: ctx.session.projectId,
      objectType: "OBSERVATION",
    });

    if (hasNoMatches) {
      return { observations: [] };
    }

    // 2. 调用事件服务层
    return instrumentAsync(
      { name: "get-event-list-trpc" },
      async (span) => {
        const normalizedOrderBy = normalizeOrderByForTable({
          orderBy: input.orderBy,
          expectedTimeColumn: "startTime",
        });
        addAttributesToSpan({ span, input, orderBy: normalizedOrderBy });

        return getEventList({
          projectId: ctx.session.projectId,
          filter: filterState,
          searchQuery: input.searchQuery ?? undefined,
          searchType: input.searchType,
          orderBy: normalizedOrderBy,
          page: input.page,
          limit: input.limit,
        });
      },
    );
  }),
```

### 3.3 分页参数

Langfuse 使用**偏移分页**而非键集分页（keyset pagination）：

```typescript
// packages/shared/src/types.ts 中的 paginationZod
const paginationZod = {
  page: z.number().int().min(0),
  limit: z.number().int().min(0).max(100),
};

// 分页计算在 ClickHouse 查询中实现
// LIMIT {limit} OFFSET {page * limit}
```

---

## 四、服务端事件拉取机制（真实接口与服务调用关系）

### 4.1 Events 查询完整调用链路

#### 链路概览

```
前端 → eventsRouter.all (tRPC)
        ↓
      getEventList (eventsService.ts)
        ↓
      getObservationsWithModelDataFromEventsTable (events.ts)
        ↓
      getObservationsFromEventsTableInternal (events.ts)
        ↓
      EventsQueryBuilder → build ClickHouse SQL → execute
        ↓
      enrichObservationsWithModelData (Prisma model lookup)
        ↓
      enrichObservationsWithTraceFields
        ↓
    返回前端
```

#### Step 1: tRPC 路由层

**文件**：`web/src/features/events/server/eventsRouter.ts`

```typescript
// events.all 路由调用 getEventList
return getEventList({
  projectId: ctx.session.projectId,
  filter: filterState,
  searchQuery: input.searchQuery ?? undefined,
  searchType: input.searchType,
  orderBy: normalizedOrderBy,
  page: input.page,
  limit: input.limit,
});
```

#### Step 2: Events Service 层

**文件**：`web/src/features/events/server/eventsService.ts`

```typescript
export async function getEventList(params: GetObservationsListParams) {
  const queryOpts = {
    projectId: params.projectId,
    filter: params.filter,
    searchQuery: params.searchQuery,
    searchType: params.searchType,
    orderBy: params.orderBy,
    limit: params.limit,
    offset: (params.page - 1) * params.limit, // Page is 1-indexed (page 1 = offset 0)
    selectIOAndMetadata: false, // 列表页排除 I/O，单独通过 batchIO 端点获取
    renderingProps: { truncated: true, shouldJsonParse: false },
  };

  // 1. 从 ClickHouse 获取 observation 记录
  const observations =
    await getObservationsWithModelDataFromEventsTable(queryOpts);

  if (observations.length === 0) {
    return { observations };
  }

  // 2. 提取 trace IDs，用于后续查询 trace-level scores
  const traceIds = Array.from(
    new Set(
      observations
        .map((observation) => observation.traceId)
        .filter((traceId): traceId is string => Boolean(traceId)),
    ),
  );

  // 3. 计算时间范围边界，用于优化 scores 查询
  const minStartTime = observations.reduce(
    (min, obs) => (obs.startTime < min ? obs.startTime : min),
    observations[0].startTime,
  );
  const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
  const minTraceTimestamp = new Date(minStartTime.getTime() - TWO_DAYS_MS);

  // 4. 并行查询 observation-level 和 trace-level scores
  const [scores, traceScores] = await Promise.all([
    getScoresForObservations({
      projectId: params.projectId,
      observationIds: observations.map((observation) => observation.id),
      minTimestamp: minStartTime,
      excludeMetadata: true,
      includeHasMetadata: true,
    }),
    traceIds.length > 0
      ? getScoresForTraces({
          projectId: params.projectId,
          traceIds,
          timestamp: minTraceTimestamp,
          excludeMetadata: true,
          includeHasMetadata: true,
        })
      : Promise.resolve([]),
  ]);

  // 5. 验证和聚合 scores
  const validatedScores = filterAndValidateDbScoreList({
    scores,
    dataTypes: LISTABLE_SCORE_TYPES,
    includeHasMetadata: true,
    onParseError: traceException,
  });
  const validatedTraceScores = filterAndValidateDbScoreList({
    scores: traceScores,
    dataTypes: LISTABLE_SCORE_TYPES,
    includeHasMetadata: true,
    onParseError: traceException,
  });

  // 6. 按 observationId 和 traceId 分组
  const scoresByObservationId = new Map<string, Array<Score>>();
  for (const score of validatedScores) {
    if (!score.observationId) continue;
    const existingScores = scoresByObservationId.get(score.observationId);
    existingScores ? existingScores.push(score) : scoresByObservationId.set(score.observationId, [score]);
  }

  const scoresByTraceId = new Map<string, Array<Score>>();
  for (const score of validatedTraceScores) {
    if (!score.traceId || score.observationId) continue;
    const existingScores = scoresByTraceId.get(score.traceId);
    existingScores ? existingScores.push(score) : scoresByTraceId.set(score.traceId, [score]);
  }

  // 7. 合并数据并返回
  const observationsWithScores = observations.map((observation) => ({
    ...observation,
    scores: aggregateScores(scoresByObservationId.get(observation.id) ?? []),
    traceScores: observation.traceId
      ? aggregateScores(scoresByTraceId.get(observation.traceId) ?? [])
      : {},
  }));

  return { observations: observationsWithScores };
}
```

#### Step 3: Shared Repository 层

**文件**：`packages/shared/src/server/repositories/events.ts`

```typescript
// 主入口函数：获取带 model 数据的 observations
export const getObservationsWithModelDataFromEventsTable = async (
  opts: ObservationTableQuery,
): Promise<FullEventsObservations> => {
  // 1. 从 ClickHouse 获取原始 observation 记录
  const observationRecords =
    await getObservationsFromEventsTableInternal<ObservationsTableQueryResultWitouhtTraceFields>(
      {
        ...opts,
        select: "rows",
        tags: { kind: "list" },
      },
    );

  // 2. 用 Prisma 查询 model 定价数据并 enrich
  const withModelData: Array<EventsObservation & ObservationPriceFields> =
    await enrichObservationsWithModelData(
      observationRecords,
      opts.projectId,
      false, // parseIoAsJson
      null,  // V1 path: always enrich all fields
    );

  // 3. 添加 trace 字段（tags, name, userId）
  return enrichObservationsWithTraceFields(withModelData);
};
```

#### Step 4: 内部查询实现（真实代码）

**文件**：`packages/shared/src/server/repositories/events.ts`

```typescript
async function getObservationsFromEventsTableInternal<T>(
  opts: ObservationTableQuery & {
    select: "count" | "rows";
    selectToolData?: boolean;
    tags: Record<string, string>;
  },
): Promise<Array<T>> {
  const {
    projectId,
    filter,
    selectIOAndMetadata,
    selectToolData = true,
    renderingProps = DEFAULT_RENDERING_PROPS,
    limit,
    offset,
    orderBy,
    clickhouseConfigs,
  } = opts;

  // 1. 处理 positionInTrace 特殊筛选（按 trace 分组选择第 N 个 observation）
  const positionFilter = filter.find((f) => f.type === "positionInTrace");
  const baseFilter: typeof filter = [
    ...filter.filter((f) => f.type !== "positionInTrace"),
  ];

  // 2. 构建筛选器
  const observationsFilter = new FilterList(
    createFilterFromFilterState(
      baseFilter,
      eventsTableUiColumnDefinitions,
      eventsTableCols,
    ),
  );

  const startTimeFrom = extractTimeFilter(observationsFilter);

  // 3. 检测是否有 scores 筛选（影响 CTE 构建）
  const hasObservationScoresFilter = baseFilter.some((f) => {
    const column = f.column.toLowerCase();
    return (
      column === "scores" ||
      column === "scores_avg" ||
      column === "score_categories" ||
      column === "scores (numeric)" ||
      column === "scores (categorical)"
    );
  });
  const hasTraceScoresFilter = baseFilter.some((f) => {
    const column = f.column.toLowerCase();
    return (
      column === "trace_scores_avg" ||
      column === "trace_score_categories" ||
      column === "trace scores (numeric)" ||
      column === "trace scores (categorical)"
    );
  });

  // 4. 构建搜索条件
  const search = clickhouseSearchCondition(
    opts.searchQuery,
    opts.searchType,
    "e", // table alias
    ["span_id", "name", "trace_name", "user_id", "session_id", "trace_id"],
  );

  // 5. 构建排序条目
  const orderByEntries = orderByToEntries(
    [orderBy ?? null],
    eventsTableUiColumnDefinitions,
  );

  // 6. 初始化 EventsQueryBuilder
  const queryBuilder = new EventsQueryBuilder({ projectId });

  // 7. 选择字段集
  if (opts.select === "count") {
    queryBuilder.selectFieldSet("count");
  } else {
    queryBuilder.selectFieldSet(
      selectToolData ? "base" : "baseWithoutTools",
      "calculated",
    );
    // 真实代码：selectIO 接受两个参数
    if (selectIOAndMetadata) {
      queryBuilder
        .selectIO(
          renderingProps.truncated,
          env.LANGFUSE_SERVER_SIDE_IO_CHAR_LIMIT,
        )
        .selectFieldSet("metadata");
    }
  }

  // 8. 处理 positionInTrace CTE（真实实现：手动构建 qualifying_obs CTE）
  // 所有模式使用相同模式：按 trace 对 observations 排序，选择第 N 个
  // root/first/nthFromStart → ORDER BY start_time ASC
  // last/nthFromEnd        → ORDER BY start_time DESC
  if (positionFilter && "key" in positionFilter) {
    const key = positionFilter.key;
    const isFromEnd = key === "last" || key === "nthFromEnd";
    const direction = isFromEnd ? "DESC" : "ASC";
    const position =
      key === "last" || key === "first" || key === "root"
        ? 1
        : typeof positionFilter.value === "number"
          ? positionFilter.value
          : 1;

    // 为 CTE 构建 observation-only 筛选（无 s.* 或 t.* 引用）
    const nativeFilter = new FilterList(
      createFilterFromFilterState(
        baseFilter,
        eventsTableNativeUiColumnDefinitions,
      ),
    );
    const appliedNativeFilter = nativeFilter.apply();
    const qualifyingObsBuilder = new EventsQueryBuilder({ projectId })
      .selectRaw(
        "e.span_id",
        `ROW_NUMBER() OVER (PARTITION BY e.trace_id ORDER BY e.start_time ${direction}, e.event_ts ${direction}, e.span_id ${direction}) as _rn`,
      )
      .where(appliedNativeFilter)
      .where(search);

    // 真实调用：withCTE 方法添加 CTE
    queryBuilder.withCTE(
      "qualifying_obs",
      qualifyingObsBuilder.buildWithParams(),
    );

    // 真实调用：whereRaw 进行子查询过滤
    queryBuilder.whereRaw(
      "e.span_id IN (SELECT span_id FROM qualifying_obs WHERE _rn = {_posRn: UInt32})",
      { _posRn: Math.max(1, position) },
    );
  }

  // 9. 真实流式调用链：使用 when 条件链式调用 + withCTE + leftJoin + applyFilters + where + orderByColumns + limit
  queryBuilder
    // observation-level scores CTE
    .when(hasObservationScoresFilter, (b) =>
      b.withCTE(
        "scores_agg",
        eventsScoresAggregation({ projectId, startTimeFrom }),
      ),
    )
    // trace-level scores CTE
    .when(hasTraceScoresFilter, (b) =>
      b.withCTE(
        "trace_scores_agg",
        eventsTracesScoresAggregation({
          projectId,
          startTimeFrom,
          hasScoreAggregationFilters: true,
        }),
      ),
    )
    // JOIN observation-level scores
    .when(hasObservationScoresFilter, (b) =>
      b.leftJoin("scores_agg AS s", "ON s.observation_id = e.span_id"),
    )
    // JOIN trace-level scores
    .when(hasTraceScoresFilter, (b) =>
      b.leftJoin(
        "trace_scores_agg AS ts",
        "ON ts.trace_id = e.trace_id AND ts.project_id = e.project_id",
      ),
    )
    // 真实调用：applyFilters 应用筛选
    .applyFilters(observationsFilter)
    // 真实调用：where 应用搜索条件
    .where(search)
    // 真实调用：orderByColumns 排序（不是 orderBy）
    .when(orderByEntries.length > 0, (b) => b.orderByColumns(orderByEntries))
    // 真实调用：limit(limit, offset) 一次性传入两个参数（不是分开调用）
    .limit(limit, offset);

  // 10. 构建查询
  const { query, params } = queryBuilder.buildWithParams();

  // 11. 真实调用：measureAndReturn 性能监控 + queryClickhouse + EventsReadOnly 服务选择
  return measureAndReturn({
    operationName: "getObservationsFromEventsTableInternal",
    projectId,
    input: {
      params,
      tags: {
        ...(opts.tags ?? {}),
        feature: "tracing",
        type: "events",
        projectId,
        kind: opts.select,
        operation_name: "getObservationsTableInternal",
      },
    },
    fn: async (input) => {
      return queryClickhouse<T>({
        query,
        params: input.params,
        tags: input.tags,
        clickhouseConfigs,
        preferredClickhouseService: "EventsReadOnly",
      });
    },
  });
}
```

### 4.2 Traces 查询完整调用链路

#### 链路概览

```
前端 → tracesRouter.all (tRPC)
        ↓
      getTracesTable (traces-ui-table-service.ts)
        ↓
      getTracesTableGeneric (内部函数，构建 CTE)
        ↓
      CTE 构建 + ClickHouse 执行
        ↓
      convertToUiTableRows (格式转换)
        ↓
    返回前端
```

#### 关键函数位置

**文件**：`packages/shared/src/server/services/traces-ui-table-service.ts`

```typescript
export const getTracesTable = async (p: {
  projectId: string;
  filter: FilterState;
  searchQuery?: string;
  searchType?: TracingSearchType[];
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
  clickhouseConfigs?: ClickHouseClientConfigOptions | undefined;
}) => {
  // 调用泛型查询函数，构建 observations_stats 和 scores_avg CTE
  const rows = await getTracesTableGeneric({
    select: "rows",
    tags: { kind: "list" },
    projectId: p.projectId,
    filter: p.filter,
    searchQuery: p.searchQuery,
    searchType: p.searchType,
    orderBy: p.orderBy,
    limit: p.limit,
    page: p.page,
    clickhouseConfigs: p.clickhouseConfigs,
  });

  // 转换为 UI 友好的格式
  return rows.map(convertToUiTableRows);
};
```

**getTracesTableGeneric 实际 SQL 结构（无 traces CTE）**:

**文件**：`packages/shared/src/server/services/traces-ui-table-service.ts:286-348`

```typescript
// 1. 构建 CTE 字符串（仅包含 observations_stats 和 scores_avg）
const observationsAndScoresCTE = `
  WITH observations_stats AS (
    SELECT
      COUNT(*) AS observation_count,
      sumMap(usage_details) as usage_details,
      SUM(total_cost) AS total_cost,
      ... 其他聚合字段
      trace_id,
      project_id
    FROM observations o ${skipObservationsDedup ? "" : "FINAL"}
    WHERE o.project_id = {projectId: String}
      ... 其他过滤条件
    GROUP BY trace_id, project_id
  ),
       scores_avg AS (
         SELECT
           project_id,
           trace_id,
           groupArrayIf(tuple(name, avg_value), ...) AS scores_avg,
           groupArrayIf(concat(name, ':', string_value), ...) AS score_categories
         FROM (
                SELECT
                  project_id, trace_id, name, data_type, string_value,
                  avg(value) as avg_value
                FROM scores s FINAL
                WHERE project_id = {projectId: String}
                  ... 其他过滤条件
                GROUP BY project_id, trace_id, name, data_type, string_value
            ) tmp
         GROUP BY project_id, trace_id
       )
`;

// 2. 主查询：直接从 traces 表查询，无 traces CTE
const query = `
  ${observationsAndScoresCTE}  -- 仅注入 observations_stats 和 scores_avg

  SELECT ${sqlSelect}
  -- 主表：直接查询 traces 表（不是从 CTE 查询）
  FROM traces t  ${defaultOrder || select === "count" ? "" : "FINAL"}
  -- 有条件 JOIN：只有 metrics 查询或筛选/排序需要时才 JOIN
  ${select === "metrics" || requiresObservationsJoin ? `LEFT JOIN observations_stats o on o.project_id = t.project_id and o.trace_id = t.id` : ""}
  ${select === "metrics" || requiresScoresJoin ? `LEFT JOIN scores_avg s on s.project_id = t.project_id and s.trace_id = t.id` : ""}
  WHERE t.project_id = {projectId: String}
    ... 其他过滤、排序、分页条件
`;
```

**关键要点修正**:
1. ❌ **不存在 `traces` CTE** - 主查询直接 `FROM traces t` 查询原始表
2. ✅ **只有 2 个 CTE**: `observations_stats` 和 `scores_avg`
3. ✅ **CTE 不是无条件使用**: 只有 `select === "metrics"` 或筛选/排序涉及对应表时才 `LEFT JOIN`
4. ✅ **原始表使用 FINAL 修饰**: 非默认排序时 `traces t FINAL` 保证数据一致性

### 4.3 Traces vs Events 查询构建路径对比

| 维度 | Traces 查询 | Events 查询 |
|------|------------|------------|
| **入口函数** | `getTracesTable` | `getEventList` |
| **查询构建方式** | 直接拼接 SQL 字符串 + 多个 CTE | `EventsQueryBuilder` 流式 API + `when` 条件链式调用 |
| **主数据表** | `traces` 表 (Postgres) + 关联 ClickHouse CTE | `events_core` / `events_full`（ClickHouse，自动选择） |
| **分页索引** | 0-indexed: `offset = page * limit` | 1-indexed: `offset = (page - 1) * limit` |
| **limit 方法** | 原生 SQL `LIMIT {limit} OFFSET {offset}` | `queryBuilder.limit(limit, offset)` (单方法双参数) |
| **排序方法** | 原生 SQL `ORDER BY` 拼接 | `queryBuilder.orderByColumns(entries)` |
| **筛选应用** | 直接拼接 SQL 条件 | `queryBuilder.applyFilters(filterList)` |
| **搜索条件应用** | 直接拼接 SQL 条件 | `queryBuilder.where(searchCondition)` |
| **Score 聚合方式** | CTE 内 `scores_avg` + `LEFT JOIN` 聚合 | **2 种方式**：1) scores CTE JOIN；2) `getEventList` 中单独查询 scores 表 |
| **Observation 聚合** | CTE 内 `observations_stats` + `LEFT JOIN` | ClickHouse 行级字段，无单独聚合 |
| **Model 定价数据** | 无 | 查询后 `enrichObservationsWithModelData` 单独查询 Prisma |
| **I/O 字段策略** | 无 | 列表页不包含，`batchIO` 端点单独异步获取 |
| **特殊筛选** | 无 | `positionInTrace` 筛选：需额外 `qualifying_obs` CTE + `ROW_NUMBER() OVER (...)` |
| **评论筛选** | `applyCommentFilters` | `applyCommentFilters`（注解队列共用） |
| **性能监控** | 无封装，直接调用 | `measureAndReturn` 包裹监控 + `EventsReadOnly` ClickHouse 服务选择 |

### 4.4 双表查询策略

Langfuse 针对不同场景使用不同的 ClickHouse 表：

| 表名 | 用途 | 特点 |
|------|------|------|
| `events_core` | 列表查询、快速展示 | I/O 和 metadata 被截断，查询速度快 |
| `events_full` | 详情页、导出 | 完整数据，查询较慢 |

**文件**：`packages/shared/src/server/queries/clickhouse-sql/event-query-builder.ts`

```typescript
// EventsQueryBuilder 自动选择表
protected override getTableName(): string {
  return this.needsFullTable() ? "events_full" : "events_core";
}

private needsFullTable(): boolean {
  // 需要完整 I/O（未截断）或需要完整 metadata 时使用 events_full
  const needsFullIO = this.ioFields !== null && !this.ioFields.truncated;
  const needsFullMetadata = this.metadataExpansionKeys !== null;
  return needsFullIO || needsFullMetadata;
}
```

---

## 五、结果回传流程

### 5.1 数据拆分查询策略

为优化性能，Langfuse 采用**分阶段查询**策略：

1. **第一阶段**：查询基础列表数据（`traces.all` / `events.all`）- 快速返回，用户立即看到结果
2. **第二阶段**：查询指标数据（`traces.metrics`）- 异步加载，包含 Token、成本、延迟等聚合数据

```typescript
// 前端代码: traces.tsx
// 1. 基础列表查询（启用条件：环境筛选加载完成）
const traces = api.traces.all.useQuery(tracesAllQueryFilter, {
  enabled: environmentFilterOptions.data !== undefined,
  refetchOnMount: false,
  refetchOnWindowFocus: true,
});

// 2. 指标查询（启用条件：基础列表查询成功）
const traceMetrics = api.traces.metrics.useQuery(
  {
    projectId,
    filter: filterState,
    traceIds: traces.data?.traces.map((t) => t.id) ?? [],
  },
  {
    enabled: traces.data !== undefined,
    refetchOnMount: false,
    refetchOnWindowFocus: true,
  },
);
```

### 5.2 数据合并

**文件**：`web/src/components/table/utils/joinTableCoreAndMetrics.ts`

```typescript
// 将基础数据和指标数据按 ID 合并
const traceRowData = useMemo(
  () =>
    joinTableCoreAndMetrics<TracesCoreOutput, TraceMetricOutput>(
      traces.data?.traces,
      traceMetrics.data,
    ),
  [traces.data?.traces, traceMetrics.data],
);
```

### 5.3 tRPC 传输层

- **序列化**：使用 SuperJSON 支持 Date、BigInt 等特殊类型
- **批量请求**：tRPC 自动合并多个查询请求
- **缓存策略**：React Query 缓存 + 窗口聚焦时刷新

---

## 六、关键设计特点

### 6.1 为什么使用轮询而非 SSE/WebSocket？

| 设计选择 | 原因 |
|---------|------|
| **时间范围重计算** | 简化游标管理，避免复杂的状态同步 |
| **偏移分页** | 兼容 ClickHouse 的查询特性，实现简单 |
| **可配置刷新间隔** | 用户可根据需求选择刷新频率，平衡实时性和性能 |
| **无状态服务端** | 不需要维护长连接，简化横向扩展 |
| **现有基础设施复用** | 基于已有的 tRPC + React Query 架构，开发成本低 |

### 6.2 优化策略

1. **字段集选择**：只查询需要的字段，减少数据传输
2. **分阶段加载**：先加载列表，再加载指标，提升感知速度
3. **表选择优化**：列表使用 `events_core`（截断数据），详情使用 `events_full`
4. **CTE 聚合**：在 ClickHouse 侧预聚合 observations 和 scores 数据
5. **分区裁剪**：利用 startTime 筛选进行 ClickHouse 分区裁剪
6. **Model 数据缓存**：Prisma 查询 model 定价数据后缓存

### 6.3 局限性

1. **分页性能**：深度分页（大 page 值）时 OFFSET 性能下降
2. **刷新延迟**：最快 30 秒刷新间隔，存在延迟
3. **重复查询**：时间窗口滑动时，重复查询重叠时间范围的数据
4. **无推送**：服务器无法主动推送新数据，必须由客户端轮询

---

## 七、关键文件索引

| 层级 | 文件路径 | 功能 |
|------|---------|------|
| 前端组件 | `web/src/components/table/use-cases/traces.tsx` | Traces 表实时刷新逻辑 |
| 前端组件 | `web/src/components/table/data-table-refresh-button.tsx` | 刷新按钮和间隔配置 |
| 前端钩子 | `web/src/hooks/useTableDateRange.tsx` | 时间范围管理 |
| tRPC 路由 | `web/src/server/api/routers/traces.ts` | Traces API 路由 |
| tRPC 路由 | `web/src/features/events/server/eventsRouter.ts` | Events API 路由 |
| Events Service | `web/src/features/events/server/eventsService.ts` | Events 业务逻辑层 |
| 共享服务 | `packages/shared/src/server/services/traces-ui-table-service.ts` | Traces 表查询服务 |
| 查询构建器 | `packages/shared/src/server/queries/clickhouse-sql/event-query-builder.ts` | ClickHouse 查询构建 |
| Events Repository | `packages/shared/src/server/repositories/events.ts` | Events 数据访问层 |
| 筛选状态 | `web/src/features/filters/hooks/useSidebarFilterState.ts` | 筛选状态管理 |

---

## 八、总结

Langfuse 的 Realtime Tail 实现了一个**简洁、实用**的实时数据追踪方案：

1. **无游标设计**：通过动态时间范围重计算实现"游标推进"，简化架构
2. **可配置轮询**：用户可选择刷新间隔，平衡实时性和系统负载
3. **分阶段加载**：先列表后指标，优化用户感知速度
4. **分层架构**：tRPC 路由 → Service 层 → Repository 层 → QueryBuilder 层，职责清晰
5. **ClickHouse 优化**：双表策略、CTE 聚合、字段集选择、分区裁剪等优化查询性能

这种设计非常适合 Langfuse 的使用场景——用户通常不需要亚秒级实时性，但需要灵活的筛选和聚合能力，同时服务端需要支撑高并发、大数据量的查询。
