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
- **实现路径**: 绝大多数 Public API 端点使用此包装器
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

#### B. 组织级路由 (直接调用 ApiAuthService) - 4 大类 14 个文件
- **统一校验模式**: 所有组织级路由都直接调用 `ApiAuthService`，并执行完全相同的两级校验：
  ```typescript
  if (authCheck.scope.accessLevel !== "organization" || !authCheck.scope.orgId) {
    return res.status(403).json({ message: "Organization-scoped API key required" });
  }
  ```

### 组织级密钥端点完整盘点 (14 个文件)

#### 类别 1: /api/public/organizations/* - 3 个文件
| 端点路径 | 方法 | 所需 Entitlement | 代码证据位置 |
|---------|------|-----------------|-------------|
| `/organizations/projects` | GET | admin-api | [organizations/projects/index.ts:39-46] |
| `/organizations/apiKeys` | GET | admin-api | [organizations/apiKeys/index.ts:39-46] |
| `/organizations/memberships` | GET/PUT/DELETE | admin-api | [organizations/memberships/index.ts:42-50] |

#### 类别 2: /api/public/projects/* - 4 个文件
| 端点路径 | 方法 | 所需 Entitlement | 额外校验 | 代码证据位置 |
|---------|------|-----------------|---------|-------------|
| `/projects` | POST | admin-api | 仅 POST 需要组织级，GET 用项目级 | [projects/index.ts:88-95] |
| `/projects/[projectId]` | PUT/DELETE | admin-api | 校验项目属于该组织 | [projects/[projectId]/index.ts:43-50] |
| `/projects/[projectId]/apiKeys` | GET/POST | admin-api | 校验项目属于该组织 | [projects/[projectId]/apiKeys/index.ts:38-45] |
| `/projects/[projectId]/memberships` | GET/PUT/DELETE | admin-api + rbac-project-roles | 校验项目属于该组织 | [projects/[projectId]/memberships/index.ts:49-56] |

> **特别说明**: `/api/public/projects` (GET) 使用项目级校验，不在此统计范围内；仅 POST 方法使用组织级校验。

#### 类别 3: /api/public/scim/* - 5 个文件
| 端点路径 | 方法 | 所需 Entitlement | 响应格式 | 代码证据位置 |
|---------|------|-----------------|---------|-------------|
| `/scim/Users` | GET/POST | 无 | SCIM 格式 | [scim/Users/index.ts:44-53] |
| `/scim/Users/[id]` | GET/PUT/PATCH/DELETE | 无 | SCIM 格式 | [scim/Users/[id].ts:108-117] |
| `/scim/ServiceProviderConfig` | GET | 无 | SCIM 格式 | [scim/ServiceProviderConfig.ts:40-49] |
| `/scim/Schemas` | GET | 无 | SCIM 格式 | [scim/Schemas.ts:40-49] |
| `/scim/ResourceTypes` | GET | 无 | SCIM 格式 | [scim/ResourceTypes.ts:40-49] |

> **SCIM 特殊说明**: SCIM 端点使用 SCIM 标准错误格式而非标准 JSON，但鉴权逻辑与其他组织级端点完全一致：
> - 401: 认证失败
> - 403: 非组织级密钥访问
> - 响应格式带 schemas 字段

#### 类别 4: /api/public/integrations/blob-storage/* - 2 个文件
| 端点路径 | 方法 | 所需 Entitlement | 实现模式 | 代码证据位置 |
|---------|------|-----------------|---------|-------------|
| `/integrations/blob-storage` | GET/PUT | scheduled-blob-exports | withMiddlewares 包装 | [blob-storage/index.ts:40-46] |
| `/integrations/blob-storage/[id]` | GET/DELETE | scheduled-blob-exports | withMiddlewares 包装 | [blob-storage/[id].ts:36-42] |

> **Blob Storage 特殊说明**: 此端点使用 `withMiddlewares` 统一错误处理（与项目级路由相同），但鉴权逻辑仍是组织级校验模式。

### 组织级端点统计汇总
| 类别 | 文件数 | 说明 |
|-----|-------|-----|
| Organizations | 3 | |
| Projects 管理 | 4 | 含 POST /projects |
| SCIM | 5 | |
| Blob Storage | 2 | |
| **合计** | **14 个文件** | 均包含 `accessLevel !== "organization"` 校验 |

### 管理员密钥认证 (Admin API Key)
- **生效路由**: 仅 LLM Connections 相关接口
  - `GET /api/public/llm-connections`
  - `PUT /api/public/llm-connections`
  - `DELETE /api/public/llm-connections/:id`
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
- **项目级强制**: `projectId` 必须存在且为 `string`，组织级密钥直接被拒绝 (403)
- **作用域注入**: 自动将 `auth.scope.projectId` 注入处理函数上下文
- **适用端点**: 除上述 14 个组织级端点文件外的所有 Public API

#### 组织级路由隔离
- **组织级强制**: `orgId` 必须存在且 `accessLevel === "organization"`，项目级密钥直接被拒绝 (403)
- **跨项目访问**: 使用 `auth.scope.orgId` 作为隔离边界，可访问组织下所有项目
- **额外项目校验**: 操作特定项目资源的端点会二次校验项目属于该组织 (404)

### Ingestion 租户隔离 [统一最终口径]
- **项目级隔离 - 绝对强制**: `projectId` 必须为非空字符串
  - 组织级密钥因 `projectId === null` 被 401 拒绝
  - **不存在**"组织级密钥可跨项目写入数据"的场景
- **组织级属性**: 通过 API Key 传递 `plan`、`rateLimitOverrides` 等元数据
  - 仅 **项目级密钥** 才能用于数据摄入，但其背后关联的组织信息用于限流和计划检查
- **上下文传递**: 通过 OpenTelemetry context 将 `projectId` 注入处理流程
- **Ingestion 暂停保护**: 检查 `cloudFreeTierUsageThresholdState === "BLOCKED"`

### 租户隔离对比表
| 隔离维度 | Public API 项目级路由 | Public API 组织级路由 | Ingestion/SDK | 校验位置 |
|---------|---------------------|---------------------|--------------|---------|
| Project ID 必填 | ✓ 必须为 string | ✗ 始终为 null | ✓ 必须为 string | createAuthedProjectAPIRoute.ts:113, ingestion.ts:84 |
| Organization ID 存在 | ✓ | ✓ | ✓ | ApiAuthService |
| Plan 级别隔离 | ✓ | ✓ | ✓ | 组织 cloudConfig |
| Rate Limit 覆盖 | ✓ | ✓ | ✓ | RateLimitService |
| Ingestion 暂停检查 | 仅 scores POST | ✗ | ✓ | ingestion.ts, scores/index.ts |
| 允许组织级密钥 | ✗ 403 拒绝 | ✓ (14 个文件) | ✗ 401 拒绝 | 各路由实现 |

---

## 4. 错误处理差异

### Public API 错误处理（三种模式）

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

#### B. 组织级路由错误处理 (独立 try/catch) - 12 个文件
- **独立错误处理**: handler 内直接 try/catch
- **适用端点**: Organizations (3) + Projects 管理 (4) + SCIM (5) = 12 个文件
- **错误分类与状态码**:
  | 错误类型 | HTTP 状态码 | 触发条件 |
  |---------|-----------|---------|
  | 认证失败 | 401 | 无效 API Key |
  | 权限不足 | 403 | 使用项目级密钥访问组织级路由、无 Entitlement |
  | 资源不存在 | 404 | 项目/用户不存在或不属于该组织 |
  | 方法不支持 | 405 | HTTP Method 错误 |
  | 参数错误 | 400 | 请求参数校验失败 |
  | 冲突 | 409 | SCIM 最后 Owner 无法删除、并发去重冲突 |

#### C. Blob Storage 端点错误处理 (混合模式) - 2 个文件
- **使用 withMiddlewares 统一错误捕获**
- **鉴权逻辑与组织级端点一致**

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
| 特性 | Public API 项目级路由 | Public API 组织级路由 | Blob Storage | Ingestion |
|-----|---------------------|---------------------|--------------|-----------|
| 统一错误捕获 | ✓ | ✗ 独立处理 | ✓ | ✗ 独立处理 |
| 标准化错误响应 | ✓ | 部分实现/SCIM 格式 | ✓ | 部分实现 |
| 日志分级策略 | ✓ | 基本日志 | ✓ | 仅 401+ 记录 |
| 异常追踪上报 | ✓ (5xx 错误) | ✓ | ✓ | ✓ (非 401 错误) |
| ClickHouse 资源错误处理 | ✓ | ✗ | ✗ | ✗ |
| 207 批量响应支持 | ✗ | ✗ | ✗ | ✓ |
| Entitlement 检查 | ✗ | ✓ | ✓ | ✗ |

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
│  组织级路由 (14 个文件):                                         │
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

| 认证方式 | 项目级 Public API | 组织级 Public API (14 个文件) | Ingestion/SDK |
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
| 组织级密钥可用 | ✗ 403 | ✓ (14 个文件) | ✗ 401 |
| 管理员密钥可用 | ✓ (仅 LLM Connections) | ✗ | ✗ |
| 错误处理 | withMiddlewares 统一 | handler 独立 / withMiddlewares | handler 独立 |
| 响应格式 | 标准 JSON | 标准 JSON / SCIM 格式 | 支持 207 批量 |
| projectId 必填 | ✓ (组织级密钥 403) | ✗ (应为 null) | ✓ (组织级密钥 401) |
| Entitlement 检查 | ✗ | ✓ (admin-api, scheduled-blob-exports 等) | ✗ |
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
| 组织级路由 accessLevel 检查 | 所有 14 个组织级端点文件 | 各路由 36-55 行附近 |
| 管理员密钥触发条件 | web/src/features/public-api/server/createAuthedProjectAPIRoute.ts | 148-212 |
| scores POST 允许 scores 级别 | web/src/pages/api/public/scores/index.ts | 25 |

### 组织级端点清单索引 (共 14 个文件)
| 类别 | 文件数 | 文件路径前缀 | accessLevel 校验行 |
|-----|-------|------------|-------------------|
| Organizations | 3 | web/src/pages/api/public/organizations/ | 39-50 行 |
| Projects 管理 | 4 | web/src/pages/api/public/projects/ | 43-95 行 |
| SCIM | 5 | web/src/pages/api/public/scim/ | 40-117 行 |
| Blob Storage | 2 | web/src/pages/api/public/integrations/blob-storage/ | 36-46 行 |
| **合计** | **14** | | |

---

## 8. 最终校准修正说明

### 本次严谨收敛修正的 5 处不一致

#### 🔴 修正 1: 组织级密钥端点分类统计不准确
- **原错误**: "Projects 管理 3 个端点"，漏掉了 `POST /api/public/projects`
- **修正后**: Projects 管理共 4 个文件，完整包含 `POST /projects`
- **证据**: [projects/index.ts:88-95] 明确有 `accessLevel !== "organization"` 校验
- **影响**: 原总数 13 → 修正后 14 个文件

#### 🔴 修正 2: SCIM 端点文件数统计错误
- **原错误**: "SCIM 6 个端点"（按方法统计）
- **修正后**: "SCIM 5 个文件"（按文件级统一统计口径）
- **说明**: 保持与其他类别相同的"文件数"统计维度，避免按方法与按文件混合统计的混乱
- **影响**: SCIM 类别 6 → 5，总数保持 14

#### 🔴 修正 3: 错误处理模式分类不准确
- **原错误**: 分为 "独立 try/catch (12个)、SCIM格式(6个)、withMiddlewares(2个)" 三类有重叠
- **修正后**: 分为 "独立 try/catch (12个文件)、withMiddlewares (2个文件)" 两类，SCIM 格式作为独立 try/catch 下的响应格式差异标注
- **影响**: 分类更清晰，无重叠

#### 🔴 修正 4: 混合端点 `/api/public/projects` 说明缺失
- **原错误**: 未说明此端点 GET/POST 两种不同鉴权逻辑
- **修正后**: 明确标注 "仅 POST 需要组织级，GET 用项目级"
- **证据**: [projects/index.ts:35-42] (GET) vs [projects/index.ts:88-95] (POST)
- **影响**: 理解了为什么该文件同时出现在项目级操作和组织级操作中

#### 🔴 修正 5: 组织级路由 Blob Storage 端点遗漏标注
- **原错误**: 边界矩阵中错误处理列未体现 Blob Storage 使用 withMiddlewares
- **修正后**: 错误处理列明确标注 "handler 独立 / withMiddlewares" 两种模式
- **证据**: [blob-storage/index.ts] 顶层使用 `withMiddlewares` 包装

### 最终统一的核心原则（已全部校准对齐）
1. **密钥-路由匹配原则**: 组织级密钥 → 组织级路由（14 个文件）；项目级密钥 → 项目级路由/Ingestion
2. **Ingestion 项目锁定原则**: 所有数据摄入必须关联明确的单个项目 ID，不支持跨项目摄入
3. **Bearer 公钥最小权限原则**: 仅用于 scores 写入，禁止读取和组织级操作
4. **错误码区分原则**:
   - 项目级路由遇组织密钥 → 403 (权限不足)
   - Ingestion 遇组织密钥 → 401 (认证无效，缺少 projectId)
   - 项目级密钥遇组织路由 → 403 (权限不足)
5. **Entitlement 分层原则**: 不同组织级端点需要不同的套餐 Entitlement
6. **统计口径统一原则**: 所有端点分类均按"文件数"统计，不混用方法级统计维度
