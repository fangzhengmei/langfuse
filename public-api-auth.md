# Langfuse Public API 完整鉴权链分析

## 一、核心概念：accessLevel 与 membership role 的本质区别

| 维度 | accessLevel（API Key 级别） | membership role（用户级别） |
|-----|----------------------------|---------------------------|
| **作用对象** | API Key（机器身份） | User（人类用户，登录态） |
| **取值范围** | `"organization" \| "project" \| "scores"` | `OWNER \| ADMIN \| MEMBER \| VIEWER \| NONE` |
| **解析来源** | ApiAuthService → 从 API Key 的 scope 字段派生 | Session → 从 organization/project memberships 继承 |
| **判断逻辑** | `PROJECT` scope → `"project"`；`ORGANIZATION` scope → `"organization"`；Bearer Auth → `"scores"` | 项目角色优先，否则继承组织角色；任一为 NONE 则无权限 |
| **Public API 覆盖度** | 所有入口生效 | 极少数入口生效（需额外 session） |

---

## 二、API Key Scope 完整解析链

### 2.1 解析流程图

```
Authorization Header 输入
    ↓
┌─ Basic Auth (username:password base64)
│   ↓
│   1. 解码 → publicKey, secretKey
│   2. 计算 secretKey SHA256 快速哈希
│   3. Redis 缓存查询 (key: api-key:{hash})
│   │   ├─ 命中且为 "api-key-non-existent" → 401（防暴力）
│   │   ├─ 命中且有效 → 直接返回 scope 对象
│   │   └─ 未命中 → 走数据库
│   4. 数据库快速路径 (fastHashedSecretKey)
│   │   └─ 命中 → 写入 Redis → 返回 scope
│   5. 数据库兼容路径 (publicKey + bcrypt)
│   │   ├─ 按 publicKey 查询 API Key
│   │   ├─ bcrypt 验证 secretKey 哈希
│   │   ├─ 更新 fastHashedSecretKey 字段（提速下次）
│   │   └─ 返回 scope
│   ↓
│   accessLevel 判断:
│   ├─ API Key.scope == ORGANIZATION → accessLevel = "organization"
│   └─ API Key.scope == PROJECT → accessLevel = "project"
│
└─ Bearer Auth (仅 publicKey)
    ↓
    1. 按 publicKey 查询 API Key
    2. 仅允许 PROJECT scope（否则 403）
    3. accessLevel 固定 = "scores"
    ↓
最终 Scope 输出: { orgId, projectId|null, accessLevel, plan, rateLimitOverrides, ... }
```

### 2.2 Scope 字段详解

```typescript
{
  validKey: true,
  scope: {
    // 核心鉴权字段
    accessLevel: "organization" | "project" | "scores",
    orgId: string,                          // 总是有值
    projectId: string | null,               // ORGANIZATION scope 为 null
    
    // 附加权限元数据
    plan: Plan,                             // 订阅计划（用于 entitlement 判断）
    rateLimitOverrides: RateLimitConfig[],  // 限流覆盖
    isIngestionSuspended: boolean,          // 摄入暂停状态
    
    // 标识信息
    apiKeyId: string,
    publicKey: string,
  }
}
```

---

## 三、组织角色与项目角色的继承与覆盖优先级

### 3.1 Role 继承体系（仅用户登录态生效）

```
角色优先级（高 → 低）: NONE > OWNER > ADMIN > MEMBER > VIEWER

最终角色解析算法:
├─ 1. 若用户在 Project 上有明确角色 → 使用该 Project Role
│   └─ 若为 NONE → 完全排除，无任何权限
│
├─ 2. 若无明确 Project Role → 继承 Organization Role
│   └─ 若 Organization Role 为 NONE → 完全排除
│
└─ 3. 无论哪一层，任一 level 为 NONE 则该层级下无权限
```

**代码实现** (`packages/shared/src/server/auth/userProjectRoleAuth.ts`):
```typescript
function resolveProjectRole({
  projectId,
  projectMemberships,
  orgMembershipRole,
}): Role {
  return (
    projectMemberships.find((m) => m.projectId === projectId)?.role 
    ?? orgMembershipRole  // 项目角色优先，否则继承组织角色
  );
}
```

### 3.2 角色权限矩阵

#### 组织级别权限 (`organizationRoleAccessRights`)

| Scope | OWNER | ADMIN | MEMBER | VIEWER | NONE |
|-------|-------|-------|--------|--------|------|
| projects:create | ✅ | ✅ | ❌ | ❌ | ❌ |
| projects:transfer_org | ✅ | ✅ | ❌ | ❌ | ❌ |
| organization:CRUD_apiKeys | ✅ | ❌ | ❌ | ❌ | ❌ |
| organization:update | ✅ | ✅ | ❌ | ❌ | ❌ |
| organization:delete | ✅ | ❌ | ❌ | ❌ | ❌ |
| organizationMembers:CUD | ✅ | ✅ | ❌ | ❌ | ❌ |
| organizationMembers:read | ✅ | ✅ | ✅ | ❌ | ❌ |
| langfuseCloudBilling:CRUD | ✅ | ❌ | ❌ | ❌ | ❌ |
| auditLogs:read | ✅ | ✅ | ❌ | ❌ | ❌ |

#### 项目级别权限 (`projectRoleAccessRights`)

| Scope | OWNER | ADMIN | MEMBER | VIEWER | NONE |
|-------|-------|-------|--------|--------|------|
| project:read | ✅ | ✅ | ✅ | ✅ | ❌ |
| project:update | ✅ | ✅ | ❌ | ❌ | ❌ |
| project:delete | ✅ | ❌ | ❌ | ❌ | ❌ |
| projectMembers:CUD | ✅ | ✅ | ❌ | ❌ | ❌ |
| apiKeys:CUD | ✅ | ✅ | ❌ | ❌ | ❌ |
| traces:delete | ✅ | ✅ | ❌ | ❌ | ❌ |
| scores:CUD | ✅ | ✅ | ✅ | ❌ | ❌ |
| datasets:CUD | ✅ | ✅ | ✅ | ❌ | ❌ |
| prompts:CUD | ✅ | ✅ | ✅ | ❌ | ❌ |
| prompts:read | ✅ | ✅ | ✅ | ✅ | ❌ |
| models:CUD | ✅ | ✅ | ❌ | ❌ | ❌ |
| ... | ... | ... | ... | ... | ... |

---

## 四、Public API 各入口的鉴权生效范围

### 4.1 鉴权判断分类说明

| 鉴权类型 | 判断依据 | 说明 |
|---------|---------|------|
| **A: API Key 基础校验** | authCheck.validKey | 所有入口必须通过 |
| **B: accessLevel 匹配** | scope.accessLevel | 绝大多数入口使用 |
| **C: projectId 存在** | scope.projectId != null | 项目级操作需 project scope key |
| **D: 计划 Entitlement** | hasEntitlementBasedOnPlan | 高级功能付费门槛 |
| **E: Membership Role** | hasProjectAccess / hasOrganizationAccess | 极少数入口（需额外登录态） |

### 4.2 各 Public API 入口的鉴权矩阵

| API 路径 | 适用 API Key Scope | accessLevel 要求 | projectId 必须 | Entitlement 要求 | Role 检查 |
|---------|-------------------|-----------------|---------------|-----------------|-----------|
| **/api/public/ingestion** | PROJECT only | project / scores | ✅ | ❌ | ❌ |
| **/api/public/traces** | PROJECT only | project | ✅ | ❌ | ❌ |
| **/api/public/scores** | PROJECT only | project / scores | ✅ | ❌ | ❌ |
| **/api/public/observations** | PROJECT only | project | ✅ | ❌ | ❌ |
| **/api/public/datasets** | PROJECT only | project | ✅ | ❌ | ❌ |
| **/api/public/prompts** | PROJECT only | project | ✅ | ❌ | ❌ |
| **/api/public/sessions** | PROJECT only | project | ✅ | ❌ | ❌ |
| **/api/public/events** | PROJECT only | project | ✅ | ❌ | ❌ |
| **/api/public/models** | PROJECT only | project | ✅ | ❌ | ❌ |
| **/api/public/projects (GET)** | PROJECT only | project | ✅ | ❌ | ❌ |
| **/api/public/projects (POST)** | ORGANIZATION only | organization | ❌ | admin-api | ❌ |
| **/api/public/projects/[id]** | ORGANIZATION only | organization | ❌ | admin-api | ❌ |
| **/api/public/projects/[id]/apiKeys** | ORGANIZATION only | organization | ❌ | admin-api | ❌ |
| **/api/public/projects/[id]/memberships** | ORGANIZATION only | organization | ❌ | admin-api + rbac-project-roles | ❌ |
| **/api/public/organizations/projects** | ORGANIZATION only | organization | ❌ | admin-api | ❌ |
| **/api/public/organizations/apiKeys** | ORGANIZATION only | organization | ❌ | admin-api | ❌ |
| **/api/public/organizations/memberships** | ORGANIZATION only | organization | ❌ | admin-api | ❌ |
| **/api/public/scim/*** | ORGANIZATION only | organization | ❌ | ❌ | ❌ |
| **/api/public/integrations/blob-storage** | PROJECT only | project | ✅ | ❌ | ❌ |
| **/api/public/mcp/*** | PROJECT only | project | ✅ | ❌ | ❌ |
| **/api/public/annotation-queues/[id]/assignments** | PROJECT only | project | ✅ | ❌ | ❌ |
| **/api/public/slack/install** | PROJECT only | project | ✅ | ❌ | ✅ hasProjectAccess |

> **关键结论**：除 `/api/public/slack/install` 外，**所有 Public API 均不检查用户 membership role**，仅依赖 API Key 的 accessLevel 与 scope。Role 检查主要用于 tRPC 后端和 UI 组件。

---

## 五、SDK 多入口复用机制

### 5.1 复用模式一：直接调用 ApiAuthService（轻量）

**适用场景**：单文件、逻辑简单、需自定义校验（如 ingestion）

**调用链示例** (`ingestion.ts`):
```typescript
// 1. API Key 校验
const authCheck = await new ApiAuthService(prisma, redis)
  .verifyAuthHeaderAndReturnScope(req.headers.authorization);

if (!authCheck.validKey) throw new UnauthorizedError();

// 2. 入口特定 accessLevel 检查
if (!authCheck.scope.projectId) {
  throw new UnauthorizedError("Missing projectId");
}

// 3. 入口特定状态检查
if (authCheck.scope.isIngestionSuspended) {
  throw new ForbiddenError("Ingestion suspended");
}

// 4. 限流检查
await RateLimitService.getInstance().rateLimitRequest(
  authCheck.scope, 
  "ingestion"
);

// 5. 业务处理
await processEventBatch(...);
```

### 5.2 复用模式二：createAuthedProjectAPIRoute（工厂封装）

**适用场景**：标准 CRUD、参数校验统一、需 Admin API Key 支持

**工厂封装逻辑** (`createAuthedProjectAPIRoute.ts`):
```typescript
export const createAuthedProjectAPIRoute = (config) => {
  return async (req, res) => {
    // 1. 双重认证支持：Admin API Key 优先，否则普通 API Key
    //    Admin API Key 需同时满足:
    //    - Authorization: Bearer {ADMIN_API_KEY}
    //    - X-Langfuse-Admin-Api-Key: {ADMIN_API_KEY}
    //    - X-Langfuse-Project-Id: {projectId}
    //    - 非 Langfuse Cloud 环境
    const auth = await verifyAuth(req, config.isAdminApiKeyAuthAllowed);

    // 2. 统一限流（默认 "public-api" resource）
    const rateLimit = await RateLimitService.getInstance()
      .rateLimitRequest(auth.scope, config.rateLimitResource);

    // 3. Zod 参数校验
    const query = config.querySchema?.parse(req.query);
    const body = config.bodySchema?.parse(req.body);

    // 4. OpenTelemetry context 注入
    const ctx = contextWithLangfuseProps({
      headers: req.headers,
      projectId: auth.scope.projectId,
    });

    // 5. 执行业务 handler
    return opentelemetry.context.with(ctx, async () => {
      const result = await config.fn({ query, body, req, res, auth });
      return res.status(200).json(result);
    });
  };
};
```

---

## 六、完整鉴权阶段对照表

| 鉴权阶段 | 输入数据 | 输出权限 | 对应代码位置 |
|---------|---------|---------|-------------|
| **阶段 1：API Key 校验** | Authorization Header (Basic/Bearer) | `validKey: boolean`, `error?: string` | `apiAuth.ts:verifyAuthHeaderAndReturnScope()` |
| **阶段 2：Redis 缓存** | secretKey SHA256 哈希 | 缓存命中 → 直接返回 scope；否则查 DB | `apiAuth.ts:fetchApiKeyFromRedis()` |
| **阶段 3：数据库查询** | publicKey / fastHashedSecretKey | API Key 记录 + 关联的 Project/Organization | `apiAuth.ts:findDbKeyOrThrow()` |
| **阶段 4：Org 信息提取** | API Key → Project → Organization | `orgId`, `plan`, `rateLimitOverrides`, `isIngestionSuspended` | `apiAuth.ts:extractOrgIdAndCloudConfig()` |
| **阶段 5：accessLevel 派生** | API Key.scope 字段 + Auth 方式 | `"organization" \| "project" \| "scores"` | `apiAuth.ts` L181-182, L224 |
| **阶段 6：入口 accessLevel 匹配** | `scope.accessLevel` 与入口要求比较 | 403 或继续 | 各 API route 文件 |
| **阶段 7：projectId 存在校验** | `scope.projectId != null` | 401 或继续（仅项目级入口） | 如 `ingestion.ts:84-88` |
| **阶段 8：计划 Entitlement 校验** | `scope.plan` + entitlement 名称 | 403 或继续（仅付费功能） | `hasEntitlementBasedOnPlan()` |
| **阶段 9：限流检查** | `scope.rateLimitOverrides` + resource | 429 或继续 | `RateLimitService.rateLimitRequest()` |
| **阶段 10：Membership Role 检查** | （仅极少数入口）Session user + projectId | 403 或继续 | `checkProjectAccess.ts:hasProjectAccess()` |

---

## 七、关键设计决策

### 7.1 为什么 Public API 不检查 Membership Role？

1. **身份不一致**：API Key 是机器身份，不绑定到特定用户，无 membership 概念
2. **性能优先**：Ingestion QPS 高，Redis 缓存即可，无需额外数据库查询
3. **权限模型简化**：API Key 本身已代表授权，无需叠加用户角色判断
4. **灵活性**：Organization API Key 可跨项目操作，角色继承模型不适用

### 7.2 Redis 缓存的 NONE 标记意义

- **防暴力破解**：无效 key 也缓存为 `"api-key-non-existent"`，避免重复查库
- **TTL 过期**：缓存过期后才会重新查询数据库，允许无效 key 变有效（如重新创建）
- **命中率**：实际生产环境中 >99% 的 API Key 验证走 Redis

### 7.3 Organization vs Project API Key 的权限边界

| 维度 | Organization API Key | Project API Key |
|-----|---------------------|----------------|
| projectId 字段 | `null` | 有具体值 |
| 数据摄入 | ❌ 拒绝 | ✅ 允许 |
| 跨项目操作 | ✅ 允许 | ❌ 仅所属项目 |
| 组织管理 API | ✅ 允许 | ❌ 拒绝 |
| Bearer Auth 支持 | ❌ 拒绝 | ✅ 仅 scores accessLevel |

---

## 八、相关文件索引

| 文件路径 | 核心职责 |
|---------|---------|
| `web/src/features/public-api/server/apiAuth.ts` | API Key 校验 + scope 生成 |
| `web/src/features/public-api/server/createAuthedProjectAPIRoute.ts` | 路由工厂封装 + Admin API Key 支持 |
| `packages/shared/src/server/auth/types.ts` | Auth Scope 类型定义 |
| `packages/shared/src/server/auth/userProjectRoleAuth.ts` | 项目/组织角色继承解析 |
| `web/src/features/rbac/utils/checkProjectAccess.ts` | 项目级 Role 权限判断（仅 session） |
| `web/src/features/rbac/utils/checkOrganizationAccess.ts` | 组织级 Role 权限判断（仅 session） |
| `web/src/features/rbac/constants/projectAccessRights.ts` | 项目角色权限矩阵 |
| `web/src/features/rbac/constants/organizationAccessRights.ts` | 组织角色权限矩阵 |
| `web/src/pages/api/public/ingestion.ts` | 数据摄入 API（直接调用 ApiAuthService） |
| `web/src/features/entitlements/server/hasEntitlement.ts` | 计划 entitlement 判断 |
