# Langfuse tRPC 中间件调用链与公共 API 限流架构分析

## 文档变更记录
| 版本 | 日期 | 变更说明 |
|------|------|----------|
| v2.0 | 2026-05-12 | 重写架构分析，明确两条链路分叉关系；修正自托管限流表述；按请求流转顺序重构 |

---

## 目录
1. [整体架构：两条 API 链路的分叉关系](#整体架构两条-api-链路的分叉关系)
2. [tRPC 调用链详解](#trpc-调用链详解)
3. [公共 REST API 限流链路详解](#公共-rest-api-限流链路详解)
4. [核心设计原则总结](#核心设计原则总结)

---

## 整体架构：两条 API 链路的分叉关系

### 1.1 架构总览

Langfuse 存在两条独立的 API 处理链路，它们在 Next.js 的 API 路由层就已经分叉：

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
┌──────────────────────┐    ┌──────────────────────────┐
│  tRPC 框架管道       │    │  withMiddlewares 包装器   │
│  - 上下文创建        │    │  - CORS 处理              │
│  - 中间件链式调用    │    │  - 错误统一处理           │
│  - 过程函数执行      │    └──────────┬───────────────┘
└──────────┬───────────┘               │
           │                           ▼
           │                ┌───────────────────────┐
           │                │  各端点独立业务逻辑    │
           │                │  - API Key 验证       │
           │                │  - 限流检查           │
           │                │  - 业务处理           │
           │                └───────────────────────┘
           │
           ▼
  前端 UI 交互
  (用户登录态)
```

### 1.2 两条链路的核心差异

| 维度 | tRPC API | 公共 REST API |
|------|----------|---------------|
| **路径前缀** | `/api/trpc/*` | `/api/public/*` |
| **使用方** | 前端 UI (浏览器) | 服务端集成、SDK、第三方系统 |
| **认证方式** | Next.js Session (Cookie) | API Key (Basic Auth / Bearer) |
| **限流策略** | 无显式限流 | 有按组织/计划/资源的限流 |
| **上下文注入** | tRPC 中间件链式渐进注入 | 各端点手动调用认证服务 |
| **错误处理** | tRPC 统一格式 + 中间件转换 | withMiddlewares 统一包装 |
| **自托管行为** | 无差异 | **完全不启用限流** |

---

## tRPC 调用链详解

### 2.1 请求流转总览

tRPC 请求按以下顺序流经完整的处理链：

```
1. 入口层: Next.js API Handler
   └── /api/trpc/[trpc].ts
       ├── createNextApiHandler
       └── createTRPCContext

2. 中间件层: 洋葱模型管道
   ├── OpenTelemetry 追踪 (withOtelInstrumentation)
   ├── 全局错误处理 (withErrorHandling)
   ├── 用户认证 (enforceUserIsAuthed)
   ├── 项目权限验证 (enforceUserIsAuthedAndProjectMember)
   ├── 组织权限验证 (enforceIsAuthedAndOrgMember)
   └── 资源访问控制 (enforceTraceAccess)

3. 业务层: Procedure Handler
   └── 具体的 Query / Mutation 逻辑
```

### 2.2 步骤 1：入口与上下文创建

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

  // 1. 从 Cookie 中获取用户 Session
  const session = await getServerAuthSession({ req, res });
  
  // 2. 获取请求头
  const headers = req.headers;

  // 3. 将用户信息注入 OpenTelemetry Span
  addUserToSpan({
    userId: session?.user?.id,
    email: session?.user?.email ?? undefined,
  });

  // 4. 返回基础上下文
  return createInnerTRPCContext({ session, headers });
};

// 初始上下文包含:
// - session: 用户会话信息（可能 null）
// - headers: 请求头
// - prisma: 数据库连接（单例）
```

> **关键点**: 上下文创建发生在所有中间件执行之前，是整个调用链的起点。

### 2.3 步骤 2：路由分层结构

**文件**: `web/src/server/api/root.ts`

根路由器按业务领域组织成 50+ 子路由：

```typescript
export const appRouter = createTRPCRouter({
  // ========== 核心数据模块 ==========
  traces: traceRouter,           // Trace CRUD
  sessions: sessionRouter,       // 会话管理
  generations: generationsRouter, // LLM 生成记录
  observations: observationsRouter, // 观测数据
  scores: scoresRouter,           // 评分数据
  events: eventsRouter,           // 事件流
  
  // ========== 分析与仪表板 ==========
  scoreAnalytics: scoreAnalyticsRouter,
  dashboard: dashboardRouter,
  scoreConfigs: scoreConfigsRouter,
  
  // ========== 组织与项目管理 ==========
  organizations: organizationsRouter,
  organizationApiKeys: organizationApiKeysRouter,
  projects: projectsRouter,
  projectApiKeys: projectApiKeysRouter,
  members: membersRouter,
  users: userRouter,
  
  // ========== 数据集与评估 ==========
  datasets: datasetRouter,
  evals: evalRouter,
  experiments: experimentsRouter,
  
  // ========== Prompt 管理 ==========
  prompts: promptRouter,
  
  // ========== 集成模块 ==========
  posthogIntegration: posthogIntegrationRouter,
  blobStorageIntegration: blobStorageIntegrationRouter,
  
  // ========== 媒体与导出 ==========
  media: mediaRouter,
  batchExport: batchExportRouter,
  
  // ========== 后台任务 ==========
  backgroundMigrations: backgroundMigrationsRouter,
  
  // ========== 审计与通知 ==========
  auditLogs: auditLogsRouter,
  notificationPreferences: notificationPreferencesRouter,
  
  // ========== 自动化与工作流 ==========
  automations: automationsRouter,
  
  // ========== 支持功能 ==========
  slack: slackRouter,
  surveys: surveysRouter,
  
  // ========== 工具与公共接口 ==========
  utilities: utilsRouter,
  public: publicRouter,
  credentials: credentialsRouter,
  // ... 更多路由
});
```

**路由分层原则**:
1. **一级路由**: 按业务领域划分（根路由器）
2. **二级路由**: 每个子路由器内部按操作类型细分（如 `traces.get`, `traces.list`, `traces.delete`）
3. **Procedure 类型**: 
   - `query`: 读操作，幂等
   - `mutation`: 写操作，非幂等

### 2.4 步骤 3：中间件管道与上下文渐进增强

tRPC 采用**洋葱模型**中间件设计，每个中间件可以：
- 终止请求（抛出错误）
- 修改/增强上下文并传递给下一层
- 在请求返回时做后置处理

#### 2.4.1 Procedure 类型与中间件组合

系统预定义了 7 种不同安全级别的 Procedure 类型，每种都是中间件的不同组合：

```typescript
// ========== 基础 Procedure（无认证） ==========
export const publicProcedure = withOtelTracingProcedure
  .use(withErrorHandling);

// ========== 用户认证 Procedure ==========
export const authenticatedProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceUserIsAuthed);

// ========== 项目级权限 Procedure ==========
export const protectedProjectProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceUserIsAuthedAndProjectMember);

// ========== 组织级权限 Procedure ==========
export const protectedOrganizationProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceIsAuthedAndOrgMember);

// ========== 资源级访问控制 Procedure ==========
export const protectedGetTraceProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceTraceAccess);

// ========== 管理员 API Procedure ==========
export const adminProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceAdminAuth);
```

#### 2.4.2 各中间件详解

**1. OpenTelemetry 追踪中间件**
```typescript
const withOtelInstrumentation = t.middleware(async (opts) => {
  const actualInput = await opts.getRawInput();
  
  // 从请求头提取 Trace Context，构建 OpenTelemetry 上下文
  const ctx = contextWithLangfuseProps({
    headers: opts.ctx.headers,
    userId: opts.ctx.session?.user?.id,
    projectId: (actualInput as Record<string, string>)?.projectId,
  });

  // 在追踪上下文中执行后续中间件/Procedure
  return opentelemetry.context.with(ctx, () => opts.next());
});
```
> 位置：最外层，最先执行、最后返回
> 作用：全链路追踪、请求属性注入

**2. 全局错误处理中间件**
```typescript
const withErrorHandling = t.middleware(async ({ ctx, next }) => {
  const res = await next({ ctx });

  if (!res.ok) {
    // ClickHouse 资源错误特殊处理 → 422
    if (res.error.cause instanceof ClickHouseResourceError) {
      logErrorByCode("UNPROCESSABLE_CONTENT", res.error);
      res.error = new TRPCError({ code: "UNPROCESSABLE_CONTENT", ... });
    } else {
      // 其他错误：按 HTTP 状态码分类处理
      const { code, httpStatus } = resolveError(res.error);
      const isSafeToExpose = httpStatus >= 400 && httpStatus < 600;
      
      logErrorByCode(code, res.error);
      res.error = new TRPCError({
        code,
        message: isSafeToExpose ? res.error.message : "Internal error...",
      });
    }
  }
  return res;
});
```
> 位置：第二层（追踪之后、认证之前）
> 作用：统一错误格式、屏蔽敏感错误信息、错误分类日志

**3. 用户认证中间件**
```typescript
const enforceUserIsAuthed = t.middleware(({ ctx, next }) => {
  // 前置检查：Session 必须存在且有用户信息
  if (!ctx.session || !ctx.session.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  
  // 上下文增强：收紧类型，保证后续中间件中 session.user 非空
  return next({
    ctx: {
      session: { ...ctx.session, user: ctx.session.user },
    },
  });
});
```
> 位置：第三层（错误处理之后）
> 作用：验证登录状态、收紧上下文类型

**4. 项目成员验证中间件**
```typescript
const enforceUserIsAuthedAndProjectMember = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  
  // 前置检查 1: 用户已认证（理论上由上层保证，但双重检查）
  if (!ctx.session || !ctx.session.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  // 前置检查 2: 请求参数包含 projectId
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

  // 管理员绕过：管理员可以访问所有项目
  if (!sessionProject) {
    if (ctx.session.user.admin === true) {
      // 管理员访问：从 DB 获取组织信息，注入上下文
      const dbProject = await ctx.prisma.project.findFirst({
        select: { orgId: true },
        where: { id: projectId, deletedAt: null },
      });
      
      await sendAdminAccessWebhook({
        email: ctx.session.user.email,
        projectId,
        orgId: dbProject.orgId,
      });

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
    
    // 非成员且非管理员：拒绝
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "User is not a member of this project",
    });
  }

  // 上下文增强：注入组织与项目角色
  return next({
    ctx: {
      session: {
        ...ctx.session,
        user: ctx.session.user,
        orgId: sessionProject.organization.id,
        orgRole: sessionProject.organization.role,
        projectId: projectId,
        projectRole: sessionProject.role,
      },
    },
  });
});
```
> 位置：第四层（用户认证之后）
> 作用：项目级 RBAC、注入组织/项目角色信息

**5. 组织成员验证中间件**
```typescript
const enforceIsAuthedAndOrgMember = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  
  // 类似项目验证流程：
  // 1. 解析 orgId 参数
  // 2. 验证用户组织成员身份或管理员权限
  // 3. 注入 orgId + orgRole 到上下文
  
  return next({
    ctx: {
      session: {
        ...ctx.session,
        orgId: orgId,
        orgRole: ctx.session.user.admin === true 
          ? Role.OWNER 
          : sessionOrg!.role,
      },
    },
  });
});
```

**6. Trace 资源访问控制中间件**
```typescript
const enforceTraceAccess = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  
  // 1. 解析 traceId + projectId
  // 2. 从 ClickHouse 查询 Trace 数据
  const clickhouseTrace = await getTraceById({ traceId, projectId, ... });

  if (!clickhouseTrace) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Trace not found" });
  }

  // 3. 访问权限三选一:
  //    - Trace 公开 (public: true)
  //    - 用户是项目成员
  //    - 用户是管理员
  const sessionProject = ctx.session?.user?.organizations
    .flatMap(org => org.projects)
    .find(p => p.id === projectId);

  if (!clickhouseTrace.public && !sessionProject && ctx.session?.user?.admin !== true) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Not a project member and trace is not public",
    });
  }

  // 4. 上下文增强：注入已查询的 Trace（避免后续重复查询）
  return next({
    ctx: {
      session: { /* ... */ },
      trace: clickhouseTrace,
    },
  });
});
```

### 2.5 上下文类型演进图

```
初始上下文 (createTRPCContext)
├── session: Session | null
├── headers: IncomingHttpHeaders
└── prisma: PrismaClient
        ↓
[经过 enforceUserIsAuthed]
├── session: { user: User }  // user 从可选变为必选
├── headers
└── prisma
        ↓
[经过 enforceUserIsAuthedAndProjectMember]
├── session: {
│     user: User
│     orgId: string       // 新增
│     orgRole: Role       // 新增
│     projectId: string   // 新增
│     projectRole: Role   // 新增
│   }
├── headers
└── prisma
        ↓
[经过 enforceTraceAccess]
├── session: { ... }
├── headers
├── prisma
└── trace: Trace          // 新增资源数据
```

---

## 公共 REST API 限流链路详解

### 3.1 与 tRPC 链路的关键区别

公共 API 与 tRPC 的核心区别：
1. **限流存在性**: 公共 API 有限流，tRPC 无显式限流
2. **限流触发条件**: 仅**云环境**启用限流，自托管环境完全不触发
3. **限流维度**: 按组织 ID + 计划级别 + 资源类型三维限流

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

### 3.3 公共 API 请求流转顺序

以 `ingestion` 端点为例：

```
POST /api/public/ingestion
        │
        ▼
[ 步骤 1 ] CORS 预检处理
        │
        ▼
[ 步骤 2 ] OpenTelemetry 上下文注入
        │
        ▼
[ 步骤 3 ] API Key 认证
        │   ├── Basic Auth (publicKey + secretKey)
        │   └── Bearer Auth (仅公钥，权限受限)
        │
        ▼
[ 步骤 4 ]  ingestion 暂停检查
        │
        ▼
[ 步骤 5 ] 限流检查
        │   ├── 获取组织计划
        │   ├── 计算限流配置（基础配置 + 自定义覆盖）
        │   ├── Redis Token Bucket 消费
        │   └── 超限 → 返回 429 + Retry-After 头
        │
        ▼
[ 步骤 6 ] 请求参数校验 (Zod)
        │
        ▼
[ 步骤 7 ] 业务逻辑处理
        │
        ▼
[ 步骤 8 ] 异常捕获与统一错误响应
```

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
    // 1. 获取有效限流配置
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
      
      // 记录 metrics
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

1. **洋葱模型**: 中间件按顺序嵌套执行，请求从外到内，响应从内到外
2. **上下文渐进增强**: 每个中间件只添加自己负责的那部分上下文，不跨层污染
3. **类型安全**: TypeScript 类型系统确保流经中间件后，上下文类型被正确收紧
4. **单一职责**: 每个中间件只做一件事（认证、授权、错误处理、追踪等）
5. **管理员绕过**: 系统设计了管理员权限通道，可绕过组织/项目成员验证

### 4.2 限流系统设计原则

1. **云环境专属**: 自托管环境完全不启用限流，避免给私有化部署增加运维复杂度
2. **多维度配置**: 支持计划级基础配置 + 组织级自定义覆盖，灵活性高
3. **失败开放**: Redis 不可用时自动放行，不影响业务可用性
4. **标准响应**: 遵循 RFC 规范，返回 Retry-After 和 X-RateLimit-* 系列头
5. **可观测性**: 限流触发时有 Metrics 上报，便于监控和告警

### 4.3 两条链路的设计取舍

| 设计决策 | tRPC 链路 | 公共 API 链路 | 原因 |
|---------|-----------|--------------|------|
| 限流机制 | 无 | 有 | tRPC 面向前端用户，受登录态保护；公共 API 面向服务端，需防滥用 |
| 认证方式 | Cookie Session | API Key | 面向场景不同 |
| 错误处理 | tRPC 格式 | REST JSON | 生态约定 |
| 上下文注入 | 中间件链式自动注入 | 各端点手动处理 | tRPC 框架能力 vs 原生 Next.js API |

---

## 文件索引

| 功能模块 | 文件路径 |
|---------|---------|
| tRPC 入口 | `web/src/pages/api/trpc/[trpc].ts` |
| tRPC 配置与中间件 | `web/src/server/api/trpc.ts` |
| 根路由器 | `web/src/server/api/root.ts` |
| 公共 API 限流服务 | `web/src/features/public-api/server/RateLimitService.ts` |
| API 认证服务 | `web/src/features/public-api/server/apiAuth.ts` |
| 公共 API 中间件包装器 | `web/src/features/public-api/server/withMiddlewares.ts` |
| Ingestion 端点示例 | `web/src/pages/api/public/ingestion.ts` |
