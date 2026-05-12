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
| `packages/shared/src/server/services/traces-ui-table-service.ts:446-462` | `ORDER BY timestamp DESC` | 按时间倒序，最新数据在顶部 |

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

### 2.1 跨文件证据

| 文件路径 | 关键函数/组件 | 作用 |
|---------|--------------|------|
| `web/src/features/filters/hooks/useSidebarFilterState.ts` | `useSidebarFilterState` | 过滤器状态管理 |
| `packages/shared/src/server/queries/clickhouse-sql/factory.ts` | `createFilterFromFilterState` | FilterState → ClickHouse Filter 转换 |
| `packages/shared/src/server/queries/clickhouse-sql/clickhouse-filter.ts` | `StringFilter`, `ArrayOptionsFilter`, `DateTimeFilter` | 过滤器类型实现 |
| `packages/shared/src/server/queries/clickhouse-sql/filter-list.ts` | `FilterList.apply()` | 多过滤器组合为 SQL 片段 + 参数绑定 |

### 2.2 支持的过滤器类型

| 过滤器类型 | 适用字段 | 核心 SQL 操作 |
|-----------|---------|-------------|
| `stringOptions` | environment, userId, sessionId | `IN (...)` / `NOT IN (...)` |
| `arrayOptions` | tags | `hasAny(array, values)` / `hasAll(array, values)` |
| `datetime` | timestamp | `>=`, `<=`, `>`, `<` |
| `stringObject` | metadata | `JSONExtractString(metadata, key1, key2, ...) OP value` |
| `scoreNumeric` | scores_avg | `arrayExists(x -> tuple condition, scores_avg)` |
| `scoreCategorical` | score_categories | `hasAny(score_categories, name:value_pairs)` |

### 2.3 数据流说明

```
用户操作: 在侧边栏选择过滤条件
  ├─ 选择标签: tags = ["production"]
  ├─ 元数据过滤: metadata.user.plan = "premium"
  └─ 分数过滤: accuracy >= 0.8
    ↓
[前端] useSidebarFilterState 组装为 FilterState[]
    ↓
[前端] 合并 dateRangeFilter + userIdFilter → 统一 FilterState
    ↓
[tRPC] traces.all.query 携带 filter 字段
    ↓
[后端] createFilterFromFilterState(
    userFilters,
    tracesTableUiColumnDefinitions,
    tracesTableCols
  )
    ↓ 类型分发
  ├─ tags → ArrayOptionsFilter
  ├─ metadata.user.plan → StringObjectFilter
  └─ accuracy >= 0.8 → ScoreNumericFilter (scores CTE)
    ↓
[后端] FilterList.push(...) 收集所有过滤器
    ↓
[后端] FilterList.apply() → { query: "cond1 AND cond2", params: {...} }
    ↓
[ClickHouse] WHERE 子句注入，可能触发 observation_stats / score_stats CTE 构建
```

### 2.4 标签过滤实现

```typescript
// ArrayOptionsFilter 核心逻辑
// 来自: packages/shared/src/server/queries/clickhouse-sql/clickhouse-filter.ts
apply() {
  const placeholders = this.values.map((_, i) => 
    `{${this.field}_${i}:String}`
  ).join(", ");
  
  switch (this.operator) {
    case "any of":
      return { query: `hasAny(${this.field}, [${placeholders}])`, params };
    case "all of":
      return { query: `hasAll(${this.field}, [${placeholders}])`, params };
    case "none of":
      return { query: `NOT hasAny(${this.field}, [${placeholders}])`, params };
  }
}
```

### 2.5 元数据过滤实现

```typescript
// StringObjectFilter 支持嵌套键
// 例如: metadata.user.plan = "premium"
//
// 转换为 SQL:
// JSONExtractString(metadata, 'user', 'plan') = {value}
```

---

## 三、查询计划链路 (Query Planning)

### 3.1 跨文件证据

| 文件路径 | 关键函数/CTE | 作用 |
|---------|-------------|------|
| `web/src/features/public-api/server/traces.ts:48-399` | `buildTracesBaseQuery()` | 主查询构建函数 |
| `packages/shared/src/server/services/traces-ui-table-service.ts:286-348` | `observation_stats`, `scores_avg` CTE | UI 表的 CTE 构建 |
| `web/src/features/public-api/server/traces.ts:134-230` | CTE 条件组装逻辑 | 根据字段/过滤器决定是否包含 CTE |
| `web/src/features/public-api/server/traces.ts:112-118` | `shouldUseSkipIndexes` 决策 | FINAL vs LIMIT 1 BY 选择 |

### 3.2 核心查询架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                      WITH Clause (动态组装)                       │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  observation_stats (条件: 需要 metrics/observations 或过滤)│  │
│  │  SELECT trace_id, sum(total_cost), latency_milliseconds...│  │
│  │  FROM observations [FINAL?]                                │  │
│  │  WHERE start_time >= {traceTimestamp} - 5 MINUTES          │  │
│  │  GROUP BY project_id, trace_id                             │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ↓ 可选                              │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  score_stats (条件: 需要 scores 或分数过滤)                 │  │
│  │  模式 A: 有分数聚合过滤 → 两层聚合 (avg 正确性)             │  │
│  │  模式 B: 无分数过滤 → 直接聚合 (性能×2)                    │  │
│  │  SELECT trace_id, scores_avg, score_categories             │  │
│  │  FROM scores FINAL                                         │  │
│  │  GROUP BY project_id, trace_id                             │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ↓ 可选                              │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  base (条件: 需要 input/output/metadata 大字段)            │  │
│  │  SELECT 轻量列 (id, timestamp, name, tags...)              │  │
│  │  FROM traces [FINAL?]                                      │  │
│  │  WHERE <所有过滤条件>                                       │  │
│  │  ORDER BY timestamp DESC                                   │  │
│  │  LIMIT 50 OFFSET 0                                        │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ↓                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  io (条件: 需要 input/output/metadata)                     │  │
│  │  SELECT input, output, metadata                            │  │
│  │  FROM traces                                               │  │
│  │  WHERE (id, project_id) IN (SELECT id, project_id FROM base)│  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      最终 SELECT + JOIN                          │
│  SELECT b.*, i.input, i.output, i.metadata, o.*, s.*            │
│  FROM base b LEFT JOIN io i LEFT JOIN observation_stats o ...   │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 CTE 包含决策矩阵

| 请求字段 / 过滤引用 | 需要的 CTE |
|-------------------|-----------|
| `metrics` (latency, totalCost) | `observation_stats` |
| `observations` 字段组 | `observation_stats` |
| 过滤器引用 `observations` 表 | `observation_stats` |
| `scores` 字段组 | `score_stats` |
| 过滤器引用 `scores` 表 | `score_stats` |
| `input`, `output`, `metadata` | `base` + `io` 双层查询 |

```typescript
// 决策代码 (public-api/server/traces.ts:121-124)
const filtersNeedObservations = filter.some(
  f => f.clickhouseTable === "observations"
);
const filtersNeedScores = filter.some(
  f => f.clickhouseTable === "scores"
);

// CTE 条件包含 (public-api/server/traces.ts:134-170)
if (select.includeObservations || select.includeMetrics || filtersNeedObservations) {
  ctes.push(`observation_stats AS (...)`);
}
if (select.includeScores || filtersNeedScores) {
  ctes.push(`score_stats AS (...)`);
}
```

### 3.4 时间边界传播优化

Trace 的时间过滤器向下传播到关联表，避免全量扫描：

```sql
-- trace 过滤条件
WHERE t.timestamp >= '2024-01-01 10:00:00'

-- 传播到 observations
AND o.start_time >= '2024-01-01 10:00:00' - 5 MINUTES
AND o.start_time <= '2024-01-01 10:00:00' + 5 MINUTES
AND o.end_time <= '2024-01-01 10:00:00' + 5 MINUTES

-- 传播到 scores
AND s.timestamp >= '2024-01-01 10:00:00'
```

**常量定义**：
- `TRACE_TO_OBSERVATIONS_INTERVAL = 5 MINUTES`
- `SCORE_TO_TRACE_OBSERVATIONS_INTERVAL = 5 MINUTES`

---

## 四、用户操作 → 过滤器 → SQL/CTE → 返回字段 对照表

| 用户操作 | 前端 FilterState 结构 | 触发的 CTE/SQL 特征 | 返回字段影响 |
|---------|----------------------|-------------------|------------|
| 选择 `Last 1 hour` 时间范围 | `{column: "timestamp", type: "datetime", operator: ">=", value: Date}` | `WHERE t.timestamp >= {...}` + 时间传播到 observations/scores | 无 |
| 勾选标签 `production` | `{column: "tags", type: "arrayOptions", operator: "any of", value: ["production"]}` | `WHERE hasAny(tags, ['production'])` | 无 |
| 元数据过滤 `metadata.user.plan = premium` | `{column: "metadata", type: "stringObject", key: "user.plan", operator: "=", value: "premium"}` | `WHERE JSONExtractString(metadata, 'user', 'plan') = {value}` + 触发 `shouldUseSkipIndexes=true` | 无 |
| 分数过滤 `accuracy >= 0.8` | `{column: "accuracy", type: "scoreNumeric", operator: ">=", value: 0.8}` | 触发 `score_stats` CTE + 两层聚合模式 + `WHERE arrayExists(x -> x.1='accuracy' AND x.2>=0.8, scores_avg)` | 无 |
| 类别分数过滤 `quality:good` | `{column: "quality", type: "scoreCategorical", operator: "=", value: "good"}` | 触发 `score_stats` CTE + `WHERE hasAny(score_categories, ['quality:good'])` | 无 |
| 请求 `Metrics` 字段组 | N/A (字段选择) | 触发 `observation_stats` CTE | 返回 `latency`, `totalCost`, `usage_details` |
| 请求 `Scores` 字段组 | N/A (字段选择) | 触发 `score_stats` CTE | 返回 `scores_avg`, `score_categories` |
| 请求 `Input/Output` 字段 | N/A (字段选择) | 触发 `base + io` 双层查询 | 返回 `input`, `output`, `metadata` |
| 用户 ID 过滤 | `{column: "userId", type: "string", operator: "=", value: "u123"}` | `WHERE user_id = {...}` + 触发 `shouldUseSkipIndexes=true` | 无 |
| Session ID 过滤 | `{column: "sessionId", type: "string", operator: "=", value: "s456"}` | `WHERE session_id = {...}` + 触发 `shouldUseSkipIndexes=true` | 无 |

---

## 五、FINAL 与 LIMIT 1 BY 切换条件

### 5.1 决策机制

```typescript
// public-api/server/traces.ts:112-118
// traces-ui-table-service.ts:414-422
const shouldUseSkipIndexes = filter.some(f =>
  f.clickhouseTable === "traces" &&
  ["user_id", "session_id", "metadata"].some(
    skipIndexCol => f.field.includes(skipIndexCol)
  )
);

// 使用 FINAL (默认)
FROM traces FINAL

// 不使用 FINAL，改用 LIMIT 1 BY 去重
FROM traces
LIMIT 1 BY id, project_id
ORDER BY event_ts DESC
```

### 5.2 切换条件对照表

| 条件 | 使用 FINAL? | 使用 LIMIT 1 BY? | 原因 |
|-----|------------|-----------------|------|
| 默认无过滤 | ✅ 是 | ❌ 否 | 依赖 CollapsingMergeTree 去重 |
| 按 `id` 过滤 | ✅ 是 | ❌ 否 | 主键查找，FINAL 开销可忽略 |
| 按 `timestamp` 范围过滤 | ✅ 是 | ❌ 否 | 时间分区过滤高效 |
| 按 `user_id` 过滤 | ❌ 否 | ✅ 是 (event_ts DESC) | user_id 是 Skip Index，FINAL 会破坏跳跃扫描 |
| 按 `session_id` 过滤 | ❌ 否 | ✅ 是 (event_ts DESC) | session_id 是 Skip Index，同上 |
| 按 `metadata` 嵌套过滤 | ❌ 否 | ✅ 是 (event_ts DESC) | metadata 索引，FINAL 会破坏跳过扫描 |
| 按 `tags` 过滤 | ✅ 是 | ❌ 否 | tags 不是 Skip Index 列 |
| 按 `environment` 过滤 | ✅ 是 | ❌ 否 | environment 不是 Skip Index 列 |

### 5.3 性能权衡

| 方案 | 优点 | 缺点 |
|-----|------|------|
| `FINAL` | 1. 结果 100% 正确（CollapsingMergeTree 语义）<br>2. 无需额外排序/去重逻辑 | 1. 强制按主键顺序读取<br>2. **破坏 Skip Index 跳跃扫描优化**<br>3. user_id/session_id/metadata 查询变慢 ×10~100 |
| `LIMIT 1 BY + event_ts DESC` | 1. 保留 Skip Index 跳跃扫描能力<br>2. user_id/session_id/metadata 查询速度提升显著 | 1. 极端情况下可能读到旧版本（窗口内 event_ts 最新）<br>2. 需额外排序开销 |

---

## 六、Numeric 与 Categorical 分数聚合路径

### 6.1 两种分数类型的数据模型

| 分数类型 | 存储方式 | 聚合表示 | 过滤操作 |
|---------|---------|---------|---------|
| **Numeric** (数值型) | `scores.value` (Float64) | `tuple(name, avg_value)` 数组<br>`scores_avg = [(accuracy, 0.85), (latency, 1.2)]` | `arrayExists(x -> 条件, scores_avg)` |
| **Categorical** (类别型) | `scores.string_value` (String) | `name:value` 字符串数组<br>`score_categories = ["quality:good", "sentiment:positive"]` | `hasAny(score_categories, 候选值数组)` |

### 6.2 Numeric 分数聚合路径

**文件**: `packages/shared/src/server/services/traces-ui-table-service.ts:313-336`

```sql
-- 两层聚合（确保 avg 计算正确）
WITH scores_avg AS (
  SELECT
    project_id,
    trace_id,
    -- 内层先按 id 聚合，外层再收集为 tuple 数组
    groupArrayIf(tuple(name, avg_value), data_type IN ('NUMERIC', 'BOOLEAN')) AS scores_avg
  FROM (
    SELECT
      project_id,
      trace_id,
      name,
      data_type,
      avg(value) as avg_value  -- 先按 (trace, name, data_type) 求平均
    FROM scores FINAL
    WHERE project_id = {projectId: String}
    GROUP BY project_id, trace_id, name, data_type, string_value
  ) tmp
  GROUP BY project_id, trace_id
)

-- 过滤使用
SELECT * FROM traces t
LEFT JOIN scores_avg s ON t.id = s.trace_id
WHERE arrayExists(
  x -> x.1 = 'accuracy' AND x.2 >= 0.8,  -- x.1 = name, x.2 = avg_value
  s.scores_avg
)
```

### 6.3 Categorical 分数聚合路径

**文件**: `packages/shared/src/server/services/traces-ui-table-service.ts:337-348`

```sql
-- 聚合为 name:value 字符串数组
WITH scores_avg AS (
  SELECT
    project_id,
    trace_id,
    groupArrayIf(
      concat(name, ':', string_value),  -- 拼接为 "quality:good"
      data_type = 'CATEGORICAL' AND notEmpty(string_value)
    ) AS score_categories
  FROM scores FINAL
  WHERE project_id = {projectId: String}
  GROUP BY project_id, trace_id
)

-- 过滤使用 hasAny（ClickHouse 数组原生操作，高效）
SELECT * FROM traces t
LEFT JOIN scores_avg s ON t.id = s.trace_id
WHERE hasAny(s.score_categories, ['quality:good', 'quality:excellent'])
```

### 6.4 分数聚合模式切换

```typescript
// public-api/server/traces.ts:172-230
const hasScoreAggregationFilters = filter.some(
  f => f.field === "s.scores_avg" || f.field === "s.score_categories"
);

if (hasScoreAggregationFilters) {
  // 模式 A: 有分数过滤 → 两层聚合
  // 优点: avg() 计算在语义上完全正确
  // 缺点: 多一层 GROUP BY
  ctes.push(`
    score_stats AS (
      SELECT ..., avg(value) as avg_value
      FROM scores FINAL
      GROUP BY project_id, trace_id, id, name, data_type, string_value
      → 外层再 GROUP BY trace_id
    )
  `);
} else {
  // 模式 B: 无分数过滤 → 单层直接聚合
  // 优点: 性能提升约 2 倍
  // 注意: value 直接使用而非 avg()，适用于每个 score name 每行只有一个值的场景
  ctes.push(`
    score_stats AS (
      SELECT ..., groupArrayIf(tuple(name, value), ...)
      FROM scores
      GROUP BY project_id, trace_id
    )
  `);
}
```

---

## 七、查询执行完整流程

```
1. 用户操作
   ├─ 选择时间范围
   ├─ 设置标签/元数据/分数过滤
   ├─ 选择返回字段组
   └─ 排序/分页
      ↓
2. 前端组装
   ├─ FilterState 合并
   ├─ 字段选择配置
   └─ tRPC 请求发送
      ↓
3. 后端过滤组装
   ├─ createFilterFromFilterState()
   ├─ FilterList.apply() → SQL 片段 + 参数
   └─ 分析过滤器引用的表 → CTE 决策
      ↓
4. 查询计划生成
   ├─ shouldUseSkipIndexes 决策 → FINAL/LIMIT 1 BY
   ├─ CTE 条件组装 (observation_stats? score_stats? base+io?)
   ├─ 时间边界传播
   ├─ 排序分页注入
   └─ 参数绑定完成
      ↓
5. ClickHouse 执行
   ├─ 分区裁剪 (timestamp)
   ├─ Skip Index 跳跃扫描 (user_id/session_id/metadata)
   ├─ CTE 物化
   ├─ JOIN 执行
   └─ 结果集返回
      ↓
6. 结果转换
   ├─ convertClickhouseTracesListToDomain()
   ├─ 分数聚合结果解构
   └─ 前端表格渲染
```

---

## 附录: 关键文件索引

| 模块 | 文件路径 |
|-----|---------|
| 前端表格 | `web/src/components/table/use-cases/traces.tsx` |
| 前端过滤 | `web/src/features/filters/hooks/useSidebarFilterState.ts` |
| Public API 查询 | `web/src/features/public-api/server/traces.ts` |
| UI 表服务 | `packages/shared/src/server/services/traces-ui-table-service.ts` |
| 过滤器工厂 | `packages/shared/src/server/queries/clickhouse-sql/factory.ts` |
| 过滤器实现 | `packages/shared/src/server/queries/clickhouse-sql/clickhouse-filter.ts` |
| 导出流 | `worker/src/features/database-read-stream/trace-stream.ts` |
