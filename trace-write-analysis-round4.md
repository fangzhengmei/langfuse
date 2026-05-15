# Trace 层级一致性边界深度分析报告（Round 4）

## 1. Trace 展示链路父节点缺失的处理逻辑

### 1.1 核心兜底机制已实现

**文件位置**：`web/src/components/trace/lib/tree-building.ts:80-102`

```typescript
function prepareObservations(list: ObservationReturnType[]): {
  sortedObservations: ObservationReturnType[];
} {
  if (list.length === 0) return { sortedObservations: [] };

  // 构建所有 observation ID 的集合用于 O(1) 查找
  const observationIds = new Set(list.map((o) => o.id));

  // 关键逻辑：如果父节点不存在于当前列表中，清除 parentObservationId
  const mutableList = list.map((o) => {
    if (o.parentObservationId && !observationIds.has(o.parentObservationId)) {
      return { ...o, parentObservationId: null };  // 兜底：清除无效的父节点引用
    }
    return o;
  });

  // 按 start_time 排序
  const sortedObservations = mutableList.sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime(),
  );

  return { sortedObservations };
}
```

### 1.2 工作原理

| 步骤 | 逻辑 | 效果 |
|------|------|------|
| 1 | 构建所有 observation ID 的 Set | O(1) 时间复杂度查找 |
| 2 | 遍历每个 observation，检查 parentObservationId | 如果父节点不在当前列表中，设置为 null |
| 3 | 后续树形构建将 parentObservationId 为 null 的节点视为根节点 | 孤儿节点自动提升为根节点显示 |

### 1.3 测试证据

**代码位置**：`buildDependencyGraph` 函数（tree-building.ts:110-175）

```typescript
// 第三遍：使用 BFS 从上到下计算深度
const rootIds: string[] = [];
for (const [id, node] of nodeRegistry) {
  if (!node.observation.parentObservationId) {  // parentObservationId 为 null 或 undefined
    rootIds.push(id);  // 作为根节点处理
    node.depth = 0;
  }
}
```

**验证逻辑**：
- `!node.observation.parentObservationId` 同时兼容 `null` 和 `undefined`
- 被 `prepareObservations` 清除父节点引用的孤儿节点会被正确识别为根节点
- 树形图可以正确显示所有节点，不会出现"静默丢失"

---

## 2. parent_span_id 差异矩阵

### 2.1 写入路径对比

| 路径 | 根节点标识值 | 适用场景 | 代码位置 |
|------|-------------|---------|---------|
| **实时事件传播** | `parent_span_id = ''`（空字符串） | Synthetic Span（来自 Trace 双写） | `handleEventPropagationJob.ts:240-243` |
| **历史回填** | `parent_span_id = NULL` | 直接从 observations 表读取的根节点 | `backfillEventsHistoric.ts:450` |
| **Wrapper Trace 观察** | 父节点指向不存在的 `t-{traceId}` | 旧 SDK 无 trace_id 场景 | `IngestionService/index.ts:851-869` |

**实时传播 SQL 逻辑**：
```sql
CASE
  WHEN obs.id = concat('t-', obs.trace_id) THEN ''  // Synthetic Span → 空字符串
  ELSE coalesce(obs.parent_observation_id, concat('t-', obs.trace_id))
END AS parent_span_id
```

**历史回填 SQL 逻辑**：
```sql
if(o.id = o.trace_id, NULL, coalesce(o.parent_observation_id, concat('t-', o.trace_id))) AS parent_span_id
```

### 2.2 查询路径兼容性

#### 2.2.1 前端树形构建

**兼容情况**：✅ 完全兼容

**判断逻辑**（tree-building.ts:138-144）：
```typescript
if (!node.observation.parentObservationId) {
  rootIds.push(id);
  node.depth = 0;
}
```

- JavaScript 中 `!'' === true`（空字符串为 falsy）
- JavaScript 中 `!null === true`（null 为 falsy）
- **结论**：`''` 和 `NULL` 都会被正确识别为根节点

#### 2.2.2 其他查询路径

| 查询场景 | 根节点判断逻辑 | 兼容性 |
|---------|--------------|--------|
| **Trace 深度递归查询** | `parent_span_id IS NULL OR parent_span_id = ''` | ✅ 完全兼容 |
| **孤儿节点比例统计** | `parent_span_id NOT IN (子查询)` | ⚠️ 依赖具体实现 |
| **Public API 过滤** | `parentObservationId` 字段映射 | ✅ 字段级兼容 |

### 2.3 更新路径对比

**文件位置**：`packages/shared/src/server/repositories/events.ts:1506-1530`

```typescript
export const updateEvents = async (
  projectId: string,
  selector: { spanIds?: string[]; traceIds?: string[]; rootOnly?: boolean },
  updates: UpdateableEventFields,
): Promise<void> => {
  // ...
  
  const whereClause = `
    WHERE project_id = {projectId: String}
    ${selector.spanIds ? "AND span_id IN ({spanIds: Array(String)})" : ""}
    ${selector.traceIds ? "AND trace_id IN ({traceIds: Array(String)})" : ""}
    ${selector.rootOnly === true ? "AND parent_span_id = ''" : ""}  // ⚠️ 只匹配空字符串，不匹配 NULL
  `;
```

**关键发现**：
- `rootOnly` 标志只匹配 `parent_span_id = ''`
- **不匹配** `parent_span_id IS NULL`
- 历史回填的根节点如果是 `NULL`，使用 `rootOnly=true` 更新时会被漏掉

---

## 3. 校正后的用户可见影响结论

### 3.1 已被现有逻辑兜底的风险

| 风险场景 | Round 3 结论 | Round 4 校正结论 | 证据 |
|---------|-------------|-----------------|------|
| **孤儿节点在树形图中消失** | ❌ 高风险：静默丢失 | ✅ 已兜底：前端自动提升为根节点 | `prepareObservations` 函数清除无效父引用 |
| **平铺列表中不可见** | ⚠️ 部分影响 | ✅ 无影响：列表不依赖父子关系 | 查询直接返回所有匹配行 |
| **Trace 详情页空白** | ❌ 严重用户体验问题 | ✅ 已兜底：所有节点都能显示 | 根节点判断同时兼容 `''` 和 `NULL` |

### 3.2 仍然存在的真实风险

#### 风险 A：`rootOnly` 更新操作不一致

**影响范围**：
- 对实时写入的 Synthetic Span（`parent_span_id = ''`）：✅ 更新正常
- 对历史回填的根节点（`parent_span_id = NULL`）：❌ 更新不生效
- 对 Wrapper Trace 的观察（`parent_span_id = 't-{traceId}'`）：❌ 更新不生效

**用户可见表现**：
- 用户勾选"只更新根节点"批量操作时，部分根节点未被更新
- 特别是使用旧 SDK 数据的项目，批量 bookmark/公开操作效果不一致

**严重程度**：中

---

#### 风险 B：统计查询结果不一致

**影响场景**：
1. **根节点数量统计**：
   ```sql
   -- 查询 A：只统计空字符串
   SELECT count(*) FROM events WHERE parent_span_id = ''
   
   -- 查询 B：只统计 NULL
   SELECT count(*) FROM events WHERE parent_span_id IS NULL
   
   -- 查询 C：都统计
   SELECT count(*) FROM events WHERE parent_span_id = '' OR parent_span_id IS NULL
   ```
   不同写法得到不同结果，导致监控告警阈值漂移

2. **Trace 深度计算**：
   ```sql
   WITH RECURSIVE trace_depth AS (
     SELECT ... FROM events WHERE parent_span_id IS NULL  -- 不匹配 ''
     UNION ALL
     ...
   )
   ```
   如果递归 CTE 只处理 `NULL` 不处理 `''`，会漏掉 Synthetic Span 作为根的情况

**严重程度**：中低

---

#### 风险 C：下游消费者的静默不一致

**影响场景**：
- ETL 管道只过滤 `parent_span_id IS NULL` 作为根节点
- BI 报表统计根节点占比时只匹配一种情况
- 自定义脚本批量处理根节点逻辑不完整

**用户可见表现**：
- 基于 events 表的自定义分析数据不一致
- 某些分析只包含 Synthetic Span，某些只包含历史根节点

**严重程度**：低（只影响高级用户自定义分析）

---

#### 风险 D：Wrapper Trace 的父节点指向不存在节点

**虽然显示正常，但语义不一致**：

| 层面 | 表现 | 影响 |
|------|------|------|
| **显示层** | ✅ 正常显示为根节点 | 无用户体验问题 |
| **数据层** | ❌ parent_span_id = 't-{traceId}'，但该节点不存在 | 1. 统计查询可能把它算成非根<br>2. `rootOnly` 更新不生效<br>3. 自定义递归查询可能断链 |

**严重程度**：低（主要影响数据分析而非 UI）

---

## 4. 风险矩阵总结

| 风险 | 用户可见？ | 已兜底？ | 严重程度 | 建议优先级 |
|------|-----------|---------|---------|-----------|
| 树形图中孤儿节点消失 | ✅ 是 | ✅ 已兜底 | - | - |
| `rootOnly` 更新不匹配 NULL 根节点 | ⚠️ 间接可见 | ❌ 未兜底 | 中 | P2 |
| 统计查询根节点定义不一致 | ❌ 否（仅分析） | ❌ 未兜底 | 中低 | P3 |
| 下游消费者逻辑不完整 | ❌ 否（仅高级用户） | ❌ 未兜底 | 低 | P3 |
| Wrapper Trace 父节点指向不存在节点 | ⚠️ 间接 | ⚠️ 部分兜底 | 低 | P3 |

---

## 5. 建议修复方案

### 5.1 立即修复（P0）

**无需操作**：核心用户体验问题已被前端 `prepareObservations` 兜底。

### 5.2 近期修复（P2）

#### 方案 A：统一 `rootOnly` 更新的 WHERE 条件

**修改位置**：`packages/shared/src/server/repositories/events.ts:1526`

```sql
-- 修改前
${selector.rootOnly === true ? "AND parent_span_id = ''" : ""}

-- 修改后
${selector.rootOnly === true ? "AND (parent_span_id = '' OR parent_span_id IS NULL)" : ""}
```

**影响**：
- ✅ 修复 `rootOnly` 更新不匹配 NULL 根节点的问题
- ✅ 向后兼容，不影响现有数据
- ⚠️ 查询性能：需要同时匹配两种情况，但该字段不是主键索引

#### 方案 B：标准化所有根节点为单一值

**执行步骤**：
1. 选择标准化目标值（推荐 `''`，因为是现有 Synthetic Span 的值）
2. 执行一次性 backfill 更新 `parent_span_id IS NULL` → `parent_span_id = ''`
3. 修改历史回填 SQL 统一输出 `''` 而非 `NULL`

```sql
-- 一次性 backfill
ALTER TABLE events_full UPDATE parent_span_id = '' WHERE parent_span_id IS NULL;
ALTER TABLE events_core UPDATE parent_span_id = '' WHERE parent_span_id IS NULL;
```

**影响**：
- ✅ 彻底消除语义不一致
- ❌ 需要停止写入或协调双写期间的一致性
- ❌ 大数据量下 backfill 耗时较长

### 5.3 长期方案（P3）

#### 方案 C：在 events 表物化视图层统一

1. 创建标准化列：`is_root BOOLEAN`
2. 物化视图中计算：`is_root = (parent_span_id = '' OR parent_span_id IS NULL)`
3. 所有查询和更新使用 `is_root = true` 而非直接比较 `parent_span_id`

**优势**：
- 查询性能更好（布尔索引）
- 语义清晰，减少人为错误
- 兼容新旧数据格式

---

## 6. 附录：完整代码参考位置

| 功能 | 文件路径 | 关键行 |
|------|---------|--------|
| 父节点缺失兜底逻辑 | `web/src/components/trace/lib/tree-building.ts` | 80-102 |
| 根节点识别（树形构建） | `web/src/components/trace/lib/tree-building.ts` | 138-144 |
| 实时传播 parent_span_id 逻辑 | `worker/src/features/eventPropagation/handleEventPropagationJob.ts` | 240-243 |
| 历史回填 parent_span_id 逻辑 | `worker/src/backgroundMigrations/backfillEventsHistoric.ts` | 450 |
| rootOnly 更新 WHERE 条件 | `packages/shared/src/server/repositories/events.ts` | 1526 |
| Wrapper Trace 创建逻辑 | `worker/src/services/IngestionService/index.ts` | 851-869 |
