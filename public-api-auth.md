# Langfuse Public API 鉴权链分析报告

---

## 一、核心概念对比：accessLevel 与 membership role

| 维度 | accessLevel（API Key 级别） | membership role（用户级别） |
|-----|----------------------------|---------------------------|
| **作用对象** | API Key（机器身份，由 ApiAuthService 解析） | User（人类用户，登录态 Session） |
| **取值范围** | `"organization"` \| `"project"` \| `"scores"` | `OWNER` \| `ADMIN` \| `MEMBER` \| `VIEWER` \| `NONE` |
| **派生逻辑** | 见「Scope 解析链」章节 | 见「成员角色解析」章节 |
| **Public API 覆盖范围** | 绝大多数入口生效 | 仅浏览器交互入口生效（如 Slack OAuth） |

---

## 二、API Key Scope 完整解析链

### 2.1 Basic Auth 解析流程（5 步）

**源码位置**: `web/src/features/public-api/server/apiAuth.ts`

```
Authorization: Basic base64(publicKey:secretKey)
    ↓
1. Header 解码，提取 publicKey 和 secretKey
    ↓
2. secretKey 加盐 SHA256 哈希（用于 Redis 快速查找）
    ↓
3. Redis 缓存查询
   ├─ 命中且值为 "api-key-non-existent" → 返回无效 key
   ├─ 命中且为有效 Scope 对象 → 直接返回
   └─ 未命中 → 进入数据库查询
    ↓
4. 数据库查询（两条路径）
   ├─ 路径 A：fastHashedSecretKey 匹配 → 写入 Redis → 返回 Scope
   └─ 路径 B：publicKey 匹配 + bcrypt 验证 secretKey → 更新 fastHashedSecretKey → 写入 Redis
    ↓
5. accessLevel 派生
   ├─ 若 API Key.scope = ORGANIZATION → accessLevel = "organization"
   └─ 若 API Key.scope = PROJECT → accessLevel = "project"
```

**代码证据**:
- SHA256 哈希计算: `apiAuth.ts:106-107`
- Redis 查询: `apiAuth.ts:290-303`
- 数据库快速路径: `apiAuth.ts:308-323`
- 数据库兼容路径: `apiAuth.ts:116-160`
- accessLevel 派生: `apiAuth.ts:181-182`

### 2.2 Bearer Auth 解析流程（3 步）

```
Authorization: Bearer {publicKey}
    ↓
1. 按 publicKey 从数据库查询 API Key
    ↓
2. Scope 校验：仅允许 PROJECT scope（ORGANIZATION scope 抛出错误）
    ↓
3. accessLevel 固定赋值为 "scores"
```

**代码证据**:
- Bearer 分支: `apiAuth.ts:200-234`
- accessLevel 固定值: `apiAuth.ts:224`

### 2.3 Scope 输出结构

```typescript
{
  validKey: boolean;
  scope: {
    projectId: string | null;        // PROJECT scope 有值，ORGANIZATION scope 为 null
    accessLevel: string;              // "organization" | "project" | "scores"
    orgId: string;                    // 总是有值，从 Project.organization 或 Organization 提取
    plan: string;                     // 从组织配置提取
    rateLimitOverrides: any[];        // 从组织配置提取
    apiKeyId: string;                 // API Key ID
    publicKey: string;                // API Key publicKey
    isIngestionSuspended: boolean;    // 摄入暂停状态
  }
}
```

**代码证据**: `apiAuth.ts:42-196`, `types.ts:40-76`

---

## 三、成员角色解析

### 3.1 Project Role 解析算法

**源码位置**: `packages/shared/src/server/auth/userProjectRoleAuth.ts:6-19`

```typescript
function resolveProjectRole({
  projectId,
  projectMemberships,
  orgMembershipRole,
}): Role {
  return (
    projectMemberships.find((membership) => membership.projectId === projectId)
      ?.role ?? orgMembershipRole
  );
}
```

**解析逻辑**:
1. 遍历 `projectMemberships`，查找匹配 `projectId` 的记录
2. 若找到 → 使用该记录的 `role` 字段
3. 若未找到 → 回退使用 `orgMembershipRole`
4. 无额外优先级排序逻辑，完全依赖数组查找顺序

### 3.2 NONE 语义实现

**源码位置**: `packages/shared/src/server/auth/userProjectRoleAuth.ts:66-88`

```sql
WITH all_eligible_users AS (
  -- 组织成员且无项目角色，继承组织角色
  SELECT u.id, om.role as role
  FROM organization_memberships om
  INNER JOIN users u ON om.user_id = u.id
  WHERE om.org_id = ${orgId}
    AND om.role != 'NONE'        -- 排除组织角色为 NONE
    AND NOT EXISTS (
      SELECT 1 FROM project_memberships pm 
      WHERE pm.org_membership_id = om.id
    )
  
  UNION
  
  -- 有明确项目角色，使用项目角色
  SELECT u.id, pm.role as role
  FROM organization_memberships om
  INNER JOIN project_memberships pm ON om.id = pm.org_membership_id
  INNER JOIN users u ON om.user_id = u.id
  WHERE om.org_id = ${orgId}
    AND pm.project_id = ${projectId}
    AND pm.role != 'NONE'        -- 排除项目角色为 NONE
)
```

**NONE 语义**:
- `om.role != 'NONE'`: 过滤掉组织层面无权限的成员
- `pm.role != 'NONE'`: 过滤掉项目层面无权限的成员
- 两层独立过滤，无层级优先级关系

**代码证据**:
- SQL NONE 过滤: `userProjectRoleAuth.ts:72, 86`
- UNION 查询结构: `userProjectRoleAuth.ts:67-88`

### 3.3 角色权限矩阵定义

**组织级别权限** (`organizationAccessRights.ts`):
```typescript
organizationRoleAccessRights: Record<Role, OrganizationScope[]> = {
  OWNER: ["projects:create", "projects:transfer_org", "organization:CRUD_apiKeys", ...],
  ADMIN: ["projects:create", "projects:transfer_org", "organizationMembers:CUD", ...],
  MEMBER: ["organizationMembers:read"],
  VIEWER: [],
  NONE: []
}
```

**项目级别权限** (`projectAccessRights.ts`):
```typescript
projectRoleAccessRights: Record<Role, ProjectScope[]> = {
  OWNER: ["project:update", "projectMembers:CUD", "apiKeys:CUD", ...],
  ADMIN: ["project:update", "projectMembers:CUD", "apiKeys:CUD", ...],
  MEMBER: ["project:read", "scores:CUD", "datasets:CUD", ...],
  VIEWER: ["project:read", "prompts:read", ...],
  NONE: []
}
```

---

## 四、Public API 入口鉴权矩阵

### 4.1 鉴权类型定义

| 类型 | 标识符 | 判断依据 |
|-----|-------|---------|
| A | API Key 基础校验 | `new ApiAuthService().verifyAuthHeaderAndReturnScope()` |
| B | accessLevel 匹配 | `scope.accessLevel` 与入口要求比较 |
| C | projectId 存在校验 | `scope.projectId != null` |
| D | 计划 Entitlement 校验 | `hasEntitlementBasedOnPlan()` |
| E | Membership Role 校验 | `hasProjectAccess()` / `hasOrganizationAccess()` + Session |

### 4.2 完整入口矩阵

| API 路径 | 适用 API Key Scope | accessLevel 要求 | projectId 必须 | Entitlement 要求 | 检查 Membership Role | 实现依据 |
|---------|-------------------|-----------------|---------------|-----------------|---------------------|---------|
| **/api/public/ingestion** | PROJECT only | project / scores | ✅ | ❌ | ❌ | `ingestion.ts:76-88`，直接调用 ApiAuthService，无 hasProjectAccess |
| **/api/public/traces** | PROJECT only | project | ✅ | ❌ | ❌ | `traces/index.ts:36`，使用 createAuthedProjectAPIRoute，无 Session |
| **/api/public/scores** | PROJECT only | project / scores | ✅ | ❌ | ❌ | `scores/index.ts`，使用 createAuthedProjectAPIRoute，无 Session |
| **/api/public/observations** | PROJECT only | project | ✅ | ❌ | ❌ | `observations/index.ts`，使用 createAuthedProjectAPIRoute，无 Session |
| **/api/public/datasets** | PROJECT only | project | ✅ | ❌ | ❌ | `datasets.ts`，使用 createAuthedProjectAPIRoute，无 Session |
| **/api/public/prompts** | PROJECT only | project | ✅ | ❌ | ❌ | `prompts.ts`，使用 createAuthedProjectAPIRoute，无 Session |
| **/api/public/sessions** | PROJECT only | project | ✅ | ❌ | ❌ | `sessions/index.ts:10`，使用 createAuthedProjectAPIRoute，无 Session |
| **/api/public/events** | PROJECT only | project | ✅ | ❌ | ❌ | `events.ts`，使用 createAuthedProjectAPIRoute，无 Session |
| **/api/public/models** | PROJECT only | project | ✅ | ❌ | ❌ | `models/index.ts`，使用 createAuthedProjectAPIRoute，无 Session |
| **/api/public/projects (GET)** | PROJECT only | project | ✅ | ❌ | ❌ | `projects/index.ts`，使用 ApiAuthService，无 Session |
| **/api/public/projects (POST)** | ORGANIZATION only | organization | ❌ | admin-api | ❌ | `projects/index.ts`，使用 ApiAuthService + hasEntitlement，无 Session |
| **/api/public/projects/[id]** | ORGANIZATION only | organization | ❌ | admin-api | ❌ | `projects/[projectId]/index.ts`，使用 ApiAuthService + hasEntitlement，无 Session |
| **/api/public/projects/[id]/apiKeys** | ORGANIZATION only | organization | ❌ | admin-api | ❌ | `projects/[projectId]/apiKeys/index.ts`，使用 ApiAuthService + hasEntitlement，无 Session |
| **/api/public/projects/[id]/memberships** | ORGANIZATION only | organization | ❌ | admin-api + rbac-project-roles | ❌ | `projects/[projectId]/memberships/index.ts`，使用 ApiAuthService + hasEntitlement，无 Session |
| **/api/public/organizations/projects** | ORGANIZATION only | organization | ❌ | admin-api | ❌ | `organizations/projects/index.ts`，使用 ApiAuthService + hasEntitlement，无 Session |
| **/api/public/organizations/apiKeys** | ORGANIZATION only | organization | ❌ | admin-api | ❌ | `organizations/apiKeys/index.ts`，使用 ApiAuthService + hasEntitlement，无 Session |
| **/api/public/organizations/memberships** | ORGANIZATION only | organization | ❌ | admin-api | ❌ | `organizations/memberships/index.ts`，使用 ApiAuthService + hasEntitlement，无 Session |
| **/api/public/scim/*** | ORGANIZATION only | organization | ❌ | ❌ | ❌ | `scim/*`，使用 ApiAuthService，无 Session |
| **/api/public/integrations/blob-storage** | PROJECT only | project | ✅ | ❌ | ❌ | `integrations/blob-storage/index.ts`，使用 ApiAuthService，无 Session |
| **/api/public/mcp/*** | PROJECT only | project | ✅ | ❌ | ❌ | `mcp/index.ts`，使用 ApiAuthService，无 Session |
| **/api/public/annotation-queues/*** | PROJECT only | project | ✅ | ❌ | ❌ | `annotation-queues/*`，使用 ApiAuthService 或 createAuthedProjectAPIRoute，无 Session |
| **/api/public/v2/*** | PROJECT only | project | ✅ | ❌ | ❌ | `v2/*`，使用 createAuthedProjectAPIRoute，无 Session |
| **/api/public/unstable/*** | PROJECT only | project | ✅ | ❌ | ❌ | `unstable/*`，使用 createAuthedProjectAPIRoute，无 Session |
| **/api/public/slack/install** | 不适用 API Key | - | - | ❌ | ✅ | `slack/install/index.ts:27-47`，使用 getServerAuthSession + hasProjectAccess，无 API Key 校验 |
| **/api/public/slack/oauth** | 不适用 API Key | - | - | ❌ | ❌ | `slack/oauth/index.ts`，纯 OAuth 回调处理，无认证 |
| **/api/public/health** | 不适用 | - | - | ❌ | ❌ | `health.ts`，无任何认证检查 |
| **/api/public/ready** | 不适用 | - | - | ❌ | ❌ | `ready.ts`，无任何认证检查 |

---

## 五、SDK 多入口复用机制

### 5.1 复用模式一：直接调用 ApiAuthService

**适用场景**: 需自定义校验逻辑（如 ingestion 的 isIngestionSuspended 检查）

**调用模板**:
```typescript
// Step 1: API Key 校验
const authCheck = await new ApiAuthService(prisma, redis)
  .verifyAuthHeaderAndReturnScope(req.headers.authorization);

if (!authCheck.validKey) {
  return res.status(401).json({ error: authCheck.error });
}

// Step 2: 入口特定校验
if (!authCheck.scope.projectId) { /* 403 */ }
if (authCheck.scope.isIngestionSuspended) { /* 403 */ }

// Step 3: 限流检查（可选）
await RateLimitService.getInstance().rateLimitRequest(
  authCheck.scope, "ingestion"
);

// Step 4: 业务处理
```

**使用此模式的入口**:
- `/api/public/ingestion` - `ingestion.ts:75-138`
- 所有 `/api/public/scim/*` 端点
- 所有 organization-level API 端点

**代码证据**: `ingestion.ts:75-94`, `apiAuth.ts:86-261`

### 5.2 复用模式二：createAuthedProjectAPIRoute 工厂封装

**适用场景**: 标准 CRUD 接口，需统一参数校验、限流、错误处理

**工厂内部流程**:
```typescript
export const createAuthedProjectAPIRoute = (config) => {
  return async (req, res) => {
    // 1. 认证：支持 Admin API Key 或普通 API Key
    const auth = await verifyAuth(req, config.isAdminApiKeyAuthAllowed);
    
    // 2. 统一限流检查（默认为 "public-api" resource）
    const rateLimit = await RateLimitService.getInstance()
      .rateLimitRequest(auth.scope, config.rateLimitResource);
    
    // 3. Zod 参数校验（query + body）
    const query = config.querySchema?.parse(req.query);
    const body = config.bodySchema?.parse(req.body);
    
    // 4. OpenTelemetry context 注入
    const ctx = contextWithLangfuseProps({ headers: req.headers, projectId: auth.scope.projectId });
    
    // 5. 执行业务 handler
    return opentelemetry.context.with(ctx, async () => {
      const result = await config.fn({ query, body, req, res, auth });
      return res.status(200).json(result);
    });
  };
};
```

**Admin API Key 认证逻辑**（仅自托管）:
```typescript
// 双重 Header 校验：Authorization + x-langfuse-admin-api-key
// 均需与 env.ADMIN_API_KEY 时序安全比较
crypto.timingSafeEqual(Buffer.from(token), Buffer.from(env.ADMIN_API_KEY));

// 需指定 x-langfuse-project-id Header，注入到 auth.scope.projectId
```

**使用此模式的入口**:
- 所有 v1/v2 Project CRUD 接口（traces, scores, observations, datasets, prompts 等）
- 所有 unstable eval API 接口

**代码证据**:
- 工厂封装: `createAuthedProjectAPIRoute.ts:270-403`
- Admin API Key 认证: `createAuthedProjectAPIRoute.ts:142-228`
- verifyAuth 函数: `createAuthedProjectAPIRoute.ts:243-268`

---

## 六、结论与代码依据汇总

### 6.1 accessLevel 结论

| 结论 | 源码位置 |
|-----|---------|
| Basic Auth 下，PROJECT scope → accessLevel = "project" | `apiAuth.ts:181-182` |
| Basic Auth 下，ORGANIZATION scope → accessLevel = "organization" | `apiAuth.ts:181-182` |
| Bearer Auth 下，accessLevel 固定为 "scores"，且仅允许 PROJECT scope | `apiAuth.ts:200-234` |
| ORGANIZATION scope key 的 scope.projectId 始终为 null | `types.ts:22-30` |

### 6.2 Scope 解析链结论

| 结论 | 源码位置 |
|-----|---------|
| Redis 缓存 key 为 secretKey 的 SHA256 哈希（加盐） | `apiAuth.ts:106-107, 290` |
| 无效 key 会被缓存为 "api-key-non-existent"，避免重复查库 | `apiAuth.ts:124-135, types.ts:33` |
| 兼容路径会更新 fastHashedSecretKey 字段，提速下次验证 | `apiAuth.ts:149-160` |
| orgId 从 API Key 关联的 Project.organization 或 Organization 提取 | `apiAuth.ts:413-429` |

### 6.3 SDK 多入口复用结论

| 结论 | 源码位置 |
|-----|---------|
| createAuthedProjectAPIRoute 内置 API Key 认证、限流、参数校验、错误处理 | `createAuthedProjectAPIRoute.ts:270-403` |
| Admin API Key 认证需同时匹配 Authorization 和 x-langfuse-admin-api-key Header | `createAuthedProjectAPIRoute.ts:178-193` |
| Admin API Key 认证仅在非 CLOUD 环境可用 | `createAuthedProjectAPIRoute.ts:156-161` |
| withMiddlewares 提供统一的异常处理和 CORS 支持 | `withMiddlewares.ts:65-186` |

### 6.4 成员角色链路结论

| 结论 | 源码位置 |
|-----|---------|
| 仅 `/api/public/slack/install` 使用 membership role 校验，其余 Public API 均不检查 | `slack/install/index.ts:27-48` |
| Slack install 使用 NextAuth Session 而非 API Key 认证 | `slack/install/index.ts:27-31` |
| Slack oauth 回调完全无认证检查 | `slack/oauth/index.ts:6-27` |
| hasProjectAccess 需传入 session 才能生效 | `checkProjectAccess.ts:56-67` |
| resolveProjectRole 使用 nullish coalescing 实现 fallback，无额外优先级排序 | `userProjectRoleAuth.ts:15-18` |
| SQL 查询通过两层 `role != 'NONE'` 过滤无权限用户，无层级继承优先级 | `userProjectRoleAuth.ts:72, 86` |

---

## 七、核心文件索引

| 文件路径 | 核心职责 |
|---------|---------|
| `web/src/features/public-api/server/apiAuth.ts` | API Key 校验 + Scope 生成 |
| `web/src/features/public-api/server/createAuthedProjectAPIRoute.ts` | 路由工厂封装 + Admin API Key 支持 |
| `web/src/features/public-api/server/withMiddlewares.ts` | 统一异常处理 + CORS |
| `packages/shared/src/server/auth/types.ts` | Auth Scope 类型 + API_KEY_NON_EXISTENT 常量 |
| `packages/shared/src/server/auth/apiKeys.ts` | API Key 生成 + bcrypt 哈希 |
| `packages/shared/src/server/auth/userProjectRoleAuth.ts` | 项目/组织角色 SQL 查询 + resolveProjectRole |
| `web/src/features/rbac/utils/checkProjectAccess.ts` | hasProjectAccess 工具函数（仅 Session） |
| `web/src/features/rbac/utils/checkOrganizationAccess.ts` | hasOrganizationAccess 工具函数（仅 Session） |
| `web/src/features/rbac/constants/organizationAccessRights.ts` | 组织角色权限矩阵 |
| `web/src/features/rbac/constants/projectAccessRights.ts` | 项目角色权限矩阵 |
| `web/src/pages/api/public/ingestion.ts` | 数据摄入 API（模式一范例） |
| `web/src/pages/api/public/sessions/index.ts` | 标准 CRUD API（模式二范例） |
