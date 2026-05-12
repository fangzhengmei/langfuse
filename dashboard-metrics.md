# Dashboard Metrics 数据通路架构

## 核心洞察：两条查询路径

Langfuse 看板系统同时存在两条独立的查询路径，最终都汇入 ClickHouse，但共享权限和隔离机制。

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
│                                           │ • 时间范围设定                  │
├───────────────────────────────────────────┼─────────────────────────────────┤
│  v1: 手写 SQL + 手动 project_id 过滤      │ v1/v2: QueryBuilder + ViewDecl │
│  v2: 汇入统一 QueryBuilder 流             │                                 │
├───────────────────────────────────────────┴─────────────────────────────────┤
│                     共享层：权限、参数校验、ClickHouse                        │
│  protectedProjectProcedure → validateQuery → queryClickhouse                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 一、默认图表路径：硬编码查询流

### 1.1 入口：DashboardRouter 内置查询

**位置**：`web/src/features/dashboard/server/dashboard-router.ts:298`

```typescript
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
  .query(async ({ input }) => {
    switch (input.queryName) {
      case "score-aggregate":
        return input.version === "v2"
          ? getScoreAggregateV2(input)   // v2: 使用 QueryBuilder
          : getScoreAggregate(input);    // v1: 硬编码 SQL
      // ... 其他查询类似
    }
  });
```

### 1.2 v1 版本：直接 SQL 拼装（遗留路径）

**位置**：`packages/shared/src/server/repositories/dashboards.ts`

```sql
-- getObservationCostByTypeByTime: 手写 SQL，绕过 QueryBuilder
SELECT 
    start_time, 
    groupArray((cost_key, cost_sum)) AS costs
FROM (
    SELECT 
        toStartOfInterval(start_time, INTERVAL N SECOND) as start_time,
        cost_key, 
        SUM(cost) AS cost_sum
    FROM observations o FINAL
    LEFT JOIN traces t ON o.trace_id = t.id  -- 可选 JOIN
    ARRAY JOIN
        mapKeys(cost_details) AS cost_key, 
        mapValues(cost_details) AS cost
    WHERE project_id = {projectId}           -- 手动注入 project_id
      AND environment = {env}                 -- 手动处理过滤
      AND t.timestamp >= {fromTimestamp}     -- 手动映射时间范围
    GROUP BY start_time, cost_key
) 
GROUP BY start_time
ORDER BY start_time ASC WITH FILL
```

**关键特征**：
- ✅ 直接在代码中写死 SQL 模板
- ✅ 绕过 QueryBuilder 和 ViewDeclaration 层
- ✅ 手动处理 Filter 映射和 project_id 注入
- ✅ 性能最优但扩展性差，新增维度需要改代码
- ❌ 不支持自定义维度和指标组合

### 1.3 v2 版本：汇入 QueryBuilder 统一流

```typescript
async function getObservationsByTypeV2(params) {
  // 1. 过滤映射：UI 字段名 → View 字段名
  const mappedFilters = mapLegacyUiTableFilterToView(
    "observations",
    params.filter,
  );

  // 2. 构造 QueryType（固定维度、固定指标）
  const query: QueryType = {
    view: "observations",
    dimensions: [{ field: "costType" }],       // 固定维度
    metrics: [{ measure: "costByType", aggregation: "sum" }],  // 固定指标
    filters: mappedFilters,
    timeDimension: { granularity: "auto" },
    fromTimestamp: fromIso,
    toTimestamp: toIso,
    orderBy: null,
  };
  
  // 3. 汇入统一执行器
  return executeQuery(params.projectId, query, "v2", true);
}
```

---

## 二、自定义指标卡片路径：声明式查询流

### 2.1 入口：executeQuery 通用端点

**位置**：`web/src/features/dashboard/server/dashboard-router.ts:420`

```typescript
executeQuery: protectedProjectProcedure
  .input(z.object({
    projectId: z.string(),
    query: QueryTypeSchema,    // 完整查询表达式，前端构造
    version: z.enum(["v1", "v2"]).default("v1"),
  }))
  .query(async ({ input }) => {
    // 1. 参数校验：维度、指标、过滤是否在视图定义中存在
    const validation = validateQuery(input.query, input.version);
    if (!validation.valid) {
      throw new InvalidRequestError(validation.reason);
    }

    // 2. 执行查询
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
  dimensions: Array<{ field: string }>;                   // 用户选择的拆分维度
  metrics: Array<{                                         // 用户选择的聚合指标
    measure: string;
    aggregation: "sum" | "avg" | "count" | "p95" | "uniq" | "histogram";
  }>;
  filters: FilterState;                                    // 用户过滤条件
  timeDimension: { granularity: "auto" | "minute" | "hour" | "day" } | null;
  fromTimestamp: ISO8601String;
  toTimestamp: ISO8601String;
  orderBy: Array<{ field: string; direction: "asc" | "desc" }> | null;
  chartConfig?: { type: string; bins?: number; row_limit?: number };
}
```

### 2.3 查询表达 → 聚合层：关键转换步骤

**位置**：`web/src/features/query/server/queryBuilder.ts`

#### 第一步：视图解析 (View Resolution)

```typescript
// QueryBuilder.build() 第 1237 行
const view = getViewDeclaration(query.view, version);
// 返回：observationsView (v1) 或 eventsObservationsView (v2)
```

#### 第二步：维度映射 + PairExpand 处理

```typescript
private mapDimensions(dimensions, view): AppliedDimension[] {
  return dimensions.map(d => {
    const dimDef = view.dimensions[d.field];
    
    // 普通维度
    if (!dimDef.pairExpand) {
      return { sql: dimDef.sql, alias: dimDef.alias };
    }
    
    // PairExpand 维度（Map 解构 → ARRAY JOIN）
    // 例如 costType、usageType
    if (dimDef.pairExpand) {
      return {
        sql: dimDef.sql,
        alias: dimDef.alias,
        pairExpand: dimDef.pairExpand,  // 标记需要 ARRAY JOIN
      };
    }
  });
}
```

#### 第三步：指标映射 + 自动依赖注入

```typescript
private mapMetrics(metrics, view): AppliedMetric[] {
  return metrics.map(m => {
    const measureDef = view.measures[m.measure];
    
    // 自动注入依赖维度（PairExpand）
    // 例如：costByType 指标自动加入 costType 维度
    if (measureDef.requiresDimension && 
        !currentDimensions.includes(measureDef.requiresDimension)) {
      this.applyAutoDimension(measureDef.requiresDimension);
    }
    
    // 聚合模板替换（@@AGG@@、@@AGG1@@ → 实际聚合函数）
    if (measureDef.aggs) {
      const substitutedSql = substituteAggTemplates(
        measureDef.sql, 
        measureDef.aggs,
        m.aggregation,  // 用户选择的聚合函数
      );
      return { sql: substitutedSql, aggregation: m.aggregation };
    }
    
    return { sql: measureDef.sql, aggregation: m.aggregation };
  });
}
```

#### 第四步：关联表自动注入

```typescript
private collectRelationTables(appliedDims, appliedMetrics, filters) {
  const relations = new Set<string>();
  
  // 维度引用的关联表（如 traceName 需要 JOIN traces）
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
  
  return Array.from(relations).map(tableName => {
    const rel = view.tableRelations[tableName];
    return `LEFT JOIN ${rel.name} ${rel.joinConditionSql}`;
  });
}
```

#### 第五步：自动注入 project_id 过滤（关键安全点！）

**位置**：`web/src/features/query/server/queryBuilder.ts:444`

```typescript
// QueryBuilder 第 444-454 行：强制注入 project_id 过滤
private buildFilterList(
  filter: FilterState,
  fromTimestamp: string,
  toTimestamp: string,
  projectId: string,  // 来自路由参数，不可篡改
  view: ViewDeclaration,
): string {
  // ...
  
  // 自动添加 project_id 过滤 —— 这是最后一道安全防线
  const projectIdFilter = createFilterFromFilterState(
    [
      {
        column: "project_id",
        type: "string",
        operator: "=",
        value: projectId,  // 从参数注入，用户无法修改
      },
    ],
    [projectIdMapping],  // 字段映射定义
  );
  
  // ...
  
  filterList.push(...projectIdFilter, ...fromFilter, ...toFilter);
  // 最终 WHERE 子句包含 AND project_id = '{projectId}'
}
```

---

## 三、自定义指标定义层：声明式契约

### 3.1 视图定义核心结构

**位置**：`web/src/features/query/dataModel.ts`

```typescript
interface ViewDeclaration {
  name: string;
  description: string;
  
  // 基础表：v1 使用 observations FINAL，v2 使用 events_core
  baseCte: string;  
  
  // 维度定义：支持 pairExpand、自定义聚合函数
  dimensions: Record<string, {
    sql: string;
    alias?: string;
    type?: string;
    unit?: string;
    relationTable?: string;  // 需要 JOIN 的表
    pairExpand?: {            // Map 拆分解聚
      valuesSql: string;
      valueAlias: string;
    };
    aggregationFunction?: string;  // 维度级聚合
  }>;
  
  // 指标定义：支持聚合模板、自动依赖注入
  measures: Record<string, {
    sql: string;
    alias?: string;
    type?: string;
    unit?: string;
    aggs?: Record<string, string>;      // 聚合模板映射
    relationTable?: string;             // 需要 JOIN 的表
    requiresDimension?: string;         // 自动依赖的维度
  }>;
  
  // JOIN 关系定义
  tableRelations: Record<string, {
    name: string;
    joinConditionSql: string;
    useFinal?: boolean;
  }>;
  
  // 内置常量过滤
  segments: Filter[];
  
  // 时间列名（用于 WITH FILL）
  timeDimension: string;
}
```

### 3.2 指标定义示例详解

```typescript
// v2 observations 视图中的指标
measures: {
  // ========== 简单计数指标 ==========
  count: {
    sql: "@@AGG@@(1)",
    aggs: { agg: "count" },
    alias: "count",
    type: "integer",
    unit: "observations",
  },
  
  // ========== Map 聚合指标 ==========
  totalTokens: {
    sql: "@@AGG1@@(usage_details)['total']",
    aggs: { agg1: "sumMap" },  // sumMap 预聚合后取 total
    alias: "totalTokens",
    type: "integer",
    unit: "tokens",
  },
  
  // ========== PairExpand 依赖指标 ==========
  costByType: {
    sql: "cost_value",          // 直接引用 ARRAY JOIN 后的值
    alias: "costByType",
    type: "decimal",
    unit: "USD",
    requiresDimension: "costType",  // 自动注入 costType 维度
  },
  
  // ========== 关联表指标 ==========
  scoresCount: {
    sql: "uniq(scores.id)",    // 需要 JOIN scores 表
    alias: "scoresCount",
    type: "integer",
    relationTable: "scores",   // 触发自动 JOIN
  },
}
```

---

## 四、端到端时序流：权限 → 参数校验 → 查询构建 → 执行

### 4.1 完整时序图

```
时间轴 →

0ms    ┌─────────────────────────────────────────────────────────┐
       │  1. HTTP Request 到达 tRPC 层                             │
       │     POST /api/trpc/dashboard.executeQuery                │
       │     Cookie: session=<JWT>                                 │
       └──────────────────┬───────────────────────────────────────┘
                          │
5ms    ┌──────────────────▼───────────────────────────────────────┐
       │  2. protectedProjectProcedure 中间件                      │
       │     (web/src/server/api/trpc.ts:271)                      │
       │                                                             │
       │     ├─ 解析 JWT → session.user.id                         │
       │     ├─ 提取 input.projectId                                 │
       │     ├─ 验证用户是项目成员：                                │
       │     │    session.user.organizations                       │
       │     │      → .flatMap(org => org.projects)                │
       │     │      → .find(project => project.id === projectId)   │
       │     ├─ Admin 旁路检查（如果是 admin 也放行）              │
       │     └─ ❌ 非成员 → TRPCError(code="UNAUTHORIZED")         │
       └──────────────────┬───────────────────────────────────────┘
                          │
30ms   ┌──────────────────▼───────────────────────────────────────┐
       │  3. validateQuery 参数校验                                 │
       │     (web/src/features/query/validateQuery.ts)             │
       │                                                             │
       │     ├─ 检查 view 是否在允许列表中                          │
       │     ├─ 检查 dimensions 每个 field 是否在 view.dimensions  │
       │     ├─ 检查 metrics 每个 measure 是否在 view.measures      │
       │     ├─ 检查 metrics.aggregation 是否与 measure.type 兼容  │
       │     ├─ 检查 filters 每个 column 是否在视图定义中           │
       │     └─ ❌ 非法 → InvalidRequestError                       │
       └──────────────────┬───────────────────────────────────────┘
                          │
50ms   ┌──────────────────▼───────────────────────────────────────┐
       │  4. executeQuery 执行器                                    │
       │     (web/src/features/query/server/queryExecutor.ts:98)   │
       │                                                             │
       │     ┌────────────────────────────────────────────────────┐│
       │     │  ❗ 关键发现：应用层 LocalCache 未在此路径使用 ❗    ││
       │     │                                                     ││
       │     │  LocalCache 实际只用于 modelMatch（模型价格匹配）  ││
       │     │  executeQuery 路径无任何缓存调用！                   ││
       │     │  唯一缓存：ClickHouse 服务端条件缓存（环境变量）    ││
       │     └────────────────────────────────────────────────────┘│
       └──────────────────┬───────────────────────────────────────┘
                          │
80ms   ┌──────────────────▼───────────────────────────────────────┐
       │  5. QueryBuilder.build() 构建阶段                          │
       │     (web/src/features/query/server/queryBuilder.ts:419)   │
       │                                                             │
       │     ├─ 解析视图定义 view = viewDeclarations[v][view]      │
       │     ├─ 映射维度 → appliedDimensions                       │
       │     ├─ 映射指标 → appliedMetrics                          │
       │     ├─ 自动注入依赖维度（requiresDimension）              │
       │     ├─ 收集关联表 JOINs                                    │
       │     ├─ 构建 ARRAY JOIN（pairExpand 维度）                │
       │     ├─ 处理过滤器 → WHERE 条件 + 参数绑定                 │
       │     ├─ ✅ 自动添加 project_id 过滤（安全关键！）           │
       │     ├─ 决策：单级 vs 两级聚合                              │
       │     ├─ 构建时间维度 WITH FILL                              │
       │     ├─ 生成 LIMIT/OFFSET                                  │
       │     └─ 最终 SQL 字符串 + parameters 对象                   │
       └──────────────────┬───────────────────────────────────────┘
                          │
150ms  ┌──────────────────▼───────────────────────────────────────┐
       │  6. ClickHouse 路由 + 服务端缓存配置                        │
       │                                                             │
       │  preferredClickhouseService =                              │
       │    view.baseCte.includes("events_")                       │
       │      ? "EventsReadOnly"  ← 读副本，分担主库压力           │
       │      : undefined                                             │
       │                                                             │
       │  clickhouseSettings: {                                      │
       │    date_time_output_format: "iso",                         │
       │    ...(env.CLICKHOUSE_USE_QUERY_CONDITION_CACHE === "true" │
       │      ? { use_query_condition_cache: "true" } : {})         │
       │                  ↖️  ClickHouse 服务端缓存开关              │
       │                  （环境变量控制，默认关闭）                 │
       │  }                                                          │
       └──────────────────┬───────────────────────────────────────┘
                          │
200ms  ┌──────────────────▼───────────────────────────────────────┐
       │  7. queryClickhouse 执行 + 重试保护                        │
       │                                                             │
       │  backOff 重试策略：                                          │
       │    numOfAttempts: env.LANGFUSE_CLICKHOUSE_QUERY_MAX_ATTEMPTS │
       │    仅重试网络错误：socket hang up、broken pipe 等           │
       │                                                             │
       │  ClickHouse 端：                                             │
       │    ├─ 如果 use_query_condition_cache=true                  │
       │    │   └─ 相同 WHERE 条件块的中间结果可复用（CH 内部）     │
       │    ├─ 预聚合数据块处理                                       │
       │    ├─ 合并聚合结果                                          │
       │    └─ WITH FILL 填充时间间隙                                │
       └──────────────────┬───────────────────────────────────────┘
                          │
350ms  ┌──────────────────▼───────────────────────────────────────┐
       │  8. 结果返回                                                 │
       │     ↪️  无应用层缓存写入！                                  │
       │                                                             │
       │  HTTP 200 OK + JSON Array                                   │
       └────────────────────────────────────────────────────────────┘
```

### 4.2 缓存命中与失效（修正版）

| 层级 | 缓存机制 | 命中条件 | 失效条件 |
|-----|---------|---------|---------|
| **前端缓存** | React Query / SWR | 相同 queryKey（前端控制） | 时间过期、手动失效、窗口刷新 |
| **应用层（Node.js）** | LocalCache LRU | ❌ **executeQuery 路径未使用** | ❌ 不适用 |
| **ClickHouse 服务端** | query condition cache | `CLICKHOUSE_USE_QUERY_CONDITION_CACHE=true` + 相同 WHERE 条件块 | CH 内存压力、配置关闭、进程重启 |

**关键修正**：
- `LocalCache` 类存在但仅用于 `modelMatch`（模型价格匹配）
- `dashboard.executeQuery` 路径**无任何应用层缓存**
- 唯一缓存是 ClickHouse 服务端的查询条件缓存，且默认关闭

### 4.3 权限分发三层安全防线

| 层级 | 位置 | 职责 |
|-----|------|------|
| **L1：tRPC 中间件** | `trpc.ts:271` | 验证用户身份、提取 session、验证项目成员资格 |
| **L2：输入校验** | `dashboard-router.ts:420` | Zod schema 校验 projectId 格式 |
| **L3：QueryBuilder 强制注入** | `queryBuilder.ts:444` | SQL 强制追加 `AND project_id = {projectId}`，用户无法绕过 |

**注意**：`executeQuery` 本身没有额外的 RBAC scope 检查（如 `dashboards:read`），只依赖 `protectedProjectProcedure` 的项目成员验证。而 `allDashboards`、`createDashboard` 等看板元数据操作会额外调用 `throwIfNoProjectAccess` 进行 RBAC 校验。

---

## 五、两条路径对比总结

| 维度 | 🟦 默认图表 (v1) | 🟩 默认图表 (v2) | 🟢 自定义卡片 |
|-----|------------------|------------------|---------------|
| **查询表达** | 硬编码 queryName | 固定 QueryType | 完整 QueryType |
| **维度组合** | 固定 1-2 个 | 固定 | 用户自由选择 |
| **指标组合** | 固定 | 固定 | 用户自由选择 |
| **经过 ViewDeclaration** | ❌ 否 | ✅ 是 | ✅ 是 |
| **经过 QueryBuilder** | ❌ 否 | ✅ 是 | ✅ 是 |
| **单级聚合优化** | ❌ 手动实现 | ✅ 自动判断 | ✅ 自动判断 |
| **应用层缓存** | ❌ 无 | ❌ 无 | ❌ 无 |
| **权限校验 L1** | ✅ 项目成员 | ✅ 项目成员 | ✅ 项目成员 |
| **权限校验 L3 (project_id)** | ✅ 手动注入 | ✅ 自动注入 | ✅ 自动注入 |
| **扩展性** | 差 | 中 | 好 |

---

## 六、关键文件索引

| 模块 | 文件路径 | 核心职责 |
|------|---------|---------|
| **入口层** | `web/src/features/dashboard/server/dashboard-router.ts` | API 路由、v1/v2 分流、默认图表调用 |
| **权限层** | `web/src/server/api/trpc.ts:271` | protectedProjectProcedure 中间件、项目成员验证 |
| **参数校验** | `web/src/features/query/validateQuery.ts` | QueryType 合法性校验 |
| **查询执行** | `web/src/features/query/server/queryExecutor.ts` | ClickHouse 路由、参数绑定、重试策略 |
| **SQL 构建** | `web/src/features/query/server/queryBuilder.ts` | 维度/指标映射、JOIN 生成、project_id 强制注入 |
| **指标定义** | `web/src/features/query/dataModel.ts` | 视图声明、维度/指标契约、聚合模板定义 |
| **过滤器兼容** | `web/src/features/query/dashboardUiTableToViewMapping.ts` | 遗留字段名映射 |
| **v1 硬编码** | `packages/shared/src/server/repositories/dashboards.ts` | Score/Cost 等默认图表 SQL 实现 |
| **缓存实现** | `packages/shared/src/server/cache/localCache.ts` | LRU 缓存（⚠️ 未用于 executeQuery） |
| **看板 CRUD** | `packages/shared/src/server/services/DashboardService/DashboardService.ts` | 看板元数据存储 |
| **ClickHouse 查询** | `packages/shared/src/server/repositories/clickhouse.ts:388` | 底层查询执行、重试、错误包装 |
