# Langfuse Public API 与 SDK 鉴权边界差异分析

## 1. 密钥来源差异

### Public API 密钥机制
- **认证方式**: HTTP Basic Auth
- **凭据组成**: 
  - Username = Public Key (格式: `pk-lf-<uuid>`)
  - Password = Secret Key (格式: `sk-lf-<uuid>`)
- **密钥验证流程**:
  1. 首次认证: 使用 bcrypt 比较 (hashSecretKey, 11 rounds)
  2. 后续认证: 使用 SHA256 + Salt 快速哈希 (fastHashedSecretKey)
  3. Redis 缓存: 验证成功的密钥会缓存到 Redis，TTL 由 `LANGFUSE_CACHE_API_KEY_TTL_SECONDS` 控制

### SDK/Ingestion 密钥机制
- 支持**两种认证方式**:
  - **基础认证 (Basic Auth)**: 提供完整的读写权限 (accessLevel: `project`)
  - **Bearer 认证 (仅公钥)**: 仅提供分数写入权限 (accessLevel: `scores`)
- **密钥作用域**:
  - **组织级密钥**: scope = "ORGANIZATION"，可访问组织下所有项目
  - **项目级密钥**: scope = "PROJECT"，仅可访问特定项目
- **SDK Header**: 
  - `X-Langfuse-Sdk-Name`: 标识 SDK 名称（可选）
  - `X-Langfuse-Sdk-Version`: 标识 SDK 版本（可选）
  - `X-Langfuse-Public-Key`: 公钥标识（可选）
  - **证据来源**: [fern/apis/server/definition/api.yml:25-28]

---

## 2. 权限校验差异

### Public API 权限校验
- **认证入口**: `createAuthedProjectAPIRoute.ts` 中的 `verifyAuth()` 函数
- **权限等级校验**: `allowedAccessLevels: RouteAccessLevel[]`
  - **默认值**: `["project"]` - 需要完整的 Basic Auth 认证
  - **Scores POST 端点**: `["project", "scores"]` - 同时支持 Bearer Auth (仅公钥)
    - **证据来源**: [web/src/pages/api/public/scores/index.ts:25]

#### 管理员密钥认证 (Admin API Key)
- **生效路由**: 仅 LLM Connections 相关接口
  - `GET /api/public/llm-connections` [llm-connections/index.ts:27]
  - `PUT /api/public/llm-connections` [llm-connections/index.ts:84]
  - `DELETE /api/public/llm-connections/:id` [llm-connections/[id].ts:25]
- **触发条件** (必须全部满足):
  1. **环境限制**: `NEXT_PUBLIC_LANGFUSE_CLOUD_REGION` 未设置 (仅自托管可用)
  2. **双重 Header 校验**:
     - `Authorization: Bearer <ADMIN_API_KEY>`
     - `x-langfuse-admin-api-key: <ADMIN_API_KEY>` (冗余校验，防止攻击)
  3. **项目指定**: `x-langfuse-project-id: <project-id>` 必须是有效项目 ID
  4. **配置要求**: `ADMIN_API_KEY` 环境变量必须已配置
  5. **安全比较**: 使用 `crypto.timingSafeEqual` 进行时序攻击防护
    - **证据来源**: [createAuthedProjectAPIRoute.ts:148-212]

### Ingestion 权限校验
- **认证入口**: `ingestion.ts` 直接调用 `ApiAuthService.verifyAuthHeaderAndReturnScope()`
- **访问级别**: 支持所有 API key scope，但要求 `projectId` 必须存在
- **额外检查**:
  - `isIngestionSuspended`: 检查组织是否因用量超限而被暂停写入

#### Bearer 公钥 (仅公钥认证) 的真实限制
- **权限级别**: `accessLevel: "scores"` - 仅写入权限
- **代码级限制** [apiAuth.ts:200-234]:
  1. **组织级密钥禁用 Bearer**: 如果 API Key 的 `scope === "ORGANIZATION"`，直接抛出错误
     > "Unauthorized: Cannot use organization key with bearer auth"
  2. **仅支持项目级密钥**: Bearer 认证只接受 `scope === "PROJECT"` 的密钥
- **端点级限制**:
  - 仅 `POST /api/public/scores` 配置了 `allowedAccessLevels: ["project", "scores"]`
  - 所有其他 Public API 端点默认仅接受 `["project"]` 级别，Bearer 公钥访问会返回 403
- **测试证据** [scores-api-v1.servertest.ts:1332-1446]:
  - ✅ POST /api/public/scores - 返回 200
  - ❌ GET /api/public/scores - 返回 403
  - ❌ GET /api/public/scores/:scoreId - 返回 403
  - ❌ DELETE /api/public/scores/:scoreId - 返回 403
  - ❌ GET /api/public/traces - 返回 403
  - ❌ GET /api/public/observations - 返回 403
  - ❌ GET /api/public/sessions - 返回 403

#### 组织级密钥的生效范围
- **生效端点** (需要 `accessLevel: "organization"`):
  - `/api/public/organizations/*` - 组织管理 API
  - `/api/public/projects` (POST) - 创建项目
  - `/api/public/projects/:projectId` (DELETE/PUT) - 删除/更新项目
  - `/api/public/scim/*` - SCIM 用户同步 API
- **测试证据** [organizations-api.servertest.ts, projects-api.servertest.ts]:
  - ✅ 组织级密钥可访问组织 API
  - ❌ 项目级密钥访问组织 API 返回 403 "Organization-scoped API key required"

### 权限层级对比表
| 认证方式 | Public API | Ingestion/SDK | 访问级别 |
|---------|-----------|--------------|---------|
| Basic Auth (公钥 + 私钥) | 所有端点 | ✓ | project |
| Bearer Auth (仅公钥) | 仅 POST /scores | ✓ | scores |
| 组织级 API Key | 组织级端点 | ✓ | organization |
| 管理员 API Key | 仅 LLM Connections (自托管) | ✗ | project |

---

## 3. 租户隔离差异

### Public API 租户隔离
- **项目级隔离**: 通过 API key 绑定的 `projectId` 进行隔离
- **组织级隔离**: 通过 API key 绑定的 `orgId` 进行隔离
- **路由配置**: `createAuthedProjectAPIRoute` 自动将 auth.scope 注入处理函数
- **权限守卫**: 组织级 API 验证 `scope === "ORGANIZATION"`，项目级 API 验证 `projectId` 存在

### Ingestion 租户隔离
- **项目级隔离**: 同样通过 `projectId` 隔离，但在 ingestion.ts 中进行校验
- **组织级属性**: 通过 API key 传递 `plan`、`rateLimitOverrides` 等组织级属性
- **上下文传递**: 通过 OpenTelemetry context 将 projectId 注入处理流程
- **Ingestion 暂停保护**: 检查 `cloudFreeTierUsageThresholdState === "BLOCKED"`，对免费 tier 超限组织进行写入拦截

### 租户隔离对比表
| 隔离维度 | Public API | Ingestion/SDK | 验证位置 |
|---------|-----------|--------------|---------|
| Project ID 隔离 | ✓ | ✓ | ApiAuthService |
| Organization ID 隔离 | ✓ | ✓ | ApiAuthService |
| Plan 级别隔离 | ✓ | ✓ | 组织 cloudConfig |
| Rate Limit 覆盖 | ✓ | ✓ | RateLimitService |
| Ingestion 暂停检查 | 部分端点 (scores POST) | ✓ | ingestion.ts, scores/index.ts |

---

## 4. 错误处理差异

### Public API 错误处理 (withMiddlewares.ts)
- **统一错误捕获**: 所有路由异常通过统一的中间件捕获处理
- **错误分类与状态码**:
  - `UnauthorizedError` (401): 认证失败、无效凭据
  - `ForbiddenError` (403): 权限不足、Ingestion 被暂停
  - `LangfuseNotFoundError` (404): 资源不存在
  - `MethodNotAllowedError` (405): 方法不支持
  - `ClickHouseResourceError` (422): 资源限制、查询超时
  - `ZodError` (400): 请求参数校验失败
- **错误响应格式**:
  ```json
  {
    "message": "错误消息",
    "error": "错误类型名称"
  }
  ```
- **日志策略**:
  - 401/404 仅记录 info 级别日志
  - 500 错误记录 error 并上报异常追踪

### Ingestion 错误处理 (ingestion.ts)
- **独立错误处理**: 在 handler 内直接进行 try/catch 处理
- **错误分类与状态码**:
  - `UnauthorizedError` (401): 认证失败
  - `ForbiddenError` (403): ingestion 被暂停
  - `MethodNotAllowedError` (405): 方法不支持
  - `ZodError` (400): 请求数据校验失败
- **批量响应**: 返回 207 Multi-Status，包含每个事件的处理结果
- **限流响应**: 调用 `RateLimitService.sendRestResponseIfLimited()`

### 错误处理对比表
| 特性 | Public API (withMiddlewares) | Ingestion |
|-----|------------------------------|-----------|
| 统一错误捕获 | ✓ | ✗ (handler 内处理) |
| 标准化错误响应 | ✓ | 部分实现 |
| 日志分级策略 | ✓ | 仅 401+ 记录 |
| 异常追踪上报 | ✓ (5xx 错误) | ✓ (非 401 错误) |
| ClickHouse 资源错误处理 | ✓ | ✗ |
| 207 批量响应支持 | ✗ | ✓ |

---

## 5. 服务端验签链路 (SDK → 服务端)

### 完整验证流程
```
SDK 发起请求
    ↓
┌─ Request Headers ──────────────────────────────┐
│  Authorization: Basic base64(pk:sk)           │
│  OR Authorization: Bearer pk                  │
│  X-Langfuse-Sdk-Name: langfuse-python        │ ← 可选，仅统计
│  X-Langfuse-Sdk-Version: 3.x.x               │
│  X-Langfuse-Public-Key: pk-lf-...           │ ← 可选，冗余标识
└─────────────────────────────────────────────────┘
    ↓
┌─ ApiAuthService.verifyAuthHeaderAndReturnScope() ─┐
│  1. 解析 Authorization 头                          │
│  2. 分支:                                          │
│     ├─ Basic Auth → bcrypt 验证 → accessLevel: project │
│     └─ Bearer Auth → 验证 scope ≠ ORGANIZATION → accessLevel: scores │
│  3. 提取 orgId, projectId, plan, rateLimitOverrides │
│  4. 检查 isIngestionSuspended 状态                  │
│  5. 注入 OpenTelemetry context                      │
└─────────────────────────────────────────────────────┘
    ↓
┌─ 业务处理 ──────────────────────────────────────┐
│  Public API: 校验 allowedAccessLevels         │
│  Ingestion: 直接使用 auth.scope.projectId     │
└─────────────────────────────────────────────────┘
```

### 密钥安全加固点
1. **时序攻击防护**:
   - 管理员 API Key: 使用 `crypto.timingSafeEqual`
   - 普通 API Key: bcrypt + SHA256 双重哈希

2. **缓存安全**:
   - **API_KEY_NON_EXISTENT 标记**: 不存在的密钥也会被缓存，防止暴力破解数据库查询
   - **TTL 控制**: 缓存有过期时间，防止密钥撤销后长期有效

3. **密钥层级原则**:
   - 公钥 (pk-lf): 可公开，仅用于标识
   - 私钥 (sk-lf): 必须保密，用于认证
   - 管理员 API Key: 环境变量配置，仅自托管可用

---

## 6. 关键证据来源

### 代码位置索引
| 验证项 | 文件路径 | 行号 |
|-------|---------|-----|
| Bearer 认证禁用组织密钥 | `web/src/features/public-api/server/apiAuth.ts` | 205-209 |
| Bearer 认证 accessLevel | `web/src/features/public-api/server/apiAuth.ts` | 224 |
| Scores 端点允许 scores 级别 | `web/src/pages/api/public/scores/index.ts` | 25 |
| 管理员密钥触发条件 | `web/src/features/public-api/server/createAuthedProjectAPIRoute.ts` | 148-212 |
| 管理员密钥生效路由 | `web/src/pages/api/public/llm-connections/index.ts` | 27, 84 |
| Ingestion 暂停检查 | `web/src/pages/api/public/ingestion.ts` | 90-94 |
| SDK Headers 定义 | `fern/apis/server/definition/api.yml` | 25-28 |

### 测试证据索引
| 验证项 | 测试文件 | 测试用例位置 |
|-------|---------|-----------|
| Bearer 公钥可 POST scores | `scores-api-v1.servertest.ts` | 1332-1363 |
| Bearer 公钥不可 GET scores | `scores-api-v1.servertest.ts` | 1365-1376 |
| Bearer 公钥不可访问其他端点 | `scores-api-v1.servertest.ts` | 1419-1446 |
| 组织级密钥要求 | `projects-api.servertest.ts` | 347-360 |
| 管理员密钥认证测试 | `admin-api-key-auth.servertest.ts` | 完整文件 |

---

## 7. 总结与边界矩阵

### Public API vs SDK/Ingestion 边界矩阵

| 维度 | Public API | SDK/Ingestion |
|-----|-----------|--------------|
| 认证入口 | `createAuthedProjectAPIRoute` | 直接调用 `ApiAuthService` |
| 权限级别控制 | 路由级别配置 `allowedAccessLevels` | 统一处理，依赖密钥本身 scope |
| 管理员密钥支持 | ✓ (仅 LLM Connections，自托管) | ✗ |
| 错误处理 | 统一中间件处理 | Handler 内独立处理 |
| 响应格式 | 标准 JSON | 支持 207 批量响应 |
| Ingestion 暂停检查 | 部分端点 (scores POST) | ✓ |
| Bearer 公钥支持 | 仅 POST /scores | ✓ |
| 组织级密钥支持 | ✓ (组织级端点) | ✓ |

### 关键结论
1. **Bearer 公钥权限极有限**: 仅支持 Scores 写入，禁止读取，禁止组织级密钥使用
2. **管理员密钥高度受限**: 仅自托管，仅 LLM Connections 端点，需双重 Header 校验
3. **组织级密钥需明确端点**: 仅组织管理类 API 接受组织级密钥，其他端点均返回 403
4. **Ingestion 与 Public API 共享底层认证**: 但上层权限校验逻辑差异显著
