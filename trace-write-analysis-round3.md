# Trace 层级一致性边界深度分析报告（Round 3）

## 1. 实时传播 vs 历史回填：parent_span_id 判定条件对比

### 1.1 核心判定逻辑逐行对比

| 维度 | 实时事件传播 (handleEventPropagationJob.ts:240-243) | 历史回填 (backfillEventsHistoric.ts:450) |
|------|------------------------------------------------|-------------------------------------------|
| **判定条件** | `obs.id = concat('t-', obs.trace_id)` | `o.id = o.trace_id` |
| **根节点标识值** | `''` (空字符串) | `NULL` |
| **分支逻辑结构** | `CASE WHEN ... THEN '' ELSE coalesce(...) END` | `if(..., NULL, coalesce(...))` |
| **数据来源表** | `observations_batch_staging` | `observations_pid_tid_sorting` |
| **是否含 Synthetic Span** | ✅ 包含（来自 Trace 双写） | ❌ 不包含（直接从 observations 读取） |

### 1.2 语义不一致的具体场景

#### 场景 A：Synthetic Span 的 ID 前缀差异

**实时传播逻辑**：
```sql
-- 当 Observation 是 Trace 转换的 Synthetic Span 时（ID 有 t- 前缀）
WHEN obs.id = concat('t-', obs.trace_id) THEN ''
```
- 匹配条件：`id = 't-' + trace_id`
- 命中后设置 `parent_span_id = ''`（根节点）

**历史回填逻辑**：
```sql
-- 历史回填没有 t- 前缀概念，直接比较 id = trace_id
if(o.id = o.trace_id, NULL, ...)
```
- 匹配条件：`id = trace_id`（无前缀）
- 命中后设置 `parent_span_id = NULL`（根节点）

**不一致后果**：
1. 实时数据中，`t-trace-123` 这个 Synthetic Span 的 `parent_span_id = ''`
2. 历史数据中，**根本不存在 `t-trace-123` 这条记录**（因为历史回填从 observations 读取，不包含 Synthetic Span）
3. 历史数据中，只有当某个 Observation 的 ID 恰好等于 Trace ID 时才会被当作根节点（这通常是 Wrapper Trace 的情况）

#### 场景 B：根节点的 NULL vs '' 语义差异

| 情况 | 实时传播结果 | 历史回填结果 | 语义差异 |
|------|-------------|--------------|----------|
| **真正的根节点 (Synthetic Span)** | `parent_span_id = ''` | ❌ 记录不存在 | 历史数据缺少 Synthetic Span 作为根 |
| **普通 Observation 无父节点** | `parent_span_id = 't-' + trace_id` | `parent_span_id = 't-' + trace_id` | ✅ 一致 |
| **Wrapper Trace 的 Observation** | `parent_span_id = 't-' + trace_id` | `parent_span_id = NULL` | ❌ 不一致（历史把它当作根节点） |

#### 场景 C：Synthetic Span 缺失导致的树形断裂

**实时数据的完整树形**：
```
t-trace-abc (parent_span_id = '')
  └── span-123 (parent_span_id = 't-trace-abc')
       └── gen-456 (parent_span_id = 'span-123')
```

**历史回填数据的断裂树形**：
```
span-123 (parent_span_id = 't-trace-abc')  ← 父节点不存在！
  └── gen-456 (parent_span_id = 'span-123')
```
- `t-trace-abc` 在历史回填数据中 **不存在**
- `span-123` 的 `parent_span_id` 指向一个不存在的节点
- 导致 `span-123` 成为"孤儿节点"

---

## 2. Wrapper Trace（Observation 先到缺 trace_id）的具体影响

### 2.1 触发机制回顾

**位置**：`worker/src/services/IngestionService/index.ts:851-869`

```typescript
// 向后兼容：为没有 trace_id 的 Observation 创建 Wrapper Trace
if (!finalObservationRecord.trace_id) {
  const wrapperTraceRecord: TraceRecordInsertType = {
    id: finalObservationRecord.id,      // ✅ 复用 Observation 的 ID 作为 Trace ID
    timestamp: finalObservationRecord.start_time,
    // ... 其他字段默认值
  };

  // ✅ 写入 traces 表
  this.clickhouseWriter.addToQueue(TableName.Traces, wrapperTraceRecord);
  
  // ✅ 设置 trace_id 字段
  finalObservationRecord.trace_id = finalObservationRecord.id;
}
```

### 2.2 关键遗漏点

**Wrapper Trace 被写入 traces 表，但：**
❌ **没有**调用 `convertTraceToStagingObservation()` 转换为 Synthetic Span
❌ **没有**被双写到 `observations_batch_staging` 表
❌ 因此 **不会**出现在 `events_full` 表中

### 2.3 在 events_full 查询中的具体影响

#### 2.3.1 父节点指向不存在的 Synthetic Span

假设场景：
1. 客户端发送 Generation `gen-old-sdk`，没有 `trace_id`
2. 系统创建 Wrapper Trace `gen-old-sdk`
3. Generation 的 `trace_id` 被设置为 `gen-old-sdk`

**实时传播 SQL 计算 parent_span_id**：
```sql
-- 对于 obs.id = 'gen-old-sdk', obs.trace_id = 'gen-old-sdk'
CASE
  WHEN obs.id = concat('t-', obs.trace_id) THEN ''
  -- 'gen-old-sdk' = 't-gen-old-sdk' ? → 不相等
  ELSE coalesce(obs.parent_observation_id, concat('t-', obs.trace_id))
  -- parent_observation_id 是 undefined，所以取 't-gen-old-sdk'
END AS parent_span_id
```

**结果**：
```
span_id = 'gen-old-sdk'
parent_span_id = 't-gen-old-sdk'  ← 这个节点在 events_full 中不存在！
```

#### 2.3.2 历史回填中的不一致

**历史回填 SQL**：
```sql
-- 对于 o.id = 'gen-old-sdk', o.trace_id = 'gen-old-sdk'
if(o.id = o.trace_id, NULL, coalesce(o.parent_observation_id, concat('t-', o.trace_id)))
-- 'gen-old-sdk' = 'gen-old-sdk' → 相等，所以 parent_span_id = NULL
```

**结果**：
```
span_id = 'gen-old-sdk'
parent_span_id = NULL  ← 被当作根节点！
```

#### 2.3.3 对比汇总表

| 数据路径 | span_id | parent_span_id | 父节点是否存在 | 节点角色 |
|---------|---------|----------------|--------------|---------|
| **实时传播** | `gen-old-sdk` | `t-gen-old-sdk` | ❌ 不存在 | 有父节点的子节点（但父丢失） |
| **历史回填** | `gen-old-sdk` | `NULL` | - | ✅ 根节点 |

### 2.4 树结构重建中的可观测现象

#### 现象 1：前端树形图显示"悬空节点"

**使用实时 events_full 查询时**：
```
前端组件尝试构建树形：
- 找到 parent_span_id 为空或 NULL 的节点作为根
- 对于每个节点，查找其子节点

问题：
1. 'gen-old-sdk' 的 parent_span_id = 't-gen-old-sdk'（非空，非NULL）
2. 系统不会把它当作根节点
3. 系统找不到 id = 't-gen-old-sdk' 的父节点
4. 该节点被归类为"孤儿节点"，不显示在树形图中
```

**用户可见表现**：
- ✅ 在平铺列表视图中可以看到这个 Span
- ❌ 在 Trace 详情页的树形图中 **完全看不到** 这个 Span
- ❌ 没有报错或警告，数据"静默丢失"
- 客户投诉："我的 Trace 详情页是空的，但列表中明明有数据"

#### 现象 2：历史回填数据与实时数据不一致

**客户先看到历史回填数据**：
- `gen-old-sdk` 显示为根节点（`parent_span_id = NULL`）
- 树形图正常显示

**切换到实时事件表后**：
- 同一个 `gen-old-sdk` 不再是根节点
- 树形图不显示它
- 用户困惑："为什么相同的数据在不同页面显示不一样？"

### 2.5 下游统计中的偏差

#### 2.5.1 Trace 深度统计偏差

```sql
-- 计算 Trace 深度的常见 SQL
WITH RECURSIVE trace_depth AS (
  SELECT 
    span_id, 
    parent_span_id, 
    1 as depth
  FROM events_core
  WHERE parent_span_id IS NULL OR parent_span_id = ''
    AND trace_id = 'gen-old-sdk'
  
  UNION ALL
  
  SELECT 
    e.span_id, 
    e.parent_span_id, 
    td.depth + 1
  FROM events_core e
  JOIN trace_depth td ON e.parent_span_id = td.span_id
)
SELECT max(depth) FROM trace_depth;
```

**实时数据结果**：深度 = 0（找不到根节点）
**历史数据结果**：深度 = 1（正确）

#### 2.5.2 孤儿节点比例统计

监控 SQL：
```sql
SELECT 
  count(*) as total_spans,
  sumIf(1, parent_span_id NOT IN (SELECT span_id FROM events_core WHERE trace_id = e.trace_id)) as orphan_spans,
  orphan_spans / total_spans as orphan_ratio
FROM events_core e
```

**问题**：
- 使用旧 SDK 的项目会有异常高的孤儿节点率
- 监控告警频繁触发
- 团队花费大量时间排查但找不到根本原因

---

## 3. 最小可复现数据样例

### 3.1 测试数据构建

#### 步骤 1：模拟旧 SDK 发送无 trace_id 的 Observation

```sql
-- 写入 traces 表（Wrapper Trace）
INSERT INTO traces (
  id, project_id, timestamp, name, user_id, session_id, 
  metadata, tags, bookmarked, public, event_ts, is_deleted,
  created_at, updated_at, environment, version, release
) VALUES (
  'gen-old-sdk',         -- id = Observation ID
  'proj-test-123',       -- project_id
  1715000000000,         -- timestamp
  '',                    -- name（空）
  '',                    -- user_id（空）
  '',                    -- session_id（空）
  map(),                 -- metadata（空）
  [],                    -- tags（空数组）
  0,                     -- bookmarked
  0,                     -- public
  1715000000000,         -- event_ts
  0,                     -- is_deleted
  1715000000000,         -- created_at
  1715000000000,         -- updated_at
  'production',          -- environment
  '',                    -- version
  ''                     -- release
);

-- 写入 observations 表
INSERT INTO observations (
  id, project_id, trace_id, parent_observation_id, type,
  start_time, end_time, name, environment, version,
  metadata, level, status_message, provided_model_name,
  internal_model_id, model_parameters, provided_usage_details,
  usage_details, provided_cost_details, cost_details, total_cost,
  prompt_id, prompt_name, prompt_version, tool_definitions,
  tool_calls, tool_call_names, input, output,
  completion_start_time, created_at, updated_at, event_ts, is_deleted
) VALUES (
  'gen-old-sdk',         -- id
  'proj-test-123',       -- project_id
  'gen-old-sdk',         -- trace_id（设置为与 id 相同）
  NULL,                  -- parent_observation_id
  'GENERATION',          -- type
  1715000000000,         -- start_time
  1715000000500,         -- end_time
  'old-sdk-call',        -- name
  'production',          -- environment
  '',                    -- version
  map(),                 -- metadata
  'DEFAULT',             -- level
  '',                    -- status_message
  'gpt-3.5-turbo',       -- provided_model_name
  NULL,                  -- internal_model_id
  '{}',                  -- model_parameters
  map('input', 10, 'output', 20),  -- provided_usage_details
  map('input', 10, 'output', 20),  -- usage_details
  map(),                 -- provided_cost_details
  map(),                 -- cost_details
  0.00001,               -- total_cost
  NULL,                  -- prompt_id
  NULL,                  -- prompt_name
  NULL,                  -- prompt_version
  NULL,                  -- tool_definitions
  NULL,                  -- tool_calls
  NULL,                  -- tool_call_names
  'Hello',               -- input
  'Hi there',            -- output
  NULL,                  -- completion_start_time
  1715000000000,         -- created_at
  1715000000000,         -- updated_at
  1715000000000,         -- event_ts
  0                      -- is_deleted
);
```

#### 步骤 2：写入 observations_batch_staging 表（模拟实时路径）

**注意**：不写入 Synthetic Span，模拟 Wrapper Trace 的情况

```sql
INSERT INTO observations_batch_staging (
  id, project_id, trace_id, parent_observation_id, type,
  start_time, end_time, name, environment, version,
  metadata, level, status_message, provided_model_name,
  internal_model_id, model_parameters, provided_usage_details,
  usage_details, provided_cost_details, cost_details,
  prompt_id, prompt_name, prompt_version, tool_definitions,
  tool_calls, tool_call_names, input, output,
  completion_start_time, created_at, updated_at, event_ts, is_deleted,
  s3_first_seen_timestamp
) VALUES (
  'gen-old-sdk',         -- id
  'proj-test-123',       -- project_id
  'gen-old-sdk',         -- trace_id
  NULL,                  -- parent_observation_id
  'GENERATION',          -- type
  1715000000000,         -- start_time
  1715000000500,         -- end_time
  'old-sdk-call',        -- name
  'production',          -- environment
  '',                    -- version
  map(),                 -- metadata
  'DEFAULT',             -- level
  '',                    -- status_message
  'gpt-3.5-turbo',       -- provided_model_name
  NULL,                  -- internal_model_id
  '{}',                  -- model_parameters
  map('input', 10, 'output', 20),  -- provided_usage_details
  map('input', 10, 'output', 20),  -- usage_details
  map(),                 -- provided_cost_details
  map(),                 -- cost_details
  NULL,                  -- prompt_id
  NULL,                  -- prompt_name
  NULL,                  -- prompt_version
  NULL,                  -- tool_definitions
  NULL,                  -- tool_calls
  NULL,                  -- tool_call_names
  'Hello',               -- input
  'Hi there',            -- output
  NULL,                  -- completion_start_time
  1715000000000,         -- created_at
  1715000000000,         -- updated_at
  1715000000000,         -- event_ts
  0,                     -- is_deleted
  1715000000000          -- s3_first_seen_timestamp
);
```

### 3.2 验证查询

#### 验证 1：实时传播路径的 parent_span_id 计算

```sql
-- 模拟实时传播的 CASE 逻辑
SELECT 
  'gen-old-sdk' as span_id,
  CASE
    WHEN 'gen-old-sdk' = concat('t-', 'gen-old-sdk') THEN ''
    ELSE coalesce(NULL, concat('t-', 'gen-old-sdk'))
  END AS parent_span_id,
  concat('t-', 'gen-old-sdk') as expected_parent_id;

/*
结果：
span_id      | parent_span_id | expected_parent_id
-------------|----------------|-------------------
gen-old-sdk  | t-gen-old-sdk  | t-gen-old-sdk
*/
```

**结论**：`parent_span_id = 't-gen-old-sdk'`，但这个节点不存在于 events_full。

#### 验证 2：历史回填路径的 parent_span_id 计算

```sql
-- 模拟历史回填的 if 逻辑
SELECT 
  'gen-old-sdk' as span_id,
  if('gen-old-sdk' = 'gen-old-sdk', NULL, coalesce(NULL, concat('t-', 'gen-old-sdk'))) AS parent_span_id;

/*
结果：
span_id      | parent_span_id
-------------|----------------
gen-old-sdk  | NULL
*/
```

**结论**：`parent_span_id = NULL`，被当作根节点。

### 3.3 树形重建测试 SQL

```sql
-- 使用 WITH RECURSIVE 模拟前端树形构建
WITH RECURSIVE trace_tree AS (
  -- 根节点：parent_span_id 为空字符串或 NULL
  SELECT 
    'gen-old-sdk' as span_id,
    CASE
      WHEN 'gen-old-sdk' = concat('t-', 'gen-old-sdk') THEN ''
      ELSE coalesce(NULL, concat('t-', 'gen-old-sdk'))
    END AS parent_span_id,
    1 as depth,
    'ROOT' as node_type
  WHERE (
    CASE
      WHEN 'gen-old-sdk' = concat('t-', 'gen-old-sdk') THEN ''
      ELSE coalesce(NULL, concat('t-', 'gen-old-sdk'))
    END IS NULL 
    OR 
    CASE
      WHEN 'gen-old-sdk' = concat('t-', 'gen-old-sdk') THEN ''
      ELSE coalesce(NULL, concat('t-', 'gen-old-sdk'))
    END = ''
  )
  
  UNION ALL
  
  -- 子节点（在我们的样例中没有，但演示结构）
  SELECT 
    e.span_id,
    e.parent_span_id,
    tt.depth + 1,
    'CHILD' as node_type
  FROM (
    SELECT 'gen-old-sdk' as span_id, 't-gen-old-sdk' as parent_span_id
  ) e
  JOIN trace_tree tt ON e.parent_span_id = tt.span_id
)
SELECT * FROM trace_tree;

/*
结果（实时路径）：
→ 空集！因为没有根节点被选中

结果（历史路径）：
span_id      | parent_span_id | depth | node_type
-------------|----------------|-------|----------
gen-old-sdk  | NULL           | 1     | ROOT
*/
```

---

## 4. 修复思路

### 4.1 短期兜底方案（热修复）

#### 方案 A：在 Wrapper Trace 创建时也双写 Synthetic Span

**修改位置**：`worker/src/services/IngestionService/index.ts:851-869`

```typescript
if (!finalObservationRecord.trace_id) {
  const wrapperTraceRecord: TraceRecordInsertType = {
    id: finalObservationRecord.id,
    timestamp: finalObservationRecord.start_time,
    project_id: projectId,
    environment: finalObservationRecord.environment,
    created_at: Date.now(),
    updated_at: Date.now(),
    metadata: {},
    tags: [],
    bookmarked: false,
    public: false,
    event_ts: Date.now(),
    is_deleted: 0,
  };

  // ✅ 现有的：写入 traces 表
  this.clickhouseWriter.addToQueue(TableName.Traces, wrapperTraceRecord);
  
  // 🔴 新增：将 Wrapper Trace 转换为 Synthetic Span 并双写
  const wrapperTraceAsObservation = convertTraceToStagingObservation(
    wrapperTraceRecord,
    this.getPartitionAwareTimestamp(Date.now())
  );
  this.clickhouseWriter.addToQueue(
    TableName.ObservationsBatchStaging,
    wrapperTraceAsObservation
  );
  
  finalObservationRecord.trace_id = finalObservationRecord.id;
}
```

**优点**：
- 修复简单，改动小
- 与正常 Trace 的处理逻辑一致
- 新增数据完全兼容现有查询

**缺点**：
- 只修复新数据，历史已存在的 Wrapper Trace 仍有问题
- 需要额外的存储空间（每个 Wrapper Trace 多一条记录）

#### 方案 B：在事件传播 SQL 中增加兜底逻辑

**修改位置**：`worker/src/features/eventPropagation/handleEventPropagationJob.ts:240-243`

```sql
CASE
  -- 现有逻辑：正常 Synthetic Span
  WHEN obs.id = concat('t-', obs.trace_id) THEN ''
  
  -- 🔴 新增：兜底 Wrapper Trace 情况（id = trace_id 但没有 t- 前缀）
  WHEN obs.id = obs.trace_id AND obs.id NOT LIKE 't-%' THEN ''
  
  -- 现有逻辑：正常节点
  ELSE coalesce(obs.parent_observation_id, concat('t-', obs.trace_id))
END AS parent_span_id
```

**优点**：
- 同时修复新数据和已存在于 staging 表的数据
- 不需要回溯处理

**缺点**：
- SQL 逻辑变复杂
- 可能会误匹配一些恰好 id = trace_id 的正常 Observation

#### 方案 C：前端查询时增加兜底逻辑

**修改位置**：前端树形构建逻辑

```typescript
function buildTree(events: Event[]): TreeNode[] {
  const nodeMap = new Map(events.map(e => [e.span_id, e]));
  const roots: TreeNode[] = [];
  
  for (const event of events) {
    // 🔴 新增：如果 parent_span_id 指向不存在的节点，当作根节点
    if (!event.parent_span_id || !nodeMap.has(event.parent_span_id)) {
      roots.push({
        ...event,
        children: [],
        // 可选：标记为"孤儿节点"以便用户识别
        isOrphan: !event.parent_span_id ? false : true
      });
    } else {
      const parent = nodeMap.get(event.parent_span_id)!;
      if (!parent.children) parent.children = [];
      parent.children.push(event);
    }
  }
  
  return roots;
}
```

**优点**：
- 不需要修改后端
- 可以立即生效
- 可以给用户视觉反馈（标记孤儿节点）

**缺点**：
- 只是前端显示修复，数据本身仍然不一致
- 下游统计（如深度计算）仍然有问题
- 如果有多个地方查询 events 表，需要多处修改

### 4.2 长期一致化方案

#### 方案 D：统一实时传播与历史回填的判定逻辑

**目标**：让两个路径的 parent_span_id 计算逻辑完全一致

**步骤 1**：修改历史回填 SQL，匹配实时逻辑

```sql
-- 修改 backfillEventsHistoric.ts:450
-- 原逻辑：
if(o.id = o.trace_id, NULL, coalesce(o.parent_observation_id, concat('t-', o.trace_id))) AS parent_span_id

-- 🔴 新逻辑（与实时传播一致）：
CASE
  WHEN o.id = concat('t-', o.trace_id) THEN ''
  WHEN o.id = o.trace_id THEN ''  -- 额外处理 Wrapper Trace
  ELSE coalesce(o.parent_observation_id, concat('t-', o.trace_id))
END AS parent_span_id
```

**步骤 2**：统一根节点标识值

选择统一使用 `''` 或 `NULL`：
```sql
-- 方案：统一用 NULL（更符合 SQL 语义）
CASE
  WHEN o.id = concat('t-', o.trace_id) THEN NULL  -- 改 '' 为 NULL
  WHEN o.id = o.trace_id THEN NULL                -- Wrapper Trace 也是根
  ELSE coalesce(o.parent_observation_id, concat('t-', o.trace_id))
END AS parent_span_id
```

**步骤 3**：历史回填时"虚拟"生成 Synthetic Span

对于历史数据中没有 Synthetic Span 的情况，可以在回填 SQL 中用 UNION 生成：

```sql
WITH synthetic_spans AS (
  -- 从 traces 表生成 Synthetic Span
  SELECT
    concat('t-', t.id) as id,
    t.project_id,
    t.id as trace_id,
    NULL as parent_observation_id,
    'SPAN' as type,
    t.timestamp as start_time,
    NULL as end_time,
    t.name,
    -- ... 其他字段从 trace 映射
  FROM traces t
  WHERE t.project_id IN (...) AND t.id IN (...)
)
SELECT ...
FROM (
  SELECT * FROM observations_pid_tid_sorting o
  UNION ALL
  SELECT * FROM synthetic_spans
) combined
LEFT JOIN traces t ON ...
```

### 4.3 推荐方案组合

| 优先级 | 方案 | 适用场景 | 预期时间 |
|-------|------|---------|----------|
| P0（立即） | 方案 A（Wrapper Trace 双写） | 所有新数据 | 1-2 天 |
| P0（立即） | 方案 C（前端兜底） | 所有历史数据的显示 | 1 天 |
| P1（近期） | 方案 B（SQL 兜底） | staging 表中已存在的数据 | 2-3 天 |
| P2（中期） | 方案 D（统一逻辑） | 彻底解决一致性问题 | 1-2 周 |

### 4.4 验证修复效果的测试用例

```typescript
describe('Wrapper Trace Parent Consistency', () => {
  it('should have parent_span_id pointing to existing node for wrapper trace observations', async () => {
    // 1. 创建无 trace_id 的 Observation
    // 2. 触发事件传播
    // 3. 查询 events_full
    
    const events = await queryEvents('gen-old-sdk');
    
    // 验证：要么是根节点，要么父节点存在
    const wrapperTraceEvents = events.filter(e => e.span_id === 'gen-old-sdk');
    expect(wrapperTraceEvents.length).toBeGreaterThan(0);
    
    for (const event of wrapperTraceEvents) {
      if (event.parent_span_id) {
        // 如果有父节点，父节点必须存在
        const parentExists = events.some(e => e.span_id === event.parent_span_id);
        expect(parentExists).toBe(true, 
          `Parent node ${event.parent_span_id} not found for span ${event.span_id}`);
      }
    }
  });
  
  it('should produce identical parent_span_id between real-time and backfill', async () => {
    // 1. 写入相同数据到两个路径
    // 2. 比较两个 events_full 副本中的 parent_span_id
    // 3. 断言完全一致
  });
});
```

---

## 5. 总结与行动项

### 5.1 问题根因汇总

1. **Wrapper Trace 缺少 Synthetic Span**：创建 Wrapper Trace 时只写 traces 表，不双写 Synthetic Span
2. **实时与历史判定逻辑不一致**：
   - 实时：`concat('t-', trace_id)` 匹配 → `''`
   - 历史：`id = trace_id` 匹配 → `NULL`
3. **根节点标识值不统一**：`''` 和 `NULL` 混用导致查询逻辑复杂
4. **孤儿节点静默丢失**：没有监控和告警，用户发现问题时已经晚了

### 5.2 立即行动项

- [ ] **P0**：修复 Wrapper Trace 创建逻辑，双写 Synthetic Span（方案 A）
- [ ] **P0**：前端树形构建增加孤儿节点兜底逻辑（方案 C）
- [ ] **P0**：添加孤儿节点比例监控告警
- [ ] **P1**：修复事件传播 SQL，增加 Wrapper Trace 兜底（方案 B）
- [ ] **P2**：统一实时与历史回填的判定逻辑（方案 D）
- [ ] **P2**：清理并修复历史已存在的不一致数据
