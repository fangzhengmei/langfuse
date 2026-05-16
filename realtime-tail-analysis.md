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
│  │  3. 触发时间范围重新计算 → 触发 tRPC 查询                    │  │
│  └───────────────────────────────────────────────────────────┘  │
└───────────────────────────────────┬─────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                       tRPC API 层                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  traces.all / traces.countAll / traces.metrics             │  │
│  │  events.all / events.countAll / events.metrics              │  │
│  │  ... 其他表同理                                              │  │
│  └───────────────────────────────────────────────────────────┘  │
└───────────────────────────────────┬─────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Shared 服务层 (ClickHouse)                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  getTracesTable / getTracesTableCount / getTracesTableMetrics │  │
│  │  EventsQueryBuilder → 构建 ClickHouse SQL 查询              │  │
│  │  执行查询 → 返回结果                                          │  │
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

## 四、服务端事件拉取机制

### 4.1 ClickHouse 查询构建器

**文件**：`packages/shared/src/server/queries/clickhouse-sql/event-query-builder.ts`

Langfuse 使用 **EventsQueryBuilder** 流式构建查询：

```typescript
// 核心查询构建类
export class EventsQueryBuilder extends BaseEventsQueryBuilder<typeof EVENTS_FIELDS> {
  private ioFields: { truncated: boolean; charLimit?: number } | null = null;
  
  // 选择字段集
  selectFieldSet(...setNames: Array<FieldSetName>): this;
  
  // 选择 I/O 字段（支持截断）
  selectIO(truncated: boolean = false, charLimit?: number): this;
  
  // 构建查询
  buildWithParams(): { query: string; params: Record<string, any> };
}

// 字段集定义（预定义的字段组合）
const FIELD_SETS = {
  base: ["id", "type", "projectId", "name", ...], // 基础字段
  calculated: ["latency", "timeToFirstToken"],     // 计算字段
  io: ["input", "output"],                          // I/O 字段
  metadata: ["metadata"],                           // 元数据字段
  // ... 其他字段集
};
```

### 4.2 Traces 表查询流程

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
}) => {
  // 调用泛型查询函数
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
  });

  // 转换为 UI 友好的格式
  return rows.map(convertToUiTableRows);
};

// getTracesTableGeneric 内部构建 CTE (Common Table Expression) 查询
// - traces CTE: 从 traces 表查询基础字段
// - observations_stats CTE: 聚合 observation 统计（延迟、Token 等）
// - scores_avg CTE: 聚合评分数据
```

### 4.3 双表查询策略

Langfuse 针对不同场景使用不同的 ClickHouse 表：

| 表名 | 用途 | 特点 |
|------|------|------|
| `events_core` | 列表查询、快速展示 | I/O 和 metadata 被截断，查询速度快 |
| `events_full` | 详情页、导出 | 完整数据，查询较慢 |

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

1. **第一阶段**：查询基础列表数据（`traces.all`）- 快速返回，用户立即看到结果
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
| 共享服务 | `packages/shared/src/server/services/traces-ui-table-service.ts` | Traces 表查询服务 |
| 查询构建器 | `packages/shared/src/server/queries/clickhouse-sql/event-query-builder.ts` | ClickHouse 查询构建 |
| 筛选状态 | `web/src/features/filters/hooks/useSidebarFilterState.ts` | 筛选状态管理 |

---

## 八、总结

Langfuse 的 Realtime Tail 实现了一个**简洁、实用**的实时数据追踪方案：

1. **无游标设计**：通过动态时间范围重计算实现"游标推进"，简化架构
2. **可配置轮询**：用户可选择刷新间隔，平衡实时性和系统负载
3. **分阶段加载**：先列表后指标，优化用户感知速度
4. **ClickHouse 优化**：双表策略、CTE 聚合、字段集选择等优化查询性能

这种设计非常适合 Langfuse 的使用场景——用户通常不需要亚秒级实时性，但需要灵活的筛选和聚合能力，同时服务端需要支撑高并发、大数据量的查询。
