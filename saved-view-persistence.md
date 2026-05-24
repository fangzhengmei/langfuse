# 保存视图与筛选状态持久化机制分析

## 一、核心数据模型

### 1.1 数据库表结构

#### TableViewPreset 表
`packages/shared/prisma/schema.prisma:1424-1449`

```prisma
model TableViewPreset {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  updatedAt DateTime @default(now()) @updatedAt

  projectId String  @map("project_id")
  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  name      String
  tableName String

  createdBy     String?
  createdByUser User?   @relation("CreatedByUser", fields: [createdBy], references: [id], onDelete: SetNull)
  updatedBy     String?
  updatedByUser User?   @relation("UpdatedByUser", fields: [updatedBy], references: [id], onDelete: SetNull)

  // 视图配置
  filters          Json
  columnOrder      Json
  columnVisibility Json
  searchQuery      String?
  orderBy          Json?

  @@unique([projectId, tableName, name])
  @@map("table_view_presets")
}
```

**关键约束**：`(projectId, tableName, name)` 联合唯一索引，确保同一项目同一表格下视图名称不重复。

#### DefaultView 表
`packages/shared/prisma/schema.prisma:1451-1470`

```prisma
model DefaultView {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  updatedAt DateTime @default(now()) @updatedAt

  projectId String
  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  userId String?
  user   User?   @relation("DefaultViewUser", fields: [userId], references: [id], onDelete: Cascade)

  viewName String
  viewId   String

  @@index([projectId, viewName])
  @@map("default_views")
}
```

**设计要点**：
- `viewId` 无外键约束，支持系统预设（以 `__langfuse_` 开头的ID）
- 通过部分索引实现唯一性约束：
  - 用户级默认：`UNIQUE(project_id, user_id, view_name) WHERE user_id IS NOT NULL`
  - 项目级默认：`UNIQUE(project_id, view_name) WHERE user_id IS NULL`

### 1.2 领域类型定义
`packages/shared/src/domain/table-view-presets.ts`

```typescript
export enum TableViewPresetTableName {
  Traces = "traces",
  Observations = "observations",
  ObservationsEvents = "observations-events",
  Scores = "scores",
  Sessions = "sessions",
  SessionDetail = "session-detail",
  Datasets = "datasets",
  Experiments = "experiments",
  ExperimentItems = "experiment-items",
}

export type TableViewPresetState = Pick<
  TableViewPresetDomain,
  "filters" | "columnOrder" | "columnVisibility" | "orderBy"
> & {
  searchQuery?: string | null;
};
```

**持久化内容**：每个视图保存 5 项状态：
1. `filters` - 筛选条件数组
2. `columnOrder` - 列顺序数组
3. `columnVisibility` - 列可见性映射
4. `orderBy` - 排序配置
5. `searchQuery` - 搜索关键词

---

## 二、视图创建流程

### 2.1 前端创建流程
`web/src/components/table/table-view-presets/components/data-table-view-presets-drawer.tsx:274-292`

```typescript
const handleCreateView = (createdView: { name: string }) => {
  capture("saved_views:create", { tableName, name: createdView.name });

  createMutation.mutate({
    name: createdView.name,
    tableName,
    projectId,
    orderBy: currentState.orderBy,       // 当前排序
    filters: currentState.filters,       // 当前筛选
    columnOrder: currentState.columnOrder,     // 当前列顺序
    columnVisibility: currentState.columnVisibility, // 当前列可见性
    searchQuery: currentState.searchQuery,       // 当前搜索词
  });

  setIsCreateDialogOpen(false);
};
```

### 2.2 后端创建流程
`packages/shared/src/server/services/TableViewService/TableViewService.ts:66-80`

```typescript
public static async createTableViewPresets(
  input: CreateTableViewPresetsInput,
  createdBy: string,
): Promise<TableViewPresetDomain> {
  const newTableViewPresets = await prisma.tableViewPreset.create({
    data: {
      createdBy,
      updatedBy: createdBy,
      ...input,
      orderBy: input.orderBy ?? undefined,
    },
  });

  return newTableViewPresets as unknown as TableViewPresetDomain;
}
```

### 2.3 API 层权限控制
`web/src/server/api/routers/tableViewPresets.ts:27-57`

```typescript
create: protectedProjectProcedure
  .input(CreateTableViewPresetsInput)
  .mutation(async ({ input, ctx }) => {
    throwIfNoProjectAccess({
      session: ctx.session,
      projectId: input.projectId,
      scope: "TableViewPresets:CUD",  // 需要写权限
    });

    try {
      const view = await TableViewService.createTableViewPresets(
        input,
        ctx.session.user?.id,
      );
      return { success: true, view };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new LangfuseConflictError(
          "Table view preset with this name already exists."
        );
      }
      throw error;
    }
  }),
```

---

## 三、视图加载机制

### 3.1 视图加载优先级
`web/src/components/table/table-view-presets/hooks/useTableViewManager.ts:142-201`

视图加载遵循三级优先级机制（从高到低）：

1. **URL 参数**（最高优先级）：`?viewId=xxx`
2. **Session Storage**：`${tableName}-${projectId}-viewId`
3. **默认视图**：用户级默认 > 项目级默认

```typescript
useEffect(() => {
  if (disabled) return;
  if (isInitialized) return;
  if (!isRouterReady) return;

  // 优先级1: URL参数中的viewId
  if (selectedViewId && (!isSystemPresetId(selectedViewId) || allowBackendSystemPresets)) {
    return;
  }

  // 优先级2: Session Storage（上一次访问的视图）
  if (storedViewId && (!isSystemPresetId(storedViewId) || allowBackendSystemPresets)) {
    setSelectedViewId(storedViewId);
    return;
  }

  // 优先级3: 默认视图（等待查询返回）
  if (isDefaultLoading) return;

  if (defaultViewId) {
    setStoredViewId(defaultViewId);
    setSelectedViewId(defaultViewId);
    return;
  }

  // 无视图可加载，使用默认表格配置
  setIsInitialized(true);
  setIsLoading(false);
}, [/* 依赖项 */]);
```

### 3.2 默认视图解析
`packages/shared/src/server/services/DefaultViewService/DefaultViewService.ts:95-115`

```typescript
public static async getResolvedDefault({
  projectId,
  viewName,
  userId,
}: GetResolvedDefaultParams): Promise<ResolvedDefault | null> {
  const assignments = await DefaultViewService.getDefaultAssignments({
    projectId, viewName, userId,
  });

  // 优先级: 用户默认 > 项目默认
  if (assignments.userDefaultViewId) {
    return { viewId: assignments.userDefaultViewId, scope: "user" };
  }

  if (assignments.projectDefaultViewId) {
    return { viewId: assignments.projectDefaultViewId, scope: "project" };
  }

  return null;
}
```

### 3.3 视图状态应用与验证
`web/src/components/table/table-view-presets/hooks/useTableViewManager.ts:204-301`

```typescript
const applyViewState = useCallback(
  (viewData: TableViewPresetState) => {
    setIsLoading(true);

    // 1. 验证排序配置
    let validOrderBy: OrderByState | null = null;
    if (viewData.orderBy) {
      validOrderBy = validateOrderBy(
        viewData.orderBy,
        validationContext.columns,
        validationContext.filterColumnDefinition,
      );
    }

    // 2. 验证筛选条件
    let validFilters: FilterState = [];
    if (viewData.filters) {
      validFilters = validateFilters(
        viewData.filters,
        validationContext.filterColumnDefinition,
      );
    }

    // 3. 检测过期配置并提示
    if (!isEqual(validOrderBy, viewData.orderBy) ||
        validFilters.length !== viewData.filters.length) {
      showErrorToast(
        "Outdated view",
        "This view is outdated. Some old filters or ordering may have been ignored."
      );
    }

    // 4. 应用验证后的状态
    if (setOrderByRef.current) setOrderByRef.current(validOrderBy);
    if (setFiltersRef.current) setFiltersRef.current(validFilters);
    if (viewData.searchQuery && setSearchQueryRef.current) {
      setSearchQueryRef.current(viewData.searchQuery);
    }
    if (viewData.columnOrder) setColumnOrder(viewData.columnOrder);
    if (viewData.columnVisibility) setColumnVisibility(viewData.columnVisibility);
  },
  [/* 依赖项 */]
);
```

### 3.4 系统预设视图
`packages/shared/src/server/services/TableViewService/systemPresets.ts`

系统预设是硬编码在代码中的视图，ID 以 `__langfuse_` 开头，不存储在数据库中。

```typescript
export const isSystemTableViewPresetId = (id: string | null): boolean =>
  !!id?.startsWith("__langfuse_");

// 示例：Observations Events 页面的系统预设
const OBSERVATIONS_EVENTS_SYSTEM_TABLE_VIEW_PRESETS: SystemTableViewPreset[] = [
  {
    id: "__langfuse_trace_root_observations",
    name: "Root Observations",
    description: "See top-level observations only",
    tableName: TableViewPresetTableName.ObservationsEvents,
    state: {
      filters: [{ column: "hasParentObservation", type: "boolean", operator: "=", value: false }],
      columnOrder: [],
      columnVisibility: {},
      orderBy: null,
      searchQuery: "",
    },
  },
  // ... 更多预设
];
```

---

## 四、跨页面共享机制

### 4.1 永久链接生成
`packages/shared/src/server/services/TableViewService/TableViewService.ts:322-342`

```typescript
private static readonly TABLE_NAME_TO_URL_MAP: Partial<Record<TableViewPresetTableName, string>> = {
  [TableViewPresetTableName.Traces]: "traces",
  [TableViewPresetTableName.Observations]: "observations",
  [TableViewPresetTableName.ObservationsEvents]: "traces",
  [TableViewPresetTableName.Scores]: "scores",
  [TableViewPresetTableName.Sessions]: "sessions",
  [TableViewPresetTableName.Datasets]: "datasets",
  [TableViewPresetTableName.Experiments]: "experiments",
  [TableViewPresetTableName.ExperimentItems]: "experiments/results",
};

public static async generatePermalink(
  baseUrl: string,
  TableViewPresetsId: string,
  tableName: TableViewPresetTableName,
  projectId: string,
): Promise<string> {
  const page = TABLE_NAME_TO_URL_MAP[tableName];
  if (!page) throw new Error(`Permalinks not supported for table ${tableName}`);
  return `${baseUrl}/project/${projectId}/${page}?viewId=${TableViewPresetsId}`;
}
```

### 4.2 永久链接访问流程

当用户访问 `?viewId=xxx` 链接时：

1. `useTableViewManager` 检测到 URL 中的 `viewId` 参数
2. 跳过 Session Storage 和默认视图，直接通过 API 加载该视图
3. 视图数据加载成功后，调用 `applyViewState()` 应用配置
4. 将 `viewId` 存入 Session Storage，以便在同会话内跨导航保持
5. 记录埋点 `saved_views:permalink_visit`

`web/src/components/table/table-view-presets/hooks/useTableViewManager.ts:321-358`

```typescript
useEffect(() => {
  if (!isSelectedViewSuccess || !selectedViewData) return;
  if (isInitializedRef.current) return;

  // 验证视图适用于当前表格
  if (!isViewApplicableToTable(tableName, selectedViewData.tableName)) {
    handleSetViewId(null);
    return;
  }

  // 跟踪永久链接访问
  capture("saved_views:permalink_visit", {
    tableName, viewId: requestedViewId, name: selectedViewData.name,
  });

  applyViewState(selectedViewData);
  if (storedViewId !== requestedViewId) {
    setStoredViewId(requestedViewId);
  }
  isInitializedRef.current = true;
  setIsInitialized(true);
}, [/* 依赖项 */]);
```

### 4.3 Session Storage 持久化
`web/src/components/table/table-view-presets/hooks/useTableViewManager.ts:75-78`

```typescript
// 按 tableName + projectId 隔离存储
const [storedViewId, setStoredViewId] = useSessionStorage<string | null>(
  `${tableName}-${projectId}-viewId`,
  null,
);
```

**作用域**：Session Storage 是按浏览器标签页隔离的，关闭标签页后失效。

### 4.4 兼容性处理：Observations 表重命名
`packages/shared/src/server/services/TableViewService/TableViewService.ts:38-46`

```typescript
// v4版本错误地将events表发布为observations名称
// 读取时兼容旧命名，写入时使用新命名
const getReadCompatibleTableNames = (tableName: TableViewPresetTableName) =>
  tableName === TableViewPresetTableName.ObservationsEvents
    ? [TableViewPresetTableName.ObservationsEvents, TableViewPresetTableName.Observations]
    : [tableName];
```

去重逻辑优先使用新命名空间的预设：
`packages/shared/src/server/services/TableViewService/TableViewService.ts:241-266`

---

## 五、多用户协作边界

### 5.1 RBAC 权限模型
`web/src/features/rbac/constants/projectAccessRights.ts:75-76`

```typescript
// 定义的权限范围
"TableViewPresets:read",  // 读取权限
"TableViewPresets:CUD",   // 创建/更新/删除权限
```

**各角色权限分配**：
| 角色         | read  | CUD   |
|-------------|-------|-------|
| Owner       | ✓     | ✓     |
| Admin       | ✓     | ✓     |
| Member      | ✓     | ✓     |
| Viewer      | ✓     | ✗     |

### 5.2 API 权限检查矩阵
`web/src/server/api/routers/tableViewPresets.ts`

| 操作          | 所需权限              | 说明                                   |
|--------------|----------------------|----------------------------------------|
| create       | TableViewPresets:CUD | 需要写权限                             |
| update       | TableViewPresets:CUD | 需要写权限                             |
| updateName   | TableViewPresets:CUD | 需要写权限                             |
| delete       | TableViewPresets:CUD | 需要写权限，同时清理默认视图引用        |
| getByTableName| TableViewPresets:read| 读取权限                               |
| getById      | TableViewPresets:read| 读取权限                               |
| generatePermalink | TableViewPresets:read | 读取权限                            |
| getDefault   | TableViewPresets:read| 读取权限                               |
| setAsDefault | 视scope而定          | user级: read; project级: CUD           |
| clearDefault | 视scope而定          | user级: read; project级: CUD           |

**注意**：设置默认视图时，用户级默认只需要读取权限（用户可为自己设置），但项目级默认需要写权限（影响所有用户）。

### 5.3 协作边界与限制

#### 5.3.1 视图可见性
- **项目内共享**：所有有 `TableViewPresets:read` 权限的项目成员都能看到所有用户创建的视图
- **无私有视图**：系统目前不支持仅创建者可见的私有视图
- **跨项目隔离**：视图严格按 projectId 隔离，无法跨项目访问

#### 5.3.2 修改边界
- **无所有者限制**：任何有 `TableViewPresets:CUD` 权限的用户都可以修改或删除其他用户创建的视图
- **更新无锁**：并发修改时后写入者覆盖先写入者（无乐观锁或版本检查）
- **删除级联**：删除视图时会自动清理引用该视图的默认视图配置
  `web/src/server/api/routers/tableViewPresets.ts:113-128`

```typescript
// 使用事务确保原子性
await ctx.prisma.$transaction(async (tx) => {
  // 先删除视图（不存在会抛出）
  await tx.tableViewPreset.delete({
    where: { id: input.tableViewPresetsId, projectId: input.projectId },
  });
  // 再清理默认视图引用
  await tx.defaultView.deleteMany({
    where: { viewId: input.tableViewPresetsId },
  });
});
```

#### 5.3.3 默认视图的协作
`packages/shared/src/server/services/DefaultViewService/DefaultViewService.ts:121-165`

```typescript
// 使用 Serializable 隔离级别防止并发写入竞争
await prisma.$transaction(
  async (tx) => {
    const existing = await tx.defaultView.findFirst({
      where: { projectId, viewName: canonicalViewName, userId: userIdToUse },
    });
    if (existing) {
      await tx.defaultView.update({
        where: { id: existing.id },
        data: { viewId, viewName: canonicalViewName },
      });
    } else {
      await tx.defaultView.create({
        data: { projectId, userId: userIdToUse, viewName: canonicalViewName, viewId },
      });
    }
  },
  { isolationLevel: "Serializable" },
);
```

**用户级默认**：
- 每个用户可为自己设置独立的默认视图
- 用户级默认优先级高于项目级默认
- 仅需 `TableViewPresets:read` 权限

**项目级默认**：
- 整个项目共享一个默认视图
- 需要 `TableViewPresets:CUD` 权限（通常是管理员）
- 设置项目级默认会影响所有未设置个人默认的用户

#### 5.3.4 并发与一致性
- **无实时同步**：视图修改后不会实时推送给其他在线用户，需刷新页面才能看到
- **无冲突检测**：多个用户同时修改同一视图时，最后提交的覆盖之前的
- **Session Storage 过期**：如果视图被删除，其他用户的 Session Storage 中可能还保留着旧的 viewId，加载时会优雅降级到默认视图

---

## 六、筛选器持久化的额外机制

### 6.1 侧边栏筛选器的 Session Storage 持久化
`web/src/features/filters/lib/persistedSidebarFilterQuery.ts`

```typescript
// 存储键格式：{tableName}-filter-query-{contextId}
export function buildSidebarFilterQueryStorageKey(params: {
  tableName: string;
  contextId?: string | null;
}): string {
  const scopedContextId = contextId ?? "global";
  return `${tableName}-filter-query-${scopedContextId}`;
}

// 存储格式：{ contextId, query }
export type PersistedSidebarFilterQueryState = {
  contextId: string | null;
  query: string;
};
```

**这是与保存视图独立的另一套持久化机制**：
- 仅持久化侧边栏的文本搜索查询
- 不包含筛选条件、列配置等完整视图状态
- 与视图持久化互补，用于快速恢复搜索框内容

---

## 七、优雅降级与兼容性处理

### 7.1 过期视图处理
`web/src/components/table/table-view-presets/hooks/useTableViewManager.ts:230-239`

当视图引用的列或筛选条件已不存在时：
1. 验证逻辑会过滤掉无效部分
2. 尽可能应用有效的配置
3. 显示警告提示用户更新视图
4. 应用继续正常运行

### 7.2 删除视图的处理
`web/src/components/table/table-view-presets/hooks/useTableViewManager.ts:360-379`

```typescript
useEffect(() => {
  if (!isSelectedViewError || !selectedViewError) return;

  isInitializedRef.current = true;
  setIsInitialized(true);
  setIsLoading(false);
  handleSetViewId(null);  // 清除无效的viewId
  showErrorToast("Error applying view", selectedViewError.message, "WARNING");
}, [/* 依赖项 */]);
```

### 7.3 系统预设的特殊处理
系统预设（`__langfuse_` 开头）不会被持久化到 URL 的 viewId 参数中：
`web/src/components/table/table-view-presets/hooks/useTableViewManager.ts:159-162`

```typescript
// 清除 URL 中过期的前端系统预设
if (selectedViewId && isSystemPresetId(selectedViewId)) {
  handleSetViewId(null);
  return;
}
```

---

## 八、冲突边界详细分析

### 8.1 URL、会话缓存、默认视图同时存在时的生效顺序及回退条件

#### 8.1.1 初始化状态机核心机制
`web/src/components/table/table-view-presets/hooks/useTableViewManager.ts`

整个初始化过程由 `isInitialized` 一次性锁控制，一旦设为 `true`，所有自动加载逻辑永久停止。这是理解所有优先级和回退行为的关键。

```typescript
const [isInitialized, setIsInitialized] = useState(false);
const isInitializedRef = useRef(isInitialized);
isInitializedRef.current = isInitialized;
```

`isInitialized` 仅在以下 4 种场景被设置为 `true`：
1. 调用 `handleSetViewId(null)` 且尚未初始化时（用户主动选择"My view (default)"）
2. 视图数据通过 `getById` 查询成功并完成 `applyViewState` 后
3. 视图查询失败（视图被删除、无权限等），错误处理分支中
4. 无任何视图可加载（URL、Session Storage、默认视图全部为空）

#### 8.1.2 优先级判定流程（Single Resolve Effect）
`web/src/components/table/table-view-presets/hooks/useTableViewManager.ts:142-201`

```typescript
useEffect(() => {
  if (disabled) return;
  if (isInitialized) return;      // 已初始化，永久跳过
  if (!isRouterReady) return;     // 等待路由就绪

  // ─── 优先级1: URL 参数 viewId ───
  if (selectedViewId && (!isSystemPresetId(selectedViewId) || allowBackendSystemPresets)) {
    return;  // 不做任何操作，让下方的 getById query 去加载
  }

  // 回退: URL 中的 viewId 是系统预设（__langfuse_ 开头），清除并继续
  if (selectedViewId && isSystemPresetId(selectedViewId)) {
    handleSetViewId(null);  // 这会设置 isInitialized=true，停止整个初始化流程
    return;
  }

  // ─── 优先级2: Session Storage 中的 storedViewId ───
  if (storedViewId && (!isSystemPresetId(storedViewId) || allowBackendSystemPresets)) {
    setSelectedViewId(storedViewId);  // 将 viewId 同步到 URL，触发 getById 查询
    return;
  }

  // ─── 优先级3: 默认视图（需等待查询返回）───
  if (isDefaultLoading) return;  // 等待默认视图查询完成

  if (defaultViewId) {
    // 回退: 默认视图是系统预设且不允许后端系统预设
    if (isSystemPresetId(defaultViewId) && !allowBackendSystemPresets) {
      handleSetViewId(null);
      return;
    }
    // 将默认视图同时写入 Session Storage 和 URL
    setStoredViewId(defaultViewId);
    setSelectedViewId(defaultViewId);
    return;
  }

  // ─── 优先级4: 无视图可加载，使用默认表格配置 ───
  setIsInitialized(true);
  setIsLoading(false);
}, [/* 依赖项 */]);
```

#### 8.1.3 完整优先级链条（从高到低）

| 层级 | 来源 | 存储键/位置 | 触发条件 | 回退条件 |
|------|------|-------------|----------|---------|
| 1 | URL `viewId` 参数 | `?viewId=xxx` | 非系统预设 ID | 是系统预设 ID → 清除并回退 |
| 2 | Session Storage | `${tableName}-${projectId}-viewId` | URL 无 viewId，且 Session 有值 | 是系统预设 ID → 跳过，继续下一级 |
| 3 | 用户级默认视图 | `default_views` 表（userId 非空） | URL 和 Session 均无值 | 不存在 → 继续下一级 |
| 4 | 项目级默认视图 | `default_views` 表（userId 为空） | URL、Session、用户默认均无值 | 不存在 → 继续下一级 |
| 5 | 默认表格配置 | 代码默认值 | 以上全部为空 | 无回退，最终状态 |

#### 8.1.4 回退场景详细说明

**场景 A：URL 中的 viewId 是系统预设**
```typescript
if (selectedViewId && isSystemPresetId(selectedViewId)) {
  handleSetViewId(null);  // 设置 isInitialized=true，终止初始化
  return;
}
```
- 系统预设（`__langfuse_` 开头）是页面特定的硬编码视图
- 不会持久化到 URL 参数，遇到时直接清除并终止初始化
- 结果：使用用户当前的工作视图（My view）

**场景 B：URL 中的 viewId 对应视图已删除/无权限**
`web/src/components/table/table-view-presets/hooks/useTableViewManager.ts:360-379`
```typescript
useEffect(() => {
  if (!isSelectedViewError || !selectedViewError) return;
  
  isInitializedRef.current = true;
  setIsInitialized(true);
  setIsLoading(false);
  handleSetViewId(null);  // 清除无效 viewId
  showErrorToast("Error applying view", selectedViewError.message, "WARNING");
}, [/* 依赖项 */]);
```
- getById 查询失败时，清除 URL 和 Session 中的 viewId
- 回退到默认表格配置
- 显示警告提示用户

**场景 C：默认视图是系统预设且不允许后端系统预设**
```typescript
if (defaultViewId) {
  if (isSystemPresetId(defaultViewId) && !allowBackendSystemPresets) {
    handleSetViewId(null);  // 终止初始化
    return;
  }
  // ...
}
```
- 前端系统预设（如 `__langfuse_default__`）不通过后端查询加载
- 遇到时直接回退到默认表格配置

**场景 D：Session Storage 中的 viewId 已失效**
- Session Storage 仅存储 viewId，不校验有效性
- 失效检测发生在 getById 查询阶段（同场景 B）
- 查询失败后自动清除并回退

#### 8.1.5 视图数据加载与应用时序
`web/src/components/table/table-view-presets/hooks/useTableViewManager.ts:303-358`

```typescript
// getById 查询仅在未初始化且有 viewId 时才启用
const { data: selectedViewData, isSuccess: isSelectedViewSuccess } =
  api.TableViewPresets.getById.useQuery(
    { viewId: selectedViewId as string, projectId },
    {
      enabled:
        !disabled &&
        isRouterReady &&
        !!selectedViewId &&
        !isInitialized &&  // 关键：初始化后不再查询
        (!isSystemPresetId(selectedViewId) || allowBackendSystemPresets),
    },
  );
```

查询成功后的应用流程：
1. 检查 `isInitializedRef.current` 是否已被其他分支设置
2. 检查 `selectedViewIdRef.current` 是否匹配（防止并发竞态）
3. 检查 `selectedViewData.tableName` 是否适用于当前表格
4. 调用 `applyViewState(selectedViewData)` 应用配置
5. 更新 Session Storage 中的 viewId
6. 设置 `isInitialized=true`，锁定状态

### 8.2 多人并发修改同一视图时的覆盖规则及默认视图清理的时序

#### 8.2.1 并发修改覆盖规则

**数据库层面：无乐观锁，无版本检查**
`packages/shared/src/server/services/TableViewService/TableViewService.ts:85-127`

```typescript
public static async updateTableViewPresets(
  input: UpdateTableViewPresetsInput,
  updatedBy: string,
): Promise<TableViewPresetDomain> {
  // 步骤1: 检查视图是否存在
  const tableViewPresets = await prisma.tableViewPreset.findFirst({
    where: {
      id: input.id,
      projectId: input.projectId,
      tableName: { in: getReadCompatibleTableNames(input.tableName) },
    },
  });

  if (!tableViewPresets) {
    throw new LangfuseNotFoundError("Saved table view preset not found");
  }

  // 步骤2: 直接更新，无条件检查
  try {
    const updatedTableViewPresets = await prisma.tableViewPreset.update({
      where: { id: input.id, projectId: input.projectId },
      data: {
        name: input.name,
        tableName: input.tableName,
        filters: input.filters,           // 直接覆盖
        columnOrder: input.columnOrder,   // 直接覆盖
        columnVisibility: input.columnVisibility, // 直接覆盖
        searchQuery: input.searchQuery,   // 直接覆盖
        orderBy: input.orderBy ?? undefined,
        updatedBy,
      },
    });

    return updatedTableViewPresets as unknown as TableViewPresetDomain;
  } catch (error) {
    return throwTableViewPresetConflictIfDuplicateName(error);
  }
}
```

**关键发现**：
- **无版本字段**：数据库表中没有 `version` 或 `updatedAt` 检查
- **读取和更新分离**：`findFirst` 和 `update` 是两个独立操作，非原子
- **唯一的冲突检测**：仅 `(projectId, tableName, name)` 联合唯一索引防止重命名冲突
- **后写入者获胜**：并发更新时，最后执行 `update` 的用户完全覆盖之前的所有修改

**前端层面：无实时同步**
- 视图列表通过 tRPC 查询加载，无 WebSocket 推送
- 其他用户的修改只有刷新页面或重新打开视图抽屉时才会看到
- `getDefault` 查询有 5 分钟缓存（`staleTime: 5 * 60 * 1000`），默认视图变更可能延迟感知

#### 8.2.2 删除视图时默认视图清理的时序
`web/src/server/api/routers/tableViewPresets.ts:113-128`

```typescript
// 使用事务确保原子性
await ctx.prisma.$transaction(async (tx) => {
  // 步骤1: 先删除视图预设（作为存在性检查）
  // 如果视图不存在，delete 会抛出异常，整个事务回滚
  await tx.tableViewPreset.delete({
    where: {
      id: input.tableViewPresetsId,
      projectId: input.projectId,
    },
  });

  // 步骤2: 再清理所有引用该视图的默认视图（用户级 + 项目级）
  await tx.defaultView.deleteMany({
    where: { viewId: input.tableViewPresetsId },
  });
});
```

**执行时序分析**：
1. **事务开始** → 2. **删除 TableViewPreset** → 3. **删除 DefaultView 引用** → 4. **事务提交**

**关键设计要点**：
- **顺序重要**：先删视图再删默认视图。因为 `tableViewPreset.delete` 会在视图不存在时抛出，可作为存在性校验
- **原子性保证**：两步操作在同一事务中，要么全部成功要么全部回滚
- **无外键约束**：`DefaultView.viewId` 没有外键约束（因为要支持系统预设），所以必须手动清理
- **清理范围**：`deleteMany` 会删除所有引用该 viewId 的默认视图，包括：
  - 所有用户的个人默认视图（`userId` 非空的记录）
  - 项目级默认视图（`userId` 为空的记录）

**对其他用户的影响**：
- 用户 A 删除视图 V，用户 B 已将 V 设为个人默认
- 事务执行后，用户 B 的 `default_views` 记录被删除
- 用户 B 下次加载页面时，`getDefault` 返回 null，回退到下一级
- 整个过程对用户 B 是透明的，不会报错

#### 8.2.3 设置默认视图的并发保护
`packages/shared/src/server/services/DefaultViewService/DefaultViewService.ts:121-165`

```typescript
// 使用 Serializable 隔离级别防止并发写入竞争
await prisma.$transaction(
  async (tx) => {
    const existing = await tx.defaultView.findFirst({
      where: {
        projectId,
        viewName: canonicalViewName,
        userId: userIdToUse,
      },
    });

    if (existing) {
      await tx.defaultView.update({
        where: { id: existing.id },
        data: { viewId, viewName: canonicalViewName },
      });
    } else {
      await tx.defaultView.create({
        data: {
          projectId,
          userId: userIdToUse,
          viewName: canonicalViewName,
          viewId,
        },
      });
    }
  },
  { isolationLevel: "Serializable" },  // 最高隔离级别
);
```

**Serializable 隔离级别的作用**：
- 两个并发请求设置同一用户/项目的默认视图时，数据库会串行化执行
- 避免重复插入（PostgreSQL 部分索引不被所有驱动识别为唯一约束）
- 后执行的请求会覆盖先执行的，保证最终一致性

### 8.3 跨页面返回后侧边栏筛选与保存视图的覆盖关系

#### 8.3.1 两套独立的持久化系统对比

| 维度 | 保存视图系统 `useTableViewManager` | 侧边栏筛选系统 `useSidebarFilterState` |
|------|----------------------------------|--------------------------------------|
| **核心钩子** | `useTableViewManager` | `useSidebarFilterState` |
| **持久化内容** | filters, columnOrder, columnVisibility, orderBy, searchQuery（完整视图） | 仅 filter 编码字符串（仅筛选条件） |
| **URL 参数** | `?viewId=xxx`（存储视图ID引用） | `?filter=xxx`（存储实际筛选编码） |
| **Session Storage** | 存 viewId | 存 filter 编码字符串 |
| **数据库存储** | 完整配置存 `table_view_presets` 表 | 不存数据库 |
| **初始化锁** | `isInitialized` 一次性锁 | 无锁，响应式更新 |
| **存储键格式** | `${tableName}-${projectId}-viewId` | `${tableName}-filter-query-${contextId}` |

#### 8.3.2 两个钩子的协同架构
`web/src/components/table/use-cases/traces.tsx:1305-1335`

```typescript
// 1. 侧边栏筛选先初始化
const queryFilter = useSidebarFilterState(
  tracesFilterConfig,
  filterOptions,
  queryFilterOptions,
);

// 2. 通过 ref 包装打破循环依赖
const queryFilterRef = useRef(queryFilter);
queryFilterRef.current = queryFilter;

// 3. 创建 wrapper，让视图管理器能调用侧边栏的方法
const setFiltersWrapper = useCallback(
  (filters: FilterState) => queryFilterRef.current?.setFilterState(filters),
  [],  // 空依赖！通过 ref 始终获取最新
);

// 4. 视图管理器后初始化
const { isLoading: isViewLoading, ...viewControllers } = useTableViewManager({
  tableName: TableViewPresetTableName.Traces,
  projectId,
  stateUpdaters: {
    setOrderBy: setOrderByState,
    setFilters: setFiltersWrapper,       // 关键：视图通过 wrapper 覆盖侧边栏
    setExpandedFilters: queryFilter.onExpandedChange,
    setColumnOrder: setColumnOrder,
    setColumnVisibility: setColumnVisibility,
    setSearchQuery: setSearchQuery,
  },
  validationContext: {
    columns,
    filterColumnDefinition: tracesFilterConfig.columnDefinitions,
    expandableFilterColumns: tracesFilterConfig.facets.map(f => f.column),
  },
  currentFilterState: queryFilter.explicitFilterState,  // 读取侧边栏当前状态
  currentExpandedFilters: queryFilter.expanded,
  disabled: hideControls,
});
```

**关键设计**：
- `setFiltersWrapper` 使用 `useCallback` 空依赖 + ref 模式
- 确保 `useTableViewManager` 始终调用最新的 `queryFilter.setFilterState`
- 避免因 `queryFilter` 变化导致 `useTableViewManager` 重新初始化

#### 8.3.3 侧边栏筛选的优先级机制
`web/src/features/filters/hooks/useSidebarFilterState.tsx:503-517`

```typescript
const urlFilterState: FilterState = useMemo(() => {
  if (stateLocationType !== "url" && stateLocationType !== "urlAndSessionStorage") {
    return [];
  }

  const rawQuery = (() => {
    // 优先级1: 待处理的乐观更新（防止URL异步更新导致闪烁）
    if (pendingFiltersQuery !== null) {
      return pendingFiltersQuery;
    }

    // 优先级2: URL 中的 filter 参数
    if (typeof urlFiltersQuery === "string") {
      return urlFiltersQuery;
    }

    // 优先级3: Session Storage 中的存储值（仅 urlAndSessionStorage 模式）
    if (stateLocationType === "urlAndSessionStorage") {
      return storedFiltersQuery;
    }

    return "";
  })();

  return decodeAndNormalizeFilters(rawQuery, config.columnDefinitions);
}, [/* 依赖项 */]);
```

#### 8.3.4 覆盖关系时序分析

**场景 A：页面首次加载，URL 同时有 `viewId` 和 `filter` 参数**

```
时序0: 组件挂载
├── queryFilter 初始化
│   ├── 从 URL 读取 filter=xxx 参数
│   └── 解码为筛选状态 A
│
└── useTableViewManager 初始化
    ├── 检测到 URL 中有 viewId=xxx
    ├── 触发 getById 查询视图 V
    ├── 查询成功，调用 applyViewState(V)
    │   └── setFiltersWrapper(V.filters)  → 调用 queryFilter.setFilterState
    │       ├── 编码 V.filters 为字符串 B
    │       ├── 设置 pendingFiltersQuery = B
    │       ├── 调用 setUrlFiltersQuery(B)  → 更新 URL 的 filter 参数
    │       └── 调用 setStoredFiltersQuery(B) → 更新 Session Storage
    └── 设置 isInitialized=true
```

**结果**：视图 V 的筛选配置 B 覆盖了 URL 原有的 filter 参数 A

**场景 B：跨页面返回，URL 只有 `filter` 参数，无 `viewId`**

```
时序0: 组件挂载
├── queryFilter 初始化
│   ├── 从 URL 读取 filter=xxx 参数
│   └── 解码为筛选状态 A
│
└── useTableViewManager 初始化
    ├── URL 无 viewId
    ├── 检查 Session Storage：如果有 viewId，进入场景 A 逻辑
    ├── Session Storage 也无 viewId
    ├── 检查默认视图：如果有，进入场景 A 逻辑
    ├── 均无，设置 isInitialized=true
    └── 不再干预筛选状态
```

**结果**：侧边栏筛选 A 保持生效，视图系统不干预

**场景 C：视图加载完成后，用户手动修改侧边栏筛选**

```
时序0: 用户在侧边栏勾选/取消筛选
├── queryFilter.setFilterState(newFilters)
│   ├── 编码为字符串 C
│   ├── 设置 pendingFiltersQuery = C
│   ├── 更新 URL filter 参数为 C
│   └── 更新 Session Storage 为 C
│
└── useTableViewManager 无动作
    ├── isInitialized 已为 true，所有自动加载逻辑停止
    ├── selectedViewId 仍保持原值（视图标记仍为选中）
    └── 仅 UI 显示"Update view with current filters"按钮提示差异
```

**结果**：侧边栏筛选覆盖当前显示数据，但不修改保存的视图定义

**场景 D：用户点击"Update view with current filters"**

```
时序0: 用户点击更新按钮
└── updateConfigMutation.mutate({
        id: selectedViewId,
        filters: queryFilter.explicitFilterState,  // 读取侧边栏当前状态
        columnOrder: currentState.columnOrder,
        columnVisibility: currentState.columnVisibility,
        orderBy: currentState.orderBy,
        searchQuery: currentState.searchQuery,
     })
     └── 后端 updateTableViewPresets 直接覆盖数据库记录
```

**结果**：侧边栏的当前筛选状态永久写入视图定义

#### 8.3.5 Session Storage 同步规则

**视图系统的 Session Storage 行为**：
```typescript
// 存储键：${tableName}-${projectId}-viewId
// 存储值：viewId 字符串或 null
const [storedViewId, setStoredViewId] = useSessionStorage<string | null>(
  `${tableName}-${projectId}-viewId`,
  null,
);
```
- **写入时机**：选择视图时、加载视图成功时、切换到"My view"时
- **清除时机**：加载视图失败时、用户手动切换到"My view"时
- **作用范围**：仅存储 viewId 引用，不存储实际配置

**侧边栏筛选的 Session Storage 行为**：
`web/src/features/filters/hooks/useSidebarFilterState.tsx:678-695`

```typescript
// 当 URL 有明确 filter 参数时，同步到 Session Storage
useEffect(() => {
  if (stateLocationType !== "urlAndSessionStorage") return;
  if (pendingFiltersQuery !== null) return;
  if (typeof urlFiltersQuery !== "string") return;
  if (!urlFiltersQuery) return;
  if (urlFiltersQuery === storedFiltersQuery) return;

  setStoredFiltersQuery(urlFiltersQuery);
}, [/* 依赖项 */]);
```

**跨页面返回时的交互**：
- 用户在 Traces 页选择视图 V → Session Storage 存 `viewId=V_id`
- 用户导航到 Sessions 页 → 独立的 Session Storage 键 `sessions-${projectId}-viewId`
- 用户点击浏览器返回 Traces 页 → 读取 `traces-${projectId}-viewId` 恢复视图 V
- 视图 V 加载时，其筛选配置覆盖侧边栏的 Session Storage 筛选

#### 8.3.6 覆盖关系总结

| 阶段 | 主导系统 | 行为 |
|------|---------|------|
| **初始化阶段** | 保存视图系统（优先级更高） | 加载视图 → 覆盖侧边栏筛选 → 锁定初始化状态 |
| **初始化完成后** | 侧边栏筛选系统 | 用户修改筛选 → 更新 URL 和 Session Storage → 不影响视图定义 |
| **用户主动更新视图** | 双向同步 | 读取侧边栏当前状态 → 写入视图数据库定义 |
| **跨页面返回** | 保存视图系统 | Session Storage 中的 viewId 恢复视图 → 覆盖侧边栏 |

**唯一例外**：当 URL 只有 `filter` 参数而无 `viewId`，且 Session Storage 和默认视图均无值时，侧边栏筛选独立生效，不被视图系统覆盖。

---

## 九、关键文件索引

| 文件路径 | 说明 |
|---------|------|
| `packages/shared/prisma/schema.prisma:1424-1470` | 数据库表结构定义 |
| `packages/shared/src/domain/table-view-presets.ts` | 领域类型与 Zod Schema |
| `packages/shared/src/server/services/TableViewService/TableViewService.ts` | 视图服务层 |
| `packages/shared/src/server/services/TableViewService/systemPresets.ts` | 系统预设定义 |
| `packages/shared/src/server/services/DefaultViewService/DefaultViewService.ts` | 默认视图服务 |
| `web/src/server/api/routers/tableViewPresets.ts` | tRPC API 路由 |
| `web/src/components/table/table-view-presets/hooks/useTableViewManager.ts` | 前端视图管理核心钩子 |
| `web/src/components/table/table-view-presets/components/data-table-view-presets-drawer.tsx` | 视图选择 UI 组件 |
| `web/src/features/filters/hooks/useSidebarFilterState.tsx` | 侧边栏筛选状态管理 |
| `web/src/features/filters/lib/persistedSidebarFilterQuery.ts` | 侧边栏筛选器持久化 |
| `web/src/features/rbac/constants/projectAccessRights.ts` | 权限定义 |
| `web/src/components/useSessionStorage.tsx` | Session Storage 通用钩子 |
