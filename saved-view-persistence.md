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

## 八、关键文件索引

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
| `web/src/features/filters/lib/persistedSidebarFilterQuery.ts` | 侧边栏筛选器持久化 |
| `web/src/features/rbac/constants/projectAccessRights.ts` | 权限定义 |
