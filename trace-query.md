# Trace 查询链路设计文档

## 概述

Langfuse 的 trace 查询系统支持三条核心链路：
1. **实时尾随 (Live Tail)** - 轮询刷新最新数据
2. **复合过滤 (Filter Composition)** - 标签、元数据、分数的多维度组合过滤
3. **查询计划 (Query Planning)** - 动态 CTE 组装与性能优化

本文档详细说明每条链路的跨文件实现、数据流、以及关键决策逻辑。

---

## 一、实时尾随链路 (Live Tail)

### 1.1 跨文件证据

| 文件路径 | 关键函数/组件 | 作用 |
|---------|--------------|------|
| `web/src/components/table/use-cases/traces.tsx:171-202` | `useSessionStorage(refreshInterval)` + `useEffect(setInterval)` | 前端刷新循环驱动 |
| `web/src/components/table/use-cases/traces.tsx:220-225` | `toAbsoluteTimeRange(timeRange)` | 动态计算时间窗口 |
| `web/src/components/table/data-table-toolbar.tsx` | `refreshConfig` 配置 | 刷新按钮与间隔选择 UI |
| `packages/shared/src/server/services/traces-ui-table-service.ts:450-462` | `ORDER BY timestamp DESC` | 按时间倒序，最新数据在顶部 |

### 1.2 数据流说明

```
用户操作: 选择刷新间隔 (5s/10s/30s/auto)
    ↓
[前端] useSessionStorage 保存 refreshInterval-${projectId}
    ↓
[前端] useEffect 启动 setInterval，每次触发 refreshTick++
    ↓
[前端] toAbsoluteTimeRange(timeRange) 重新计算 [from, to]
    ↓
[前端] 时间范围注入 dateRangeFilter → FilterState
    ↓
[tRPC] traces.all.query 携带新时间范围调用后端
    ↓
[后端] traces-ui-table-service: FilterState 转换为 ClickHouse WHERE 条件
    ↓
[ClickHouse] SELECT ... ORDER BY timestamp DESC LIMIT 50 OFFSET 0
    ↓
[前端] 新数据替换表格，实现"尾随"效果
```

### 1.3 关键实现细节

```typescript
// 刷新循环核心 (traces.tsx:189-202)
useEffect(() => {
  if (!refreshInterval) return;
  const id = setInterval(() => {
    setRefreshTick((t) => t + 1);  // 触发重渲染
  }, refreshInterval);
  return () => clearInterval(id);   // 清理定时器
}, [refreshInterval, manualRefreshTrigger]);

// 时间范围动态计算 (traces.tsx:220-225)
const tableDateRange = useMemo(() => {
  return toAbsoluteTimeRange(timeRange) ?? undefined;
}, [timeRange, refreshTick]);  // refreshTick 变化强制重新计算
```

---

## 二、复合过滤链路 (Filter Composition)

### 2.1 真实 FilterState 类型枚举

**定义来源**: `packages/shared/src/interfaces/filters.ts`

| FilterState 类型 | 适用场景 | Trace 中的落点字段 | 说明 |
|-----------------|---------|------------------|------|
| `stringOptions` | 单值多选项过滤 | `environment`, `traceName`, `level` | `IN (...)` / `NOT IN (...)` 操作 |
| `categoryOptions` | 分类分数过滤 | `score_categories` | `hasAny(array, ["name:value"])` 操作 |
| `arrayOptions` | 数组包含过滤 | `traceTags` (tags) | `hasAny` / `hasAll` / `NOT hasAny` 操作 |
| `stringObject` | 元数据嵌套键过滤 | `metadata` | `JSONExtractString(metadata, key) OP value` |
| `numberObject` | 数值分数过滤 | `scores_avg` | `arrayExists(x -> x.1 = key AND x.2 OP value, scores_avg)` |
| `datetime` | 时间范围过滤 | `timestamp` | `>=`, `<=`, `>`, `<` 操作 |
| `string` | 字符串精确/模糊过滤 | `userId`, `sessionId`, `id`, `version`, `release` | `=`, `contains`, `starts with`, `ends with` |
| `number` | 数值范围过滤 | `latency`, `inputTokens`, `totalCost` 等 | `=`, `>`, `<`, `>=`, `<=` |
| `boolean` | 布尔过滤 | `bookmarked` | `=`, `<>` 操作 |
| `null` | 空值判断 | 各 nullable 字段 | `is null`, `is not null` |

### 2.2 分数过滤的真实类型映射

| 分数类型 | 存储字段 | FilterState 类型 | ClickHouse 过滤器类 | 查询逻辑 |
|---------|---------|-----------------|-------------------|---------|
| **Numeric / Boolean** | `scores_avg` | `numberObject` | `NumberObjectFilter` | `arrayExists(x -> x.1 = key AND x.2 >= value, scores_avg)` |
| **Categorical** | `score_categories` | `categoryOptions` | `CategoryOptionsFilter` | `hasAny(score_categories, ["key:value1", "key:value2"])` |

**分数聚合 CTE 定义**: `packages/shared/src/server/services/traces-ui-table-service.ts:312-326`

```sql
WITH scores_avg AS (
  SELECT
    project_id,
    trace_id,
    -- 数值/布尔分数: tuple(name, avg_value) 数组
    groupArrayIf(
      tuple(name, avg_value),
      data_type IN ('NUMERIC', 'BOOLEAN')
    ) AS scores_avg,
    -- 分类分数: "name:value" 字符串数组，便于 hasAny 操作
    groupArrayIf(
      concat(name, ':', string_value),
      data_type = 'CATEGORICAL' AND notEmpty(string_value)
    ) AS score_categories
  FROM scores FINAL
  GROUP BY project_id, trace_id
)
```

### 2.3 跨文件证据

| 文件路径 | 关键函数/组件 | 作用 |
|---------|--------------|------|
| `packages/shared/src/interfaces/filters.ts` | `singleFilter` Zod discriminated union | FilterState 类型定义 |
| `packages/shared/src/tableDefinitions/tracesTable.ts:149-161` | `scores_avg: numberObject`, `score_categories: categoryOptions` | 列类型配置 |
| `web/src/features/filters/config/traces-config.ts:140-148` | `keyValue` facet for `score_categories`, `numericKeyValue` for `scores_avg` | 前端过滤 facet 配置 |
| `packages/shared/src/server/queries/clickhouse-sql/factory.ts:123-154` | `createFilterFromFilterState` switch 分发 | FilterState → ClickHouse Filter 转换 |
| `packages/shared/src/server/queries/clickhouse-sql/clickhouse-filter.ts:217-268` | `CategoryOptionsFilter.apply()` | 分类分数过滤 SQL 生成 |
| `packages/shared/src/server/queries/clickhouse-sql/clickhouse-filter.ts:274-350` | `StringObjectFilter`, `NumberObjectFilter` | 元数据/数值分数过滤实现 |

### 2.4 数据流说明

```
用户操作: 在侧边栏选择过滤条件
  ├─ 选择标签: tags = ["production"]
  ├─ 元数据过滤: metadata.user.plan = "premium"
  └─ 分数过滤: accuracy >= 0.8
    ↓
[前端] useSidebarFilterState 组装为 FilterState[]
  ├─ tags → type: "arrayOptions"
  ├─ metadata.user.plan → type: "stringObject", key: "user.plan"
  └─ accuracy >= 0.8 → type: "numberObject", key: "accuracy"
    ↓
[前端] 合并 dateRangeFilter + userIdFilter → 统一 FilterState
    ↓
[tRPC] traces.all.query 携带 filter 字段
    ↓
[后端] createFilterFromFilterState 分发 (factory.ts:62-154)
  ├─ arrayOptions → ArrayOptionsFilter
  ├─ stringObject → StringObjectFilter
  └─ numberObject → NumberObjectFilter (作用于 scores_avg CTE)
    ↓
[后端] FilterList.push(...) 收集所有过滤器
    ↓
[后端] FilterList.apply() → { query: "cond1 AND cond2", params: {...} }
    ↓
[ClickHouse] WHERE 子句注入，触发 observations_stats / scores_avg CTE 构建
```

### 2.5 CategoryOptionsFilter 核心实现

**文件**: `packages/shared/src/server/queries/clickhouse-sql/clickhouse-filter.ts:217-268`

```typescript
// 将 key:value 扁平化处理，使用 hasAny 高效数组操作
apply(): ClickhouseFilter {
  const uid = clickhouseCompliantRandomCharacters();
  const varName = `categoryOptionsFilter${uid}`;

  // Flatten: "parent:child" 字符串数组
  const flattenedValues: string[] = [];
  this.values.forEach((child) => {
    flattenedValues.push(`${this.key}:${child}`);  // e.g., "quality:good"
  });

  switch (this.operator) {
    case "any of":
      return {
        query: `hasAny(${fieldRef}, {${varName}: Array(String)})`,
        params: { [varName]: flattenedValues },
      };
    case "none of":
      return {
        query: `NOT hasAny(${fieldRef}, {${varName}: Array(String)})`,
        params: { [varName]: flattenedValues },
      };
  }
}
```

---

## 三、两条查询入口拆解

### 3.1 入口一: UI traces.all.query (tRPC)

**文件路径**:
- Router: `web/src/server/api/routers/traces.ts:125-150`
- Service: `packages/shared/src/server/services/traces-ui-table-service.ts`

#### 链路图

```
[前端] traces.all.query
    ↓ 输入: { projectId, filter, searchQuery, orderBy, limit, page }
[tRPC] protectedProjectProcedure
    ↓
[后端] applyCommentFilters(commentCount, commentContent)
    ↓
[后端] getTracesTable()
    ├─ 构建 filterState → createFilterFromFilterState()
    ├─ 分析过滤器引用的表: requiresObservationsJoin, requiresScoresJoin
    ├─ 构建 CTE: observations_stats, scores_avg
    ├─ 应用时间边界传播优化
    ├─ ORDER BY + LIMIT + OFFSET
    └─ convertClickhouseTracesListToDomain()
    ↓
[前端] TanStack Table 渲染
```

#### 关键代码片段 (traces-ui-table-service.ts:443-455)

```typescript
// scores_avg CTE 定义 + JOIN 条件
${requiresScoresJoin ? `LEFT JOIN scores_avg s on s.project_id = t.project_id and s.trace_id = t.id` : ""}
WHERE t.project_id = {projectId: String}
${tracesFilterRes ? `AND ${tracesFilterRes.query}` : ""}
${observationsFilter ? `AND ${observationFilterRes.query}` : ""}
${scoresFilter ? `AND ${scoresFilterRes.query}` : ""}
```

---

### 3.2 入口二: Public API /api/public/traces

**文件路径**: `web/src/features/public-api/server/traces.ts`

#### 链路图

```
[HTTP] GET /api/public/traces
    ↓ 输入: { projectId, limit, offset, userId, sessionId, traceTags, ... }
[后端] parseAndValidateZodSchema
    ↓
[后端] buildTracesBaseQuery()
    ├─ 转换 API 参数为 FilterState
    ├─ createFilterFromFilterState() → FilterList
    ├─ 分析: shouldUseSkipIndexes? (user_id/session_id/metadata)
    ├─ 决策: 使用 FINAL 还是 LIMIT 1 BY?
    ├─ 条件 CTE 组装: observations_stats? score_stats? base+io?
    ├─ 时间边界传播到关联表
    └─ 参数绑定防 SQL 注入
    ↓
[后端] queryClickhouse<TracesRow[]>()
    ↓
[后端] convertClickhouseTracesListToDomain()
    ↓
[HTTP] JSON Response 200 OK
```

#### 关键代码片段 (public-api/server/traces.ts:112-132)

```typescript
// FINAL vs LIMIT 1 BY 决策逻辑
const shouldUseSkipIndexes = filter.some(f =>
  f.clickhouseTable === "traces" &&
  ["user_id", "session_id", "metadata"].some(
    skipIndexCol => f.field.includes(skipIndexCol)
  )
);

// 方案 A: 默认使用 FINAL (CollapsingMergeTree 语义)
FROM traces FINAL

// 方案 B: 涉及 Skip Index 列时，使用 LIMIT 1 BY 去重
FROM traces
LIMIT 1 BY id, project_id
ORDER BY event_ts DESC
```

---

## 四、查询计划优化 (Query Planning)

### 4.1 核心查询架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                      WITH Clause (动态组装)                       │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  observations_stats (条件: 需要 metrics 或过滤引用)         │  │
│  │  SELECT trace_id, sum(total_cost), latency_milliseconds...│  │
│  │  FROM observations FINAL                                  │  │
│  │  WHERE start_time >= {traceTimestamp} - 5 MINUTES          │  │
│  │  GROUP BY project_id, trace_id                             │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ↓ 可选                              │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  scores_avg (条件: 需要 scores 或分数过滤)                   │  │
│  │  SELECT trace_id, scores_avg, score_categories             │  │
│  │  FROM scores FINAL                                         │  │
│  │  GROUP BY project_id, trace_id                             │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ↓ 可选                              │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  base + io (条件: 需要 input/output/metadata 大字段)       │  │
│  │  base: SELECT 轻量列 ORDER BY LIMIT (小结果集排序高效)      │  │
│  │  io: SELECT input, output, metadata                        │  │
│  │      WHERE (id, project_id) IN (SELECT id FROM base)       │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      最终 SELECT + LEFT JOIN                      │
│  SELECT t.*, o.*, s.scores_avg, s.score_categories              │
│  FROM traces t LEFT JOIN observations_stats o                   │
│  LEFT JOIN scores_avg s ON ...                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 CTE 包含决策矩阵

| 请求字段 / 过滤引用 | 需要的 CTE | 决策代码位置 |
|-------------------|-----------|------------|
| `latency`, `totalCost`, `usage_details` (metrics) | `observations_stats` | `public-api/server/traces.ts:134` |
| 过滤器引用 `observations` 表 | `observations_stats` | `public-api/server/traces.ts:121-122` |
| `scores_avg`, `score_categories` 字段 | `scores_avg` (UI) / `score_stats` (API) | `public-api/server/traces.ts:123-124` |
| 过滤器引用 `scores` 表 (numberObject/categoryOptions) | `scores_avg` | `traces-ui-table-service.ts:453` |
| `input`, `output`, `metadata` 大字段 | `base` + `io` (双层查询) | `public-api/server/traces.ts:260-354` |

### 4.3 时间边界传播优化

**常量定义**: `TRACE_TO_OBSERVATIONS_INTERVAL = 5 MINUTES`

Trace 的时间过滤器向下传播到关联表，避免全量扫描：

```sql
-- trace 过滤条件
WHERE t.timestamp >= '2024-01-01 10:00:00'

-- 传播到 observations (扩大 5 分钟窗口避免漏数据)
AND o.start_time >= '2024-01-01 10:00:00' - 5 MINUTES
AND o.start_time <= '2024-01-01 10:00:00' + 5 MINUTES
AND o.end_time <= '2024-01-01 10:00:00' + 5 MINUTES

-- 传播到 scores
AND s.timestamp >= '2024-01-01 10:00:00'
```

---

## 五、术语与真实类型对照表

| 报告术语 | 代码真实类型/类名 | 出处文件 |
|---------|-----------------|---------|
| FilterState (Discriminated Union) | `singleFilter` | `packages/shared/src/interfaces/filters.ts` |
| 数值分数过滤 | `numberObject` | `packages/shared/src/interfaces/filters.ts:73-79` |
| 分类分数过滤 | `categoryOptions` | `packages/shared/src/interfaces/filters.ts:110-116` |
| 标签过滤 | `arrayOptions` | `packages/shared/src/interfaces/filters.ts:49-65` |
| 元数据过滤 | `stringObject` | `packages/shared/src/interfaces/filters.ts:66-72` |
| 环境/名称过滤 | `stringOptions` | `packages/shared/src/interfaces/filters.ts:42-48` |
| Filter → SQL 转换工厂 | `createFilterFromFilterState` | `packages/shared/src/server/queries/clickhouse-sql/factory.ts` |
| 分类分数过滤器类 | `CategoryOptionsFilter` | `packages/shared/src/server/queries/clickhouse-sql/clickhouse-filter.ts:217-268` |
| 数值分数过滤器类 | `NumberObjectFilter` | `packages/shared/src/server/queries/clickhouse-sql/clickhouse-filter.ts` |
| 过滤器组合器 | `FilterList` | `packages/shared/src/server/queries/clickhouse-sql/clickhouse-filter.ts` |
| 分数聚合 CTE 名称 | `scores_avg` | `packages/shared/src/server/services/traces-ui-table-service.ts:312` |
| 分类分数聚合字段 | `score_categories` | `packages/shared/src/server/services/traces-ui-table-service.ts:325` |
| UI Trace 查询服务 | `getTracesTable` | `packages/shared/src/server/services/traces-ui-table-service.ts` |
| Public API 查询构建器 | `buildTracesBaseQuery` | `web/src/features/public-api/server/traces.ts` |
| Skip Index 优化列 | `user_id`, `session_id`, `metadata` | `web/src/features/public-api/server/traces.ts:113-115` |

---

## 六、性能优化要点总结

| 优化手段 | 效果 | 代价 | 关键代码位置 |
|---------|------|------|------------|
| base + io 双层查询 | 大字段 IO 减少 90%+，排序在轻量列上完成 | 查询复杂度提升 | `public-api/server/traces.ts:260-354` |
| 条件 CTE 组装 | 避免不必要的 JOIN / GROUP BY | 代码分支增加 | `public-api/server/traces.ts:134-230` |
| 时间边界传播 | cross-table 扫描范围显著缩小 | 边界值需保守估计 (±5min) | `traces-ui-table-service.ts:286-310` |
| FINAL / LIMIT 1 BY 切换 | Skip Index 利用率最大化，user_id 查询速度提升 ×100 | 极端情况下 event_ts 不是最新 | `public-api/server/traces.ts:112-132` |
| 分数聚合模式切换 | 无分数过滤时避免多层 GROUP BY | 两种路径需维护测试 | `public-api/server/traces.ts:172-230` |
| score_categories hasAny 优化 | 分类分数过滤无需 JOIN，使用原生数组操作 | 扁平化存储占用额外空间 | `traces-ui-table-service.ts:322-325` |

---

## 七、查询执行完整流程

```
1. 用户操作
   ├─ 选择时间范围 / 刷新间隔
   ├─ 设置标签/元数据/分数过滤
   ├─ 选择返回字段组
   └─ 排序/分页
      ↓
2. 前端组装
   ├─ FilterState 合并 (datetime/arrayOptions/stringObject/numberObject 等)
   ├─ 字段选择配置
   └─ tRPC / HTTP API 请求发送
      ↓
3. 后端过滤组装
   ├─ createFilterFromFilterState() → 分发表 10 种 Filter 类
   ├─ FilterList.apply() → SQL 片段 + 参数绑定
   └─ 分析过滤器引用的表 → CTE 包含决策
      ↓
4. 查询计划生成
   ├─ shouldUseSkipIndexes 决策 → FINAL vs LIMIT 1 BY
   ├─ CTE 条件组装 (observations_stats? scores_avg? base+io?)
   ├─ 时间边界传播 (±5 MINUTES 到关联表)
   ├─ ORDER BY + LIMIT + OFFSET 注入
   └─ 参数化查询防 SQL 注入
      ↓
5. ClickHouse 执行
   ├─ 分区裁剪 (timestamp)
   ├─ Skip Index 跳跃扫描 (user_id/session_id/metadata)
   ├─ CTE 物化
   ├─ LEFT JOIN 执行
   └─ 结果集返回
      ↓
6. 结果转换
   ├─ convertClickhouseTracesListToDomain()
   ├─ 分数聚合结果解构
   └─ 前端表格渲染
```
