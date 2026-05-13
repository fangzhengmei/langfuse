# 组织与项目权限范围解析机制

本文档详细说明了 Langfuse 系统中组织(Organization)与项目(Project)两层权限叠加的完整解析机制，可用于权限配置复核。

---

## 一、Membership 数据模型

### 1.1 核心数据结构

#### Role 枚举定义

系统定义了5种角色层级（从高到低）：

```prisma
enum Role {
  OWNER   // 所有者 - 完全控制
  ADMIN   // 管理员 - 管理权限
  MEMBER  // 成员 - 读写权限
  VIEWER  // 查看者 - 只读权限
  NONE    // 无权限
}
```

#### OrganizationMembership 模型

组织成员关系表，存储用户在组织层面的角色：

```prisma
model OrganizationMembership {
  id                 String              @id @default(cuid())
  userId             String              @map("user_id")
  orgId              String              @map("organization_id")
  role               Role
  user               User                @relation(fields: [userId], references: [id], onDelete: Cascade)
  organization       Organization        @relation(fields: [orgId], references: [id], onDelete: Cascade)
  ProjectMemberships ProjectMembership[]
  
  @@unique([userId, orgId])
  @@map("organization_memberships")
}
```

#### ProjectMembership 模型

项目成员关系表，存储用户在特定项目上的角色覆盖：

```prisma
model ProjectMembership {
  id                String                 @id @default(cuid())
  userId            String                 @map("user_id")
  projectId         String                 @map("project_id")
  role              Role
  orgMembershipId   String                 @map("org_membership_id")
  user              User                   @relation(fields: [userId], references: [id], onDelete: Cascade)
  project           Project                @relation(fields: [projectId], references: [id], onDelete: Cascade)
  organizationMembership OrganizationMembership @relation(fields: [orgMembershipId], references: [id], onDelete: Cascade)

  @@unique([projectId, userId])
  @@map("project_memberships")
}
```

---

## 二、权限范围解析核心逻辑

### 2.1 角色叠加规则

**核心原则：项目角色覆盖组织角色**

用户在某个项目上的最终权限由以下规则决定：

1. **显式项目角色优先**：如果用户在该项目上有明确的 `ProjectMembership` 记录，则使用该记录中的 `role`
2. **组织角色继承**：如果没有项目级别的成员关系，则继承用户在所属组织中的 `role`
3. **管理员例外**：系统级管理员（`user.admin === true`）自动拥有所有组织和项目的 `OWNER` 权限

### 2.2 resolveProjectRole 核心函数

位置：`packages/shared/src/server/auth/userProjectRoleAuth.ts:6-19`

```typescript
export function resolveProjectRole({
  projectId,
  projectMemberships,
  orgMembershipRole,
}: {
  projectId: string;
  projectMemberships: ProjectMembership[];
  orgMembershipRole: Role;
}): Role {
  return (
    projectMemberships.find((membership) => membership.projectId === projectId)
      ?.role ?? orgMembershipRole
  );
}
```

**逻辑解析**：
- 在用户的所有项目成员关系中查找目标项目
- 找到则返回项目角色
- 未找到则返回组织角色作为默认值

---

## 三、Session 中间件：权限注入流程

### 3.1 认证回调中的权限计算

位置：`web/src/server/auth.ts:852-896`

在用户登录时的 Session 回调中，系统会预计算用户在所有组织和项目上的权限：

```typescript
organizations: dbUser.organizationMemberships.map(
  (orgMembership) => {
    return {
      id: orgMembership.organization.id,
      name: orgMembership.organization.name,
      role: orgMembership.role,                    // 组织级角色
      projects: orgMembership.organization.projects
        .map((project) => {
          const projectRole = resolveProjectRole({
            projectId: project.id,
            projectMemberships: orgMembership.ProjectMemberships,
            orgMembershipRole: orgMembership.role,
          });
          return {
            id: project.id,
            name: project.name,
            role: projectRole,                      // 计算后的最终项目角色
            retentionDays: project.retentionDays,
            hasTraces: project.hasTraces,
            deletedAt: project.deletedAt,
            metadata: project.metadata,
          };
        })
        // 仅保留有读取权限的项目
        .filter((project) =>
          projectRoleAccessRights[project.role].includes("project:read"),
        ),
    };
  },
),
```

**关键流程**：
1. 遍历用户的所有组织成员关系
2. 对每个组织下的每个项目，调用 `resolveProjectRole` 计算最终角色
3. 过滤掉没有 `project:read` 权限的项目（前端不可见）
4. 权限结果被序列化到 Session 的 JWT 中

---

## 四、完整链路：从中间件注入到 Scope 断言到路由调用

### 4.1 第一步：tRPC 中间件注入角色到 Context

位置：`web/src/server/api/trpc.ts:271-360`

```typescript
const enforceUserIsAuthedAndProjectMember = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  
  // 1. 认证检查
  if (!ctx.session || !ctx.session.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  // 2. 从请求输入中提取 projectId
  const actualInput = await opts.getRawInput();
  const parsedInput = inputProjectSchema.safeParse(actualInput);
  
  // 3. 在 Session 中匹配项目（已预计算权限）
  const projectId = parsedInput.data.projectId;
  const sessionProject = ctx.session.user.organizations
    .flatMap((org) =>
      org.projects.map((project) => ({ ...project, organization: org })),
    )
    .find((project) => project.id === projectId);

  // 4. 权限判定
  if (!sessionProject) {
    // 4a. 系统管理员例外
    if (ctx.session.user.admin === true) {
      // 管理员强制赋予 OWNER 权限
      return next({
        ctx: {
          session: {
            ...ctx.session,
            orgId: dbProject.orgId,
            orgRole: Role.OWNER,
            projectId: projectId,
            projectRole: Role.OWNER,
          },
        },
      });
    }
    // 4b. 普通用户无权限
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "User is not a member of this project",
    });
  }

  // 5. ⭐ 将预计算的角色注入 API Context
  // 这是后续 Scope 断言的基础数据
  return next({
    ctx: {
      session: {
        ...ctx.session,
        orgId: sessionProject.organization.id,
        orgRole: sessionProject.organization.role,
        projectId: projectId,
        projectRole: sessionProject.role,
      },
    },
  });
});
```

**Context 注入结果**：API Handler 可以通过 `ctx.session.projectRole` 获取最终角色

---

### 4.2 第二步：Scope 断言函数校验权限

位置：`web/src/features/rbac/utils/checkProjectAccess.ts:28-68`

```typescript
/**
 * 检查用户是否有指定 Scope 权限，无权限则抛出 TRPCError
 * 在路由 Handler 第一行调用
 */
export const throwIfNoProjectAccess = (p: HasProjectAccessParams) => {
  if (!hasProjectAccess(p))
    throw new TRPCError({
      code: "FORBIDDEN",
      message: p.forbiddenErrorMessage ?? 
        "User does not have access to this resource or action",
    });
};

/**
 * 核心权限判断逻辑
 */
function hasProjectAccess(p: HasProjectAccessParams): boolean {
  // 1. 系统管理员绕过所有检查
  const isAdmin = hasOwnRole(p) ? p.admin : p.session?.user?.admin;
  if (isAdmin) return true;

  // 2. 从 Context 中获取中间件预注入的项目角色
  // 两种调用方式：
  //    a) 直接传 role（中间件已注入后使用）
  //    b) 传 session + projectId（未注入时自行查找）
  const projectRole: Role | undefined = hasOwnRole(p)
    ? p.role
    : p.session?.user?.organizations
        .flatMap((org) => org.projects)
        .find((project) => project.id === p.projectId)?.role;
  
  if (projectRole === undefined) return false;

  // 3. ⭐ 查表：根据角色映射到具体 Scope 列表
  return projectRoleAccessRights[projectRole].includes(p.scope);
}
```

---

### 4.3 第三步：路由 Handler 调用断言

位置：`web/src/features/rbac/server/membersRouter.ts` （典型路由示例）

```typescript
// 创建受保护的项目级路由
export const membersRouter = createTRPCRouter({
  // 示例1：查询项目成员
  byProjectId: protectedProjectProcedure
    .input(z.object({
      projectId: z.string(),
      searchQuery: z.string().optional(),
    }))
    .query(async ({ input, ctx }) => {
      // ⭐ 第一行即做 Scope 断言
      // 使用中间件已注入的 ctx.session.projectRole
      throwIfNoProjectAccess({
        role: ctx.session.projectRole,
        scope: "projectMembers:read",
      });

      // 权限校验通过后执行业务逻辑...
      const users = await getUserProjectRoles({
        projectId: input.projectId,
        orgId: ctx.session.orgId,
        // ...
      });
      return users;
    }),
});
```

---

### 4.4 完整链路总结图

```
┌─────────────────────────────────────────────────────────────────────┐
│                    权限校验完整执行链路                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  用户发送 API 请求                                      │
│      │                                                             │
│      ▼                                                             │
│  1. tRPC 中间件 enforceUserIsAuthedAndProjectMember                   │
│      │                                                             │
│      ├─ 检查 session.user 是否存在                                    │
│      ├─ 从输入中解析 projectId                                       │
│      ├─ 在 Session 中查找项目（通过预计算的 projects 列表）              │
│      └─ 将 {orgId, orgRole, projectId, projectRole} 注入 ctx.session    │
│                                                                     │
│      │                                                             │
│      ▼                                                             │
│  2. 路由 Handler 执行                                                 │
│      │                                                             │
│      ▼                                                             │
│  3. ⭐ 调用 throwIfNoProjectAccess() 做 Scope 断言                      │
│      │                                                             │
│      ├─ 参数：{ role: ctx.session.projectRole, scope: "..." }          │
│      ├─ 查表 projectRoleAccessRights[role]                           │
│      └─ 不包含所需 Scope 则抛出 FORBIDDEN                               │
│                                                                     │
│      │                                                             │
│      ▼                                                             │
│  4. 执行业务逻辑                                                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 五、项目角色设为 NONE 的过滤逻辑与边界示例

### 5.1 为什么 NONE 角色会被过滤？

**根本原因**：`projectRoleAccessRights[NONE] = []`，即 NONE 角色没有任何权限，包括 `project:read`。

**过滤发生在两个关键节点**：

---

#### 过滤节点 1：Session 生成时（后端）

位置：`web/src/server/auth.ts:139-141`

```typescript
projects: orgMembership.organization.projects
  .map((project) => {
    const projectRole = resolveProjectRole({...});
    return { id: project.id, name: project.name, role: projectRole, ... };
  })
  // ⭐ 这里过滤掉最终角色为 NONE 的项目
  .filter((project) =>
    projectRoleAccessRights[project.role].includes("project:read"),
  ),
```

**逻辑**：
- 当 `resolveProjectRole()` 返回 `NONE` 时（无论是组织级还是项目级设为 NONE）
- `projectRoleAccessRights[NONE]` 是空数组 `[]`
- `[].includes("project:read")` 返回 `false`
- 该项目从 `session.user.organizations[*].projects` 列表中被移除

---

#### 过滤节点 2：前端 AppLayout 层拦截（前端）

**真实实现逻辑**：

位置：`web/src/components/layouts/app-layout/index.tsx:85-103`

```typescript
// Project access denied - handle based on path type
if (session.status === "authenticated" && !projectAccess.hasAccess) {
  // For publishable paths (shared traces/sessions), render minimal layout without sidebar
  // This allows authenticated users to view shared content without seeing project navigation
  if (isPublishable) {
    return <MinimalLayout>{props.children}</MinimalLayout>;
  }

  // For non-publishable paths, show error page
  return (
    <ErrorPageWithSentry
      title="Project Not Found"
      message="The project you are trying to access does not exist or you do not have access to it."
      additionalButton={{
        label: "Go to Home",
        href: "/",
      }}
    />
  );
}
```

**触发条件**（同时满足）：
1. `session.status === "authenticated"` - 用户已登录
2. `!projectAccess.hasAccess` - Hook 返回无访问权限（即项目不在 Session projects 列表中）

**实际返回结果**（分两种情况）：
- **情况 A - 可公开路径（isPublishable = true）**：
  - 包括：共享的 traces、sessions 页面
  - 返回：`<MinimalLayout>` 极简布局（无侧边栏导航）
  - 目的：允许已登录用户查看共享内容，不暴露项目导航

- **情况 B - 普通项目路径（isPublishable = false）**：
  - 包括：项目设置、成员管理等所有其他项目页面
  - 返回：`<ErrorPageWithSentry>` 错误页面
  - 标题："Project Not Found"
  - 提示信息："The project you are trying to access does not exist or you do not have access to it."
  - 带"Go to Home"按钮返回首页

**关键点说明**：
- 不是统一的 HTTP 403 状态码，而是在 React 组件层面的布局切换
- 故意使用"Project Not Found"而非"Access Denied"，避免泄露项目存在性信息
- 共享路径特殊处理保证分享链接体验

---

### 5.2 边界示例：显式设为 NONE 实现"组织内排除"

**场景**：某组织有 3 个项目，用户 A 在组织级是 ADMIN，但需要被排除在其中一个敏感项目之外。

#### 数据库配置：

```sql
-- 组织成员关系（ADMIN 角色）
INSERT INTO organization_memberships (id, user_id, organization_id, role)
VALUES ('om-1', 'user-a-id', 'org-1', 'ADMIN');

-- 项目成员关系（显式设为 NONE，排除 project-1）
INSERT INTO project_memberships (id, user_id, project_id, role, org_membership_id)
VALUES 
  ('pm-1', 'user-a-id', 'project-1', 'NONE', 'om-1');
```

#### 权限计算过程：

| 项目 ID | 组织角色 | 是否有 ProjectMembership | 项目角色 | 最终角色 | 是否有 project:read |
|---------|---------|-------------------------|---------|---------|-------------------|
| project-1 | ADMIN | ✅ 有 | NONE | NONE | ❌ 被过滤 |
| project-2 | ADMIN | ❌ 无 | - | ADMIN | ✅ 可见 |
| project-3 | ADMIN | ❌ 无 | - | ADMIN | ✅ 可见 |

#### 最终效果：

1. **Session 中的 projects 列表**：仅包含 `project-2`、`project-3`
2. **前端项目选择器**：只显示 Project 2、Project 3
3. **直接访问 `/project/project-1/settings`**：
   - 非共享路径 → 显示"Project Not Found"错误页面（不是 403）
4. **直接调用 API `membersRouter.byProjectId`**：
   - 中间件在 `session.user.organizations[*].projects` 中找不到 `project-1`
   - 抛出 `UNAUTHORIZED: "User is not a member of this project"`

#### 关键意义：

这种设计使得管理员可以**在组织级别给予广泛权限的同时，选择性排除特定项目**，实现了"黑名单"式的权限管理模式。

---

## 六、成员查询函数职责与风险分析

### 6.1 两个成员查询函数的职责划分

系统中存在两个独立的项目成员查询函数，各自服务不同场景：

---

#### 函数 A：getMembers() - 项目设置页面成员表

**位置**：`web/src/features/rbac/server/allMembersRoutes.ts:27-140`

**使用入口**：
- 路由：`allMembersRoutes.allFromProject`
- 页面：`/project/{id}/settings/members` → `<MembersTable>` 组件
- 用途：项目/组织设置页面的成员管理表格

**查询逻辑**（第 38-59 行）：
```typescript
whereClause = {
  orgId: query.orgId,
  // restrict to only members with role in a project if projectId is set and showAllOrgMembers is false
  ...("projectId" in query && !showAllOrgMembers
    ? {
        // either org level role or project level role
        OR: [
          { role: { not: Role.NONE } },                    // 组织角色不是 NONE
          {
            ProjectMemberships: {
              some: {
                projectId: query.projectId,
                role: { not: Role.NONE },                 // 当前项目角色不是 NONE
              },
            },
          },
        ],
      }
    : {}),
};
```

**关键设计**：
- 基于 `OrganizationMembership` 主表查询
- `showAllOrgMembers` 标志控制：有组织级权限显示全部，只有项目级权限显示有项目权限的
- 通过左连接查询 `projectRole` 字段并展示在表格中
- 用户在其他项目有覆盖不影响本查询结果

---

#### 函数 B：getUserProjectRoles() - 通知/分配下拉列表

**位置**：`packages/shared/src/server/auth/userProjectRoleAuth.ts:43-96`

**使用入口**：
- `membersRouter.byProjectId` - 获取可 @ 提及的用户列表
- `commentMentionHandler.ts` - 评论通知的收件人范围
- `annotationQueueAssignmentsRouter.ts` - 标注任务分配的可选用户
- `comments.ts` - 评论功能的提及列表
- Public API: `/api/public/annotation-queues/[queueId]/assignments`

**查询逻辑**（UNION 查询）：
```sql
WITH all_eligible_users AS (
  -- 第一部分：仅继承组织角色的用户（无任何项目级覆盖）
  SELECT u.id, u.name, u.email, om.role as role
  FROM organization_memberships om
  INNER JOIN users u ON om.user_id = u.id
  WHERE om.org_id = ?
    AND om.role != 'NONE'
    AND NOT EXISTS (
      SELECT 1 FROM project_memberships pm 
      WHERE pm.org_membership_id = om.id
      -- ❌ 没有限定 pm.project_id = 当前查询项目！
    )
  
  UNION
  
  -- 第二部分：有当前项目显式角色覆盖的用户
  SELECT u.id, u.name, u.email, pm.role as role
  FROM organization_memberships om
  INNER JOIN project_memberships pm ON om.id = pm.org_membership_id
  INNER JOIN users u ON om.user_id = u.id
  WHERE om.org_id = ?
    AND pm.project_id = ?
    AND pm.role != 'NONE'
)
```

---

### 6.2 边界场景：showAllOrgMembers = false 时的黑名单误显示问题

#### 触发前提条件

**前提 1 - 查看者权限**：调用 `allMembersRoutes.allFromProject` 接口的用户
- ✅ 有**项目级**权限：`hasProjectAccess({ projectId, scope: "projectMembers:read" }) = true`
- ❌ **没有**组织级权限：`hasOrganizationAccess({ scope: "organizationMembers:read" }) = false`
- 最终：`showAllOrgMembers = orgAccess = false`

**前提 2 - 被查看者配置**：
- 组织角色非 NONE（如 VIEWER、MEMBER 等）
- **在当前项目显式设为 NONE**（即黑名单排除）

#### 为什么与"成员表逻辑正确"相冲突？

`OR` 查询条件的逻辑问题：
```sql
-- 实际 SQL 条件（showAllOrgMembers = false 时）
WHERE org.role != 'NONE'                    -- 条件 A：组织角色非 NONE
   OR EXISTS (                              -- 条件 B：当前项目角色非 NONE
         SELECT 1 FROM project_memberships pm
         WHERE pm.org_membership_id = org.id
           AND pm.project_id = ?
           AND pm.role != 'NONE'
       )
```

**冲突分析**：
- 黑名单用户满足**条件 A**（组织角色非 NONE），即使在当前项目是 NONE
- OR 逻辑意味着只要条件 A 满足，用户就被包含在结果中
- 但根据权限规则，项目角色 NONE 应该完全排除该项目访问权限

#### 实际影响：哪些人会被误显示？

| 用户配置 | 实际最终权限 | showAllOrgMembers=true<br>（组织管理员查看） | showAllOrgMembers=false<br>（仅项目管理员查看） |
|---------|-------------|-----------------------------------------|---------------------------------------------|
| 组织角色 MEMBER<br>无项目角色覆盖 | ✅ MEMBER | ✅ 显示（正确） | ✅ 显示（正确） |
| 组织角色 MEMBER<br>当前项目设为 ADMIN | ✅ ADMIN | ✅ 显示（正确） | ✅ 显示（正确） |
| 组织角色 MEMBER<br>当前项目设为 NONE<br>（黑名单排除） | ❌ NONE（不可访问） | ✅ 显示（组织管理员可见） | ⚠️ **误显示！**<br>用户实际不能访问项目，但出现在成员表中 |
| 组织角色 NONE<br>当前项目设为 OWNER | ✅ OWNER | ✅ 显示（正确） | ✅ 显示（正确） |

#### 与现有代码一致的修正思路

**SQL 条件修正**：在第一个 OR 分支中增加"当前项目无显式覆盖"的排除条件：

```sql
-- 修改前
WHERE org.role != 'NONE'
   OR EXISTS (/* 当前项目角色非 NONE */)

-- 修改后（不改变原有代码模式，仅补充条件）
WHERE (
  org.role != 'NONE'
  AND NOT EXISTS (
    SELECT 1 FROM project_memberships pm
    WHERE pm.org_membership_id = org.id
      AND pm.project_id = ?  -- 关键：限定当前项目
  )
) OR EXISTS (/* 当前项目角色非 NONE */)
```

**TypeScript 对应修正**（保持现有代码结构）：
```typescript
OR: [
  // 修改前：{ role: { not: Role.NONE } }
  // 修改后：
  {
    role: { not: Role.NONE },
    NOT: {
      ProjectMemberships: {
        some: { projectId: query.projectId }
      }
    }
  },
  {
    ProjectMemberships: {
      some: {
        projectId: query.projectId,
        role: { not: Role.NONE },
      },
    },
  },
],
```

**修正逻辑说明**：
- 第一个分支：组织角色非 NONE **且**在当前项目没有任何显式角色 → 显示（继承组织角色）
- 第二个分支：在当前项目有显式角色且非 NONE → 显示（项目覆盖）
- 被排除：组织角色非 NONE 但在当前项目显式设为 NONE → 不显示（黑名单）

---

### 6.3 getUserProjectRoles() 风险结论

#### 核心问题识别

第一个 UNION 分支的 `NOT EXISTS` 子查询**没有限定 `pm.project_id = ?`**，导致：

```sql
NOT EXISTS (
  SELECT 1 FROM project_memberships pm 
  WHERE pm.org_membership_id = om.id
  -- 缺少：AND pm.project_id = ?
)
```

#### 实际影响矩阵

| 用户配置 | getMembers() 结果<br>（项目成员表） | getUserProjectRoles() 结果<br>（通知/分配下拉） | Session 访问权限 |
|---------|-------------------------------|---------------------------------------------|-----------------|
| 组织角色 MEMBER<br>无任何项目覆盖 | ✅ 显示，角色 MEMBER | ✅ 包含，角色 MEMBER | ✅ 可访问 |
| 组织角色 MEMBER<br>在**当前项目**设为 ADMIN | ✅ 显示，项目角色 ADMIN | ✅ 包含，角色 ADMIN | ✅ 可访问 |
| 组织角色 MEMBER<br>在**其他项目**设为 ADMIN<br>当前项目无覆盖 | ✅ 显示，项目角色空（继承 MEMBER） | ❌ **不包含** | ✅ 可访问 |
| 组织角色 NONE<br>在当前项目设为 OWNER | ✅ 显示，项目角色 OWNER | ✅ 包含，角色 OWNER | ✅ 可访问 |
| 组织角色 MEMBER<br>在当前项目设为 NONE<br>（showAllOrgMembers=false） | ⚠️ **误显示** | ❌ 不包含 | ❌ 不可访问 |

#### ⚠️ 准确风险结论

**影响范围仅限 getUserProjectRoles() 调用方**：
1. **评论 @ 提及下拉**：遗漏在其他项目有角色覆盖但当前项目继承组织角色的用户
2. **标注任务分配**：同上，无法分配给这类用户
3. **通知邮件收件人**：同上，这类用户收不到评论通知

**不影响的范围**：
- ❌ **不影响**用户实际访问权限（Session 计算逻辑独立、正确）
- ❌ **不影响**权限中间件和 Scope 断言

#### 根本原因

`getUserProjectRoles()` 的 SQL 查询意图是"找出没有任何项目覆盖的用户 → 继承组织角色"，但实际执行效果是"只要用户在任意项目有覆盖，无论哪个项目，都从继承组排除"。查询逻辑与权限计算的设计意图不一致。

---

## 七、组织角色/项目角色组合权限对照表

### 7.1 组合矩阵说明

**使用方法**：横向为组织角色，纵向为项目覆盖角色，交叉点为最终权限结果。

| 项目覆盖角色 ↓ | 组织角色：OWNER | 组织角色：ADMIN | 组织角色：MEMBER | 组织角色：VIEWER | 组织角色：NONE |
|--------------|----------------|----------------|-----------------|-----------------|---------------|
| **OWNER**    | 最终角色：OWNER<br>可见项目：✅<br>全部 Scope<br>（项目覆盖不降级） | 最终角色：OWNER<br>可见项目：✅<br>全部 Scope<br>（项目覆盖提升权限） | 最终角色：OWNER<br>可见项目：✅<br>全部 Scope<br>（项目覆盖提升权限） | 最终角色：OWNER<br>可见项目：✅<br>全部 Scope<br>（项目覆盖提升权限） | 最终角色：OWNER<br>可见项目：✅<br>全部 Scope<br>（项目覆盖提升权限） |
| **ADMIN**    | 最终角色：ADMIN<br>可见项目：✅<br>大部分管理权限<br>（项目覆盖降级） | 最终角色：ADMIN<br>可见项目：✅<br>大部分管理权限 | 最终角色：ADMIN<br>可见项目：✅<br>大部分管理权限<br>（项目覆盖提升权限） | 最终角色：ADMIN<br>可见项目：✅<br>大部分管理权限<br>（项目覆盖提升权限） | 最终角色：ADMIN<br>可见项目：✅<br>大部分管理权限<br>（项目覆盖提升权限） |
| **MEMBER**   | 最终角色：MEMBER<br>可见项目：✅<br>读写权限<br>（项目覆盖降级） | 最终角色：MEMBER<br>可见项目：✅<br>读写权限<br>（项目覆盖降级） | 最终角色：MEMBER<br>可见项目：✅<br>读写权限 | 最终角色：MEMBER<br>可见项目：✅<br>读写权限<br>（项目覆盖提升权限） | 最终角色：MEMBER<br>可见项目：✅<br>读写权限<br>（项目覆盖提升权限） |
| **VIEWER**   | 最终角色：VIEWER<br>可见项目：✅<br>只读权限<br>（项目覆盖降级） | 最终角色：VIEWER<br>可见项目：✅<br>只读权限<br>（项目覆盖降级） | 最终角色：VIEWER<br>可见项目：✅<br>只读权限<br>（项目覆盖降级） | 最终角色：VIEWER<br>可见项目：✅<br>只读权限 | 最终角色：VIEWER<br>可见项目：✅<br>只读权限<br>（项目覆盖提升权限） |
| **NONE**     | 最终角色：NONE<br>可见项目：❌ 被过滤<br>无任何权限<br>（组织内排除） | 最终角色：NONE<br>可见项目：❌ 被过滤<br>无任何权限<br>（组织内排除） | 最终角色：NONE<br>可见项目：❌ 被过滤<br>无任何权限<br>（组织内排除） | 最终角色：NONE<br>可见项目：❌ 被过滤<br>无任何权限<br>（组织内排除） | 最终角色：NONE<br>可见项目：❌ 被过滤<br>无任何权限 |
| **无覆盖（且无任何项目成员记录）**   | 最终角色：OWNER<br>可见项目：✅<br>全部 Scope<br>（继承组织） | 最终角色：ADMIN<br>可见项目：✅<br>大部分管理权限<br>（继承组织） | 最终角色：MEMBER<br>可见项目：✅<br>读写权限<br>（继承组织） | 最终角色：VIEWER<br>可见项目：✅<br>只读权限<br>（继承组织） | 最终角色：NONE<br>可见项目：❌ 被过滤<br>（继承组织） |
| **⚠️ 无覆盖（但其他项目有覆盖）** | 最终角色：OWNER<br>可见项目：✅<br>getUserProjectRoles 不包含<br>Session 正常继承 | 最终角色：ADMIN<br>可见项目：✅<br>getUserProjectRoles 不包含<br>Session 正常继承 | 最终角色：MEMBER<br>可见项目：✅<br>getUserProjectRoles 不包含<br>Session 正常继承 | 最终角色：VIEWER<br>可见项目：✅<br>getUserProjectRoles 不包含<br>Session 正常继承 | 最终角色：NONE<br>可见项目：❌ 被过滤 |

---

### 7.2 权限复核检查清单

权限复核时，请对照以下检查项：

| 检查项 | 预期结果 | 验证方法 |
|-------|---------|---------|
| 1. 无 ProjectMembership 时 | 最终角色 = 组织角色 | 检查 `resolveProjectRole()` 逻辑 |
| 2. 有 ProjectMembership 时 | 最终角色 = 项目角色（优先覆盖） | 检查 `resolveProjectRole()` 逻辑 |
| 3. 项目角色为 NONE 时 | 从 Session projects 列表中消失 | 检查 Session callback filter 逻辑 |
| 4. 组织角色为 NONE 时 | 所有项目默认不可见 | 检查 `projectRoleAccessRights[NONE]` 为空数组 |
| 5. 系统管理员访问时 | 自动注入 OWNER 角色 | 检查中间件中的 admin 旁路逻辑 |
| 6. API 调用 Scope 检查 | 必须调用 `throwIfNoProjectAccess()` | 检查路由 Handler 第一行代码 |
| 7. 前端路由访问 NONE 项目 | AppLayout 返回 ErrorPage 或 MinimalLayout | 检查 AppLayout index.tsx 第 85-103 行 |
| 8. getMembers showAllOrgMembers=true | 显示所有组织成员（组织管理员） | 对照 allMembersRoutes.ts 逻辑 |
| 9. getMembers showAllOrgMembers=false | 黑名单用户（项目 NONE）不应显示 | 对照 OR 条件补充 NOT EXISTS 逻辑 |
| 10. getUserProjectRoles 查询逻辑 | 仅影响通知/分配下拉，不影响成员表和访问权限 | 对照 userProjectRoleAuth.ts UNION 查询 |

---

## 八、权限范围与角色映射

### 8.1 项目级权限范围定义

位置：`web/src/features/rbac/constants/projectAccessRights.ts`

```typescript
export const projectRoleAccessRights: Record<Role, ProjectScope[]> = {
  OWNER: [
    "project:read", "project:update", "project:delete",
    "projectMembers:read", "projectMembers:CUD",
    "apiKeys:read", "apiKeys:CUD",
    "integrations:CRUD",
    "objects:publish", "objects:bookmark", "objects:tag",
    "traces:delete",
    "scores:CUD",
    "scoreConfigs:CUD", "scoreConfigs:read",
    "datasets:CUD",
    "prompts:CUD", "prompts:read",
    "models:CUD",
    "evalTemplate:CUD", "evalTemplate:read",
    "evalJob:CUD", "evalJob:read",
    "evalJobExecution:read",
    "evalDefaultModel:CUD", "evalDefaultModel:read",
    "llmApiKeys:read", "llmApiKeys:create", "llmApiKeys:update", "llmApiKeys:delete",
    "llmSchemas:CUD", "llmSchemas:read",
    "llmTools:CUD", "llmTools:read",
    "batchExports:create", "batchExports:read",
    "comments:CUD", "comments:read",
    "annotationQueues:read", "annotationQueues:CUD",
    "annotationQueueAssignments:read", "annotationQueueAssignments:CUD",
    "promptExperiments:CUD", "promptExperiments:read",
    "auditLogs:read",
    "dashboards:read", "dashboards:CUD",
    "TableViewPresets:CUD", "TableViewPresets:read",
    "automations:CUD", "automations:read",
  ],
  ADMIN: [
    "project:read", "project:update",
    "projectMembers:read", "projectMembers:CUD",
    "apiKeys:read", "apiKeys:CUD",
    "integrations:CRUD",
    "objects:publish", "objects:bookmark", "objects:tag",
    "traces:delete",
    "scores:CUD",
    "scoreConfigs:CUD", "scoreConfigs:read",
    "datasets:CUD",
    "prompts:CUD", "prompts:read",
    "models:CUD",
    "evalTemplate:CUD", "evalTemplate:read",
    "evalJob:CUD", "evalJob:read",
    "evalJobExecution:read",
    "evalDefaultModel:CUD", "evalDefaultModel:read",
    "llmApiKeys:read", "llmApiKeys:create", "llmApiKeys:update", "llmApiKeys:delete",
    "llmSchemas:CUD", "llmSchemas:read",
    "llmTools:CUD", "llmTools:read",
    "batchExports:create", "batchExports:read",
    "comments:CUD", "comments:read",
    "annotationQueues:read", "annotationQueues:CUD",
    "annotationQueueAssignments:read", "annotationQueueAssignments:CUD",
    "promptExperiments:CUD", "promptExperiments:read",
    "auditLogs:read",
    "dashboards:read", "dashboards:CUD",
    "TableViewPresets:CUD", "TableViewPresets:read",
    "automations:CUD", "automations:read",
  ],
  MEMBER: [
    "project:read",
    "projectMembers:read",
    "apiKeys:read",
    "objects:publish", "objects:bookmark", "objects:tag",
    "scores:CUD",
    "scoreConfigs:CUD", "scoreConfigs:read",
    "datasets:CUD",
    "prompts:CUD", "prompts:read",
    "evalTemplate:CUD", "evalTemplate:read",
    "evalJob:read", "evalJob:CUD",
    "evalJobExecution:read",
    "evalDefaultModel:read", "evalDefaultModel:CUD",
    "llmApiKeys:read",
    "llmSchemas:read", "llmSchemas:CUD",
    "llmTools:CUD", "llmTools:read",
    "batchExports:create", "batchExports:read",
    "comments:CUD", "comments:read",
    "annotationQueues:read", "annotationQueues:CUD",
    "annotationQueueAssignments:read",
    "promptExperiments:CUD", "promptExperiments:read",
    "dashboards:read", "dashboards:CUD",
    "TableViewPresets:CUD", "TableViewPresets:read",
    "automations:read",
  ],
  VIEWER: [
    "project:read",
    "prompts:read",
    "evalTemplate:read",
    "scoreConfigs:read",
    "evalJob:read",
    "evalJobExecution:read",
    "evalDefaultModel:read",
    "llmApiKeys:read",
    "llmSchemas:read",
    "llmTools:read",
    "comments:read",
    "annotationQueues:read",
    "promptExperiments:read",
    "dashboards:read",
    "TableViewPresets:read",
    "automations:read",
  ],
  NONE: [],
};
```

---

## 九、完整权限验证流程

### 9.1 数据流概览

```
用户登录
    ↓
NextAuth Session 回调
    ↓
┌─ 遍历 OrganizationMemberships
│  └─ 对每个项目调用 resolveProjectRole
│     └─ 存在 ProjectMembership? → 是=项目角色，否=组织角色
│        └─ 检查 projectRoleAccessRights[role].includes("project:read")
│           └─ true=保留在列表, false=过滤掉（如 NONE）
    ↓
权限序列化到 JWT Session
    ↓
┌─ API 请求 (带 projectId/orgId)
│  └─ tRPC 中间件验证
│     ├─ 从 Session 提取预计算的角色
│     └─ 注入到 API Context
    ↓
API Handler 执行细粒度 Scope 检查
    ↓
throwIfNoProjectAccess({ scope: "..." })
    ↓
查表 projectRoleAccessRights[role].includes(scope)
```

### 9.2 关键设计决策

1. **Session 预计算**：登录时一次性计算所有权限，避免每次 API 调用都查数据库
2. **角色继承优先**：减少 ProjectMembership 记录数量，大多数用户只需组织级角色
3. **管理员旁路**：系统管理员绕过所有权限检查，强制 OWNER 权限
4. **Scope 分层**：每个角色映射到具体操作范围（CRUD 细分）
5. **显式排除机制**：项目角色设为 NONE 实现组织内黑名单模式

---

## 十、权限复核最小验证步骤

### 10.1 前端拦截行为验证

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 创建组织 ADMIN 用户，在项目 1 设置 NONE 角色，在项目 2 不设置 | 登录后项目选择器只显示项目 2 |
| 2 | 用该用户直接浏览器访问 `/project/{项目1-id}/settings/members` | 页面显示"Project Not Found"错误页面，带"Go to Home"按钮 |
| 3 | 分享一个项目 1 的 trace 链接给该用户，让其点击访问 | 显示 MinimalLayout 极简布局（无侧边栏），能看到 trace 内容 |

### 10.2 两个成员查询函数对比验证

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 创建组织 A，创建 2 个项目 P1、P2 | |
| 2 | 用户 U1：组织角色 MEMBER，不设置任何项目角色 | |
| 3 | 用户 U2：组织角色 MEMBER，在 P2 设为 ADMIN，P1 不设置 | |
| 4 | 检查 P1 设置页面的成员表 | U1、U2 都显示，U2 项目角色列显示空（继承 MEMBER） |
| 5 | 检查 P1 评论 @ 提及下拉列表 | U1 在列表中，U2 **不在列表中**（getUserProjectRoles 问题） |
| 6 | 用 U2 登录访问 P1 | 可正常访问 P1，权限正确 |
| 7 | 结论：成员表显示 ≠ 通知/分配下拉可选用户 | getUserProjectRoles 影响范围仅限下拉列表 |

### 10.3 showAllOrgMembers=false 黑名单误显示验证

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 创建组织 A，创建项目 P1 | |
| 2 | 管理员用户 Admin：组织角色 OWNER（有组织级成员管理权限） | |
| 3 | 项目管理员 PM：组织角色 VIEWER，在 P1 设为 ADMIN<br>→ PM 只有项目级权限，无组织级权限 | |
| 4 | 黑名单用户 Blacklist：组织角色 MEMBER，在 P1 显式设为 NONE | |
| 5 | 用 Admin 登录查看 P1 成员表（showAllOrgMembers=true） | Blacklist 显示在列表中，项目角色列显示 NONE |
| 6 | 用 PM 登录查看 P1 成员表（showAllOrgMembers=false） | ⚠️ **当前代码**：Blacklist 误显示在列表中<br>✅ **修正后期望**：Blacklist 不显示 |
| 7 | 用 Blacklist 登录访问 P1 | 不能访问 P1（权限正确，与显示问题独立） |
| 8 | 验证结论：权限计算正确 ≠ 成员表显示正确 | 这是前端展示层面的信息泄露问题，不影响实际访问控制 |

### 10.4 综合验证矩阵

| 验证场景 | 通过标准 | 备注 |
|---------|---------|------|
| 组织角色 NONE + 项目角色 OWNER | 可以访问项目 | 越级提升正常 |
| 组织角色 OWNER + 项目角色 NONE | 不能访问项目 | 黑名单排除正常 |
| 组织角色 ADMIN + 其他项目有覆盖 | Session 计算正确 | resolveProjectRole 按项目独立计算 |
| 项目成员表 vs 通知下拉 | 两者不一致是已知问题 | 仅影响 UX，不影响权限安全 |
| 项目管理员查看含黑名单的成员表 | 黑名单用户应被过滤 | showAllOrgMembers=false 场景 |
