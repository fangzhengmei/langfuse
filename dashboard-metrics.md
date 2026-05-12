# Dashboard Metrics 数据通路架构

## 概述

Langfuse 的看板指标系统采用声明式查询模型，用户通过前端选择维度和指标，系统自动拼装成高效的 ClickHouse SQL 查询。整个数据通路分为三层：**查询拼装层**、**缓存策略层**、**自定义指标定义层**，通过权限分发确保数据隔离。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           数据通路总览                                        │
├──────────────────┐    ┌──────────────────┐    ┌─────────────────────────────┐
│  前端组件层      │    │  API 路由层      │    │  查询执行层                  │
│                  │    │                  │    │                             │
│  • Dashboard     │───▶│  • dashboard     │───▶│  • QueryBuilder             │
│    Widgets       │    │    Router        │    │  • QueryExecutor            │
│  • Filter Bar    │    │  • 权限校验      │    │  • ClickHouse 查询          │
└──────────────────┘    └──────────────────┘    └─────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────────────┐
                    │   视图声明层            │
                    │   • viewDeclarations    │
                    │   • dimensions/measures │
                    └─────────────────────────┘
```

---

## 一、查询拼装层 (Query Builder)

### 1.1 核心原理

查询拼装层将用户选择的维度、指标、过滤条件转换为高效的 ClickHouse SQL。核心入口是 `QueryBuilder` 类 (`web/src/features/query/server/queryBuilder.ts`)。

### 1.2 查询构建流程

```typescript
// 简化的查询构建流程
const builder = new QueryBuilder(chartConfig, version);
const { query, parameters } = await builder.build(queryDefinition, projectId);
```

**构建步骤：**

1. **视图解析**：根据 `view` 参数从 `viewDeclarations` 中获取对应的视图定义
2. **维度映射**：将请求的字段映射到实际的 SQL 列表达式
3. **指标聚合**：为每个指标应用指定的聚合函数
4. **过滤转换**：将前端过滤器转换为 ClickHouse WHERE 条件
5. **JOIN 处理**：根据关联的维度/指标自动添加必要的 JOIN
6. **时间粒度**：自动处理时间系列的桶划分

### 1.3 两级查询模式 (v1)

默认采用两级嵌套查询模式，确保高基数维度下的正确性：

```sql
-- 内层：按实体ID分组
SELECT 
  project_id,
  trace_id,
  any(dimension_1) as dimension_1,  -- 提取维度值
  sum(metric_1) as metric_1         -- 预聚合指标
FROM events_core e
WHERE project_id = {projectId}
  AND timestamp >= {fromTime}
GROUP BY project_id, trace_id

-- 外层：按用户维度重新聚合
SELECT 
  dimension_1,
  sum(metric_1) as sum_metric_1
FROM (inner_query)
GROUP BY dimension_1
ORDER BY sum_metric_1 DESC
```

### 1.4 单级查询优化 (v2)

当所有指标都支持单级聚合时，自动跳过内层查询以提升性能：

```typescript
// QueryBuilder 中的判断逻辑
canUseSingleLevelQuery(appliedDimensions, appliedMetrics): boolean {
  // 检查所有指标是否有 aggs 配置（支持模板替换）
  // 或是否为 pairExpand 依赖的指标
  // 同时检查维度是否有自定义聚合函数
}
```

单级查询直接在 ClickHouse 层面完成所有聚合，减少数据传输和中间计算。

### 1.5 PairExpand 模式

针对 `Map` 类型字段（如 `cost_details`、`usage_details`），支持拆分解聚：

```typescript
// dataModel.ts 中的定义
costType: {
  sql: "mapKeys(events_observations.cost_details)",
  alias: "costType",
  pairExpand: {
    valuesSql: "mapValues(events_observations.cost_details)",
    valueAlias: "cost_value",
  }
}

// 生成的 SQL 包含 ARRAY JOIN
ARRAY JOIN
  mapKeys(cost_details) AS cost_key, 
  mapValues(cost_details) AS cost
```

---

## 二、缓存策略层

系统采用多层次缓存架构，在不同粒度上减少重复查询。

### 2.1 LocalCache - 应用层 LRU 缓存

**位置**：`packages/shared/src/server/cache/localCache.ts`

**核心特性：**

```typescript
class LocalCache<V extends {}> {
  private readonly cache: LRUCache<string, V>;
  
  constructor(config: {
    namespace: string;    // 缓存命名空间
    enabled: boolean;     // 开关控制
    ttlMs: number;        // 过期时间
    max: number;          // 最大条目数
  });
  
  async getOrLoad(
    key: string, 
    loader: () => Promise<LocalCacheLoadResult<V>>
  ): Promise<LocalCacheLoadResult<V>>;
}
```

**设计要点：**
- 基于 `lru-cache` 实现，支持 TTL 自动过期
- 可配置的命名空间，不同业务域隔离
- 缓存命中/失停指标上报到 Prometheus
- Loader 模式保证缓存穿透保护

### 2.2 ClickHouse 查询条件缓存

**位置**：`queryExecutor.ts` 中 `clickhouseSettings`

```typescript
const clickhouseSettings: Record<string, string> = {
  date_time_output_format: "iso",
  ...(env.CLICKHOUSE_USE_QUERY_CONDITION_CACHE === "true"
    ? { use_query_condition_cache: "true" }
    : {}),
  max_bytes_before_external_group_by: String(
    env.CLICKHOUSE_MAX_BYTES_BEFORE_EXTERNAL_GROUP_BY,
  ),
};
```

**作用：**
- ClickHouse 服务端缓存相同 WHERE 条件的中间结果
- 特别适用于高并发的看板查询场景
- 通过环境变量控制开关

### 2.3 缓存标签体系

所有 ClickHouse 查询携带结构化标签：

```typescript
tags: {
  feature: "custom-queries",  // "dashboard" for built-in widgets
  type: query.view,           // traces / observations / scores-numeric
  kind: "analytic",           // analytic type query
  projectId,
}
```

---

## 三、自定义指标定义层

指标定义采用声明式配置，集中管理所有支持的维度和指标。

### 3.1 视图定义结构

**位置**：`web/src/features/query/dataModel.ts`

```typescript
export const viewDeclarations: VersionedViewDeclarations = {
  v1: {
    traces: traceView,                   // 基于 traces 表
    observations: observationsView,      // 基于 observations 表
    "scores-numeric": scoresNumericView,
    "scores-categorical": scoresCategoricalView,
  },
  v2: {
    traces: eventsTracesView,            // 基于 events_core 表聚合 trace
    observations: eventsObservationsView,// 基于 events_core 表
    "scores-numeric": scoresNumericViewV2,
    "scores-categorical": scoresCategoricalViewV2,
  },
};
```

### 3.2 单个视图声明范例

```typescript
const eventsObservationsView: ViewDeclarationType = {
  name: "events_observations",
  description: "Observations 视图 v2 版本，基于 events_core 表",
  baseCte: "events_core events_observations",  // 基础查询表达式
  
  // 维度定义
  dimensions: {
    name: {
      sql: "events_observations.name",
      alias: "name",
      type: "string",
      description: "观察名称",
    },
    providedModelName: {
      sql: "nullIf(events_observations.provided_model_name, '')",
      alias: "providedModelName",
      type: "string",
      description: "模型名称",
    },
    // PairExpand 维度示例
    costType: {
      sql: "mapKeys(events_observations.cost_details)",
      alias: "costType",
      type: "string",
      description: "成本分类键",
      pairExpand: {
        valuesSql: "mapValues(events_observations.cost_details)",
        valueAlias: "cost_value",
      },
    },
  },
  
  // 指标定义
  measures: {
    count: {
      sql: "@@AGG@@(1)",
      aggs: { agg: "count" },  // 聚合模板
      alias: "count",
      type: "integer",
      unit: "observations",
      description: "总观察数",
    },
    totalCost: {
      sql: "@@AGG1@@(toNullable(total_cost))",
      aggs: { agg1: "sum" },
      alias: "totalCost",
      type: "decimal",
      unit: "USD",
      description: "总成本",
    },
    // 依赖 pairExpand 维度的指标示例
    costByType: {
      sql: "cost_value",
      alias: "costByType",
      type: "decimal",
      unit: "USD",
      requiresDimension: "costType",  // 自动依赖
      description: "按分类汇总成本",
    },
  },
  
  // JOIN 关系定义
  tableRelations: {
    scores: {
      name: "scores",
      joinConditionSql: "ON events_observations.span_id = scores.observation_id",
      timeDimension: "timestamp",
    },
  },
  
  segments: [],           // 常量过滤条件
  timeDimension: "start_time",  // 时间维度列名
};
```

### 3.3 v1 vs v2 视图差异

| 特性 | v1 视图 | v2 视图 |
|------|---------|---------|
| **基础表** | traces / observations 独立表 | events_core 单表 |
| **JOIN 方式** | 多表 JOIN 关联 | 自包含或轻量 JOIN |
| **聚合模板** | 无 | `@@AGG@@` 模板替换 |
| **PairExpand** | 不支持 | 支持 costType / usageType |
| **根事件条件** | 无 | 支持 trace 根事件过滤 |
| **性能** | 高基数下较慢 | 写入时预聚合，查询更快 |

### 3.4 支持的聚合函数

在 `types.ts` 中定义：

```typescript
export const metricAggregations = z.enum([
  "sum",      // 求和
  "avg",      // 平均
  "count",    // 计数
  "max",      // 最大值
  "min",      // 最小值
  "p50",      // 中位数
  "p75",      // 75分位
  "p90",      // 90分位
  "p95",      // 95分位
  "p99",      // 99分位
  "histogram",// 直方图
  "uniq",     // 去重计数
]);
```

---

## 四、过滤器映射与兼容性

### 4.1 过滤器兼容层

**位置**：`web/src/features/query/dashboardUiTableToViewMapping.ts`

处理三种 legacy 过滤器格式：
1. 用户可见的显示标签（如 "Model"）
2. UI Table ID 标识符（如 "model"）
3. 显式别名（如 "Tool Names"）

```typescript
// 映射配置范例
observations: [
  defineField(
    "providedModelName",
    sourceSpec("Model", { uiTableId: "model" }),  // 视图字段 → UI 映射
  ),
  // ...
],
```

### 4.2 过滤器转换流程

```
前端过滤器 (column="Model")
        │
        ▼
  查找映射定义
        │
        ▼
  替换为视图字段名 (providedModelName)
        │
        ▼
  FilterList 应用 → ClickHouse WHERE 条件
```

---

## 五、默认指标图表实现

### 5.1 分数聚合 (Score Aggregate)

**位置**：`packages/shared/src/server/repositories/dashboards.ts`

```sql
SELECT 
  s.name,
  count(*) as count,
  avg(s.value) as avg_value,
  s.source,
  s.data_type
FROM scores s FINAL 
[LEFT JOIN traces t FINAL ON t.id = s.trace_id]
WHERE s.project_id = {projectId}
  [AND t.timestamp >= {tracesTimestamp}]
GROUP BY s.name, s.source, s.data_type
ORDER BY count(*) DESC
```

### 5.2 成本时间序列 (Cost by Type by Time)

```sql
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
    GROUP BY start_time, cost_key
) 
GROUP BY start_time
ORDER BY start_time ASC WITH FILL
```

### 5.3 时间桶自动选择

`orderByTimeSeries` 函数根据时间范围自动选择合适的粒度：

```typescript
const potentialBucketSizesSeconds = [
  5, 10, 30, 60, 300, 600, 1800, 3600, 
  18000, 36000, 86400, 604800, 2592000,
];

// 目标约 50 个数据点
const bucketSize = closestBucketSizeTo50Points;
```

---

## 六、权限分发与项目隔离

### 6.1 路由层权限校验

**位置**：`web/src/features/dashboard/server/dashboard-router.ts`

```typescript
// 所有 Dashboard 接口都经过受保护的 tRPC 过程
protectedProjectProcedure
  .input(...)
  .query(async ({ input, ctx }) => {
    // 第一步：RBAC 检查
    throwIfNoProjectAccess({
      session: ctx.session,
      projectId: input.projectId,
      scope: "dashboards:read", // 或 "dashboards:CUD"
    });
    
    // 第二步：业务逻辑执行
    return DashboardService.getDashboard(
      input.dashboardId,
      input.projectId,
    );
  });
```

### 6.2 查询层项目隔离

每个查询在 WHERE 子句中强制添加 `project_id` 过滤：

```typescript
// QueryBuilder.build() 中自动添加
const allWhereClauses = [
  "e.project_id = {projectId: String}",  // 自动添加
  ...userFilters,
];
```

### 6.3 DashboardService 数据隔离

PostgreSQL 层面的访问控制：

```typescript
// DashboardService.getDashboard
where: {
  id: dashboardId,
  OR: [{ projectId }, { projectId: null }],  // 支持全局模板
}
```

- `projectId = null`：Langfuse 全局默认看板
- `projectId = 用户项目`：用户自定义看板
- 两者通过 OR 联合查询，确保用户可见范围正确

---

## 七、端到端数据流示例

### 7.1 "Total Cost by Model" 查询

**用户输入：**
- 视图：observations (v2)
- 维度：providedModelName
- 指标：totalCost / sum
- 时间范围：过去 7 天

**执行路径：**

```
1. 前端发送 executeQuery 请求
     │
     ▼
2. dashboardRouter 权限校验
     │
     ▼
3. QueryExecutor 准备
   ├─ 确定版本 v1/v2
   ├─ 选择 ClickHouse 服务端点
   └─ 设置查询标签
     │
     ▼
4. QueryBuilder.build()
   ├─ 解析视图定义：eventsObservationsView
   ├─ 映射维度：providedModelName → 对应 SQL 表达式
   ├─ 映射指标：totalCost / sum → @@AGG1@@ 模板替换
   ├─ 添加时间过滤：start_time >= {from}
   ├─ 自动添加 project_id 过滤
   ├─ 判断是否可用单级查询（此处可用）
   └─ 生成最终 SQL
     │
     ▼
5. ClickHouse 执行
   ├─ 应用查询条件缓存
   ├─ 按 model 分组聚合 cost
   └─ 返回结果
     │
     ▼
6. 前端渲染图表
```

**生成的 SQL (v2)：**

```sql
SELECT 
  nullIf(events_observations.provided_model_name, '') as providedModelName,
  sum(toNullable(total_cost)) as sum_totalCost
FROM events_core events_observations
WHERE project_id = {projectId: String}
  AND start_time >= {fromTime: DateTime64(3)}
  AND start_time <= {toTime: DateTime64(3)}
GROUP BY providedModelName
ORDER BY sum_totalCost DESC
```

---

## 八、关键文件索引

| 层级 | 文件路径 | 职责 |
|------|---------|------|
| **API 层** | `web/src/features/dashboard/server/dashboard-router.ts` | Dashboard tRPC 路由 |
| | `web/src/features/query/server/queryExecutor.ts` | 查询执行入口 |
| **查询构建** | `web/src/features/query/server/queryBuilder.ts` | SQL 拼装核心 |
| **视图定义** | `web/src/features/query/dataModel.ts` | 维度/指标声明 |
| **类型定义** | `web/src/features/query/types.ts` | QueryType, aggregations |
| **过滤器映射** | `web/src/features/query/dashboardUiTableToViewMapping.ts` | Legacy 兼容层 |
| **缓存** | `packages/shared/src/server/cache/localCache.ts` | LRU 缓存实现 |
| **看板服务** | `packages/shared/src/server/services/DashboardService/` | Dashboard CRUD |
| **默认查询** | `packages/shared/src/server/repositories/dashboards.ts` | Score/Cost 内置查询 |

---

## 九、性能优化要点

1. **版本选择**：优先使用 v2 视图，基于 events_core 表性能更优
2. **单级查询**：满足条件时自动启用，减少内层高基数分组
3. **时间范围**：窄时间范围启用 rootEventCondition 子查询优化
4. **ClickHouse 配置**：合理设置 `max_bytes_before_external_group_by`
5. **查询缓存**：高并发看板开启 `use_query_condition_cache`
6. **时间粒度**：自动桶大小选择保证约 50 个数据点，平衡精度和性能
