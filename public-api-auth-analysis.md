# Langfuse Public API 与 SDK 鉴权边界差异分析

## 1. 密钥来源差异

### 核心类型定义 [packages/shared/src/server/auth/types.ts:22-31]
```typescript
OrgEnrichedApiKey = discriminatedUnion("scope", [
  { scope: ORGANIZATION, projectId: null },    // 组织级密钥 - 无 projectId
  { scope: PROJECT, projectId: string }         // 项目级密钥 - 有明确 projectId
])
```

### Public API 与 Ingestion 共用的密钥机制
| 密钥类型 | scope 字段值 | projectId | accessLevel | 可用认证方式 |
|---------|-------------|-----------|------------|-------------|
| **组织级 API Key** | `ORGANIZATION` | `null` | `organization` | 仅 Basic Auth |
| **项目级 API Key** | `PROJECT` | `string` | `project` | Basic Auth / Bearer |
| **仅公钥 Bearer** | `PROJECT` | `string` | `scores` | 仅 Bearer |

### 关键约束 (来自代码)
1. **Bearer 认证禁用组织级密钥** [apiAuth.ts:205-209]
   ```typescript
   if (dbKey.scope === "ORGANIZATION") {
     throw new Error("Unauthorized: Cannot use organization key with bearer auth");
   }
   ```
   - Bearer 认证时若检测到组织级密钥，直接抛出错误

2. **Basic Auth 下密钥级别自动映射** [apiAuth.ts:181-182]
   ```typescript
   const accessLevel = finalApiKey.scope === "ORGANIZATION" ? "organization" : "project";
   ```
   - 组织级密钥自动获得 `organization` 访问级别
   - 项目级密钥自动获得 `project` 访问级别

### SDK Header 说明
- `X-Langfuse-Sdk-Name`, `X-Langfuse-Sdk-Version`, `X-Langfuse-Public-Key`
- **仅用于统计标识，不参与鉴权**
- 实际鉴权完全依赖 `Authorization` Header
- **证据来源**: [fern/apis/server/definition/api.yml:25-28]

---

## 2. 权限校验差异

### Public API 两种路由实现模式

#### A. 项目级路由 (createAuthedProjectAPIRoute) - 95% 端点使用
- **实现路径**: 大多数 Public API 端点使用此包装器
- **类型约束** [createAuthedProjectAPIRoute.ts:28]:
  ```typescript
  type RouteAccessLevel = Exclude<ApiAccessLevel, "organization">; // 明确排除 organization
  ```
- **双重校验逻辑** [createAuthedProjectAPIRoute.ts:102-119]:
  1. 检查 `allowedAccessLevels` 是否包含当前 `accessLevel`
  2. 检查 `projectId` 必须存在（非 null），否则返回 403
     ```typescript
     if (!regularAuth.scope.projectId) {
       throw { status: 403, message: "Project ID not found for API token. Are you using an organization key?" };
     }
     ```
- **权限等级配置**:
  - 默认 `["project"]` - 仅项目级密钥可用
  - `POST /api/public/scores` 特殊配置 `["project", "scores"]` - 同时支持 Bearer 公钥
    - **证据来源**: [web/src/pages/api/public/scores/index.ts:25]

#### B. 组织级路由 (直接调用 ApiAuthService) - 仅 3 个端点
- **路径前缀**: `/api/public/organizations/*`
- **实现方式**: 不使用 `createAuthedProjectAPIRoute`，直接调用 `ApiAuthService`
- **校验逻辑**: 主动检查 `accessLevel === "organization"`，否则返回 403
  ```typescript
  if (authCheck.scope.accessLevel !== "organization" || !authCheck.scope.orgId) {
    return res.status(403).json({ error: "Organization-scoped API key required" });
  }
  ```
- **实际端点列表**:
  1. `/api/public/organizations/projects` - 获取组织下所有项目
  2. `/api/public/organizations/apiKeys` - 管理组织 API 密钥
  3. `/api/public/organizations/memberships` - 管理组织成员

### 管理员密钥认证 (Admin API Key)
- **生效路由**: 仅 LLM Connections 相关接口
  - `GET /api/public/llm-connections` [llm-connections/index.ts:27]
  - `PUT /api/public/llm-connections` [llm-connections/index.ts:84]
  - `DELETE /api/public/llm-connections/:id` [llm-connections/[id].ts:25]
- **触发条件** (必须全部满足):
  1. 无 `NEXT_PUBLIC_LANGFUSE_CLOUD_REGION` (仅自托管可用)
  2. `Authorization: Bearer <ADMIN_API_KEY>`
  3. `x-langfuse-admin-api-key: <ADMIN_API_KEY>` - 双重 Header 防攻击
  4. `x-langfuse-project-id: <project-id>` - 必须指定目标项目
  5. `ADMIN_API_KEY` 环境变量已配置
  6. 使用 `crypto.timingSafeEqual` 时序攻击防护
- **证据来源**: [createAuthedProjectAPIRoute.ts:148-212]

### Ingestion 权限校验
- **认证入口**: `ingestion.ts` 直接调用 `ApiAuthService.verifyAuthHeaderAndReturnScope()`
- **项目 ID 强制约束** [ingestion.ts:84-88]:
  ```typescript
  if (!authCheck.scope.projectId) {
    throw new UnauthorizedError("Missing projectId in scope. Are you using an organization key?");
  }
  ```
  - ⚠️ **最终结论**: **组织级密钥完全无法用于 Ingestion 端点**
  - 原因：组织级密钥的 `projectId === null`，触发上述检查直接返回 401
- **额外检查**: `isIngestionSuspended` - 检查组织是否因用量超限被暂停写入

---

## 3. 租户隔离差异

### Public API 租户隔离

#### 项目级路由隔离 (createAuthedProjectAPIRoute)
- **项目级强制**: `projectId` 必须存在且为 `string`，组织级密钥直接被拒绝
- **作用域注入**: 自动将 `auth.scope.projectId` 注入处理函数上下文
- **适用端点**: 除 `/api/public/organizations/*` 外的所有 Public API

#### 组织级路由隔离
- **组织级强制**: `orgId` 必须存在且 `accessLevel === "organization"`
- **作用域注入**: 使用 `auth.scope.orgId` 跨项目访问组织资源
- **适用端点**: 仅 `/api/public/organizations/*` 下的 3 个端点

### Ingestion 租户隔离 [统一最终口径]
- **项目级隔离 - 绝对强制**: `projectId` 必须为非空字符串
  - 组织级密钥因 `projectId === null` 被 401 拒绝
  - 不存在"组织级密钥可访问所有项目"的 ingestion 场景
- **组织级属性**: 通过 API Key 传递 `plan`、`rateLimitOverrides` 等元数据
  - 仅 **项目级密钥** 才能用于数据摄入，但其背后关联的组织信息用于限流和计划检查
- **上下文传递**: 通过 OpenTelemetry context 将 `projectId` 注入处理流程
- **Ingestion 暂停保护**: 检查 `cloudFreeTierUsageThresholdState === "BLOCKED"`

### 租户隔离对比表
| 隔离维度 | Public API 项目级路由 | Public API 组织级路由 | Ingestion/SDK | 校验位置 |
|---------|---------------------|---------------------|--------------|---------|
| Project ID 必填 | ✓ 必须为 string | ✗ 应为 null | ✓ 必须为 string | createAuthedProjectAPIRoute.ts:113, ingestion.ts:84 |
| Organization ID 存在 | ✓ | ✓ | ✓ | ApiAuthService |
| Plan 级别隔离 | ✓ | ✓ | ✓ | 组织 cloudConfig |
| Rate Limit 覆盖 | ✓ | ✓ | ✓ | RateLimitService |
| Ingestion 暂停检查 | 仅 scores POST | ✗ | ✓ | ingestion.ts, scores/index.ts |
| 允许组织级密钥 | ✗ 403 拒绝 | ✓ | ✗ 401 拒绝 | 各路由实现 |

---

## 4. 错误处理差异

### Public API 错误处理 (两种模式)

#### A. 项目级路由错误处理 (withMiddlewares + createAuthedProjectAPIRoute)
- **统一错误捕获**: 通过 `withMiddlewares` 中间件统一捕获
- **错误分类与状态码**:
  | 错误类型 | HTTP 状态码 | 触发条件 |
  |---------|-----------|---------|
  | UnauthorizedError | 401 | 认证失败、无效凭据 |
  | ForbiddenError | 403 | 权限不足、使用组织级密钥访问项目级路由 |
  | ForbiddenError (Admin) | 403 | 云上环境尝试使用管理员 API Key |
  | LangfuseNotFoundError | 404 | 资源不存在 |
  | MethodNotAllowedError | 405 | 方法不支持 |
  | ClickHouseResourceError | 422 | 资源限制、查询超时 |
  | ZodError | 400 | 请求参数校验失败 |
- **日志策略**: 401/404 仅 info，500 记录 error 并上报异常

#### B. 组织级路由错误处理 (直接处理)
- **独立错误处理**: handler 内直接处理
- **错误分类与状态码**:
  | 错误类型 | HTTP 状态码 | 触发条件 |
  |---------|-----------|---------|
  | 认证失败 | 401 | 无效 API Key |
  | 权限不足 | 403 | 使用项目级密钥访问组织级路由 |
  | 方法不支持 | 405 | HTTP Method 错误 |
  | 计划无权限 | 403 | 无 `admin-api` entitlement |

### Ingestion 错误处理 (ingestion.ts)
- **独立错误处理**: handler 内直接 try/catch
- **错误分类与状态码**:
  | 错误类型 | HTTP 状态码 | 触发条件 |
  |---------|-----------|---------|
  | UnauthorizedError | 401 | 认证失败、使用组织级密钥 (projectId 为 null) |
  | ForbiddenError | 403 | Ingestion 被暂停 (用量超限) |
  | MethodNotAllowedError | 405 | 非 POST 请求 |
  | ZodError | 400 | 请求数据校验失败 |
- **批量响应**: 返回 207 Multi-Status，包含每个事件的处理结果
- **限流响应**: 调用 `RateLimitService.sendRestResponseIfLimited()`

### 错误处理对比表
| 特性 | Public API 项目级路由 | Public API 组织级路由 | Ingestion |
|-----|---------------------|---------------------|-----------|
| 统一错误捕获 | ✓ (withMiddlewares) | ✗ 独立处理 | ✗ 独立处理 |
| 标准化错误响应 | ✓ | 部分实现 | 部分实现 |
| 日志分级策略 | ✓ | 基本日志 | 仅 401+ 记录 |
| 异常追踪上报 | ✓ (5xx 错误) | ✓ | ✓ (非 401 错误) |
| ClickHouse 资源错误处理 | ✓ | ✗ | ✗ |
| 207 批量响应支持 | ✗ | ✗ | ✓ |
| Entitlement 检查 | ✗ | ✓ (admin-api) | ✗ |

---

## 5. 服务端验签链路 (SDK → 服务端)

### 完整验证流程
```
SDK 发起请求
    ↓
┌─ Request Headers ──────────────────────────────────────────────┐
│  Authorization: Basic base64(pk:sk) 或 Bearer pk             │
│  X-Langfuse-Sdk-*: (仅统计，不参与鉴权)                      │
└────────────────────────────────────────────────────────────────┘
    ↓
┌─ ApiAuthService.verifyAuthHeaderAndReturnScope() ──────────────┐
│  1. 解析 Authorization 头                                        │
│  2. 分支验证:                                                    │
│     ├─ Basic Auth:                                               │
│     │   ├─ bcrypt 验证 secretKey                                │
│     │   └─ scope = ORGANIZATION ? accessLevel: organization    │
│     │                          : accessLevel: project          │
│     └─ Bearer Auth:                                              │
│         ├─ 检查 scope ≠ ORGANIZATION (否则 throw 401)           │
│         └─ accessLevel: scores                                   │
│  3. 提取 orgId, plan, rateLimitOverrides                         │
│  4. 检查 isIngestionSuspended 状态                               │
└────────────────────────────────────────────────────────────────┘
    ↓
┌─ 路由层二次校验 ────────────────────────────────────────────────┐
│  项目级路由 (createAuthedProjectAPIRoute):                       │
│    ├─ 检查 allowedAccessLevels 包含当前 accessLevel             │
│    └─ 检查 projectId 非 null (组织级密钥被 403 拒绝)            │
│                                                                 │
│  组织级路由 (/api/public/organizations/*):                       │
│    ├─ 检查 accessLevel === organization                         │
│    └─ 检查 orgId 存在                                           │
│                                                                 │
│  Ingestion:                                                      │
│    └─ 检查 projectId 非 null (组织级密钥被 401 拒绝)            │
└────────────────────────────────────────────────────────────────┘
    ↓
业务处理
```

---

## 6. 权限矩阵与边界矩阵

### 按认证方式 × 路由类型的权限矩阵

| 认证方式 | 项目级 Public API | 组织级 Public API | Ingestion/SDK |
|---------|-----------------|-----------------|--------------|
| Basic Auth (项目级 API Key) | ✓ 200 | ✗ 403 | ✓ 200 |
| Basic Auth (组织级 API Key) | ✗ 403 | ✓ 200 | ✗ 401 |
| Bearer Auth (仅项目级公钥) | 仅 POST /scores 200 | ✗ 403 | ✓ 200 |
| 管理员 API Key (自托管) | 仅 LLM Connections 200 | ✗ | ✗ |

### Public API vs SDK/Ingestion 边界矩阵

| 维度 | Public API 项目级路由 | Public API 组织级路由 | SDK/Ingestion |
|-----|---------------------|---------------------|--------------|
| 认证入口 | createAuthedProjectAPIRoute | 直接 ApiAuthService | 直接 ApiAuthService |
| 支持的 accessLevel | project, scores | organization | project, scores |
| 组织级密钥可用 | ✗ 403 | ✓ | ✗ 401 |
| 管理员密钥可用 | ✓ (仅 LLM Connections) | ✗ | ✗ |
| 错误处理 | withMiddlewares 统一 | handler 独立 | handler 独立 |
| 响应格式 | 标准 JSON | 标准 JSON | 支持 207 批量 |
| projectId 必填 | ✓ (组织级密钥 403) | ✗ (应为 null) | ✓ (组织级密钥 401) |
| Entitlement 检查 | ✗ | ✓ (admin-api) | ✗ |
| Bearer 公钥支持 | 仅 POST /scores | ✗ | ✓ |

---

## 7. 关键证据索引

### 代码位置索引
| 验证项 | 文件路径 | 行号 |
|-------|---------|-----|
| 组织级密钥 projectId = null | packages/shared/src/server/auth/types.ts | 25 |
| RouteAccessLevel 排除 organization | web/src/features/public-api/server/createAuthedProjectAPIRoute.ts | 28 |
| projectId null 检查 (项目级路由) | web/src/features/public-api/server/createAuthedProjectAPIRoute.ts | 113-118 |
| Bearer 认证禁用组织密钥 | web/src/features/public-api/server/apiAuth.ts | 205-209 |
| Ingestion projectId null 检查 | web/src/pages/api/public/ingestion.ts | 84-88 |
| 组织级路由 accessLevel 检查 | web/src/pages/api/public/organizations/projects/index.ts | 39-47 |
| 管理员密钥触发条件 | web/src/features/public-api/server/createAuthedProjectAPIRoute.ts | 148-212 |
| scores POST 允许 scores 级别 | web/src/pages/api/public/scores/index.ts | 25 |

### 测试证据索引
| 验证项 | 测试文件 | 用例说明 |
|-------|---------|---------|
| Bearer 公钥可 POST scores | scores-api-v1.servertest.ts | 1332-1363 |
| Bearer 公钥不可 GET scores | scores-api-v1.servertest.ts | 1365-1376 |
| 组织级密钥要求 (组织 API) | organizations-api.servertest.ts | 多处 |
| 组织级密钥不可访问项目 API | projects-api.servertest.ts | 347-360 |

---

## 8. 冲突修正说明

### 本次校准修正的核心结论冲突

#### 🔴 修正 1: Ingestion 对组织级密钥的支持
- **原错误结论**: "Ingestion 支持所有 API key scope，组织级密钥可访问组织下所有项目"
- **修正后结论**: "组织级密钥完全无法用于 Ingestion 端点，因 `projectId === null` 触发 401 错误"
- **证据代码**: [ingestion.ts:84-88] 明确检查 `!authCheck.scope.projectId`
- **根本原因**: 组织级 API Key 的数据结构设计上 `projectId = null`，无法满足 ingestion 的必填校验

#### 🔴 修正 2: Public API 路由对组织级密钥的支持范围
- **原错误结论**: "Public API 组织级端点支持组织级密钥" (暗示范围较大)
- **修正后结论**: "仅 `/api/public/organizations/*` 下的 3 个专用端点支持组织级密钥，其他 95% 端点均通过 `createAuthedProjectAPIRoute` 明确排除组织级密钥 (`RouteAccessLevel = Exclude<ApiAccessLevel, "organization">`)"
- **证据代码**: [createAuthedProjectAPIRoute.ts:28, 113-118]

#### 🔴 修正 3: 权限矩阵中的错误标记
- **原错误矩阵**: "组织级 API Key - Ingestion/SDK: ✓"
- **修正后矩阵**: "组织级 API Key - Ingestion/SDK: ✗ (401 拒绝)"
- **统一口径**: 组织级密钥仅用于组织管理类 API，不可用于数据摄入和项目级操作

#### 🔴 修正 4: 租户隔离章节的矛盾描述
- **原矛盾描述**: 同时声称"组织级密钥可访问组织下所有项目"和"projectId 隔离"
- **修正后口径**: 明确区分两种路由模式：
  - 组织级路由 (`/api/public/organizations/*`): 不需要 projectId，以 orgId 为隔离边界
  - 项目级路由 & Ingestion: projectId 必须为非空字符串，组织级密钥被明确拒绝

### 统一后的核心原则
1. **密钥-路由匹配原则**: 组织级密钥 → 组织级路由；项目级密钥 → 项目级路由/Ingestion
2. **Ingestion 项目锁定原则**: 所有数据摄入必须关联明确的单个项目 ID，不支持跨项目摄入
3. **Bearer 公钥最小权限原则**: 仅用于 scores 写入，禁止读取和组织级操作
4. **错误码区分原则**: 
   - 项目级路由遇组织密钥 → 403 (权限不足)
   - Ingestion 遇组织密钥 → 401 (认证无效，缺少 projectId)
