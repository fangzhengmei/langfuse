# 组织与项目权限范围解析机制

本文档详细说明了 Langfuse 系统中组织(Organization)与项目(Project)两层权限叠加的完整解析机制。

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

## 四、tRPC 中间件：API 层权限守卫

### 4.1 项目级权限中间件

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

  // 5. 将预计算的角色注入 API Context
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

### 4.2 组织级权限中间件

位置：`web/src/server/api/trpc.ts:374-420`

```typescript
const enforceIsAuthedAndOrgMember = t.middleware(async (opts) => {
  // 类似逻辑，验证组织成员身份
  // 注入 orgId 和 orgRole 到 Context
});
```

### 4.3 导出的 Procedure 类型

```typescript
// 项目级保护 API（最常用）
export const protectedProjectProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceUserIsAuthedAndProjectMember);

// 组织级保护 API
export const protectedOrganizationProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceIsAuthedAndOrgMember);
```

---

## 五、前端权限守卫

### 5.1 页面访问守卫：useProjectAccess

位置：`web/src/components/layouts/app-layout/hooks/useProjectAccess.ts`

用于 AppLayout 组件，控制用户能否访问特定项目页面：

```typescript
export function useProjectAccess(session: Session | null) {
  const router = useRouter();
  const routerProjectId = router.query.projectId as string | undefined;

  return useMemo(() => {
    // 1. 无 projectId = 非项目页面，允许访问
    if (!routerProjectId) {
      return { hasAccess: true, projectId: undefined };
    }

    // 2. Demo 项目公开访问
    if (routerProjectId === env.NEXT_PUBLIC_DEMO_PROJECT_ID) {
      return { hasAccess: true, projectId: routerProjectId };
    }

    // 3. 系统管理员允许所有访问
    if (session?.user?.admin === true) {
      return { hasAccess: true, projectId: routerProjectId };
    }

    // 4. 基于 Session 中预计算的项目列表校验
    const userProjects =
      session?.user?.organizations
        ?.flatMap((org) => org?.projects?.map((p) => p?.id))
        .filter(Boolean) ?? [];

    const hasAccess = userProjects.includes(routerProjectId);

    return { hasAccess, projectId: routerProjectId };
  }, [routerProjectId, session?.user?.admin, session?.user?.organizations]);
}
```

### 5.2 细粒度权限检查 Hook

位置：`web/src/features/rbac/utils/checkProjectAccess.ts`

```typescript
// 在组件中直接使用
export const useHasProjectAccess = (p: {
  projectId: string | undefined;
  scope: ProjectScope;  // e.g., "projectMembers:read", "apiKeys:CUD"
}) => {
  const { scope, projectId } = p;
  const session = useSession();

  if (session.data?.user?.admin) return true;
  if (!projectId) return false;

  return hasProjectAccess({ session: session.data, scope, projectId });
};
```

**使用示例**：
```tsx
// 仅显示给有成员管理权限的用户
{useHasProjectAccess({ projectId, scope: "projectMembers:CUD" }) && (
  <MemberManagementPanel />
)}
```

---

## 六、权限范围与角色映射

### 6.1 项目级权限范围定义

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
    // ...
  ],
  MEMBER: [
    // 读写操作，但无管理权限
    // ...
  ],
  VIEWER: [
    // 仅只读操作
    "project:read",
    "prompts:read",
    "evalTemplate:read",
    "scoreConfigs:read",
    // ...
  ],
  NONE: [],
};
```

---

## 七、完整权限验证流程

### 7.1 数据流概览

```
用户登录
    ↓
NextAuth Session 回调
    ↓
┌─ 遍历 OrganizationMemberships
│  └─ 对每个项目调用 resolveProjectRole
│     └─ 存在 ProjectMembership? → 是=项目角色，否=组织角色
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
```

### 7.2 关键设计决策

1. **Session 预计算**：登录时一次性计算所有权限，避免每次 API 调用都查数据库
2. **角色继承优先**：减少 ProjectMembership 记录数量，大多数用户只需组织级角色
3. **管理员旁路**：系统管理员绕过所有权限检查，强制 OWNER 权限
4. **Scope 分层**：每个角色映射到具体操作范围（CRUD 细分）

---

## 八、SQL 级联查询优化

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
