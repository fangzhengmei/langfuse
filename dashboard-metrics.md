# Dashboard Metrics 数据通路架构

## 核心洞察：两条查询路径

Langfuse 看板系统同时存在两条独立但共享底层的查询路径，最终都汇入同一套聚合层：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           两条查询路径总览                                    │
├───────────────────────────────────────────┬─────────────────────────────────┤
│           🔵 默认图表路径                  │       🟢 自定义指标卡片路径       │
│  (Built-in Dashboard Widgets)             │  (Custom Query Cards)           │
├───────────────────────────────────────────┼─────────────────────────────────┤
│ • Score Aggregate                         │ • 维度选择 + 指标选择           │
│ • Cost by Type by Time                   │ • 可视化类型配置                 │
│ • Usage by Type by Time                  │ • 过滤条件组合                  │
│ • Traces Count                            │ • 时间范围设定                  │
├───────────────────────────────────────────┴─────────────────────────────────┤
│                              共享聚合层                                       │
│  QueryBuilder → ViewDeclarations → ClickHouse SQL → ResultSet                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 一、默认图表路径：硬编码查询流

### 1.1 入口：DashboardRouter 内置查询

**位置**：`web/src/features/dashboard/server/dashboard-router.ts`

```typescript
// 内置命名查询，前端直接按名称调用
chart: protectedProjectProcedure
  .input(z.object({
    queryName: z.enum([
      "score-aggregate",
      "observations-usage-by-type-timeseries",
      "observations-cost-by-type-timeseries",
    ]),
    filter: FilterState,
    version: z.enum(["v1", "v2"]).default("v1"),
  }))
  .query(async ({ input, ctx }) => {
    switch (input.queryName) {
      case "score-aggregate":
        return input.version === "v2" 
          ? getScoreAggregateV2(input)   // v2: 使用 QueryBuilder
          : getScoreAggregate(input);    // v1: 硬编码 SQL
      
      case "observations-cost-by-type-timeseries":
        return input.version === "v2"
          ? getObservationsByTypeV2(input)
          : getObservationCostByTypeByTime(input);
    }
  });
```

### 1.2 v1 版本：直接 SQL 拼装（遗留路径）

**位置**：`packages/shared/src/server/repositories/dashboards.ts`

```sql
-- getObservationCostByTypeByTime: 手写 SQL，不经过 ViewDeclaration
SELECT 
    start_time, 
    groupArray((cost_key, cost_sum)) AS costs
FROM (
    SELECT 
        toStartOfInterval(start_time, INTERVAL N SECOND) as start_time,
        cost_key, 
        SUM(cost) AS cost_sum
    FROM observations o FINAL
    [LEFT JOIN traces t ON o.trace_id = t.id]
    ARRAY JOIN
        mapKeys(cost_details) AS cost_key, 
        mapValues(cost_details) AS cost
    WHERE project_id = {projectId}
      [AND environment = {env}]
      [AND t.timestamp >= {traceTimestamp}]
    GROUP BY start_time, cost_key
) 
GROUP BY start_time
ORDER BY start_time ASC WITH FILL
```

**关键特征：**
- ✅ 直接在代码中写死 SQL 模板
- ✅ 绕过 QueryBuilder 和 ViewDeclaration 层
- ✅ 手动处理 Filter 映射
- ✅ 性能最优但扩展性差
- ❌ 不支持自定义维度和指标组合

### 1.3 v2 版本：汇入 QueryBuilder 统一流

```typescript
// getObservationsByTypeV2：使用 QueryExecutor
async function getObservationsByTypeV2(params) {
  const query = {
    view: "observations",        // 固定视图
    dimensions: [{ field: params.dimensionField }],  // 固定维度
    metrics: [{ 
      measure: params.metricMeasure, 
      aggregation: "sum" 
    }],
    filters: mappedFilters,
    timeDimension: { granularity: "auto" },
    fromTimestamp: fromIso,
    toTimestamp: toIso,
    orderBy: null,
  };
  
  // 汇入统一执行器
  return executeQuery(params.projectId, query, "v2", true);
}
```

---

## 二、自定义指标卡片路径：声明式查询流

### 2.1 入口：executeQuery 通用端点

```typescript
executeQuery: protectedProjectProcedure
  .input(z.object({
    projectId: z.string(),
    query: QueryTypeSchema,    // 完整查询表达式
    version: z.enum(["v1", "v2"]).default("v1"),
  }))
  .query(async ({ input }) => {
    // 参数验证
    const validation = validateQuery(input.query, input.version);
    if (!validation.valid) throw new InvalidRequestError(validation.reason);
    
    // 统一执行
    return executeQuery(
      input.projectId,
      input.query,
      input.version,
      input.version === "v2",  // enableSingleLevelOptimization
    );
  });
```

### 2.2 查询表达式结构 (QueryType)

**位置**：`web/src/features/query/types.ts`

```typescript
interface QueryType {
  view: "traces" | "observations" | "scores-numeric" | "scores-categorical";
  dimensions: Array<{ field: string }>;                   // 拆分维度
  metrics: Array<{                                         // 聚合指标
    measure: string;
    aggregation: "sum" | "avg" | "count" | "p95" | "uniq" | "histogram";
  }>;
  filters: FilterState;                                    // 过滤条件
  timeDimension: { granularity: "auto" | "minute" | "hour" | "day" } | null;
  fromTimestamp: ISO8601String;
  toTimestamp: ISO8601String;
  orderBy: Array<{ field: string; direction: "asc" | "desc" }> | null;
  chartConfig?: { type: string; bins?: number; row_limit?: number };
}
```

### 2.3 查询表达 → 聚合层：关键转换步骤

#### 第一步：视图解析 (View Resolution)

```typescript
// QueryBuilder.build()
const view = getViewDeclaration(query.view, version);
// 返回：observationsView (v1) 或 eventsObservationsView (v2)
```

#### 第二步：维度映射 (Dimension Mapping)

```typescript
private mapDimensions(dimensions, view): AppliedDimension[] {
  return dimensions.map(d => {
    const dimDef = view.dimensions[d.field];
    
    // 普通维度
    if (!dimDef.pairExpand) {
      return { sql: dimDef.sql, alias: dimDef.alias };
    }
    
    // PairExpand 维度（Map 解构）
    if (dimDef.pairExpand) {
      return {
        sql: dimDef.sql,
        alias: dimDef.alias,
        pairExpand: dimDef.pairExpand,  // 标记需要 ARRAY JOIN
      };
    }
    
    // 自定义聚合维度（如 trace name 聚合）
    if (dimDef.aggregationFunction) {
      return {
        sql: dimDef.sql,
        alias: dimDef.alias,
        aggregationFunction: dimDef.aggregationFunction,
      };
    }
  });
}
```

#### 第三步：指标映射 (Metric Mapping)

```typescript
private mapMetrics(metrics, view): AppliedMetric[] {
  return metrics.map(m => {
    const measureDef = view.measures[m.measure];
    
    // 自动注入依赖维度（PairExpand）
    if (measureDef.requiresDimension && 
        !currentDimensions.includes(measureDef.requiresDimension)) {
      // 成本查询自动加入 costType 维度
      // 用量查询自动加入 usageType 维度
      this.applyAutoDimension(measureDef.requiresDimension);
    }
    
    // 聚合模板替换
    if (measureDef.aggs) {
      // "@@AGG1@@(total_cost)" + agg1="sum" → "sum(total_cost)"
      const substitutedSql = substituteAggTemplates(
        measureDef.sql, 
        measureDef.aggs,
        m.aggregation  // 用户选择的聚合函数
      );
      return { sql: substitutedSql, aggregation: m.aggregation };
    }
    
    // 普通聚合
    return {
      sql: measureDef.sql,
      aggregation: m.aggregation,
      alias: measureDef.alias,
    };
  });
}
```

#### 第四步：关联表自动注入

```typescript
private collectRelationTables(appliedDims, appliedMetrics, filters) {
  const relations = new Set<string>();
  
  // 维度引用的关联表
  appliedDims.forEach(d => {
    if (d.relationTable) relations.add(d.relationTable);
  });
  
  // 指标引用的关联表
  appliedMetrics.forEach(m => {
    if (m.relationTable) relations.add(m.relationTable);
  });
  
  // 过滤器引用的关联表
  filters.forEach(f => {
    if (filterMapping.requiresRelation) relations.add(f.relationTable);
  });
  
  // 为每个关联表生成 JOIN 语句
  return Array.from(relations).map(tableName => {
    const rel = view.tableRelations[tableName];
    return `LEFT JOIN ${rel.name} ${rel.joinConditionSql}`;
  });
}
```

---

## 三、聚合层：两条路径的交汇点

### 3.1 统一执行入口：queryExecutor

**位置**：`web/src/features/query/server/queryExecutor.ts`

```typescript
export async function executeQuery(
  projectId: string,
  query: QueryType,
  version: ViewVersion = "v1",
  enableSingleLevelOptimization: boolean = false,
) {
  // ========== 准备阶段 ==========
  const prepared = await prepareExecuteQuery({
    projectId,
    query,
    version,
    enableSingleLevelOptimization,
  });
  // prepared 包含: compiledQuery, parameters, clickhouseSettings, tags
  
  // ========== ClickHouse 路由 ==========
  const chOpts = toClickhouseQueryOpts(prepared);
  
  // ========== 执行 ==========
  if (!prepared.usesTraceTable) {
    // 简单查询直接执行
    return queryClickhouse(chOpts);
  }
  
  // 含 trace 表的查询：带度量和超时保护
  return measureAndReturn({
    operationName: "executeQuery",
    projectId,
    input: {
      query: prepared.compiledQuery,
      params: prepared.parameters,
      fromTimestamp: prepared.fromTimestamp,
      tags: prepared.tags,
    },
    fn: async (input) => queryClickhouse({
      ...chOpts,
      query: input.query,
      params: input.params,
      tags: input.tags,
    }),
  });
}
```

### 3.2 QueryBuilder 核心：单级 vs 两级决策

```typescript
// 是否可以跳过内层查询？
private canUseSingleLevelQuery(appliedDimensions, appliedMetrics): boolean {
  // 条件 A：所有指标都有聚合模板配置 @@AGG@@
  const allMetricsHaveAggTemplates = 
    appliedMetrics.every(m => m.aggs !== undefined);
  
  // 条件 B：所有指标都是 pairExpand 依赖型（requiresDimension）
  const allMetricsArePairExpandDependent = 
    appliedMetrics.every(m => m.requiresDimension !== undefined);
  
  // 条件 C：没有维度使用自定义聚合函数
  const noCustomDimAggregation = 
    appliedDimensions.every(d => !d.aggregationFunction);
  
  return (allMetricsHaveAggTemplates || allMetricsArePairExpandDependent)
         && noCustomDimAggregation;
}
```

---

## 四、自定义指标定义层：声明式契约

### 4.1 视图定义核心结构

**位置**：`web/src/features/query/dataModel.ts`

```typescript
interface ViewDeclaration {
  name: string;
  description: string;
  
  // ========== 基础表 ==========
  baseCte: string;  // "events_core events_observations" | "observations FINAL"
  
  // ========== 维度定义 ==========
  dimensions: Record<string, {
    sql: string;           // SQL 表达式
    alias?: string;        // 别名
    type?: string;         // "string" | "number" | "string[]"
    description?: string;
    unit?: string;         // 单位 "USD" | "millisecond"
    relationTable?: string;  // 关联表名
    highCardinality?: boolean;
    explodeArray?: boolean;   // 是否需要 arrayJoin 展开
    pairExpand?: {            // Map 拆分解聚
      valuesSql: string;
      valueAlias: string;
    };
    aggregationFunction?: string;  // 维度级聚合（如 argMax）
  }>;
  
  // ========== 指标定义 ==========
  measures: Record<string, {
    sql: string;           // SQL 表达式，支持 @@AGG@@ 模板
    alias?: string;
    type?: string;         // "integer" | "decimal"
    unit?: string;         // 单位
    description?: string;
    aggs?: Record<string, string>;  // 聚合模板映射
    relationTable?: string;  // 指标来源表
    requiresDimension?: string;    // 自动依赖的维度
  }>;
  
  // ========== JOIN 关系 ==========
  tableRelations: Record<string, {
    name: string;
    joinConditionSql: string;
    timeDimension: string;
    useFinal?: boolean;
  }>;
  
  segments: Filter[];     // 内置常量过滤
  timeDimension: string;  // 时间列名
  rootEventCondition?: {  // trace 根事件优化
    column: string;
    condition: string;
  };
}
```

### 4.2 指标定义示例详解

```typescript
// v2 observations 视图中的指标
measures: {
  // ========== 简单计数指标 ==========
  count: {
    sql: "@@AGG@@(1)",
    aggs: { agg: "count" },           // 两级模式下替换为 count(1)
    alias: "count",
    type: "integer",
    unit: "observations",
  },
  
  // ========== Map 聚合指标 ==========
  totalTokens: {
    sql: "@@AGG1@@(usage_details)['total']",
    aggs: { agg1: "sumMap" },         // 两级模式：sumMap 预聚合后取 total
    alias: "totalTokens",
    type: "integer",
    unit: "tokens",
  },
  
  // ========== PairExpand 依赖指标 ==========
  costByType: {
    sql: "cost_value",                 // 直接引用 ARRAY JOIN 后的值
    alias: "costByType",
    type: "decimal",
    unit: "USD",
    requiresDimension: "costType",     // 自动注入 costType 维度
    description: "必须配合 costType 维度使用",
  },
  
  // ========== 关联表指标 ==========
  scoresCount: {
    sql: "uniq(scores.id)",            // 需要 JOIN scores 表
    alias: "scoresCount",
    type: "integer",
    relationTable: "scores",           // 触发 JOIN
  },
  
  // ========== 复杂计算指标 ==========
  outputTokensPerSecond: {
    sql: `arraySum(mapValues(
           mapFilter(x -> positionCaseInsensitive(x.1, 'output') > 0, 
                     @@AGG1@@(usage_details))
         )) / nullIf(
           date_diff('second', 
             @@AGG1@@(events_observations.completion_start_time), 
             @@AGG1@@(events_observations.end_time)
           ), 0)`,
    aggs: { agg1: "any" },
    alias: "outputTokensPerSecond",
    type: "decimal",
    unit: "tokens/s",
  },
}
```

---

## 五、端到端时序流：权限 → 缓存 → 查询 → 结果

### 5.1 完整时序图

```
时间轴 →

0ms    ┌─────────────────────────────────────────────────────────┐
       │  1. HTTP Request 到达 tRPC 层                             │
       │     POST /api/trpc/dashboard.executeQuery                │
       │     Cookie: session=<JWT>                                 │
       └──────────────────┬───────────────────────────────────────┘
                          │
5ms    ┌──────────────────▼───────────────────────────────────────┐
       │  2. 权限分发层（RBAC）                                     │
       │                                                             │
       │  protectedProjectProcedure 中间件                          │
       │    ├─ 解析 JWT → session.user.id                          │
       │    ├─ 提取 input.projectId                                 │
       │    └─ 调用 throwIfNoProjectAccess(scope)                   │
       │         ├─ 查询项目成员关系                                 │
       │         ├─ 验证角色权限: dashboards:read / dashboards:CUD │
       │         └─ ❌ 权限不足 → TRPCError(code="UNAUTHORIZED")   │
       └──────────────────┬───────────────────────────────────────┘
                          │
30ms   ┌──────────────────▼───────────────────────────────────────┐
       │  3. 参数验证层                                              │
       │                                                             │
       │  validateQuery(input.query, input.version)                 │
       │    ├─ 检查 view 是否有效                                    │
       │    ├─ 检查 dimensions 是否在视图定义中存在                │
       │    ├─ 检查 metrics.measure 是否在视图定义中存在            │
       │    ├─ 检查 metrics.aggregation 是否兼容 measure.type       │
       │    └─ 验证 filters 格式和字段合法性                        │
       └──────────────────┬───────────────────────────────────────┘
                          │
50ms   ┌──────────────────▼───────────────────────────────────────┐
       │  4. 缓存层：缓存键生成                                      │
       │                                                             │
       │  cacheKey = SHA256(                                        │
       │    JSON.stringify({                                         │
       │      projectId,                                            │
       │      query: normalizedQuery,  // 字段排序、格式标准化      │
       │      version,                                               │
       │    })                                                       │
       │  )                                                          │
       │                                                             │
       │  localCache.get(cacheKey)                                   │
       │    ├─ 🔵 缓存 HIT → 直接返回缓存结果 → 跳到步骤 10         │
       │    └─ 🟡 缓存 MISS → 继续执行                                │
       └──────────────────┬───────────────────────────────────────┘
                          │
80ms   ┌──────────────────▼───────────────────────────────────────┐
       │  5. QueryBuilder 构建阶段                                   │
       │                                                             │
       │  builder.build(query, projectId)                            │
       │    ├─ 解析视图定义 view = viewDeclarations[v][view]       │
       │    ├─ 映射维度 → appliedDimensions                         │
       │    ├─ 映射指标 → appliedMetrics                            │
       │    ├─ 自动注入依赖维度（requiresDimension）                │
       │    ├─ 收集关联表 JOINs                                      │
       │    ├─ 构建 ARRAY JOIN（pairExpand 维度）                  │
       │    ├─ 处理过滤器 → WHERE 条件 + 参数绑定                    │
       │    ├─ 自动添加 project_id 过滤 → 🔒 数据隔离               │
       │    ├─ 决策: 单级 vs 两级聚合                               │
       │    ├─ 构建时间维度 WITH FILL                               │
       │    ├─ 生成 LIMIT/OFFSET                                    │
       │    └─ 最终 SQL 字符串 + 参数对象                            │
       └──────────────────┬───────────────────────────────────────┘
                          │
150ms  ┌──────────────────▼───────────────────────────────────────┐
       │  6. ClickHouse 查询路由                                      │
       │                                                             │
       │  preferredClickhouseService =                                │
       │    view.baseCte.includes("events_")                         │
       │      ? "EventsReadOnly"  ← 读副本，分担主库压力           │
       │      : "Default"                                             │
       │                                                             │
       │  clickhouseSettings: {                                       │
       │    use_query_condition_cache: env.CLICKHOUSE_USE_CACHE      │
       │    max_bytes_before_external_group_by: "20000000000"       │
       │    date_time_output_format: "iso"                            │
       │  }                                                           │
       └──────────────────┬───────────────────────────────────────┘
                          │
200ms  ┌──────────────────▼───────────────────────────────────────┐
       │  7. ClickHouse 执行 + 内部缓存                               │
       │                                                             │
       │  query: String + params: Record                             │
       │    tags: { feature, type, kind, projectId } ← 可观测性     │
       │                                                             │
       │  ClickHouse 端:                                               │
       │    ├─ 如果 use_query_condition_cache=true                   │
       │    │   └─ 相同 WHERE 条件块的中间结果可复用                 │
       │    ├─ 预聚合数据块（按 project_id, start_time 排序）       │
       │    ├─ 合并聚合结果                                          │
       │    └─ WITH FILL 填充时间间隙                                │
       └──────────────────┬───────────────────────────────────────┘
                          │
350ms  ┌──────────────────▼───────────────────────────────────────┐
       │  8. 结果处理 + 缓存写入                                      │
       │                                                             │
       │  resultSet = clickhouseResponse.json()                     │
       │                                                             │
       │  localCache.set(cacheKey, resultSet, { ttlMs: 30000 })    │
       │              ↑ 默认 30 秒 TTL                               │
       │                                                             │
       │  记录度量指标:                                               │
       │    prometheus.increment("langfuse.query.duration_ms")      │
       │    prometheus.increment("langfuse.query.cache.hit/miss")   │
       └──────────────────┬───────────────────────────────────────┘
                          │
380ms  ┌──────────────────▼───────────────────────────────────────┐
       │  9. 结果转换（如需要）                                       │
       │                                                             │
       │  flatRows → timeseriesFormat(groupByTime)                 │
       │                                                             │
       │  直方图转换: histogram bins → chart data points           │
       └──────────────────┬───────────────────────────────────────┘
                          │
400ms  ┌──────────────────▼───────────────────────────────────────┐
       │  10. 返回响应                                               │
       │                                                             │
       │  HTTP 200 OK + JSON Array                                   │
       └────────────────────────────────────────────────────────────┘
```

### 5.2 缓存命中与失效触发条件

| 触发条件 | 结果 | 说明 |
|---------|------|------|
| **命中条件** | | |
| 相同 projectId + 相同 query 结构 + 相同 version | ✅ Cache HIT | 查询表达式必须完全匹配（字段顺序、参数值） |
| 距离上次查询 < 30 秒 | ✅ Cache HIT | 默认 TTL 30000ms |
| LocalCache 未达到 max 条目数 | ✅ Cache HIT | 默认 max = 1000 LRU |
| | | |
| **失效条件** | | |
| 时间超过 TTL（默认 30 秒） | ❌ Cache MISS | 时间窗口滑动导致失效 |
| 查询表达式任一字段变化 | ❌ Cache MISS | 维度、指标、过滤、时间范围 |
| 查询版本 v1/v2 切换 | ❌ Cache MISS | 视图定义完全不同 |
| LocalCache 内存压力驱逐条目 | ❌ Cache MISS | LRU 淘汰冷数据 |
| 进程重启 / Pod 重建 | ❌ 全量失效 | LocalCache 是内存本地缓存 |
| | | |
| **ClickHouse 层缓存** | | |
| 相同 WHERE 条件 + `use_query_condition_cache=true` | ✅ 部分命中 | ClickHouse 服务端查询条件缓存 |

### 5.3 权限分发关键节点

**位置**：`web/src/features/dashboard/server/dashboard-router.ts`

```typescript
// ========== 读取权限 ==========
allDashboards: protectedProjectProcedure
  .input(ListDashboardsInput)
  .query(async ({ ctx, input }) => {
    throwIfNoProjectAccess({
      session: ctx.session,
      projectId: input.projectId,
      scope: "dashboards:read",  // 只读
    });
    return DashboardService.listDashboards(input);
  });

// ========== 写入权限 ==========
createDashboard: protectedProjectProcedure
  .mutation(async ({ ctx, input }) => {
    throwIfNoProjectAccess({
      session: ctx.session,
      projectId: input.projectId,
      scope: "dashboards:CUD",  // 创建/更新/删除
    });
    return DashboardService.createDashboard(input);
  });

// ========== 查询执行权限 ==========
executeQuery: protectedProjectProcedure
  .query(async ({ input }) => {
    // executeQuery 本身不做额外 RBAC
    // 依赖外层 protectedProjectProcedure 已经验证的项目访问权
    // QueryBuilder 强制注入 project_id 作为数据最后防线
  });
```

**多层安全防线：**
1. **tRPC 中间件**：验证用户身份和项目成员资格
2. **RBAC Scope**：区分读/写操作权限
3. **QueryBuilder 强制注入**：所有 SQL 自动追加 `project_id = {ctx.projectId}`
4. **ClickHouse 行级**（如启用）：可额外配置 RLS

---

## 六、两条路径的对比总结

| 维度 | 🟦 默认图表 (v1) | 🟩 默认图表 (v2) | 🟢 自定义卡片 |
|-----|------------------|------------------|---------------|
| **查询表达** | 硬编码 queryName | 固定 QueryType | 完整 QueryType |
| **维度组合** | 固定 1-2 个 | 固定 | 用户自由选择 |
| **指标组合** | 固定 | 固定 | 用户自由选择 |
| **经过 ViewDeclaration** | ❌ 否 | ✅ 是 | ✅ 是 |
| **经过 QueryBuilder** | ❌ 否 | ✅ 是 | ✅ 是 |
| **单级聚合优化** | ❌ 手动 | ✅ 自动判断 | ✅ 自动判断 |
| **缓存策略** | ✅ 共用 LocalCache | ✅ 共用 | ✅ 共用 |
| **权限校验** | ✅ RBAC | ✅ RBAC | ✅ RBAC |
| **扩展性** | 差 | 中 | 好 |

---

## 七、关键文件索引

| 模块 | 文件路径 | 核心职责 |
|------|---------|---------|
| **入口层** | `web/src/features/dashboard/server/dashboard-router.ts` | API 路由、权限分发、v1/v2 分流 |
| **查询执行** | `web/src/features/query/server/queryExecutor.ts` | ClickHouse 路由、缓存接口、参数绑定 |
| **SQL 构建** | `web/src/features/query/server/queryBuilder.ts` | 维度/指标映射、JOIN 生成、单级/两级决策 |
| **指标定义** | `web/src/features/query/dataModel.ts` | 视图声明、维度/指标契约、聚合模板定义 |
| **过滤器兼容** | `web/src/features/query/dashboardUiTableToViewMapping.ts` | Legacy 字段名映射、编辑器/存储双向转换 |
| **类型契约** | `web/src/features/query/types.ts` | QueryType、aggregations、views 枚举 |
| **v1 硬编码** | `packages/shared/src/server/repositories/dashboards.ts` | Score/Cost 等默认图表 SQL 实现 |
| **缓存实现** | `packages/shared/src/server/cache/localCache.ts` | LRU 缓存、TTL、指标上报 |
| **看板 CRUD** | `packages/shared/src/server/services/DashboardService/DashboardService.ts` | 元数据存储、全局模板支持 |
