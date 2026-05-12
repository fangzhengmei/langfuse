# Langfuse Public API 认证链分析

## 一、整体认证流程概览

```
SDK 调用 (HTTP)
    ↓
1. Authorization Header 解析 (Basic/Bearer)
    ↓
2. API Key 校验 (ApiAuthService)
    ↓
3. 组织/项目归属解析 (scope 生成)
    ↓
4. 成员角色权限验证 (accessLevel)
    ↓
5. 限流检查 (RateLimitService)
    ↓
6. 业务处理 (ingestion/CRUD 等)
```

---

## 二、API Key 校验机制

### 2.1 认证方式支持

| 认证方式 | Header 格式 | 所需凭据 | 访问范围 |
|---------|------------|---------|---------|
| Basic Auth | `Basic base64(publicKey:secretKey)` | Public Key + Secret Key | 完整权限 (project/organization) |
| Bearer Auth | `Bearer publicKey` | 仅 Public Key | 受限权限 (scores) |

### 2.2 ApiAuthService 核心流程

**文件位置**: `web/src/features/public-api/server/apiAuth.ts`

```typescript
// 核心认证入口
const authCheck = await new ApiAuthService(prisma, redis)
  .verifyAuthHeaderAndReturnScope(req.headers.authorization);
```

**校验步骤**:

1. **Header 存在性检查**
   - 无 Authorization Header 直接返回 `{ validKey: false, error: "No authorization header" }`

2. **Basic Auth 处理 (完整权限)**
   ```typescript
   // 1. 解析出 publicKey 和 secretKey
   const { username: publicKey, password: secretKey } = 
     extractBasicAuthCredentials(authHeader);
   
   // 2. 计算 secretKey 的 SHA256 哈希（快速验证路径）
   const hashFromProvidedKey = createShaHash(secretKey, salt);
   
   // 3. Redis 缓存优先查询
   const cachedKey = await fetchApiKeyFromRedis(hashFromProvidedKey);
   
   // 4. 缓存未命中时查询数据库
   //    - 快速路径：通过 fastHashedSecretKey 查询
   //    - 兼容路径：通过 publicKey 查询后用 bcrypt 验证 secretKey
   
   // 5. 更新 fastHashedSecretKey（兼容旧密钥）
   if (slowKey && isValid) {
     await prisma.apiKey.update({
       where: { publicKey },
       data: { fastHashedSecretKey: shaKey }
     });
   }
   ```

3. **Bearer Auth 处理 (仅 Public Key)**
   - 仅支持 PROJECT scope 的 API Key
   - 不允许 ORGANIZATION scope 的 key 使用 Bearer 认证
   - accessLevel 固定为 `"scores"`

### 2.3 API Key Scope 类型

**Schema 定义**: `packages/shared/src/server/auth/types.ts`

| Scope 类型 | projectId | 适用场景 |
|-----------|-----------|---------|
| `PROJECT` | 有值 | 项目级数据摄入、API 操作 |
| `ORGANIZATION` | null | 组织级管理、跨项目操作 |

### 2.4 Redis 缓存策略

- **缓存 Key 格式**: `api-key:{sha256(secretKey)}`
- **TTL**: 可配置（默认值见环境变量）
- **缓存命中率提升**:
  - 首次验证后将 fastHashedSecretKey 存入 Redis
  - 后续请求直接走 Redis 跳过数据库查询
- **不存在标记**: 对无效 key 也缓存不存在标记，防暴力破解

---

## 三、项目归属解析

### 3.1 Scope 对象结构

**验证成功后返回的 scope 对象**:

```typescript
{
  validKey: true,
  scope: {
    projectId: string | null,        // 项目 ID（PROJECT scope 有值）
    accessLevel: "organization" | "project" | "scores",
    orgId: string,                    // 组织 ID（总是有值）
    plan: PlanType,                   // 订阅计划
    rateLimitOverrides: RateLimit[],  // 限流覆盖配置
    apiKeyId: string,                 // API Key ID
    publicKey: string,                // Public Key
    isIngestionSuspended: boolean     // 摄入是否被暂停
  }
}
```

### 3.2 组织/项目关联解析逻辑

```typescript
// 从 API Key 关联的 Project 或 Organization 中提取 orgId
const orgId = apiKey.project?.organization.id ?? apiKey.organization?.id;

// 从组织配置中提取：计划、限流规则、摄入暂停状态
const plan = getOrganizationPlanServerSide(cloudConfig);
const rateLimitOverrides = cloudConfig?.rateLimitOverrides;
const isIngestionSuspended = cloudFreeTierUsageThresholdState === "BLOCKED";
```

### 3.3 项目级 vs 组织级 API Key 使用

| 操作类型 | PROJECT Scope Key | ORGANIZATION Scope Key |
|---------|------------------|----------------------|
| 数据摄入 (ingestion) | ✅ 需验证 `scope.projectId` 存在 | ❌ 拒绝（无 projectId） |
| 项目 CRUD | ✅ 仅限所属项目 | ✅ 组织内所有项目 |
| 组织管理 | ❌ | ✅ |
| Bearer Auth 打分 | ✅ | ❌ |

---

## 四、SDK 多入口复用机制

### 4.1 核心入口点

| 入口路径 | 用途 | 认证方式 |
|---------|------|---------|
| `/api/public/ingestion` | 数据摄入（trace/span/generation/score） | Basic/Bearer |
| `/api/public/*` | 其他公共 API（项目、数据集、提示词等） | Basic 为主 |
| `/api/public/unstable/*` | Evaluator 实验性 API | Basic |

### 4.2 认证流程复用设计

**方案一：通用认证 Service（直接调用）**

```typescript
// ingestion.ts 中的使用示例
const authCheck = await new ApiAuthService(prisma, redis)
  .verifyAuthHeaderAndReturnScope(req.headers.authorization);

if (!authCheck.validKey) {
  throw new UnauthorizedError(authCheck.error);
}

// 入口特定校验
if (!authCheck.scope.projectId) {
  throw new UnauthorizedError("Missing projectId...");
}

if (authCheck.scope.isIngestionSuspended) {
  throw new ForbiddenError("Ingestion suspended...");
}
```

**方案二：认证路由工厂（封装复用）**

**文件位置**: `web/src/features/public-api/server/createAuthedProjectAPIRoute.ts`

```typescript
// 高阶路由工厂，封装认证、限流、校验
export const createAuthedProjectAPIRoute = (config) => {
  return async (req, res) => {
    // 1. API Key + Admin API Key 双重认证支持
    const auth = await verifyAuth(req, config.isAdminApiKeyAuthAllowed);
    
    // 2. 统一限流检查
    const rateLimit = await RateLimitService.getInstance()
      .rateLimitRequest(auth.scope, config.rateLimitResource);
    
    // 3. 请求参数 Zod 校验
    const query = config.querySchema?.parse(req.query);
    const body = config.bodySchema?.parse(req.body);
    
    // 4. 调用业务处理函数
    const result = await config.fn({ query, body, req, res, auth });
    
    return res.status(200).json(result);
  };
};
```

### 4.3 Admin API Key 特殊支持

```typescript
// 仅自托管实例可用，云环境禁用
if (env.NEXT_PUBLIC_LANGFUSE_CLOUD_REGION) {
  throw { status: 403, message: "Admin API key auth not available..." };
}

// 双重 Header 校验（防误配置）
// Authorization: Bearer {ADMIN_API_KEY}
// X-Langfuse-Admin-Api-Key: {ADMIN_API_KEY}

// 需指定目标项目 Header
// X-Langfuse-Project-Id: {projectId}

// 返回模拟 scope（绕过真实 API Key 校验）
return {
  validKey: true,
  scope: {
    projectId: projectIdHeader,
    accessLevel: "project",
    orgId: project.orgId,
    plan: "oss",
    rateLimitOverrides: [],
    apiKeyId: "ADMIN_API_KEY",
    publicKey: "ADMIN_API_KEY",
    isIngestionSuspended: false
  }
};
```

---

## 五、鉴权链完整执行路径

### 5.1 Ingestion API（数据摄入）

```
SDK 发送 HTTP POST /api/public/ingestion
    ↓
1. CORS 预检处理
    ↓
2. ApiAuthService.verifyAuthHeaderAndReturnScope
   ├─ Basic/Bearer 解析
   ├─ Redis 缓存查询
   ├─ 数据库 fallback 查询
   └─ 生成 scope (含 projectId/orgId/plan)
    ↓
3. Project ID 存在性校验（组织级 key 拒绝）
    ↓
4. isIngestionSuspended 状态检查
    ↓
5. RateLimitService.rateLimitRequest(scope, "ingestion")
    ↓
6. 请求体 Zod schema 校验 (batch)
    ↓
7. processEventBatch 业务处理
   ├─ 每个 event 单独 scope 校验
   ├─ 异步 S3 上传 + 队列
   └─ 同步 fallback 处理
    ↓
8. 返回 207 Multi-Status 结果
```

### 5.2 普通公共 API（使用路由工厂）

```
SDK 发送 API 请求
    ↓
createAuthedProjectAPIRoute 执行
    ↓
1. verifyAuth 认证（支持普通 API Key + Admin API Key）
   ├─ 尝试 Admin API Key 认证（Header 匹配）
   └─ 降级到普通 API Key 认证
    ↓
2. 限流检查 (默认 "public-api" resource)
    ↓
3. Query/Body Zod 校验
    ↓
4. OpenTelemetry context 注入 (projectId)
    ↓
5. 业务 handler fn 执行
    ↓
6. 开发环境下 response schema 校验
    ↓
7. 返回 HTTP 响应
```

---

## 六、关键安全与性能考量

### 6.1 安全设计

1. **时序安全比较**:
   - Admin API Key 使用 `crypto.timingSafeEqual()` 防时序攻击
   - 普通 API Key 使用 bcrypt 进行哈希比较

2. **失败锁定**:
   - 无效 key 在 Redis 中缓存不存在标记
   - 减少数据库压力，防暴力破解

3. **Scope 最小权限**:
   - Bearer 认证仅授予 `scores` accessLevel
   - 组织级 key 不允许用于 ingestion（需明确项目上下文）

### 6.2 性能优化

1. **分层缓存**:
   - Redis 缓存命中 → 无数据库查询
   - fastHashedSecretKey → SHA256 O(1) 比对 vs bcrypt O(n)

2. **复用度**:
   - 所有入口共用 ApiAuthService 单例逻辑
   - RateLimitService 单例复用限流配置

3. **失败开放 (Fail Open)**:
   - 限流服务异常时记录日志并继续处理
   - 避免限流故障导致整体服务不可用

---

## 七、相关文件索引

| 文件路径 | 说明 |
|---------|------|
| `web/src/features/public-api/server/apiAuth.ts` | 核心 API 认证服务 |
| `web/src/features/public-api/server/createAuthedProjectAPIRoute.ts` | 认证路由工厂 |
| `packages/shared/src/server/auth/types.ts` | Auth Scope 类型定义 |
| `packages/shared/src/server/auth/apiKeys.ts` | API Key 生成/哈希工具 |
| `web/src/pages/api/public/ingestion.ts` | 数据摄入 API |
| `web/src/features/rbac/constants/projectAccessRights.ts` | 项目级 RBAC 权限定义 |
