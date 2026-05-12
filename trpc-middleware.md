# Langfuse tRPC 中间件调用链与公共 API 限流架构分析

## 文档变更记录
| 版本 | 日期 | 变更说明 |
|------|------|----------|
| v3.0 | 2026-05-12 | 证据化校准：补充 3 个 Procedure 分支的代码级使用证据、Router/Procedure 映射、开启/关闭追踪的决策依据 |
| v2.1 | 2026-05-12 | 修正 tRPC 权限中间件多分支结构；补充公共 API 多种入口模式；更新分叉图与流程说明 |
| v2.0 | 2026-05-12 | 重写架构分析，明确两条链路分叉关系；修正自托管限流表述；按请求流转顺序重构 |

---

## 目录
1. [整体架构：两条 API 链路的分叉关系](#1-整体架构两条-api-链路的分叉关系)
2. [tRPC 调用链详解：9 条 Procedure 分支](#2-trpc-调用链详解9-条-procedure-分支)
3. [重点分支证据化分析：3 个目标 Procedure](#3-重点分支证据化分析3-个目标-procedure)
4. [公共 REST API 限流链路详解：多种入口模式](#4-公共-rest-api-限流链路详解多种入口模式)
5. [核心设计原则总结](#5-核心设计原则总结)
6. [文件索引](#6-文件索引)

---

## 1. 整体架构：两条 API 链路的分叉关系

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
┌──────────────────────────┐  ┌──────────────────────────────────┐
│   tRPC 框架管道          │  │   公共 API 多入口分支            │
│                          │  │                                  │
│  ┌─────────────────────┐│  │  ┌────────────────────────────┐│
│  │ 9 条 Procedure 分支 ││  │  │ withMiddlewares 包装器     ││
│  │ ┌──────────────────┐││  │  │  (统一错误处理 + CORS)     ││
│  │ │ 有追踪:         │││  │  └─────────────┬──────────────┘│
│  │ │  withOtel* × 6  │││  │                │               │
│  │ │                  │││  │                ▼               │
│  │ │ 无追踪:         │││  │  ┌────────────────────────────┐│
│  │ │  t.procedure ×3 │││  │  │ createAuthedProjectAPIRoute││
│  │ └──────────────────┘││  │  │ (认证 + 限流 + Zod校验)    ││
│  └──────────┬──────────┘│  │  └────────────────────────────┘│
│             │           │  │                                  │
│             │           │  │  ┌────────────────────────────┐│
│             │           │  │  │   自定义入口（特殊场景）    ││
│             │           │  │  │   - ingestion.ts           ││
│             │           │  │  │   - mcp/index.ts           ││
│             │           │  │  │   - health.ts / ready.ts   ││
│             │           │  │  └────────────────────────────┘│
└─────────────┼───────────┘  └──────────────────────────────────┘
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
| **中间件模式** | 9 条 Procedure 分支：6 条有追踪 + 3 条无追踪 | 多模式：withMiddlewares + 自定义入口 |
| **上下文注入** | 渐进式类型收紧 | 各端点手动处理 |
| **错误处理** | tRPC 格式 + 中间件转换 | REST JSON + 统一错误包装 |
| **自托管行为** | 无差异 | 完全不启用限流 |

---

## 2. tRPC 调用链详解：9 条 Procedure 分支

### 2.1 请求流转总览

tRPC 采用**中间件组合模式**，不是单一路径，而是通过不同 Procedure 类型形成 **9 条独立的处理分支**。重要修正：**不是所有 Procedure 都从 withOtelTracingProcedure 开始**，实际上分为两类：

```
┌─────────────────────────────────────────────────────────────────────┐
│                     两类 Procedure 起点                               │
│                                                                      │
│  ┌─────────────────────────────┐   ┌─────────────────────────────┐  │
│  │  withOtelTracingProcedure   │   │      t.procedure            │  │
│  │  (OpenTelemetry 追踪)       │   │  (原生 tRPC 基础)           │  │
│  └──────────────┬──────────────┘   └──────────────┬──────────────┘  │
│                 │                                  │                 │
│                 ▼                                  ▼                 │
│         withErrorHandling                   withErrorHandling        │
│                 │                                  │                 │
│     ┌───────────┼───────────┐          ┌───────────┼───────────┐     │
│     ▼           ▼           ▼          ▼           ▼           ▼     │
│  项目权限    单资源访问   用户认证    项目权限                  用户认证│
│  (×3)        (×2)        (×1)       (×1)                        (×1)│
│                                                                      │
│  总计：6 条有追踪分支             总计：3 条无追踪分支                │
└───────────────────────────────────────────────────────────────────────┘
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

> **关键点**: 上下文创建发生在所有中间件执行之前，是所有 9 条 Procedure 分支的共同起点。

### 2.3 步骤 2：路由分层结构

**文件**: `web/src/server/api/root.ts`

根路由器按业务领域组织成 50+ 子路由，每个子路由根据权限需求和追踪需求选择合适的 Procedure 类型：

```typescript
export const appRouter = createTRPCRouter({
  // ========== 公开数据模块 ==========
  public: publicRouter,                    // publicProcedure（有追踪）
  
  // ========== 用户相关模块（需登录）==========
  users: userRouter,                        // authenticatedProcedure
  userAccount: userAccountRouter,           // 按性能需求选择有追踪/无追踪
  credentials: credentialsRouter,           // protectedProcedureWithoutTracing
                                              // （密码重置，安全敏感）
  
  // ========== 项目级权限模块 ==========
  traces: traceRouter,                      // protectedProjectProcedure
  sessions: sessionRouter,                  // protectedProjectProcedure +
                                          // protectedGetSessionProcedure
  generations: generationsRouter,           // protectedProjectProcedure
  llmApiKey: llmApiKeyRouter,               // protectedProjectProcedureWithoutTracing
                                          // （API Key 管理，安全/性能敏感）
  
  // ========== 组织级权限模块 ==========
  organizations: organizationsRouter,       // protectedOrganizationProcedure
  
  // ========== 管理员模块 ==========
  // adminProcedure (内部管理员 API)
});
```

**Procedure 选择原则**:
- 公开数据无需认证 → `publicProcedure`
- 用户个人信息操作 → 根据性能/安全需求选择 `authenticatedProcedure` 或 `protectedProcedureWithoutTracing`
- 项目内资源操作 → 根据性能/安全需求选择 `protectedProjectProcedure` 或 `protectedProjectProcedureWithoutTracing`
- Session 详情访问 → `protectedGetSessionProcedure`
- 高频率、性能敏感、安全敏感接口 → **优先选择无追踪版本**

---

## 3. 重点分支证据化分析：3 个目标 Procedure

### 3.1 分类总表

| Procedure 名称 | 起点类型 | 追踪状态 | 使用模块 | 关联 Procedure 数量 |
|----------------|---------|---------|---------|--------------------|
| protectedProcedureWithoutTracing | `t.procedure` | ❌ 关闭 | 用户认证凭据模块 | 1 个 |
| protectedProjectProcedureWithoutTracing | `t.procedure` | ❌ 关闭 | LLM API Key 模块 | 4 个 |
| protectedGetSessionProcedure | `withOtelTracingProcedure` | ✅ 开启 | Session 详情模块 | 4 个 |

---

### 3.2 分支 1：protectedProcedureWithoutTracing（用户认证、无追踪）

#### 3.2.1 定义证据

**文件**: `web/src/server/api/trpc.ts:259-261`

```typescript
// 定义：直接从 t.procedure 开始，跳过 OpenTelemetry 追踪
export const protectedProcedureWithoutTracing = t.procedure
  .use(withErrorHandling)
  .use(enforceUserIsAuthed);
```

#### 3.2.2 与有追踪版本对比

有追踪版本定义（`trpc.ts:255-257`）：
```typescript
export const authenticatedProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceUserIsAuthed);
```

**差异对比表**:

| 维度 | authenticatedProcedure（有追踪） | protectedProcedureWithoutTracing（无追踪） |
|------|--------------------------------|------------------------------------------|
| 起点 | `withOtelTracingProcedure` | `t.procedure` |
| 中间件链路 | Otel追踪 → 错误处理 → 用户认证 | 错误处理 → 用户认证 |
| 可观测性 | ✅ 完整调用链追踪 | ❌ 跳过追踪中间件 |
| 性能开销 | 较高（Span 创建、上下文传播） | 较低（纯认证逻辑） |

#### 3.2.3 实际使用证据

**文件**: `web/src/features/auth-credentials/server/credentialsRouter.ts:12-43`

```typescript
import {
  createTRPCRouter,
  protectedProcedureWithoutTracing,
} from "@/src/server/api/trpc";

export const credentialsRouter = createTRPCRouter({
  resetPassword: protectedProcedureWithoutTracing
    .input(
      z.object({
        password: passwordSchema,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // 1. 验证邮箱状态
      const user = await ctx.prisma.user.findUnique({
        where: { id: ctx.session.user.id },
        select: { emailVerified: true },
      });

      const emailVerificationStatus = isEmailVerifiedWithinCutoff(
        user?.emailVerified?.toISOString(),
      );

      if (!emailVerificationStatus.verified) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: emailVerificationStatus.reason === "not_verified"
            ? "Email not verified."
            : "Email verification expired.",
        });
      }

      // 2. 执行密码更新
      await updateUserPassword(ctx.session.user.id, input.password);
    }),
});
```

#### 3.2.4 关闭追踪的决策分析

| 决策因素 | 分析 |
|---------|------|
| **安全敏感性** | 操作涉及用户密码重置，包含敏感凭据信息。追踪可能捕获请求参数或上下文，存在安全风险。 |
| **性能敏感性** | 密码哈希计算是 CPU 密集型操作，减少追踪开销可提升响应速度。 |
| **可观测性需求** | 密码重置属于低频操作，且已有完整的错误日志和审计日志（中间件层面），追踪价值较低。 |
| **数据最小化原则** | 敏感操作尽可能减少数据采集点，符合隐私保护最佳实践。 |

> **代码注释验证**: 该 Procedure 命名明确包含 `WithoutTracing`，表明是有意识的设计决策，而非遗漏。

---

### 3.3 分支 2：protectedProjectProcedureWithoutTracing（项目级权限、无追踪）

#### 3.3.1 定义证据

**文件**: `web/src/server/api/trpc.ts:366-368`

```typescript
// 定义：直接从 t.procedure 开始，跳过 OpenTelemetry 追踪
export const protectedProjectProcedureWithoutTracing = t.procedure
  .use(withErrorHandling)
  .use(enforceUserIsAuthedAndProjectMember);
```

#### 3.3.2 与有追踪版本对比

有追踪版本定义（`trpc.ts:362-364`）：
```typescript
export const protectedProjectProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceUserIsAuthedAndProjectMember);
```

**差异对比表**:

| 维度 | protectedProjectProcedure（有追踪） | protectedProjectProcedureWithoutTracing（无追踪） |
|------|-----------------------------------|-----------------------------------------------|
| 起点 | `withOtelTracingProcedure` | `t.procedure` |
| 中间件链路 | Otel追踪 → 错误处理 → 项目成员认证 | 错误处理 → 项目成员认证 |
| 可观测性 | ✅ 完整调用链追踪 | ❌ 跳过追踪中间件 |
| 注入字段 | orgId, orgRole, projectId, projectRole | 完全相同 |
| 性能开销 | 较高（Span 创建 + 管理员 Webhook 追踪） | 较低 |

#### 3.3.3 实际使用证据

**文件**: `web/src/features/llm-api-key/server/router.ts`

该模块使用无追踪版本的 4 个 Procedure：

| Procedure 名称 | 行号 | 操作类型 | 外部调用 |
|---------------|------|---------|---------|
| `create` | 193 | 创建 LLM API Key | 否 |
| `test` | 479 | 测试 LLM API 连接 | ✅ 调用外部 LLM API |
| `testUpdate` | 510 | 测试更新后的 API Key | ✅ 调用外部 LLM API |
| `update` | 590 | 更新 LLM API Key | 否 |

**核心代码示例（test Procedure）**: `router.ts:479-508`

```typescript
test: protectedProjectProcedureWithoutTracing
  .input(CreateLlmApiKey)
  .mutation(async ({ input, ctx }) => {
    throwIfNoProjectAccess({
      session: ctx.session,
      projectId: input.projectId,
      scope: "llmApiKeys:create",
    });

    // 测试外部 LLM API 连接
    return testLLMConnection({
      adapter: input.adapter,
      provider: input.provider,
      secretKey: input.secretKey,  // 敏感信息
      baseURL: input.baseURL,
      customModels: input.customModels,
      extraHeaders: input.extraHeaders,  // 敏感信息
      config: input.config,
    });
  }),
```

**LLM 连接测试逻辑** (`router.ts:100-169`):
```typescript
async function testLLMConnection(
  params: TestLLMConnectionParams,
): Promise<{ success: boolean; error?: string }> {
  try {
    // 构建测试消息
    const testMessages: ChatMessage[] = [
      { role: ChatMessageRole.User, content: "How are you?", type: ChatMessageType.User },
    ];

    // 调用外部 LLM API（网络 I/O，性能敏感）
    await fetchLLMCompletion({
      modelParams: { adapter: params.adapter, provider: params.provider, model },
      llmConnection: {
        secretKey: encrypt(params.secretKey),  // 敏感信息加密传输
        extraHeaders: params.extraHeaders && encrypt(JSON.stringify(params.extraHeaders)),
        baseURL: params.baseURL || undefined,
        config: parsedConfig,
      },
      messages: testMessages,
      streaming: false,
      maxRetries: 1,
    });

    return { success: true };
  } catch (err) {
    logger.error(err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
```

#### 3.3.4 关闭追踪的决策分析

| 决策因素 | 分析 |
|---------|------|
| **安全敏感性** | 操作涉及 LLM API 密钥（`secretKey`）、自定义请求头等高度敏感信息。追踪系统可能捕获这些参数，存在凭证泄露风险。 |
| **性能敏感性** | `test`/`testUpdate` Procedure 包含外部 LLM API 网络调用，延迟不可控。减少追踪中间件的开销可降低总响应时间。 |
| **外部调用复杂性** | `fetchLLMCompletion` 内部已有独立的 OpenTelemetry 追踪，外层 tRPC 追踪会造成重复追踪，增加数据冗余。 |
| **操作频率** | API Key 测试操作可能被用户频繁触发（调试配置时），高频操作的追踪成本累积效应显著。 |
| **数据最小化原则** | 涉及第三方 API 密钥的操作应尽可能减少数据采集链路，降低泄露面。 |

> **代码注释验证**: 该模块同时导入了 `protectedProjectProcedure` 和 `protectedProjectProcedureWithoutTracing`（`router.ts:13-14`），表明是有意识的选择，而非全局默认。

---

### 3.4 分支 3：protectedGetSessionProcedure（Session 资源访问控制、有追踪）

#### 3.4.1 定义证据

**文件**: `web/src/server/api/trpc.ts:626-628`

```typescript
// 定义：从 withOtelTracingProcedure 开始，保留完整追踪
export const protectedGetSessionProcedure = withOtelTracingProcedure
  .use(withErrorHandling)
  .use(enforceSessionAccess);
```

**核心中间件 enforceSessionAccess 定义** (`trpc.ts:549-624`):
```typescript
const inputSessionSchema = z.object({
  sessionId: z.string(),
  projectId: z.string(),
});

const enforceSessionAccess = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  const actualInput = await opts.getRawInput();
  const result = inputSessionSchema.safeParse(actualInput);
  
  // 1. 验证 Session 存在性（PostgreSQL 查询）
  const session = await ctx.prisma.traceSession.findFirst({
    where: { id: sessionId, projectId },
    select: { public: true },
  });

  if (!session) {
    logger.error(`Session with id ${sessionId} not found for project ${projectId}`);
    throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
  }

  // 2. 多条件权限判定：公开 OR 项目成员 OR 管理员
  const userSessionProject = ctx.session?.user?.organizations
    .flatMap((org) => org.projects)
    .find(({ id }) => id === projectId);

  if (!session.public && !userSessionProject && ctx.session?.user?.admin !== true) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "User is not a member of this project and this session is not public",
    });
  }

  // 3. 管理员访问 Webhook 通知
  if (ctx.session?.user?.admin === true) {
    await sendAdminAccessWebhook({
      email: ctx.session.user.email,
      projectId,
    });
  }

  // 4. 注入项目角色到上下文
  return next({
    ctx: {
      session: {
        ...ctx.session,
        projectRole: ctx.session?.user?.admin === true
          ? Role.OWNER
          : userSessionProject?.role,
      },
    },
  });
});
```

#### 3.4.2 实际使用证据

**文件**: `web/src/server/api/routers/sessions.ts`

该模块使用有追踪版本的 4 个 Procedure：

| Procedure 名称 | 行号 | 操作类型 | 数据库查询 | ClickHouse 查询 |
|---------------|------|---------|-----------|----------------|
| `byIdWithScores` | 638 | 获取 Session 详情 + Scores | ✅ PostgreSQL | ✅ ClickHouse |
| `byIdWithScoresFromEvents` | 669 | 从事件表获取 Session 详情 | ✅ PostgreSQL | ✅ ClickHouse |
| `tracesFromEvents` | 722 | 获取 Session 关联 Traces | ❌ | ✅ ClickHouse |
| `observationsForTraceFromEvents` | 761 | 获取 Trace 的 Observations | ❌ | ✅ ClickHouse |

**核心代码示例（byIdWithScores Procedure）**: `sessions.ts:638-668`

```typescript
byIdWithScores: protectedGetSessionProcedure
  .input(
    z.object({
      sessionId: z.string(), // used for security check
      projectId: z.string(), // used for security check
    }),
  )
  .query(async ({ input, ctx }) => {
    // 并行查询：Scores + Session 详情（多数据库操作）
    const [scores, session] = await Promise.all([
      getScoresForSessions({
        projectId: input.projectId,
        sessionIds: [input.sessionId],
      }),
      handleGetSessionById({
        sessionId: input.sessionId,
        projectId: input.projectId,
        ctx,
      }),
    ]);

    // Score 数据校验与转换
    const validatedScores: ScoreDomain[] = filterAndValidateDbScoreList({
      scores,
      dataTypes: LISTABLE_SCORE_TYPES,
      onParseError: traceException,
    });

    return {
      ...session,
      scores: toDomainArrayWithStringifiedMetadata(validatedScores),
    };
  }),
```

#### 3.4.3 开启追踪的决策分析

| 决策因素 | 分析 |
|---------|------|
| **可观测性需求高** | Session 详情页是核心用户功能，涉及多数据库（PostgreSQL + ClickHouse）的复杂查询。完整追踪对性能调优和故障排查至关重要。 |
| **查询复杂性** | 每个 Procedure 都包含多个并行/串行的数据库查询，涉及 ClickHouse 的聚合查询性能波动大，需要追踪来定位瓶颈。 |
| **错误排查价值** | Session 查询可能遇到数据一致性问题（PostgreSQL 与 ClickHouse 数据不同步），追踪可帮助复现和诊断此类问题。 |
| **安全审计需求** | 包含公开 Session 访问权限判定和管理员访问 Webhook，追踪可提供完整的访问审计链路。 |
| **操作频率适中** | Session 详情查询属于中等频率操作，追踪开销在可接受范围内。 |
| **无敏感凭据** | 不涉及密码、API Key 等敏感凭据，追踪的安全风险较低。 |

> **设计意图验证**: 该中间件内部包含 `logger.error` 日志记录（`trpc.ts:578-584`），表明设计者明确需要完整的可观测性来支持运维。

---

### 3.5 三个分支的追踪决策对比总结

| 决策维度 | protectedProcedureWithoutTracing | protectedProjectProcedureWithoutTracing | protectedGetSessionProcedure |
|---------|--------------------------------|---------------------------------------|-----------------------------|
| **追踪状态** | ❌ 关闭 | ❌ 关闭 | ✅ 开启 |
| **安全敏感度** | 高（密码） | 高（LLM API Key） | 低（只读数据） |
| **性能敏感度** | 中（密码哈希） | 高（外部 LLM API 调用） | 中（多数据库查询） |
| **可观测性价值** | 低 | 低（外部调用已有独立追踪） | 高（复杂查询性能分析） |
| **操作频率** | 低频 | 中高频 | 中高频 |
| **外部调用** | 无 | 有（LLM API） | 无 |
| **审计需求** | 有（密码变更） | 有（API Key 变更） | 有（公开访问权限） |

**追踪决策核心原则**:
> **当安全敏感性或性能敏感性超过可观测性收益时，选择关闭 tRPC 层面的追踪；依赖日志和审计系统完成可观测性闭环。**

---

## 4. 公共 REST API 限流链路详解：多种入口模式

### 4.1 与 tRPC 链路的核心区别

公共 API 与 tRPC 的核心区别：
1. **限流存在性**：公共 API 有限流，tRPC 无显式限流
2. **限流触发条件**：仅**云环境**启用限流，自托管环境完全不触发
3. **限流维度**：按组织 ID + 计划级别 + 资源类型三维限流
4. **入口模式多样性**：公共 API 有 3 种不同的入口模式，不是所有端点都走 `withMiddlewares`

### 4.2 限流启用条件（修正说明）

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

### 4.3 公共 API 的 3 种入口模式

公共 API 不是所有端点都走 `withMiddlewares`，根据功能需求分为 3 种模式：

| 入口模式 | 代表端点 | 特点 |
|---------|---------|------|
| **模式 1：withMiddlewares + createAuthedProjectAPIRoute** | 大部分 REST API（如 GET traces/[traceId]、v2 系列） | 统一错误处理 + CORS + 认证 + 限流 + Zod 校验 |
| **模式 2：自定义入口 + 手动调用认证/限流** | `ingestion.ts`, `mcp/index.ts` | 特殊传输需求（SSE 流式）、自定义错误处理、性能优化 |
| **模式 3：极简入口（无认证无限流）** | `health.ts`, `ready.ts` | 健康检查、运维监控专用 |

#### 4.3.1 模式 1：标准 REST API 流程（withMiddlewares + createAuthedProjectAPIRoute）

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

#### 4.3.2 模式 2：自定义入口 - ingestion.ts 高吞吐数据接入

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

#### 4.3.3 模式 2：自定义入口 - mcp/index.ts 流式传输

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

#### 4.3.4 模式 3：极简入口 - health.ts / ready.ts 健康检查

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

### 4.4 限流核心实现

#### 4.4.1 限流服务架构

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

#### 4.4.2 限流配置策略

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

#### 4.4.3 各计划级别限流配置表

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

#### 4.4.4 限流响应格式

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

### 4.5 失败开放策略

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

## 5. 核心设计原则总结

### 5.1 tRPC 中间件设计原则

1. **组合优于继承**：通过 `.use()` 链式组合不同中间件，形成 9 条独立的权限分支
2. **双起点设计**：
   - `withOtelTracingProcedure`：6 条分支，需要可观测性的常规接口
   - `t.procedure`：3 条分支，高频率/性能敏感/安全敏感接口，跳过追踪开销
3. **洋葱模型执行**：中间件按顺序嵌套执行，请求从外到内，响应从内到外
4. **上下文渐进增强**：每个中间件只添加自己负责的那部分上下文，不跨层污染，类型逐步收紧
5. **单一职责**：每个中间件只做一件事（认证、授权、错误处理、追踪等）
6. **管理员通道设计**：每个权限中间件都内置管理员绕过逻辑，支持系统级运维操作
7. **预加载优化**：资源级中间件（如 `enforceTraceAccess`、`enforceSessionAccess`）预加载数据注入上下文，避免重复查询
8. **性能按需取舍**：提供无追踪版本，允许在可观测性和性能之间做权衡
   - **关闭追踪触发条件**：安全敏感性高（密码、API Key）、性能敏感性高（外部 LLM 调用）、可观测性价值低
   - **开启追踪触发条件**：查询复杂度高、可观测性价值高、安全风险低

### 5.2 公共 API 入口设计原则

1. **分层设计**：3 种入口模式应对不同场景需求，不搞"一刀切"
2. **场景适配**：标准 REST API 用统一模式，高吞吐和流式传输走自定义入口
3. **可用性优先**：限流系统采用多级失败开放机制，确保 Redis 故障时业务不受影响
4. **权限最小化**：健康检查等运维端点完全开放，无认证无限流，避免监控系统故障
5. **协议兼容**：MCP 等特殊协议端点放弃统一中间件，直接控制传输层以保证兼容性

### 5.3 两条链路的设计取舍对比

| 设计决策 | tRPC 链路 | 公共 API 链路 | 原因 |
|---------|-----------|--------------|------|
| 限流机制 | 无 | 有（云环境） | tRPC 面向前端用户，受登录态保护；公共 API 面向服务端，需防滥用 |
| 认证方式 | Cookie Session | API Key (Basic/Bearer) | 面向场景不同 |
| 权限模型 | 9 条分支渐进式授权 | API Key scope + 组织计划 | tRPC 面向人机交互，权限维度复杂；公共 API 面向自动化集成 |
| 错误处理 | tRPC 格式 + 中间件转换 | REST JSON + 多模式包装 | 生态约定与传输需求 |
| 上下文注入 | 中间件链式自动注入 | 各端点手动处理 | tRPC 框架能力 vs 原生 Next.js API 灵活性 |
| 可观测性策略 | 双起点：有追踪/无追踪可选 | 统一有追踪，但限流可配置 | 前端交互与服务端集成的性能需求差异 |

---

## 6. 文件索引

| 功能模块 | 文件路径 |
|---------|---------|
| tRPC 入口 | `web/src/pages/api/trpc/[trpc].ts` |
| tRPC 配置与 9 种 Procedure 定义 | `web/src/server/api/trpc.ts` |
| tRPC 根路由器 | `web/src/server/api/root.ts` |
| Session 路由器（protectedGetSessionProcedure 使用示例） | `web/src/server/api/routers/sessions.ts` |
| 凭据路由器（protectedProcedureWithoutTracing 使用示例） | `web/src/features/auth-credentials/server/credentialsRouter.ts` |
| LLM API Key 路由器（protectedProjectProcedureWithoutTracing 使用示例） | `web/src/features/llm-api-key/server/router.ts` |
| 公共 API 限流服务 | `web/src/features/public-api/server/RateLimitService.ts` |
| API 认证服务 | `web/src/features/public-api/server/apiAuth.ts` |
| 公共 API 中间件包装器（模式 1） | `web/src/features/public-api/server/withMiddlewares.ts` |
| 认证路由工厂（模式 1） | `web/src/features/public-api/server/createAuthedProjectAPIRoute.ts` |
| 自定义入口 - 数据摄入（模式 2） | `web/src/pages/api/public/ingestion.ts` |
| 自定义入口 - MCP 协议（模式 2） | `web/src/pages/api/public/mcp/index.ts` |
| 极简入口 - 健康检查（模式 3） | `web/src/pages/api/public/health.ts` |
| 极简入口 - 就绪检查（模式 3） | `web/src/pages/api/public/ready.ts` |
