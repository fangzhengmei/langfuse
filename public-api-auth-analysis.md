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
- 支持两种认证方式：
  - **基础认证 (Basic Auth)**: 提供完整的读写权限 (accessLevel: `project`)
  - **Bearer 认证 (仅公钥)**: 仅提供分数写入权限 (accessLevel: `scores`)
  - **组织级密钥**: scope = "ORGANIZATION"，可访问组织下所有项目
  - **项目级密钥**: scope = "PROJECT"，仅可访问特定项目

## 2. 权限校验差异

### Public API 权限校验
- **认证入口**: `createAuthedProjectAPIRoute.ts` 中的 `verifyAuth()` 函数
- **权限等级校验**: `allowedAccessLevels: RouteAccessLevel[]`
  - 默认值: `["project"]` - 需要完整的 Basic Auth 认证
  - 某些端点 (如 scores 写入): `["project", "scores"]` - 同时支持 Bearer Auth (仅公钥)
- **管理员密钥认证**: 仅在自托管实例可用，需要:
  - Authorization: Bearer `<ADMIN_API_KEY>`
  - x-langfuse-admin-api-key: `<ADMIN_API_KEY>` (冗余校验)
  - x-langfuse-project-id: `<project-id>` (目标项目)

### Ingestion 权限校验
- **认证入口**: `ingestion.ts` 直接调用 `ApiAuthService.verifyAuthHeaderAndReturnScope()`
- **访问级别**: 支持所有 API key scope，但要求 `projectId` 必须存在
- **额外检查**:
  - `isIngestionSuspended`: 检查组织是否因用量超限而被暂停写入

### 权限层级对比表
| 认证方式 | Public API | Ingestion/SDK | 访问级别 |
|---------|-----------|--------------|---------|
| Basic Auth (公钥 + 私钥) | ✓ | ✓ | project |
| Bearer Auth (仅公钥) | 部分端点 | ✓ | scores |
| 组织级 API Key | ✓ (需路由支持) | ✓ | organization |
| 管理员 API Key | ✓ (自托管) | ✗ | project |

## 3. 租户隔离差异

### Public API 租户隔离
- **项目级隔离**: 通过 API key 绑定的 `projectId` 进行隔离
- **组织级隔离**: 通过 API key 绑定的 `orgId` 进行隔离
- **路由配置**: `createAuthedProjectAPIRoute` 自动将 auth.scope 注入处理函数

### Ingestion 租户隔离
- **项目级隔离**: 同样通过 `projectId` 隔离，但在 ingestion.ts 中进行校验
- **组织级属性**: 通过 API key 传递 `plan`、`rateLimitOverrides` 等组织级属性
- **上下文传递**: 通过 OpenTelemetry context 将 projectId 注入处理流程

### 租户隔离对比表
| 隔离维度 | Public API | Ingestion/SDK |
|---------|-----------|--------------|
| Project ID 隔离 | ✓ | ✓ |
| Organization ID 隔离 | ✓ | ✓ |
| Plan 级别隔离 | ✓ | ✓ |
| Rate Limit 覆盖 | ✓ | ✓ |
| Ingestion 暂停检查 | ✗ | ✓ |

## 4. 错误处理差异

### Public API 错误处理 (withMiddlewares.ts)
- **统一错误处理**: 所有路由异常通过统一的中间件捕获处理
- **错误分类与状态码**:
  - `UnauthorizedError` (401): 认证失败
  - `ForbiddenError` (403): 权限不足
  - `LangfuseNotFoundError` (404): 资源不存在
  - `MethodNotAllowedError` (405): 方法不支持
  - `ClickHouseResourceError` (422): 资源限制
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
- **错误响应格式**:
  ```json
  {
    "message": "错误消息",
    "error": "错误类型名称"
  }
  ```
- **特殊处理**:
  - 限流错误: 调用 `RateLimitService.sendRestResponseIfLimited()`
  - 批量处理返回 207 状态码: `Multi-Status`，包含每个事件的处理结果

### 错误处理对比表
| 特性 | Public API (withMiddlewares) | Ingestion |
|-----|------------------------------|-----------|
| 统一错误捕获 | ✓ | ✗ (自行处理) |
| 标准化错误响应 | ✓ | 部分实现 |
| 日志分级策略 | ✓ | 仅 401 以上错误 |
| 异常追踪上报 | ✓ (5xx 错误) | ✓ (非 401 错误) |
| ClickHouse 资源错误处理 | ✓ | ✗ |
| 207 批量响应支持 | ✗ | ✓ |

## 5. 核心代码路径

### Public API 认证流程
```
createAuthedProjectAPIRoute.ts
└── verifyAuth()
    ├── verifyAdminApiKeyAuth() (可选, 自托管)
    │   └── timingSafeEqual 比较 ADMIN_API_KEY
    └── verifyApiKeyAuth()
        └── ApiAuthService.verifyAuthHeaderAndReturnScope()
            ├── Basic Auth (公钥+私钥) → accessLevel: project
            └── Bearer Auth (仅公钥) → accessLevel: scores
```

### Ingestion 认证流程
```
ingestion.ts
└── ApiAuthService.verifyAuthHeaderAndReturnScope()
    ├── Basic Auth (公钥+私钥) → accessLevel: project
    └── Bearer Auth (仅公钥) → accessLevel: scores
```

### API Key 验证层级
```
验证请求
├── 1. Redis 缓存检查 (快速路径)
│   └── 通过 fastHashedSecretKey 查找缓存
├── 2. Postgres 数据库检查 (慢速路径)
│   ├── 通过 publicKey 查找 API key
│   └── bcrypt 比较 secretKey (11 rounds)
└── 3. 缓存更新
    └── 更新 fastHashedSecretKey 和 Redis 缓存
```

## 6. 安全加固点

### 定时安全比较
- **管理员 API Key**: 使用 `crypto.timingSafeEqual` 防止时序攻击
- **普通 API Key**: 使用 bcrypt + SHA256 双重哈希保护

### 缓存安全
- **API_KEY_NON_EXISTENT 标记**: 不存在的密钥也会被缓存，防止暴力破解数据库查询
- **TTL 控制**: 缓存有过期时间，防止密钥撤销后长期有效

### 密钥层级
- **公钥 (pk-lf)**: 可公开，仅用于标识
- **私钥 (sk-lf)**: 必须保密，用于认证
- **管理员 API Key**: 环境变量配置，仅自托管可用

## 7. 总结

Public API 和 SDK (Ingestion) 共享相同的底层 `ApiAuthService` 认证服务，但在以下方面存在差异：

| 维度 | Public API | SDK/Ingestion |
|-----|-----------|--------------|
| 认证入口 | `createAuthedProjectAPIRoute` | 直接调用 `ApiAuthService` |
| 权限级别控制 | 路由级别配置 `allowedAccessLevels` | 统一处理，依赖密钥本身 scope |
| 管理员密钥支持 | ✓ (自托管) | ✗ |
| 错误处理 | 统一中间件处理 | Handler 内独立处理 |
| 响应格式 | 标准 JSON | 支持 207 批量响应 |
| Ingestion 暂停检查 | ✗ | ✓ |
| 路由层级权限控制 | ✓ (RBAC) | ✗ (仅依赖 API key) |
