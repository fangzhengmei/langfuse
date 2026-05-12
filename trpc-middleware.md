# Langfuse tRPC 中间件调用链与公共 API 限流架构分析

## 文档变更记录
| 版本 | 日期 | 变更说明 |
|------|------|----------|
| v2.1 | 2026-05-12 | 修正 tRPC 权限中间件多分支结构；补充公共 API 多种入口模式；更新分叉图与流程说明 |
| v2.0 | 2026-05-12 | 重写架构分析，明确两条链路分叉关系；修正自托管限流表述；按请求流转顺序重构 |

---

## 目录
1. [整体架构：两条 API 链路的分叉关系](#整体架构两条-api-链路的分叉关系)
2. [tRPC 调用链详解：多分支权限中间件](#trpc-调用链详解多分支权限中间件)
3. [公共 REST API 限流链路详解：多种入口模式](#公共-rest-api-限流链路详解多种入口模式)
4. [核心设计原则总结](#核心设计原则总结)
5. [文件索引](#文件索引)

---

## 整体架构：两条 API 链路的分叉关系

### 1.1 架构总览图

Langfuse 存在两条独立的 API 处理链路，它们在 Next.js 的 API 路由层就已经分叉，且两条链路内部各自有多种处理分支：

```
                    HTTP Request
                         │
                         ▼
                ┌──────────────────┐
                │  Next.js Router  │
                └────────┬─────────┘
                         │
           ┌─────────────┴─────────────┐
           ▼                           ▼
    ┌─────────────┐           ┌─────────────────┐
    │  /api/trpc  │           │  /api/public/*   │
    │  (tRPC API) │           │  (REST API)      │
    └──────┬──────┘           └────────┬─────────┘
           │                           │
           ▼                           ▼
┌──────────────────────┐    ┌──────────────────────────────────┐
│   tRPC 框架管道      │    │   公共 API 多入口分支            │
│                      │    │                                  │
│  ┌──────────────────┐│    │  ┌────────────────────────────┐│
│  │ 6种 Procedure 分支││    │  │ withMiddlewares 包装器     ││
│  │  - public        ││    │  │  (统一错误处理 + CORS)      ││
│  │  - authenticated ││    │  └─────────────┬──────────────┘│
│  │  - protectedProj ││    │                │               │
│  │  - protectedOrg  ││    │                ▼               │
│  │  - protectedTrace││    │  ┌────────────────────────────┐│
│  │  - admin         ││    │  │ createAuthedProjectAPIRoute││
│  └────────┬─────────┘│    │  │ (认证 + 限流 + Zod校验)    ││
│           │          │    │  └────────────────────────────┘│
└───────────┼──────────┘    │                                  │
            │               │  ┌────────────────────────────┐│
            │               │  │   自定义入口（特殊场景）    ││
            │               │  │   - ingestion.ts          ││
            │               │  │   - mcp/index.ts          ││
            │               │  │   - health.ts / ready.ts  ││
            │               │  └────────────────────────────┘│
            │               └──────────────────────────────────┘
            │
            ▼
      前端 UI 交互
    (用户登录态保护)
```

### 1.2 两条链路的核心差异对比

| 维度 | tRPC API | 公共 REST API |
|------|----------|---------------|
| **路径前缀** | `/api/trpc/*` | `/api/public/*` |
| **使用方** | 前端 UI (浏览器) | 服务端集成、SDK、MCP 客户端、第三方系统 |
| **认证方式** | Next.js Session (Cookie) | API Key (Basic Auth / Bearer Auth) |
| **限流策略** | 无显式限流 | 云环境启用，按组织/计划/资源限流 |
| **中间件模式** | tRPC 中间件链式组合 | 多模式：withMiddlewares + 自定义入口 |
| **上下文注入** | 渐进式类型收紧 | 各端点手动处理 |
| **错误处理** | tRPC 格式 + 中间件转换 | REST JSON + 统一错误包装 |
| **自托管行为** | 无差异 | 完全不启用限流 |

---

## tRPC 调用链详解：多分支权限中间件

### 2.1 请求流转总览

tRPC 采用**中间件组合模式**，不是单一路径，而是通过不同 Procedure 类型形成 6 条独立的处理分支。每条分支都从 `withOtelTracingProcedure` 开始，然后叠加不同的中间件组合：

```
┌─────────────────────────────────────────────────────────────────┐
│                 基础层：OpenTelemetry 追踪                        │
│              withOtelTracingProcedure (全局共用)                   │
│              (withOtelInstrumentation middleware)                 │
└───────────────────────┬───────────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────────┐
        ▼               ▼                   ▼
┌────────────────┐ ┌────────────────┐ ┌─────────────────┐
│ withErrorHandling│ │ withErrorHandling│ │ withErrorHandling │
└────────┬───────┘ └────────┬───────┘ └─────────┬───────┘
         │                   │                   │
         ▼                   ▼                   ▼
┌────────────────┐ ┌────────────────┐ ┌─────────────────┐
│ publicProcedure│ │enforceUserIsA…│ │ enforceAdmi…   │
└────────────────┘ └────────┬───────┘ └─────────────────┘
                            │
                ┌───────────┼────────────┐
                ▼           ▼            ▼
        ┌─────────────┐ ┌───────────┐ ┌──────────────┐
        │ protected… │ │ protected…│ │ protected…   │
        │ (Project)   │ │ (Org)     │ │ (Trace)      │
        └─────────────┘ └───────────┘ └──────────────┘
```

### 2.2 步骤 1：入口与初始上下文创建

**文件**: `web/src/pages/api/trpc/[trpc].ts`

```typescript
// tRPC 入口由框架接管
export default createNextApiHandler({
  router: appRouter,
  createContext: createTRPCContext,  // 上下文工厂函数
  onError: ({ path, error }) => {
    // 全局错误日志与 Sentry 上报
    // 用户错误 (4xx) 仅记 INFO，系统错误 (5xx) 记 ERROR 并上报 Sentry
  },
});
```

**初始上下文创建**: `web/src/server/api/trpc.ts`

```typescript
export const createTRPCContext = async (opts: CreateNextContextOptions) => {
  const { req, res } = opts;

  // 1. 从 Cookie 中获取用户 Session（可能为 null）
  const session = await getServerAuthSession({ req, res });
  
  // 2. 获取请求头
  const headers = req.headers;

  // 3. 将用户信息注入 OpenTelemetry Span
  addUserToSpan({
    userId: session?.user?.id,
    email: session?.user?.email ?? undefined,
  });

  // 4. 返回基础上下文（所有 Procedure 共用的起点）
  return createInnerTRPCContext({ session, headers });
};

// 初始上下文包含：
// - session: Session | null（未登录用户为 null）
// - headers: IncomingHttpHeaders
// - prisma: PrismaClient 单例
```

> **关键点**: 上下文创建发生在所有中间件执行之前，是所有 6 条 Procedure 分支的共同起点。

### 2.3 步骤 2：路由分层结构

**文件**: `web/src/server/api/root.ts`

根路由器按业务领域组织成 50+ 子路由，每个子路由根据权限需求选择合适的 Procedure 类型：

```typescript
export const appRouter = createTRPCRouter({
  // ========== 公开数据模块 ==========
  public: publicRouter,                    // publicProcedure
  
  // ========== 用户相关模块（需登录）==========
  users: userRouter,                        // authenticatedProcedure
  userAccount: userAccountRouter,           // authenticatedProcedure
  
  // ========== 项目级权限模块 ==========
  traces: traceRouter,                      // protectedProjectProcedure
  sessions: sessionRouter,                  // protectedProjectProcedure
  generations: generationsRouter,           // protectedProjectProcedure
  observations: observationsRouter,         // protectedProjectProcedure
  scores: scoresRouter,                     // protectedProjectProcedure
  scoreAnalytics: scoreAnalyticsRouter,     // protectedProjectProcedure
  scoreConfigs: scoreConfigsRouter,         // protectedProjectProcedure
  dashboard: dashboardRouter,               // protectedProjectProcedure
  datasets: datasetRouter,                  // protectedProjectProcedure
  experiments: experimentsRouter,           // protectedProjectProcedure
  media: mediaRouter,                       // protectedProjectProcedure
  batchExport: batchExportRouter,           // protectedProjectProcedure
  automations: automationsRouter,           // protectedProjectProcedure
  
  // ========== 组织级权限模块 ==========
  organizations: organizationsRouter,       // protectedOrganizationProcedure
  organizationApiKeys: organizationApiKeysRouter, // protectedOrganizationProcedure
  members: membersRouter,                   // protectedOrganizationProcedure
  
  // ========== 管理员工具 ==========
  // adminProcedure (内部管理员 API)
});
```

**Procedure 选择原则**:
- 公开数据无需认证 → `publicProcedure`
- 用户个人信息操作 → `authenticatedProcedure`
- 项目内资源操作 → `protectedProjectProcedure`
- 组织级配置操作 → `protectedOrganizationProcedure`
- Trace 公开访问场景 → `protectedGetTraceProcedure`

### 2.4 步骤 3：中间件组合与 6 条分支详解

#### 2.4.1 中间件执行顺序模型

每个 Procedure 类型都是通过 `.use()` 链式组合不同中间件，每个中间件可以：
- 前置校验（失败则抛出错误终止）
- 上下文增强（添加新字段或收紧类型）
- 后置处理（响应返回时执行）

```
请求 → 中间件1 → 中间件2 → 中间件3 → Procedure 业务逻辑
           ↓         ↓         ↓
         校验+注入 校验+注入 校验+注入
```

#### 2.4.2 分支 1/6：publicProcedure（无认证）

**中间件链**: `withOtelTracingProcedure → withErrorHandling`

```typescript
// web/src/server/api/trpc.ts
export const publicProcedure = withOtelTracingProcedure
  .use(withErrorHandling);
```

**上下文演进**:
```
初始上下文 → 经过错误处理中间件（无上下文变更）
├── session: Session | null  ← 保持可选状态
├── headers: IncomingHttpHeaders
└── prisma: PrismaClient
```

**使用场景**:
- 公开访问的数据（如公开 Share Link 中的 Trace）
- 无需登录的功能

#### 2.4.3 分支 2/6：authenticatedProcedure（用户认证）

**中间件链**: `withOtelTracingProcedure → withErrorHandling → enforceUserIsAuthed`

```typescript
export const authenticatedProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceUserIsAuthed);
```

**核心中间件：enforceUserIsAuthed**
```typescript
const enforceUserIsAuthed = t.middleware(({ ctx, next }) => {
  // 前置校验：必须有有效 Session
  if (!ctx.session || !ctx.session.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  
  // 上下文增强：收紧类型，user 从可选变为必选
  return next({
    ctx: {
      session: { ...ctx.session, user: ctx.session.user },
    },
  });
});
```

**上下文演进**:
```
初始上下文
├── session: Session | null
├── headers
└── prisma
        ↓ (经过 enforceUserIsAuthed)
├── session: { user: User }  ← user 变为必选，类型收紧
├── headers
└── prisma
```

**使用场景**:
- 用户个人信息管理
- 个人偏好设置
- 无需特定项目/组织权限的操作

#### 2.4.4 分支 3/6：protectedProjectProcedure（项目级权限）

**中间件链**: `withOtelTracingProcedure → withErrorHandling → enforceUserIsAuthedAndProjectMember`

```typescript
export const protectedProjectProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceUserIsAuthedAndProjectMember);
```

**核心中间件：enforceUserIsAuthedAndProjectMember**
```typescript
const enforceUserIsAuthedAndProjectMember = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  
  // 前置校验 1：用户已认证（双重保险）
  if (!ctx.session || !ctx.session.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  // 前置校验 2：请求参数包含 projectId
  const actualInput = await opts.getRawInput();
  const parsedInput = inputProjectSchema.safeParse(actualInput);
  if (!parsedInput.success) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "projectId required" });
  }

  const projectId = parsedInput.data.projectId;
  
  // 权限验证：检查用户是否为项目成员
  const sessionProject = ctx.session.user.organizations
    .flatMap((org) => org.projects.map(p => ({ ...p, organization: org })))
    .find((p) => p.id === projectId);

  // ========== 管理员绕过通道 ==========
  if (!sessionProject) {
    if (ctx.session.user.admin === true) {
      // 管理员访问：从 DB 获取组织信息
      const dbProject = await ctx.prisma.project.findFirst({
        select: { orgId: true },
        where: { id: projectId, deletedAt: null },
      });
      
      await sendAdminAccessWebhook({
        email: ctx.session.user.email,
        projectId,
        orgId: dbProject.orgId,
      });

      // 注入管理员上下文（角色 OWNER）
      return next({
        ctx: {
          session: {
            ...ctx.session,
            user: ctx.session.user,
            orgId: dbProject.orgId,
            orgRole: Role.OWNER,
            projectId: projectId,
            projectRole: Role.OWNER,
          },
        },
      });
    }
    
    // 非成员且非管理员：拒绝访问
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "User is not a member of this project",
    });
  }

  // ========== 正常成员访问 ==========
  return next({
    ctx: {
      session: {
        ...ctx.session,
        user: ctx.session.user,
        orgId: sessionProject.organization.id,     // 新增：组织 ID
        orgRole: sessionProject.organization.role, // 新增：组织角色
        projectId: projectId,                      // 新增：项目 ID
        projectRole: sessionProject.role,          // 新增：项目角色
      },
    },
  });
});
```

**上下文演进**:
```
初始上下文 (session.user 可能为 null)
        ↓ (经过 enforceUserIsAuthed，隐式在中间件内校验)
├── session: { user: User }
├── headers
└── prisma
        ↓ (经过 enforceUserIsAuthedAndProjectMember)
├── session: {
│     user: User
│     orgId: string       ← 新增
│     orgRole: Role       ← 新增
│     projectId: string   ← 新增
│     projectRole: Role   ← 新增
│   }
├── headers
└── prisma
```

**使用场景**:
- Trace、Observation、Score 等数据的读写
- 数据集、实验、Prompt 管理
- 项目级配置操作

#### 2.4.5 分支 4/6：protectedOrganizationProcedure（组织级权限）

**中间件链**: `withOtelTracingProcedure → withErrorHandling → enforceIsAuthedAndOrgMember`

```typescript
export const protectedOrganizationProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceIsAuthedAndOrgMember);
```

**核心中间件：enforceIsAuthedAndOrgMember**
```typescript
const enforceIsAuthedAndOrgMember = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  
  // 前置校验：用户已认证
  if (!ctx.session || !ctx.session.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  // 参数校验：必须有 orgId
  const actualInput = await opts.getRawInput();
  const result = inputOrganizationSchema.safeParse(actualInput);
  if (!result.success) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "orgId required" });
  }

  const orgId = result.data.orgId;
  
  // 权限验证：检查用户是否为组织成员或管理员
  const sessionOrg = ctx.session.user.organizations.find(
    (org) => org.id === orgId,
  );

  if (!sessionOrg && ctx.session.user.admin !== true) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "User is not a member of this organization",
    });
  }

  // 上下文增强：注入组织 ID 和角色
  return next({
    ctx: {
      session: {
        ...ctx.session,
        user: ctx.session.user,
        orgId: orgId,
        orgRole: ctx.session.user.admin === true ? Role.OWNER : sessionOrg!.role,
      },
    },
  });
});
```

**上下文演进**:
```
初始上下文
        ↓ (经过认证与组织权限校验)
├── session: {
│     user: User
│     orgId: string       ← 新增
│     orgRole: Role       ← 新增
│   }
├── headers
└── prisma
```

**使用场景**:
- 组织成员管理
- 组织 API Key 管理
- 组织级配置操作
- 计费与计划管理

#### 2.4.6 分支 5/6：protectedGetTraceProcedure（Trace 资源访问控制）

**中间件链**: `withOtelTracingProcedure → withErrorHandling → enforceTraceAccess`

```typescript
export const protectedGetTraceProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceTraceAccess);
```

**核心中间件：enforceTraceAccess**
```typescript
const enforceTraceAccess = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  
  // 1. 解析 traceId 和 projectId
  const actualInput = await opts.getRawInput();
  const result = inputTraceSchema.safeParse(actualInput);

  // 2. 从 ClickHouse 查询 Trace 数据
  const clickhouseTrace = await getTraceById({
    traceId,
    projectId,
    timestamp,
    // ...
  });

  if (!clickhouseTrace) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Trace not found" });
  }

  // ========== 多条件权限判定 ==========
  // 三个条件满足任一即可访问：
  // 1. Trace 设置为 public
  // 2. 用户是项目成员
  // 3. 用户是系统管理员
  const sessionProject = ctx.session?.user?.organizations
    .flatMap(org => org.projects)
    .find(p => p.id === projectId);

  if (
    !clickhouseTrace.public &&
    !sessionProject &&
    ctx.session?.user?.admin !== true
  ) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Not a project member and this trace is not public",
    });
  }

  // ========== 上下文增强：注入已查询的 Trace ==========
  // 避免业务层重复查询数据库，提升性能
  return next({
    ctx: {
      session: {
        ...ctx.session,
        projectRole: ctx.session?.user?.admin === true
          ? Role.OWNER
          : sessionProject?.role,
      },
      trace: clickhouseTrace,  // ← 新增：Trace 数据
    },
  });
});
```

**上下文演进**:
```
初始上下文
        ↓ (经过 enforceTraceAccess)
├── session: { ..., projectRole?: Role }
├── headers
├── prisma
└── trace: Trace  ← 新增：预加载的 Trace 数据
```

**使用场景**:
- Trace 详情查询（支持公开分享链接）
- 支持未登录用户访问公开 Trace
- 同时支持成员和管理员访问所有 Trace

#### 2.4.7 分支 6/6：adminProcedure（管理员专属）

**中间件链**: `withOtelTracingProcedure → withErrorHandling → enforceAdminAuth`

```typescript
export const adminProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceAdminAuth);
```

**核心中间件：enforceAdminAuth**
```typescript
const enforceAdminAuth = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  // 前置校验：必须有有效的 Admin API Key
  const actualInput = await opts.getRawInput();
  const result = inputAdminSchema.safeParse(actualInput);
  if (!result.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid input, adminApiKey is required",
    });
  }

  // 验证 Admin API Key 有效性
  const adminAuthResult = AdminApiAuthService.verifyAdminAuthFromAuthString(
    result.data.adminApiKey,
  );

  if (!adminAuthResult.isAuthorized) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: adminAuthResult.error,
    });
  }

  // 无额外上下文注入，认证通过即放行
  return next({ ctx });
});
```

**使用场景**:
- 跨组织管理操作
- 系统级配置变更
- 仅云环境内部管理员使用

### 2.5 6 条 Procedure 分支汇总对比表

| Procedure 类型 | 中间件链 | 核心校验 | 注入字段 | 典型使用场景 |
|--------------|----------|---------|---------|------------|
| **publicProcedure** | Otel + ErrorHandling | 无 | - | 公开分享 Trace、无需登录功能 |
| **authenticatedProcedure** | Otel + ErrorHandling + enforceUserIsAuthed | 用户已登录 | session.user（非空） | 用户个人设置、账号管理 |
| **protectedProjectProcedure** | Otel + ErrorHandling + enforceUserIsAuthedAndProjectMember | 用户认证 + 项目成员身份 + 管理员通道 | orgId, orgRole, projectId, projectRole | Trace/Scores/数据集管理、项目级操作 |
| **protectedOrganizationProcedure** | Otel + ErrorHandling + enforceIsAuthedAndOrgMember | 用户认证 + 组织成员身份 + 管理员通道 | orgId, orgRole | 组织成员管理、API Key 管理 |
| **protectedGetTraceProcedure** | Otel + ErrorHandling + enforceTraceAccess | Trace 公开 OR 项目成员 OR 管理员 | projectRole?, trace | Trace 详情查询（支持公开访问） |
| **adminProcedure** | Otel + ErrorHandling + enforceAdminAuth | Admin API Key 验证 | - | 系统管理、跨组织操作 |

---

## 公共 REST API 限流链路详解：多种入口模式

### 3.1 与 tRPC 链路的核心区别

公共 API 与 tRPC 的核心区别：
1. **限流存在性**: 公共 API 有限流，tRPC 无显式限流
2. **限流触发条件**: 仅**云环境**启用限流，自托管环境完全不触发
3. **限流维度**: 按组织 ID + 计划级别 + 资源类型三维限流
4. **入口模式多样性**: 公共 API 有 3 种不同的入口模式，不是所有端点都走 `withMiddlewares`

### 3.2 限流启用条件（修正说明）

**原错误表述**: "自托管环境不禁用限流"  
**正确表述**: **自托管环境完全不启用限流**

代码验证 (`RateLimitService.ts:67-70`):
```typescript
async rateLimitRequest(scope: ApiAccessScope, resource: RateLimitResource) {
  // ✅ 正确逻辑：非云环境直接返回无限制的 Helper
  if (!env.NEXT_PUBLIC_LANGFUSE_CLOUD_REGION) {
    return new RateLimitHelper(undefined);  // isRateLimited() 永远返回 false
  }
  
  // 以下代码仅云环境会执行
  if (env.LANGFUSE_RATE_LIMITS_ENABLED === "false") {
    return new RateLimitHelper(undefined);
  }
  // ...
}
```

**限流生效的必要条件**:
1. ✅ `NEXT_PUBLIC_LANGFUSE_CLOUD_REGION` 环境变量存在（即云环境）
2. ✅ `LANGFUSE_RATE_LIMITS_ENABLED` 不等于 `"false"`
3. ✅ Redis 可用（否则失败开放）
4. ✅ 该资源类型对该计划有限额配置

### 3.3 公共 API 的 3 种入口模式

公共 API 不是所有端点都走 `withMiddlewares`，根据功能需求分为 3 种模式：

| 入口模式 | 代表端点 | 特点 |
|---------|---------|------|
| **模式 1：withMiddlewares + createAuthedProjectAPIRoute** | 大部分 REST API（如 GET traces/[traceId]、v2 系列） | 统一错误处理 + CORS + 认证 + 限流 + Zod 校验 |
| **模式 2：自定义入口 + 手动调用认证/限流** | `ingestion.ts`, `mcp/index.ts` | 特殊传输需求（SSE 流式）、自定义错误处理、性能优化 |
| **模式 3：极简入口（无认证无限流）** | `health.ts`, `ready.ts` | 健康检查、运维监控专用 |

#### 3.3.1 模式 1：标准 REST API 流程（withMiddlewares + createAuthedProjectAPIRoute）

这是绝大多数公共 API 端点采用的模式，以 `GET traces/[traceId]` 为例：

```
HTTP Request
     │
     ▼
withMiddlewares 包装器
     ├─ CORS 预检处理
     ├─ OpenTelemetry 上下文注入
     └─ 统一错误捕获与格式转换
     │
     ▼
createAuthedProjectAPIRoute 处理器
     ├─ API Key 认证（Basic / Bearer）
     ├─ 限流检查（基于 orgId + plan + resource）
     ├─ Query/Body 参数 Zod 校验
     ├─ 响应 Schema 校验
     └─ 业务逻辑执行
     │
     ▼
HTTP Response
```

**代码示例**:
```typescript
// web/src/pages/api/public/traces/[traceId].ts
export default withMiddlewares(
  {
    GET: createAuthedProjectAPIRoute({
      name: "Get Single Trace",
      querySchema: GetTraceV1Query,
      responseSchema: GetTraceV1Response,
      rateLimitResource: "public-api",  // 可自定义限流资源类型
      fn: async ({ query, auth }) => {
        // 业务逻辑...
      },
    }),
    DELETE: createAuthedProjectAPIRoute({
      name: "Delete Trace",
      querySchema: DeleteTraceV1Query,
      responseSchema: DeleteTraceV1Response,
      rateLimitResource: "trace-delete",  // 专属限流配额
      fn: async ({ query, auth }) => {
        // Trace 删除逻辑...
      },
    }),
  },
  {
    clickHouseResourceErrorMessage: 
      LEGACY_PUBLIC_API_OBSERVATIONS_CLICKHOUSE_RESOURCE_ERROR_MESSAGE,
  },
);
```

#### 3.3.2 模式 2：自定义入口 - ingestion.ts 高吞吐数据接入

`ingestion.ts` 是数据摄入的核心入口，由于高吞吐、性能敏感，采用完全自定义的处理流程：

```
POST /api/public/ingestion
     │
     ▼
  手动 CORS 处理
     │
     ▼
  OpenTelemetry Span 创建
     │
     ▼
  安全头校验（x-langfuse-*）
     │
     ▼
  API Key 认证（Basic Auth）
     │
  ├─ 验证项目级访问权限
  └─ 检查 ingestion 暂停状态
     │
     ▼
  限流检查（ingestion 资源类型）
     │
     ▼
  Zod Schema 批量校验
     │
     ▼
  事件批量处理（异步队列 + S3 备份）
     │
     ▼
  自定义错误处理（分级上报 Sentry）
```

**关键差异点**:
- 不使用 `withMiddlewares`，错误处理完全自定义
- 对 Prisma 异常、Zod 异常有专门的分类处理逻辑
- 支持 4.5MB 大请求体（标准 API 为 1MB）
- 有 ingestion 暂停状态检查（免费额度用尽时阻断）

#### 3.3.3 模式 2：自定义入口 - mcp/index.ts 流式传输

MCP (Model Context Protocol) 端点由于需要支持 SSE 长连接流式响应，无法使用标准的 `withMiddlewares`：

```
ANY /api/public/mcp
     │
     ▼
  validateMcpRequestSecurity 安全校验
     ├─ Host/Origin 头校验
     └─ 自定义 CORS 头注入
     │
     ▼
  OPTIONS 预检响应（早返回）
     │
     ▼
  BasicAuth API Key 认证
     │
  ├─ 仅允许项目级 API Key
  └─ 禁止 Bearer Auth
     │
     ▼
  ingestion 暂停状态检查
     │
     ▼
  限流检查（public-api 资源类型）
     │
     ▼
  构建 ServerContext
     │
     ▼
  创建 MCP Server 实例（每次请求新建，无状态）
     │
     ▼
  handleMcpRequest 传输层处理
     ├─ POST: JSON-RPC 请求处理
     ├─ GET: SSE 流建立
     └─ DELETE: 会话清理
     │
     ▼
  自定义错误格式化（符合 MCP 协议规范）
```

**关键差异点**（代码注释确认）:
> "This endpoint does NOT use withMiddlewares() like other public APIs because the transport layer needs direct response control for both JSON and SSE responses. Error handling, header validation, and CORS are implemented in this route layer."

#### 3.3.4 模式 3：极简入口 - health.ts / ready.ts 健康检查

健康检查端点用于负载均衡和运维监控，采用最简化的处理：

```
GET /api/public/health
     │
     ▼
  CORS 处理（仅这一步共用）
     │
     ▼
  Telemetry 上报（匿名）
     │
     ▼
  可选检查项：
     ├─ Prisma 数据库连通性
     └─ ClickHouse 最近数据检查
     │
     ▼
  200 / 503 响应
```

**关键差异点**:
- 无认证（任何人可调用）
- 无限流（允许高频探测）
- 仅最基础的 CORS 处理
- 自定义的健康状态检查逻辑

### 3.4 限流核心实现

#### 3.4.1 限流服务架构

```typescript
// web/src/features/public-api/server/RateLimitService.ts

export class RateLimitService {
  private static redis: Redis | Cluster | null;
  
  static getInstance(redis?: Redis) {
    // 单例模式 + Redis 懒连接
  }

  async rateLimitRequest(scope: ApiAccessScope, resource: RateLimitResource) {
    // [条件 1] 非云环境 → 不限流
    if (!env.NEXT_PUBLIC_LANGFUSE_CLOUD_REGION) {
      return new RateLimitHelper(undefined);
    }
    
    // [条件 2] 限流开关关闭 → 不限流
    if (env.LANGFUSE_RATE_LIMITS_ENABLED === "false") {
      return new RateLimitHelper(undefined);
    }

    // [条件 3] Redis 不可用 → 不限流（失败开放）
    if (!RateLimitService.redis) {
      logger.warn("Rate limiting not available without Redis");
      return new RateLimitHelper(undefined);
    }

    // 执行限流检查
    return new RateLimitHelper(await this.checkRateLimit(scope, resource));
  }

  async checkRateLimit(scope: ApiAccessScope, resource: RateLimitResource) {
    // 1. 获取有效限流配置（基础配置 + 自定义覆盖）
    const effectiveConfig = getRateLimitConfig(scope, resource);

    // 无配置 → 不限流
    if (!effectiveConfig || !effectiveConfig.points) return;

    // 2. 确保 Redis 连接就绪
    if (RateLimitService?.redis?.status !== "ready") {
      try { await RateLimitService?.redis?.connect(); } 
      catch (_err) { /* 连接失败 → 失败开放 */ }
    }

    // 3. 使用 rate-limiter-flexible 的 Redis Token Bucket
    const rateLimiter = new RateLimiterRedis({
      points: effectiveConfig.points,           // 令牌数
      duration: effectiveConfig.durationInSec,  // 时间窗口
      keyPrefix: `rate-limit:${resource}`,      // Redis Key 前缀
      storeClient: RateLimitService.redis,
      rejectIfRedisNotReady: true,
    });

    try {
      // 以 orgId 作为限流键（同一组织共享配额）
      const libRes = await rateLimiter.consume(scope.orgId);
      
      // 记录 Metrics
      recordIncrement("langfuse.rate_limit.exceeded", ...);
      
      return {
        resource,
        scope,
        points: effectiveConfig.points,
        remainingPoints: libRes.remainingPoints,
        msBeforeNext: libRes.msBeforeNext,
        consumedPoints: libRes.consumedPoints,
        isFirstInDuration: libRes.isFirstInDuration,
      };
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        // 令牌耗尽 → 返回限流结果
        return { /* 限流信息 */ };
      }
      // 其他错误（Redis 故障等）→ 日志 + 失败开放
      logger.error("Internal Rate limit error", err);
      return undefined;
    }
  }
}
```

#### 3.4.2 限流配置策略

```typescript
const getRateLimitConfig = (scope: ApiAccessScope, resource: RateLimitResource) => {
  // 策略：自定义覆盖 > 计划基础配置
  const planBasedConfig = getPlanBasedRateLimitConfig(scope.plan, resource);
  const customConfig = scope.rateLimitOverrides?.find(
    (config) => config.resource === resource,
  );
  
  return customConfig || planBasedConfig;
};
```

#### 3.4.3 各计划级别限流配置表

| 资源类型 | Hobby 计划 | Core 计划* | Pro/Team/Enterprise |
|---------|-----------|-----------|-------------------|
| **ingestion** | 1,000 / 分钟 | 20,000 / 分钟 | 20,000 / 分钟 |
| **legacy-ingestion** | 100 / 分钟 | 400 / 分钟 | 400 / 分钟 |
| **public-api** | 30 / 分钟 | 1,000 / 分钟 | 1,000 / 分钟 |
| **datasets** | 100 / 分钟 | 1,000 / 分钟 | 1,000 / 分钟 |
| **public-api-metrics** | 100 / 天 | 2,000 / 天 | 2,000 / 天 |
| **public-api-daily-metrics-legacy** | 10 / 天 | 200 / 天 | 200 / 天 |
| **trace-delete** | 50 / 天 | 200 / 天 | 1,000 / 天 |
| **score-delete** | 50 / 天 | 200 / 天 | 1,000 / 天 |
| **prompts** | 无限制 | 无限制 | 无限制 |

> *注：Core 计划目前临时使用 Pro 级别的限流配置以支持迁移

#### 3.4.4 限流响应格式

```typescript
export const sendRateLimitResponse = (res, rateLimitRes) => {
  // 标准限流响应头
  const headers = {
    "Retry-After": Math.ceil(rateLimitRes.msBeforeNext / 1000),
    "X-RateLimit-Limit": rateLimitRes.points,
    "X-RateLimit-Remaining": rateLimitRes.remainingPoints,
    "X-RateLimit-Reset": new Date(Date.now() + rateLimitRes.msBeforeNext).toString(),
  };

  for (const [k, v] of Object.entries(headers)) {
    res.setHeader(k, v);
  }

  // 返回 429 状态码
  res.status(429).end("429 - rate limit exceeded");
};
```

### 3.5 失败开放策略

限流系统的设计原则是 **可用性优先**，采用多级失败开放机制：

| 失败场景 | 处理方式 |
|---------|---------|
| 自托管部署 | 不进入限流逻辑，直接放行 |
| 限流开关关闭 | 直接放行 |
| Redis 未配置 | 告警日志 + 放行 |
| Redis 连接失败 | 告警日志 + 放行 |
| Redis 命令执行错误 | 错误日志 + 放行 |
| 限流库内部错误 | 错误日志 + 放行 |

> 这种设计确保限流功能是"锦上添花"而非"单点故障"，在任何异常情况下都不会影响正常业务。

---

## 核心设计原则总结

### 4.1 tRPC 中间件设计原则

1. **组合优于继承**: 通过 `.use()` 链式组合不同中间件，形成 6 条独立的权限分支
2. **洋葱模型执行**: 中间件按顺序嵌套执行，请求从外到内，响应从内到外
3. **上下文渐进增强**: 每个中间件只添加自己负责的那部分上下文，不跨层污染，类型逐步收紧
4. **单一职责**: 每个中间件只做一件事（认证、授权、错误处理、追踪等）
5. **管理员通道设计**: 每个权限中间件都内置管理员绕过逻辑，支持系统级运维操作
6. **预加载优化**: 资源级中间件（如 `enforceTraceAccess`）预加载数据注入上下文，避免重复查询

### 4.2 公共 API 入口设计原则

1. **分层设计**: 3 种入口模式应对不同场景需求，不搞"一刀切"
2. **场景适配**: 标准 REST API 用统一模式，高吞吐和流式传输走自定义入口
3. **可用性优先**: 限流系统采用多级失败开放机制，确保 Redis 故障时业务不受影响
4. **权限最小化**: 健康检查等运维端点完全开放，无认证无限流，避免监控系统故障
5. **协议兼容**: MCP 等特殊协议端点放弃统一中间件，直接控制传输层以保证兼容性

### 4.3 两条链路的设计取舍对比

| 设计决策 | tRPC 链路 | 公共 API 链路 | 原因 |
|---------|-----------|--------------|------|
| 限流机制 | 无 | 有（云环境） | tRPC 面向前端用户，受登录态保护；公共 API 面向服务端，需防滥用 |
| 认证方式 | Cookie Session | API Key (Basic/Bearer) | 面向场景不同 |
| 权限模型 | 6 条分支渐进式授权 | API Key scope + 组织计划 | tRPC 面向人机交互，权限维度复杂；公共 API 面向自动化集成 |
| 错误处理 | tRPC 格式 + 中间件转换 | REST JSON + 多模式包装 | 生态约定与传输需求 |
| 上下文注入 | 中间件链式自动注入 | 各端点手动处理 | tRPC 框架能力 vs 原生 Next.js API 灵活性 |

---

## 文件索引

| 功能模块 | 文件路径 |
|---------|---------|
| tRPC 入口 | `web/src/pages/api/trpc/[trpc].ts` |
| tRPC 配置与 6 种 Procedure 定义 | `web/src/server/api/trpc.ts` |
| tRPC 根路由器 | `web/src/server/api/root.ts` |
| 公共 API 限流服务 | `web/src/features/public-api/server/RateLimitService.ts` |
| API 认证服务 | `web/src/features/public-api/server/apiAuth.ts` |
| 公共 API 中间件包装器（模式 1） | `web/src/features/public-api/server/withMiddlewares.ts` |
| 认证路由工厂（模式 1） | `web/src/features/public-api/server/createAuthedProjectAPIRoute.ts` |
| 自定义入口 - 数据摄入（模式 2） | `web/src/pages/api/public/ingestion.ts` |
| 自定义入口 - MCP 协议（模式 2） | `web/src/pages/api/public/mcp/index.ts` |
| 极简入口 - 健康检查（模式 3） | `web/src/pages/api/public/health.ts` |
| 极简入口 - 就绪检查（模式 3） | `web/src/pages/api/public/ready.ts` |
