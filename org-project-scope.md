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
        projectRole: sessionProject.role,  // 关键：注入计算后的项目角色
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
        role: ctx.session.projectRole,  // 从 Context 直接获取
        scope: "projectMembers:read",   // 需要的具体 Scope
      });

      // 权限校验通过后执行业务逻辑...
      const users = await getUserProjectRoles({
        projectId: input.projectId,
        orgId: ctx.session.orgId,
        // ...
      });
      return users;
    }),

  // 示例2：更新项目成员角色
  updateProjectRole: protectedOrganizationProcedure
    .input(z.object({
      orgId: z.string(),
      userId: z.string(),
      projectId: z.string(),
      projectRole: z.enum(Role).nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      // ⭐ Scope 断言（需要组织级或项目级管理权限）
      const hasAccess = 
        hasOrganizationAccess({
          session: ctx.session,
          organizationId: input.orgId,
          scope: "organizationMembers:CUD",
        }) ||
        hasProjectAccess({
          session: ctx.session,
          projectId: input.projectId,
          scope: "projectMembers:CUD",
        });
      
      if (!hasAccess) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have the required access rights",
        });
      }

      // 权限校验通过后执行业务逻辑...
      return await ctx.prisma.projectMembership.upsert({
        // ...
      });
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
│      ├─ 在 session.organizations[*].projects 中查找项目                 │
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

位置：`web/src/components/layouts/app-layout/index.tsx:85-103

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

**实际返回结果（分两种情况**：
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

**关键点修正说明**：
- 不是统一的 403 状态码，而是在 React 组件层面的布局切换
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

-- 项目成员关系（显式设为 NONE，排除 project-3）
INSERT INTO project_memberships (id, user_id, project_id, role, org_membership_id)
VALUES 
  ('pm-1', 'user-a-id', 'project-1', 'NONE', 'om-1'),
  ('pm-2', 'user-a-id', 'project-3', 'NONE', 'om-1');
```

#### 权限计算过程：

| 项目 ID | 组织角色 | 是否有 ProjectMembership | 项目角色 | 最终角色 | 是否有 project:read |
|---------|---------|-------------------------|---------|---------|-------------------|
| project-1 | ADMIN | ✅ 有 | NONE | NONE | ❌ 被过滤 |
| project-2 | ADMIN | ❌ 无 | - | ADMIN | ✅ 可见 |
| project-3 | ADMIN | ✅ 有 | NONE | NONE | ❌ 被过滤 |

#### 最终效果：

1. **Session 中的 projects 列表**：仅包含 `project-2`
2. **前端项目选择器**：只显示 Project 2
3. **直接访问 `/project/project-1`**：
   - 非共享路径 → 显示"Project Not Found"错误页面（不是 403）
   - 共享路径 → 显示 MinimalLayout 极简布局
4. **直接调用 API `membersRouter.byProjectId`**：
   - 中间件在 `session.user.organizations[*].projects` 中找不到 `project-1`
   - 抛出 `UNAUTHORIZED: "User is not a member of this project"`

#### 关键意义：

这种设计使得管理员可以**在组织级别给予广泛权限的同时，选择性排除特定项目**，实现了"黑名单"式的权限管理模式。

---

## 六、成员角色查询深挖：跨项目覆盖角色的继承逻辑

### 6.1 问题场景

用户在组织 A 是 MEMBER，在项目 B 被显式设为 ADMIN，在**当前查询的项目 C** 没有任何 ProjectMembership 记录。此时用户在项目 C 的角色是什么？

### 6.2 查询逻辑深度解析

位置：`packages/shared/src/server/auth/userProjectRoleAuth.ts:66-89`

```sql
WITH all_eligible_users AS (
  -- ⭐ 第一部分：仅继承组织角色的用户（无当前项目覆盖）
  SELECT u.id, u.name, u.email, om.role as role
  FROM organization_memberships om
  INNER JOIN users u ON om.user_id = u.id
  WHERE om.org_id = ?
    AND om.role != 'NONE'
    -- 🔑 关键判断条件：NOT EXISTS 检查是否有 ANY 项目覆盖？不是！
    AND NOT EXISTS (
      SELECT 1 FROM project_memberships pm 
      WHERE pm.org_membership_id = om.id
    )
  
  UNION
  
  -- 第二部分：有当前项目显式角色覆盖的用户
  SELECT u.id, u.name, u.email, pm.role as role
  FROM organization_memberships om
  INNER JOIN project_memberships pm ON om.id = pm.org_membership_id
  INNER JOIN users u ON om.user_id = u.id
  WHERE om.org_id = ?
    AND pm.project_id = ?  -- 只匹配当前查询的项目
    AND pm.role != 'NONE'
)
```

### 6.3 NOT EXISTS 子查询的真实含义

**注意**：第一个 UNION 分支的 `NOT EXISTS` 条件检查的是：

```sql
NOT EXISTS (
  SELECT 1 FROM project_memberships pm 
  WHERE pm.org_membership_id = om.id
  -- ❌ 这里没有 AND pm.project_id = ? 过滤！
)
```

这意味着：
- ✅ **检查用户在**任何**项目有项目级别的成员关系**
- ❌ **不是**检查用户在**当前**项目是否有覆盖

### 6.4 逻辑漏洞与风险结论

#### 实际行为分析

| 场景 | 组织角色 | 用户在其他项目有覆盖？ | 用户在当前项目有覆盖？ | 最终角色来源 | 实际结果 |
|------|---------|-----------------------|----------------------|-------------|---------|
| 场景1：无任何项目覆盖 | MEMBER | ❌ 否 | ❌ 否 | 第一分支（组织角色） | ✅ MEMBER |
| 场景2：当前项目有覆盖 | MEMBER | ✅ 是 | ✅ 是 | 第二分支（项目角色） | ✅ 正确 |
| **场景3：仅其他项目有覆盖** | **MEMBER** | **✅ 是** | **❌ 否** | **两个分支都不匹配** | **❌ 从成员列表消失** |

#### ⚠️ 风险结论

**关键问题**：当用户在**其他项目**有角色覆盖、但在**当前查询项目**没有覆盖时，该用户不会出现在当前项目的成员列表中。

**影响：
1. **不可见性**：这类用户在项目成员管理页面不会显示
2. **权限仍生效**：但 Session 计算时仍按组织角色继承（用户实际上可以访问该项目）
3. **不一致性**：成员列表 ≠ 实际能访问项目的用户
4. **审计盲区**：无法从成员列表判断谁实际有权限

#### 根本原因：SQL 查询的 NOT EXISTS 条件过于宽泛，没有限定 `pm.project_id = ?`

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
| **⚠️ 无覆盖（但其他项目有覆盖）** | 最终角色：OWNER<br>可见项目：✅<br>**成员列表不可见**<br>Session 正常继承 | 最终角色：ADMIN<br>可见项目：✅<br>**成员列表不可见**<br>Session 正常继承 | 最终角色：MEMBER<br>可见项目：✅<br>**成员列表不可见**<br>Session 正常继承 | 最终角色：VIEWER<br>可见项目：✅<br>**成员列表不可见**<br>Session 正常继承 | 最终角色：NONE<br>可见项目：❌ 被过滤 |

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
| 8. 跨项目覆盖的成员查询 | 其他项目有覆盖但当前没有时，从成员列表消失 | 对照 getUserProjectRoles SQL 的 NOT EXISTS 逻辑 |

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
    // 大多数 OWNER 权限，除了 project:delete
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

## 十、SQL 级联查询优化

位置：`packages/shared/src/server/auth/userProjectRoleAuth.ts:43-96`

当需要查询项目的所有成员时，使用 SQL UNION 一次性获取所有符合条件的用户：

```sql
WITH all_eligible_users AS (
  -- 第一部分：仅继承组织角色的用户（无项目级覆盖）
  SELECT u.id, u.name, u.email, om.role as role
  FROM organization_memberships om
  INNER JOIN users u ON om.user_id = u.id
  WHERE om.org_id = ?
    AND om.role != 'NONE'
    AND NOT EXISTS (
      SELECT 1 FROM project_memberships pm 
      WHERE pm.org_membership_id = om.id
    )
  
  UNION
  
  -- 第二部分：有显式项目角色覆盖的用户
  SELECT u.id, u.name, u.email, pm.role as role
  FROM organization_memberships om
  INNER JOIN project_memberships pm ON om.id = pm.org_membership_id
  INNER JOIN users u ON om.user_id = u.id
  WHERE om.org_id = ?
    AND pm.project_id = ?
    AND pm.role != 'NONE'
)
SELECT * FROM all_eligible_users
```

这种设计避免了 N+1 查询问题，高效获取项目成员列表。

---

## 十一、权限复核最小验证步骤

### 11.1 前端拦截行为验证

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 创建组织 ADMIN 用户，在项目 1 设置 NONE 角色，在项目 2 不设置 | 登录后项目选择器只显示项目 2 |
| 2 | 用该用户直接浏览器访问 `/project/{项目1-id}/settings` | 页面显示"Project Not Found"错误页面（不是 403），带"Go to Home"按钮 |
| 3 | 分享一个项目 1 的 trace 链接给该用户，让其点击访问 | 显示 MinimalLayout 极简布局（无侧边栏），能看到 trace 内容 |

### 11.2 跨项目覆盖的成员查询验证

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 创建组织 A，创建 3 个项目 P1/P2/P3 | |
| 2 | 用户 U1：组织角色 MEMBER，不设置任何项目角色 | P1 成员列表能看到 U1，角色 MEMBER |
| 3 | 用户 U2：组织角色 MEMBER，在 P2 设为 ADMIN，P1/P3 不设置 | P2 成员列表能看到 U2，角色 ADMIN |
| 4 | ⚠️ 检查 P1 成员列表 | **U2 不在列表中（风险点！） |
| 5 | 用 U2 登录访问 P1 | **可正常访问 P1（权限仍生效） |
| 6 | 结论验证：成员列表 ≠ 实际有访问权限的用户列表 | 存在审计盲区 |

### 11.3 综合验证矩阵

| 验证场景 | 通过标准 | 备注 |
|---------|---------|------|
| 组织角色 NONE + 项目角色 OWNER | 可以访问项目 | 越级提升正常 |
| 组织角色 OWNER + 项目角色 NONE | 不能访问项目 | 黑名单排除正常 |
| 组织角色 ADMIN + 其他项目有覆盖 | Session 计算正确 | resolveProjectRole 按项目独立计算 |
| 成员列表 API 返回结果 | 与 Session 可见列表对比 | 不一致则说明有跨项目覆盖问题 |
