# Langfuse tRPC 中间件调用链分析

## 目录
1. [整体架构](#整体架构)
2. [路由分层](#路由分层)
3. [上下文注入](#上下文注入)
4. [限流策略](#限流策略)

---

## 整体架构

Langfuse 的 tRPC 系统采用分层中间件架构，请求从进入到处理完成会穿过一系列中间件，形成一条完整的调用链。这个架构确保了认证、权限验证、限流、错误处理等横切关注点能够统一管理。

```
HTTP Request
    ↓
[ Next.js API Route Handler ]
    ↓
[ tRPC Context Creation ]
    ↓
[ Middleware Pipeline ]
    ├─ OpenTelemetry 追踪
    ├─ 全局错误处理
    ├─ 用户认证
    ├─ 项目/组织权限验证
    └─ 资源访问控制
    ↓
[ Procedure Handler ]
```

**核心文件位置**：
- tRPC 配置与中间件定义：`web/src/server/api/trpc.ts`
- 根路由器：`web/src/server/api/root.ts`
- 公共 API 限流服务：`web/src/features/public-api/server/RateLimitService.ts`
- API 认证服务：`web/src/features/public-api/server/apiAuth.ts`

---

## 路由分层

### 1. 根路由器结构

根路由器负责组合所有功能模块的子路由器，形成完整的 API 路由树。

```typescript
// web/src/server/api/root.ts
export const appRouter = createTRPCRouter({
  // 核心数据模块
  traces: traceRouter,
  sessions: sessionRouter,
  generations: generationsRouter,
  events: eventsRouter,
  scores: scoresRouter,
  observations: observationsRouter,
  
  // 分析与仪表板
  scoreAnalytics: scoreAnalyticsRouter,
  dashboard: dashboardRouter,
  scoreConfigs: scoreConfigsRouter,
  
  // 组织与项目管理
  organizations: organizationsRouter,
  organizationApiKeys: organizationApiKeysRouter,
  projects: projectsRouter,
  projectApiKeys: projectApiKeysRouter,
  members: membersRouter,
  users: userRouter,
  
  // 数据集与评估
  datasets: datasetRouter,
  evals: evalRouter,
  experiments: experimentsRouter,
  
  // Prompt 管理
  prompts: promptRouter,
  
  // 集成模块
  posthogIntegration: posthogIntegrationRouter,
  mixpanelIntegration: mixpanelIntegrationRouter,
  blobStorageIntegration: blobStorageIntegrationRouter,
  
  // 媒体与导出
  media: mediaRouter,
  batchExport: batchExportRouter,
  
  // 后台任务
  backgroundMigrations: backgroundMigrationsRouter,
  
  // 审计与通知
  auditLogs: auditLogsRouter,
  notificationPreferences: notificationPreferencesRouter,
  
  // 自动化
  automations: automationsRouter,
  
  // 支持功能
  slack: slackRouter,
  plainRouter: plainRouter,
  surveys: surveysRouter,
  
  // 其他工具
  utilities: utilsRouter,
  public: publicRouter,
  credentials: credentialsRouter,
  // ... 更多路由
});
```

### 2. 路由分层原则

**按业务领域分组**：
- 核心数据层：traces, sessions, generations, observations
- 评估层：scores, evals, datasets
- 管理域：organizations, projects, members, users
- 集成域：各种第三方集成路由

**Procedure 类型分层**：
每个子路由器内部进一步分为：
- Query（读操作）
- Mutation（写操作）
- 按资源细粒度划分

---

## 上下文注入

### 1. 基础上下文创建

tRPC 上下文在请求开始时创建，为整个调用链提供共享数据。

```typescript
// web/src/server/api/trpc.ts
export const createTRPCContext = async (opts: CreateNextContextOptions) => {
  const { req, res } = opts;

  // 获取用户会话信息
  const session = await getServerAuthSession({ req, res });
  
  // 获取请求头
  const headers = req.headers;

  // 将用户信息添加到 OpenTelemetry span
  addUserToSpan({
    userId: session?.user?.id,
    email: session?.user?.email ?? undefined,
  });

  return createInnerTRPCContext({ session, headers });
};

// 内部上下文包含数据库连接
export const createInnerTRPCContext = (opts: CreateContextOptions) => {
  return {
    session: opts.session,
    headers: opts.headers,
    prisma, // Prisma 数据库客户端
  };
};
```

### 2. 中间件上下文增强

请求流经各个中间件时，上下文会被逐步增强，添加更多的认证和授权信息。

#### 2.1 用户认证中间件

```typescript
const enforceUserIsAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.session || !ctx.session.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      session: { ...ctx.session, user: ctx.session.user }, // 类型收紧，user 非空
    },
  });
});
```

#### 2.2 项目成员验证中间件

```typescript
const enforceUserIsAuthedAndProjectMember = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  
  // 1. 验证用户已认证
  if (!ctx.session || !ctx.session.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  // 2. 解析请求中的 projectId
  const actualInput = await opts.getRawInput();
  const parsedInput = inputProjectSchema.safeParse(actualInput);
  if (!parsedInput.success)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid input, projectId is required",
    });

  // 3. 验证用户是否为项目成员
  const projectId = parsedInput.data.projectId;
  const sessionProject = ctx.session.user.organizations
    .flatMap((org) =>
      org.projects.map((project) => ({ ...project, organization: org })),
    )
    .find((project) => project.id === projectId);

  // 管理员特殊处理
  if (!sessionProject) {
    if (ctx.session.user.admin === true) {
      // 管理员访问逻辑...
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
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "User is not a member of this project",
    });
  }

  // 4. 注入组织和项目角色信息
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

#### 2.3 组织成员验证中间件

```typescript
const enforceIsAuthedAndOrgMember = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  
  // 验证认证与 orgId 参数
  // ...
  
  const orgId = result.data.orgId;
  const sessionOrg = ctx.session.user.organizations.find(
    (org) => org.id === orgId,
  );

  if (!sessionOrg && ctx.session.user.admin !== true) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "User is not a member of this organization",
    });
  }

  return next({
    ctx: {
      session: {
        ...ctx.session,
        user: ctx.session.user,
        orgId: orgId,
        orgRole: ctx.session.user.admin === true 
          ? Role.OWNER 
          : sessionOrg!.role,
      },
    },
  });
});
```

#### 2.4 资源访问控制中间件（Trace 访问）

```typescript
const enforceTraceAccess = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  
  // 解析 traceId 和 projectId
  // ...
  
  // 从 ClickHouse 获取 trace 数据
  const clickhouseTrace = await getTraceById({
    traceId,
    projectId,
    // ...
  });

  if (!clickhouseTrace) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Trace not found",
    });
  }

  // 验证用户权限或 trace 公开状态
  const sessionProject = ctx.session?.user?.organizations
    .flatMap((org) => org.projects)
    .find(({ id }) => id === projectId);

  if (
    !clickhouseTrace.public &&
    !sessionProject &&
    ctx.session?.user?.admin !== true
  ) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "User is not a member of this project and this trace is not public",
    });
  }

  // 将查询到的 trace 注入上下文，避免后续重复查询
  return next({
    ctx: {
      session: { /* ... */ },
      trace: clickhouseTrace,
    },
  });
});
```

### 3. 导出的 Procedure 类型

不同安全级别的 Procedure 类型：

```typescript
// 公开 Procedure（无需认证）
export const publicProcedure = withOtelTracingProcedure.use(withErrorHandling);

// 用户认证 Procedure（需要登录）
export const authenticatedProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceUserIsAuthed);

// 项目级权限 Procedure
export const protectedProjectProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceUserIsAuthedAndProjectMember);

// 组织级权限 Procedure
export const protectedOrganizationProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceIsAuthedAndOrgMember);

// Trace 访问权限 Procedure
export const protectedGetTraceProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceTraceAccess);

// 管理员 API Procedure
export const adminProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceAdminAuth);
```

---

## 限流策略

### 1. 限流架构概述

Langfuse 主要在**公共 REST API** 层面实现限流（tRPC API 主要用于前端，目前没有显式限流）。限流系统基于以下技术栈：

- **存储**：Redis
- **限流库**：rate-limiter-flexible
- **策略**：基于 Token Bucket 算法，按组织 ID、计划级别、资源类型进行限流

### 2. 限流核心服务

```typescript
// web/src/features/public-api/server/RateLimitService.ts
export class RateLimitService {
  private static redis: Redis | Cluster | null;
  
  async rateLimitRequest(scope: ApiAccessScope, resource: RateLimitResource) {
    // 自托管环境不禁用限流
    if (!env.NEXT_PUBLIC_LANGFUSE_CLOUD_REGION) {
      return new RateLimitHelper(undefined);
    }
    
    if (env.LANGFUSE_RATE_LIMITS_ENABLED === "false") {
      return new RateLimitHelper(undefined);
    }

    if (!RateLimitService.redis) {
      logger.warn("Rate limiting not available without Redis");
      return new RateLimitHelper(undefined);
    }

    return new RateLimitHelper(await this.checkRateLimit(scope, resource));
  }

  async checkRateLimit(scope: ApiAccessScope, resource: RateLimitResource) {
    // 获取限流配置（考虑计划级别和自定义覆盖）
    const effectiveConfig = getRateLimitConfig(scope, resource);

    // 无配置则不限流
    if (!effectiveConfig || !effectiveConfig.points) {
      return;
    }

    // 连接 Redis
    if (RateLimitService?.redis?.status !== "ready") {
      try {
        await RateLimitService?.redis?.connect();
      } catch (_err) {
        // Redis 不可用时失败开放（fail-open）
      }
    }

    const rateLimiter = new RateLimiterRedis({
      points: effectiveConfig.points,
      duration: effectiveConfig.durationInSec,
      keyPrefix: this.rateLimitPrefix(resource),
      storeClient: RateLimitService.redis,
      rejectIfRedisNotReady: true,
    });

    try {
      // orgId 作为限流键
      const libRes = await rateLimiter.consume(scope.orgId);
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
        // 限流触发
        return { /* 限流结果 */ };
      }
      // 其他错误，失败开放
      logger.error("Internal Rate limit error", err);
      return undefined;
    }
  }
}
```

### 3. 限流配置策略

限流配置采用**计划基础配置 + 自定义覆盖**的双层策略：

```typescript
const getRateLimitConfig = (scope: ApiAccessScope, resource: RateLimitResource) => {
  const planBasedConfig = getPlanBasedRateLimitConfig(scope.plan, resource);
  const customConfig = scope.rateLimitOverrides?.find(
    (config) => config.resource === resource,
  );
  
  // 自定义覆盖优先，否则使用计划基础配置
  return customConfig || planBasedConfig;
};
```

### 4. 各计划级别限流配置

| 资源类型 | Hobby 计划 | Core 计划* | Pro/Team/Enterprise |
|---------|-----------|-----------|-------------------|
| **ingestion** | 1000/分钟 | 20000/分钟 | 20000/分钟 |
| **legacy-ingestion** | 100/分钟 | 400/分钟 | 400/分钟 |
| **public-api** | 30/分钟 | 1000/分钟 | 1000/分钟 |
| **datasets** | 100/分钟 | 1000/分钟 | 1000/分钟 |
| **public-api-metrics** | 100/天 | 2000/天 | 2000/天 |
| **public-api-daily-metrics-legacy** | 10/天 | 200/天 | 200/天 |
| **trace-delete** | 50/天 | 200/天 | 1000/天 |
| **score-delete** | 50/天 | 200/天 | 1000/天 |
| **prompts** | 无限制 | 无限制 | 无限制 |

> *注：Core 计划目前临时使用 Pro 级别的限流配置以支持迁移

### 5. 限流响应处理

```typescript
export const sendRateLimitResponse = (
  res: NextApiResponse,
  rateLimitRes: RateLimitResult,
) => {
  // 设置标准限流响应头
  const httpHeader = {
    "Retry-After": Math.ceil(rateLimitRes.msBeforeNext / 1000),
    "X-RateLimit-Limit": rateLimitRes.points,
    "X-RateLimit-Remaining": rateLimitRes.remainingPoints,
    "X-RateLimit-Reset": new Date(Date.now() + rateLimitRes.msBeforeNext).toString(),
  };

  for (const [header, value] of Object.entries(httpHeader)) {
    res.setHeader(header, value);
  }

  // 返回 429 状态码
  res.status(429).end("429 - rate limit exceeded");
};
```

### 6. API 认证与限流的集成

在实际的 API 路由中，认证与限流是顺序执行的：

```typescript
// 典型的 API 路由处理流程
async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 1. 验证 API Key 并获取访问范围
  const authResult = await apiAuthService.verifyAuthHeaderAndReturnScope(
    req.headers.authorization
  );
  
  if (!authResult.validKey) {
    return res.status(401).json({ error: authResult.error });
  }
  
  // 2. 应用限流
  const rateLimitHelper = await rateLimitService.rateLimitRequest(
    authResult.scope,
    "ingestion" // 或其他资源类型
  );
  
  if (rateLimitHelper.isRateLimited()) {
    return rateLimitHelper.sendRestResponseIfLimited(res);
  }
  
  // 3. 执行业务逻辑
  // ...
}
```

---

## 关键设计原则

### 1. 中间件组合模式
- **洋葱模型**：请求从外层中间件进入，逐层向内，响应时反向逐层返回
- **上下文渐进增强**：每个中间件只负责添加自己的那部分上下文信息
- **类型安全**：TypeScript 类型系统确保上下文在流经中间件后类型被正确收紧

### 2. 失败开放策略
- Redis 不可用时限流自动失效，保证可用性
- 限流错误不会导致 500 错误，而是静默放行并记录日志

### 3. 权限分层
- 从粗到细：用户认证 → 组织权限 → 项目权限 → 单资源权限
- 管理员拥有最高权限，可绕过组织/项目成员验证

### 4. 可观测性
- 每个请求都经过 OpenTelemetry 中间件
- 用户、项目、组织信息被注入到追踪 span 中
- 限流触发时有 metrics 记录

---

## 总结

Langfuse 的 tRPC 中间件系统是一个设计精良的分层架构：

1. **路由分层**清晰，按业务领域组织，便于维护和扩展
2. **上下文注入**采用渐进式增强，每个中间件专注单一职责，类型安全
3. **限流策略**灵活，支持多维度（计划、组织、资源）配置，并有失败开放保障

这个架构确保了系统的安全性、可维护性和可扩展性，同时为开发者提供了清晰的扩展点。
