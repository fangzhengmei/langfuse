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

#### 3.1.1 返回字段映射表

**metrics SELECT (`select="metrics"`) - 15 字段**

| 字段名 | 来源表/CTE | SQL 别名表达式 | 代码位置 |
|-------|----------|--------------|---------|
| `id` | `traces` (t) | `t.id as id` | `traces-ui-table-service.ts:363` |
| `project_id` | `traces` (t) | `t.project_id as project_id` | `traces-ui-table-service.ts:364` |
| `timestamp` | `traces` (t) | `t.timestamp as timestamp` | `traces-ui-table-service.ts:365` |
| `latency` | `observations_stats` (o) | `o.latency_milliseconds / 1000 as latency` | `traces-ui-table-service.ts:366` |
| `cost_details` | `observations_stats` (o) | `o.cost_details as cost_details` | `traces-ui-table-service.ts:367` |
| `usage_details` | `observations_stats` (o) | `o.usage_details as usage_details` | `traces-ui-table-service.ts:368` |
| `level` | `observations_stats` (o) | `o.aggregated_level as level` | `traces-ui-table-service.ts:369` |
| `error_count` | `observations_stats` (o) | `o.error_count as error_count` | `traces-ui-table-service.ts:370` |
| `warning_count` | `observations_stats` (o) | `o.warning_count as warning_count` | `traces-ui-table-service.ts:371` |
| `default_count` | `observations_stats` (o) | `o.default_count as default_count` | `traces-ui-table-service.ts:372` |
| `debug_count` | `observations_stats` (o) | `o.debug_count as debug_count` | `traces-ui-table-service.ts:373` |
| `observation_count` | `observations_stats` (o) | `o.observation_count as observation_count` | `traces-ui-table-service.ts:374` |
| `scores_avg` | `scores_avg` (s) | `s.scores_avg as scores_avg` | `traces-ui-table-service.ts:375` |
| `score_categories` | `scores_avg` (s) | `s.score_categories as score_categories` | `traces-ui-table-service.ts:376` |
| `public` | `traces` (t) | `t.public as public` | `traces-ui-table-service.ts:377` |

**rows SELECT (`select="rows"`) - 12 字段**

| 字段名 | 来源表/CTE | SQL 别名表达式 | 代码位置 |
|-------|----------|--------------|---------|
| `id` | `traces` (t) | `t.id as id` | `traces-ui-table-service.ts:381` |
| `project_id` | `traces` (t) | `t.project_id as project_id` | `traces-ui-table-service.ts:382` |
| `timestamp` | `traces` (t) | `t.timestamp as timestamp` | `traces-ui-table-service.ts:383` |
| `tags` | `traces` (t) | `t.tags as tags` | `traces-ui-table-service.ts:384` |
| `bookmarked` | `traces` (t) | `t.bookmarked as bookmarked` | `traces-ui-table-service.ts:385` |
| `name` | `traces` (t) | `t.name as name` | `traces-ui-table-service.ts:386` |
| `release` | `traces` (t) | `t.release as release` | `traces-ui-table-service.ts:387` |
| `version` | `traces` (t) | `t.version as version` | `traces-ui-table-service.ts:388` |
| `user_id` | `traces` (t) | `t.user_id as user_id` | `traces-ui-table-service.ts:389` |
| `environment` | `traces` (t) | `t.environment as environment` | `traces-ui-table-service.ts:390` |
| `session_id` | `traces` (t) | `t.session_id as session_id` | `traces-ui-table-service.ts:391` |
| `public` | `traces` (t) | `t.public as public` | `traces-ui-table-service.ts:392` |

> **注意事项**:
> - `calculatedTotalCost` 字段 **不存在**于后端 SQL SELECT 中，该字段由后续 `convertToUITableMetrics` 函数从 `cost_details.total` 转换计算得出
> - metrics SELECT 中的 level 字段别名是 `level` 而非 `aggregated_level`
> - rows SELECT 不包含任何 metrics 或 scores 字段，仅从 traces 表查询

#### 3.1.2 CTE 触发条件

| CTE 名称 | 触发条件 | 代码位置 |
|---------|---------|---------|
| `observations_stats` | `select === "metrics"` OR `requiresObservationsJoin=true` (过滤器引用 observations 表) | `traces-ui-table-service.ts:286-310, 451-452` |
| `scores_avg` | `select === "metrics"` OR `requiresScoresJoin=true` (过滤器引用 scores 表) | `traces-ui-table-service.ts:312-326, 452-453` |

#### 3.1.3 关键代码片段

**SELECT 分支逻辑** (`traces-ui-table-service.ts:356-402`):

```typescript
switch (select) {
  case "count":
    sqlSelect = "uniqExact(t.id) as count";
    break;
  case "metrics":
    sqlSelect = `
      t.id as id,
      t.project_id as project_id,
      t.timestamp as timestamp,
      o.latency_milliseconds / 1000 as latency,
      o.cost_details as cost_details,
      o.usage_details as usage_details,
      o.aggregated_level as level,
      o.error_count as error_count,
      o.warning_count as warning_count,
      o.default_count as default_count,
      o.debug_count as debug_count,
      o.observation_count as observation_count,
      s.scores_avg as scores_avg,
      s.score_categories as score_categories,
      t.public as public`;
    break;
  case "rows":
    sqlSelect = `
      t.id as id,
      t.project_id as project_id,
      t.timestamp as timestamp,
      t.tags as tags,
      t.bookmarked as bookmarked,
      t.name as name,
      t.release as release,
      t.version as version,
      t.user_id as user_id,
      t.environment as environment,
      t.session_id as session_id,
      t.public as public`;
    break;
  case "identifiers":
    sqlSelect = `t.id as id, t.project_id as projectId, t.timestamp as timestamp`;
    break;
}
```

**JOIN 条件** (`traces-ui-table-service.ts:451-453`):

```typescript
FROM traces t ${defaultOrder || select === "count" ? "" : "FINAL"}
${select === "metrics" || requiresObservationsJoin ?
  `LEFT JOIN observations_stats o on o.project_id = t.project_id and o.trace_id = t.id` : ""}
${select === "metrics" || requiresScoresJoin ?
  `LEFT JOIN scores_avg s on s.project_id = t.project_id and s.trace_id = t.id` : ""}
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

#### 3.2.1 返回字段映射表

| 字段名 | 来源表/CTE | 是否可选 | 受影响的开关/过滤器 | 代码位置 |
|-------|----------|---------|--------------------|---------|
| **核心字段 (coreSelect)** | | | | |
| `id` | `traces` (t) / `base` (b) | ❌ 必选 | 始终返回 | `public-api/server/traces.ts:260-274` |
| `project_id` | `traces` (t) / `base` (b) | ❌ 必选 | 始终返回 | `public-api/server/traces.ts:262` |
| `timestamp` | `traces` (t) / `base` (b) | ❌ 必选 | 始终返回 | `public-api/server/traces.ts:263` |
| `name` | `traces` (t) / `base` (b) | ✅ 可选 | 始终返回 | `public-api/server/traces.ts:264` |
| `environment` | `traces` (t) / `base` (b) | ✅ 可选 | 始终返回 | `public-api/server/traces.ts:265` |
| `session_id` | `traces` (t) / `base` (b) | ✅ 可选 | 始终返回 | `public-api/server/traces.ts:266` |
| `user_id` | `traces` (t) / `base` (b) | ✅ 可选 | 始终返回 | `public-api/server/traces.ts:267` |
| `release` | `traces` (t) / `base` (b) | ✅ 可选 | 始终返回 | `public-api/server/traces.ts:268` |
| `version` | `traces` (t) / `base` (b) | ✅ 可选 | 始终返回 | `public-api/server/traces.ts:269` |
| `bookmarked` | `traces` (t) / `base` (b) | ✅ 可选 | 始终返回 | `public-api/server/traces.ts:270` |
| `public` | `traces` (t) / `base` (b) | ❌ 必选 | 始终返回 | `public-api/server/traces.ts:271` |
| `tags` | `traces` (t) / `base` (b) | ✅ 可选 | 始终返回 | `public-api/server/traces.ts:272` |
| `created_at` | `traces` (t) / `base` (b) | ❌ 必选 | 始终返回 | `public-api/server/traces.ts:273` |
| `updated_at` | `traces` (t) / `base` (b) | ❌ 必选 | 始终返回 | `public-api/server/traces.ts:274` |
| `htmlPath` | 动态拼接 | ❌ 必选 | 始终返回 | `public-api/server/traces.ts:331` |
| **IO 字段 (双层查询)** | | | | |
| `input` | `io` CTE (i) | ✅ 可选 | `includeIO=true` | `public-api/server/traces.ts:345` |
| `output` | `io` CTE (i) | ✅ 可选 | `includeIO=true` | `public-api/server/traces.ts:346` |
| `metadata` | `io` CTE (i) | ✅ 可选 | `includeIO=true` | `public-api/server/traces.ts:347` |
| **Metrics 字段** | | | | |
| `latency` | `observation_stats` (o) | ✅ 可选 | `includeMetrics=true` | `public-api/server/traces.ts:281, 350` |
| `totalCost` | `observation_stats` (o) | ✅ 可选 | `includeMetrics=true` | `public-api/server/traces.ts:281, 350` |
| **关联 ID 字段** | | | | |
| `scores` | `score_stats` (s) | ✅ 可选 | `includeScores=true` → `score_ids` | `public-api/server/traces.ts:276, 348` |
| `observations` | `observation_stats` (o) | ✅ 可选 | `includeObservations=true` → `observation_ids` | `public-api/server/traces.ts:277-278, 349` |

#### 3.2.2 CTE 触发条件

| CTE 名称 | 触发条件 | 代码位置 |
|---------|---------|---------|
| `observation_stats` | `includeObservations=true` OR `includeMetrics=true` OR 过滤器引用 observations 表 | `public-api/server/traces.ts:134-170` |
| `score_stats` | `includeScores=true` OR 过滤器引用 scores 表 | `public-api/server/traces.ts:172-230` |
| `base` | `includeIO=true` (分页在轻量列上执行) | `public-api/server/traces.ts:300-312` |
| `io` | `includeIO=true` (只对结果集取大字段) | `public-api/server/traces.ts:314-326` |

#### 3.2.3 关键代码片段

**FINAL vs LIMIT 1 BY 决策逻辑** (`public-api/server/traces.ts:112-127`):

```typescript
const shouldUseSkipIndexes = filter.some(f =>
  f.clickhouseTable === "traces" &&
  ["user_id", "session_id", "metadata"].some(
    skipIndexCol => f.field.includes(skipIndexCol)
  )
);

// 方案 A: 不涉及 Skip Index，使用 FINAL (CollapsingMergeTree 语义)
FROM traces FINAL

// 方案 B: 涉及 Skip Index 列时，使用 LIMIT 1 BY 去重
FROM traces
LIMIT 1 BY id, project_id
ORDER BY event_ts DESC
```

**Base + IO 双层查询** (`public-api/server/traces.ts:300-354`):

```typescript
if (select.includeIO) {
  // base: 排序/分页只在轻量列上执行，性能优化
  ctes.push(`base AS (
    SELECT ${coreSelect} ${scoresSelect} ${observationsSelect} ${metricsSelect}
    ${queryMiddle} ${chOrderBy} ${limitByClause} ${paginationClause}
  )`);

  // io: 只对结果集取大字段 (input/output/metadata)
  ctes.push(`io AS (
    SELECT id as _io_id, project_id as _io_project_id, input, output, metadata
    FROM traces ${ioFinal}
    WHERE project_id = {projectId: String}
    AND (id, project_id) IN (SELECT id, project_id FROM base)
    ${ioDedup}
  )`);

  // 最终 JOIN base 和 io
  query = `WITH ${ctes.join(", ")}
    SELECT b.*, i.input, i.output, i.metadata
    FROM base b LEFT JOIN io i ON b.id = i._io_id AND b.project_id = i._io_project_id
    ${finalOrderBy}
  `;
}
```

---

### 3.3 两条入口对比说明

| 维度 | UI traces.all.query (tRPC) | Public API /api/public/traces | 原因说明 |
|-----|---------------------------|-------------------------------|---------|
| **核心字段集** | 13 个字段 | 15 个字段 | Public API 额外包含 `created_at`、`updated_at`、`htmlPath` |
| **Metrics 字段** | `usage_details`, `cost_details`, `aggregated_level`, `observation_count`, `error_count` 等完整字段 | 仅 `latency`、`totalCost` | UI 表格需要更丰富的指标展示；Public API 精简返回内容 |
| **Scores 返回** | `scores_avg` (tuple 数组)、`score_categories` (name:value 数组) | `scores` (score_id 数组) | UI 直接展示分数详情；Public API 返回 ID 供客户端按需加载 |
| **Input/Output/Metadata** | ❌ 不返回（需单 trace 详情接口） | ✅ 通过 `includeIO=true` 触发 `base+io` 双层查询 | Public API 设计为支持批量导出完整 trace 数据 |
| **Observations 返回** | ❌ 不直接返回（JOIN 仅用于聚合） | ✅ `observation_ids` 数组 | Public API 支持关联数据按需加载 |
| **去重策略** | `FINAL` (默认) / `LIMIT 1 BY` (非默认排序) | `FINAL` / `LIMIT 1 BY` (Skip Index 列) | 相同的 CollapsingMergeTree 去重逻辑 |
| **排序字段** | 支持所有 table 列 | 支持更多列 + `event_ts` tiebreaker | Public API 使用更灵活的 orderBy 映射 |
| **字段选择开关** | 通过 `select` 参数 (`count`/`metrics`/`rows`/`identifiers`) | 通过 `includeIO/includeMetrics/includeScores/includeObservations` 布尔开关 | UI 使用预设字段组；Public API 提供细粒度控制 |
| **CTE 名称** | `observations_stats`, `scores_avg` | `observation_stats`, `score_stats`, `base`, `io` | Public API 多了 `base+io` 双层查询优化 |
| **时间边界传播** | ✅ 支持 (`trace->observations` ±5min) | ✅ 支持 + 额外 `io` CTE 时间过滤 | Public API 传播范围更广 |

**设计意图总结**:

1. **UI traces.all.query**: 面向表格渲染优化，返回聚合后的 metrics 和 scores 数据，字段组预设合理，前端直接可用
2. **Public API /api/public/traces**: 面向批量导出和 API 集成优化，支持细粒度字段开关，通过 `base+io` 双层查询优化大字段性能，返回 ID 数组供按需关联查询

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
