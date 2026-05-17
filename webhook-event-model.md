# Langfuse Webhook 事件模型

## 概述

Langfuse 的 Webhook 系统基于自动化（Automation）框架构建，提供事件触发、过滤、投递、重试和状态追踪的完整链路。系统支持三种动作类型：Webhook HTTP 回调、Slack 消息通知和 GitHub Dispatch 事件。

---

## 架构总览

```
实体变更事件
    ↓
[EntityChangeQueue]
    ↓
promptVersionProcessor (过滤与匹配)
    ↓
创建 AutomationExecution (PENDING)
    ↓
[WebhookQueue] (BullMQ)
    ↓
webhookProcessor (处理器)
    ├─ executeWebhookAction (Webhook)
    ├─ executeSlackAction (Slack)
    └─ executeGitHubDispatchAction (GitHub)
    ↓
executeHttpAction (HTTP投递)
    ├─ URL安全验证
    ├─ 请求签名
    ├─ HTTP请求 (带重试)
    └─ 状态更新 (COMPLETED/ERROR)
```

---

## 1. 事件生成流程

### 1.1 事件源

当前支持的事件源：
- **Prompt 版本变更** (`TriggerEventSource.Prompt`)
  - 动作类型：`created`、`updated`

### 1.2 实体变更处理器

**文件**: `worker/src/features/entityChange/promptVersionProcessor.ts`

```typescript
// 核心处理流程
export const promptVersionProcessor = async (event: EntityChangeEventType) => {
  // 1. 获取该项目下所有活跃的触发器
  const triggers = await getTriggerConfigurations({
    projectId: event.projectId,
    eventSource: TriggerEventSource.Prompt,
    status: JobConfigState.ACTIVE,
  });

  // 2. 对每个触发器进行过滤匹配
  for (const trigger of triggers) {
    const eventMatches = InMemoryFilterService.evaluateFilter(
      eventData,
      mergedFilter, // 包含 eventActions 过滤条件
      fieldMapper
    );

    if (eventMatches) {
      // 3. 匹配成功，加入队列
      await enqueueAutomationAction({...});
    }
  }
};
```

### 1.3 事件入队逻辑

```typescript
async function enqueueAutomationAction({...}) {
  // 1. 创建执行记录（状态追踪起点）
  const executionId = v4();
  await prisma.automationExecution.create({
    data: {
      id: executionId,
      projectId,
      automationId: automations[0].id,
      triggerId,
      actionId,
      status: ActionExecutionStatus.PENDING, // 初始状态
      sourceId: promptData.id,
      input: {...}, // 输入快照
    },
  });

  // 2. 加入 BullMQ 队列
  await WebhookQueue.getInstance()?.add(QueueName.WebhookQueue, {
    timestamp: new Date(),
    id: v4(),
    payload: {
      projectId,
      automationId: automations[0].id,
      executionId,
      payload: {
        action: "created" | "updated",
        type: "prompt-version",
        prompt: {...}, // Prompt 完整数据
        user: {...},   // 触发用户信息
      },
    },
    name: QueueJobs.WebhookJob,
  });
}
```

---

## 2. 队列配置与重试策略

### 2.1 BullMQ 队列配置

**文件**: `packages/shared/src/server/redis/webhookQueue.ts`

```typescript
export class WebhookQueue {
  public static getInstance() {
    return new Queue(QueueName.WebhookQueue, {
      connection: redis,
      defaultJobOptions: {
        removeOnComplete: true,      // 成功后立即删除
        removeOnFail: 100_000,       // 失败后保留10万条
        attempts: 5,                  // 队列级重试次数
        backoff: {
          type: "exponential",        // 指数退避
          delay: 5000,                // 初始延迟5秒
        },
      },
    });
  }
}
```

### 2.2 队列级重试 vs HTTP级重试（更新版）

| 层级 | 重试次数 | 适用动作 | 触发条件 |
|------|---------|---------|---------|
| BullMQ 队列级 | 5次 | **仅限 Webhook/GitHub 的特定错误** | 见下方详细边界说明 |
| HTTP 请求级 | 4次 | Webhook/GitHub | 网络错误、非2xx响应、超时、fetch失败 |
| 无内部重试 | - | Slack | 任何错误直接进入禁用流程，无重试 |

---

## 3. Webhook 处理器流程

**文件**: `worker/src/queues/webhooks.ts`

### 3.1 处理器入口

```typescript
export const webhookProcessor: Processor = async (job) => {
  try {
    return await executeWebhook(job.data.payload);
  } catch (error) {
    logger.error("Error executing WebhookJob", error);
    throw error; // 只有这里抛出的错误才会触发 BullMQ 队列级重试
  }
};
```

### 3.2 Webhook 动作执行

```typescript
async function executeWebhookAction({input, automation}) {
  // 1. 获取动作配置（含解密后的密钥）
  const actionConfig = await getActionByIdWithSecrets({
    projectId: input.projectId,
    actionId: automation.action.id,
  });

  // 2. 验证并序列化 Payload
  const validatedPayload = PromptWebhookOutboundSchema.safeParse({
    id: input.executionId,
    timestamp: new Date(),
    type: input.payload.type,
    apiVersion: "v1",
    action: input.payload.action,
    prompt: input.payload.prompt,
    user: {...},
  });

  // 3. 构建请求头（含签名）
  const requestHeaders: Record<string, string> = {};

  // 添加自定义请求头（支持敏感头加密存储）
  if (webhookConfig.requestHeaders) {
    for (const [key, value] of Object.entries(webhookConfig.requestHeaders)) {
      requestHeaders[key] = value.value; // 已解密
      if (value.secret) {
        additionalSensitiveHeaders.push(key);
      }
    }
  }

  // 添加默认头
  for (const [key, value] of Object.entries(WebhookDefaultHeaders)) {
    requestHeaders[key] = value;
  }

  // 生成签名（HMAC-SHA256）
  const decryptedSecret = decrypt(webhookConfig.secretKey);
  const signature = createSignatureHeader(stringifiedPayload, decryptedSecret);
  requestHeaders["x-langfuse-signature"] = signature;

  // 4. 执行 HTTP 请求
  await executeHttpAction({
    url: webhookConfig.url,
    payload: stringifiedPayload,
    headers: requestHeaders,
    projectId: input.projectId,
    automation,
    executionId: input.executionId,
    executionStart: new Date(),
    actionConfig,
    additionalSensitiveHeaders,
  });
}
```

---

## 4. HTTP 请求执行与安全控制

### 4.1 核心执行函数

```typescript
async function executeHttpAction({url, payload, headers, ...}) {
  try {
    // HTTP 请求内重试（4次）
    await backOff(async () => {
      // 超时控制（默认环境变量）
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
      }, env.LANGFUSE_WEBHOOK_TIMEOUT_MS);

      try {
        // URL 安全验证（SSRF防护）
        if (!skipValidation) {
          await validateWebhookURL(url, whitelistFromEnv());
        }

        // 带重定向验证的 Fetch
        const redirectResult = await fetchWithSecureRedirects(
          url,
          {
            method: "POST",
            body: payload,
            headers,
            signal: abortController.signal,
          },
          {
            maxRedirects: env.LANGFUSE_WEBHOOK_MAX_REDIRECTS,
            redirectValidation: {
              validateUrl: validateWebhookURL,
              whitelist: whitelistFromEnv(),
              logContext: "Webhook",
            },
            additionalSensitiveHeaders,
          }
        );

        const res = redirectResult.response;
        const httpStatus = res.status;
        const responseBody = await res.text();

        if (!res.ok) {
          throw new Error(`Webhook does not return 2xx status`);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }, { numOfAttempts: 4 });

    // 成功：更新状态为 COMPLETED
    await prisma.automationExecution.update({
      where: {id: executionId, projectId},
      data: {
        status: ActionExecutionStatus.COMPLETED,
        startedAt: executionStart,
        finishedAt: new Date(),
      },
    });

  } catch (error) {
    // 处理错误...
  }
}
```

### 4.2 URL 安全验证（SSRF防护）

**文件**: `packages/shared/src/server/webhooks/validation.ts`

```typescript
export async function validateWebhookURL(urlString: string, whitelist) {
  const url = parseOutboundUrl(urlString);

  // 1. 协议检查：仅允许 HTTP/HTTPS
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS protocols are allowed");
  }

  // 2. 端口检查：仅允许 80/443
  if (url.port && !["443", "80"].includes(url.port)) {
    throw new Error("Only ports 80 and 443 are allowed");
  }

  // 3. 主机验证：解析 DNS 并防止内网IP访问
  await validateOutboundUrlHost({
    url,
    whitelist,
    logContext: "Webhook",
    shouldSkipDnsCheckForLiteralIps: false, // 强制 DNS 检查
  });
}
```

### 4.3 安全重定向处理

**文件**: `packages/shared/src/server/outbound-url/fetch.ts`

关键安全特性：
- 每个重定向目标都需重新验证 URL
- 可配置最大重定向深度
- 跨域重定向时自动剥离敏感头
- 循环重定向检测

自动剥离的敏感头：
- `authorization`
- `cookie`
- `proxy-authorization`
- `x-langfuse-signature`
- 配置中标记为 `secret: true` 的自定义头

---

## 5. 签名生成与验证

### 5.1 签名生成算法

**文件**: `packages/shared/src/encryption/signature.ts`

```typescript
/**
 * 签名头格式：t=timestamp,v1=signature
 * 
 * 签名算法：
 *   signedPayload = `${timestamp}.${payload}`
 *   signature = HMAC-SHA256(secret, signedPayload)
 */

export function createSignatureHeader(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);  // Unix 时间戳（秒）
  const signature = generateWebhookSignature(payload, timestamp, secret);
  return `t=${timestamp},v1=${signature}`;
}

export function generateWebhookSignature(
  payload: string,
  timestamp: number,
  secret: string
): string {
  const signedPayload = `${timestamp}.${payload}`;
  return crypto
    .createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");
}
```

### 5.2 接收方验证指南

```javascript
// 示例：Node.js 端验证 Webhook 签名
const crypto = require('crypto');

function verifyWebhookSignature(signatureHeader, payload, secret) {
  // 1. 解析签名头
  const parts = signatureHeader.split(',');
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
  const signature = parts.find(p => p.startsWith('v1='))?.slice(3);

  if (!timestamp || !signature) {
    throw new Error('Invalid signature header format');
  }

  // 2. 时间戳验证（防止重放攻击，建议 5 分钟窗口）
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    throw new Error('Signature timestamp expired');
  }

  // 3. 重新计算签名并比对
  const signedPayload = `${timestamp}.${payload}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  // 使用计时安全比较
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}
```

---

## 6. 失败处理与自动禁用机制

### 6.1 队列级重试触发边界（精确版）

> **核心复核结论**：BullMQ 队列级重试的触发条件极其严格，绝大多数错误都会在动作内部被吞掉，直接进入 ERROR 状态和禁用流程。

#### ✅ 会抛出并触发 BullMQ 重试的错误（Webhook/GitHub）

**executeHttpAction 中显式判断并重试：**

| 错误类型 | 触发场景 | 代码位置 |
|---------|---------|---------|
| `LangfuseNotFoundError` | 配置资源找不到 | webhooks.ts:247-249 |
| `InternalServerError` | 内部服务异常 | webhooks.ts:247-249 |
| **任意错误** + `!actionConfig` | 动作配置不存在时，不管什么错误都抛 | webhooks.ts:256-259 |

**动作执行前置阶段抛出的 InternalServerError：**

这些错误发生在调用 executeHttpAction 之前，会被捕获并判断为 InternalServerError 后重新抛出：

| 错误场景 | 错误消息 |
|---------|---------|
| 动作配置不存在 | "Action config not found" |
| 动作类型校验失败 | "Action config is not a valid webhook configuration" |
| Payload 校验失败 | "Invalid webhook payload: ..." |
| 签名生成失败 | "Failed to generate webhook signature" |

---

#### ❌ 会在动作内部被吞掉的错误（不触发 BullMQ 重试）

**Webhook/GitHub（executeHttpAction 内部吞掉）：**

除上述可重试错误外的 **所有其他错误** 都会被吞掉，直接：
1. 更新 `AutomationExecution.status = ERROR`
2. 记录错误信息和响应体
3. 计算连续失败次数
4. 如果 `consecutiveFailures >= 4` 则禁用触发器
5. **return 而非 throw**，不触发 BullMQ 重试

具体包括：
- HTTP 非 2xx 响应错误
- 网络连接错误 / DNS 解析失败
- 请求超时（AbortError）
- URL 验证失败（协议、端口、主机白名单）
- 重定向安全检查失败
- fetch 抛出的所有其他异常

**代码位置**：webhooks.ts:327-329
```typescript
// Error has been handled - don't rethrow
// Return empty response to indicate failure was handled
return { httpStatus: httpStatus || 0, responseBody: responseBody || "" };
```

---

**Slack（全部错误都在内部吞掉）：**

Slack 动作有完全独立的 try-catch 块，**任何错误都不会向外抛出**，包括：
- 动作配置不存在
- 无效的 Slack 配置
- Slack 消息构建失败
- Slack API 调用失败（网络错误、认证失败、权限不足等）
- 数据库更新失败
- **所有异常**

处理流程：
1. 更新 `AutomationExecution.status = ERROR`
2. **立即禁用触发器**（无连续失败计数）
3. 记录 `lastFailingExecutionId`
4. catch 内无 throw，直接 return

**代码位置**：webhooks.ts:640-694

---

### 6.2 不同动作类型的失败策略差异总结

| 维度 | Webhook/GitHub | Slack |
|-----|---------------|-------|
| **禁用触发器阈值** | 连续失败 >= 4次 | 单次失败立即禁用 |
| **HTTP内部重试** | ✅ 4次（HTTP级重试） | ❌ 无 |
| **队列级重试** | ✅ 仅特定内部错误（5次） | ❌ 完全不重试 |
| **连续失败计数** | ✅ 有 | ❌ 无 |
| **失败后动作** | ERROR状态 + 计数 + 可能禁用 | ERROR状态 + 立即禁用 |
| **错误吞掉范围** | 仅HTTP/网络/外部错误 | 全部错误 |

---

### 6.3 完整时序链路：重试、状态流转与禁用条件（修订版）

```
  实体变更事件
      │
      ▼
  ┌───────────────────────────────────────────────────────────┐
  │  创建 AutomationExecution (status = PENDING)              │
  └───────────────────────────┬───────────────────────────────┘
                              │
                              ▼
  ┌───────────────────────────────────────────────────────────┐
  │  加入 WebhookQueue (BullMQ)                               │
  │  队列配置: attempts=5, backoff=exponential(5s)            │
  └───────────────────────────┬───────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
  ┌───────────────────────┐       ┌───────────────────────┐
  │  webhookProcessor     │       │  5次队列重试耗尽      │
  │  接收任务并执行       │       │  (仅限内部错误)       │
  └───────────┬───────────┘       └───────────┬───────────┘
              │                               │
              ▼                               ▼
  ┌───────────────────────────────────────────┐     ┌─────────────────┐
  │  executeWebhook 动作分发                   │     │  队列丢弃任务  │
  │  ├─ Webhook → executeHttpAction            │     └─────────────────┘
  │  ├─ GitHub → executeHttpAction             │
  │  └─ Slack → 直接发送 Slack API             │
  └───────────────────┬───────────────────────┘
                      │
          ┌───────────┴───────────────────────────────┐
          │                                           │
          ▼                                           ▼
  ┌───────────────────────┐               ┌───────────────────────┐
  │   执行成功            │               │   执行失败            │
  │ status=COMPLETED      │               │  进入失败处理        │
  └───────────────────────┘               └───────────┬───────────┘
                                                              │
                                              ┌─────────────┴─────────────┐
                                              │                           │
                                              ▼                           ▼
                                  ┌─────────────────────┐       ┌─────────────────────┐
                                  │  Webhook/GitHub     │       │  Slack 动作         │
                                  │  - HTTP内重试4次    │       │  - 无内部重试       │
                                  │  - 检查错误类型      │       │  - 单次失败即禁用   │
                                  │  ┌─ 可重试错误 → throw → BullMQ重试 │          │
                                  │  └─ 不可重试 → 吞掉 → 计数 → >=4禁用 │          │
                                  └───────────────────────────┘       └───────────┬───┘
                                                                                    │
                                                                                    ▼
                                                                              禁用触发器
                                                                              status=INACTIVE
```

---

### 6.4 重试层级的精确边界（最终版）

```
BullMQ 队列级重试 (5次, 指数退避)
  ├─ 适用范围：仅 Webhook/GitHub 动作（Slack 完全不重试）
  ├─ 触发条件：
  │   ├─ LangfuseNotFoundError (配置丢失)
  │   ├─ InternalServerError (内部服务异常)
  │   │   ├─ Action config not found
  │   │   ├─ Invalid webhook configuration
  │   │   ├─ Invalid webhook payload
  │   │   └─ Failed to generate signature
  │   └─ 任意错误 + !actionConfig (配置不存在时强制重试)
  └─ 不触发条件：
      ├─ HTTP非2xx响应
      ├─ 网络错误/超时
      ├─ URL验证失败
      ├─ 重定向安全检查失败
      └─ 所有 Slack 错误（全部在内部吞掉）

HTTP 请求级重试 (4次, exponential-backoff)
  ├─ 仅 Webhook/GitHub Dispatch 有此层级
  ├─ 触发条件：
  │   ├─ 网络错误 (fetch失败)
  │   ├─ HTTP 非 2xx 响应
  │   └─ 请求超时 (AbortError)
  └─ 注意：HTTP重试耗尽后，仍可能不触发 BullMQ 重试（取决于错误类型）

无重试层级 (Slack专属)
  └─ 任何失败直接进入 ERROR 状态 + 立即禁用触发器
     ⚠️ Slack 完全没有队列级重试保护
```

---

### 6.5 连续失败计数逻辑

```typescript
export const getConsecutiveAutomationFailures = async ({automationId, projectId}) => {
  const automation = await getAutomationById({automationId, projectId});

  // 如果配置了 lastFailingExecutionId，仅统计该次之后的执行
  const whereClause = {
    triggerId: automation.trigger.id,
    actionId: automation.action.id,
    projectId,
    status: { in: [ERROR, COMPLETED] },
  };

  // 如果有 lastFailingExecutionId，只统计该次执行之后的记录
  if (automation.action.config.lastFailingExecutionId) {
    const lastFailing = await prisma.automationExecution.findUnique({
      where: { id: automation.action.config.lastFailingExecutionId },
      select: { createdAt: true },
    });
    if (lastFailing) {
      whereClause.createdAt = { gt: lastFailing.createdAt };
    }
  }

  const executions = await prisma.automationExecution.findMany({
    where: whereClause,
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { status: true },
  });

  // 统计连续失败，遇到成功即停止
  let consecutiveFailures = 0;
  for (const execution of executions) {
    if (execution.status === ActionExecutionStatus.ERROR) {
      consecutiveFailures++;
    } else if (execution.status === ActionExecutionStatus.COMPLETED) {
      break;
    }
  }

  return consecutiveFailures;
};
```

---

## 7. 状态追踪与数据模型

### 7.1 AutomationExecution 状态流转（分动作类型）

```
                    +----------------+
                    |   PENDING      |  初始状态（入队前创建）
                    +-------+--------+
                            |
                    +-------v--------+
          +-------->|  PROCESSING    |  处理器开始执行（隐含状态）
          |         +-------+--------+
          |                 |
      成功 |         失败    |
          |                 +-------------------+
  +-------v--------+                              |
  |  COMPLETED     |                              |
  +-------+--------+                              |
          |                                       |
          |                              +--------v---------+
          │                              │       ERROR      │
          │                              +--------+---------+
          │                                       │
          │                    ┌──────────────────┴──────────────────┐
          │                    │                                         │
          │          ┌─────────v──────────┐                 ┌──────────v─────────┐
          │          │  Webhook/GitHub    │                 │       Slack        │
          │          │  检查错误类型       │                 │   单次失败即禁用   │
          │          ├─ 可重试 → throw    │                 └────────────────────┘
          │          └─ 不可重试 → 计数    │
          │              ┌───────────┴───────────┐
          │              │                       │
          │      ┌───────v───────┐       ┌──────v───────┐
          │      │ 连续失败 < 4  │       │ 连续失败 >=4 │
          │      │   保持激活    │       │   禁用触发器  │
          │      └───────────────┘       └──────┬───────┘
          │                                       │
          └───────────────────────────────────────┼─────────────────────────────────┐
                                                  │                                 │
                                          ┌───────v───────┐
                                          │ 触发器已禁用  │
                                          │ status=INACTIVE
                                          └───────────────┘
```

### 7.2 核心数据字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 执行唯一ID |
| `projectId` | UUID | 项目ID |
| `automationId` | UUID | 自动化ID |
| `triggerId` | UUID | 触发器ID |
| `actionId` | UUID | 动作ID |
| `status` | Enum | `PENDING` / `COMPLETED` / `ERROR` / `CANCELLED` |
| `startedAt` | DateTime | 开始执行时间 |
| `finishedAt` | DateTime | 完成/失败时间 |
| `sourceId` | String | 触发源ID（如 promptId） |
| `input` | JSON | 输入参数快照 |
| `output` | JSON | 执行输出（HTTP状态、响应体） |
| `error` | String | 错误信息（status=ERROR时） |

---

## 8. Payload 格式规范

### 8.1 Webhook 请求体

```json
{
  "id": "exec_abc123",           // executionId
  "timestamp": "2024-01-15T10:30:00.000Z",
  "type": "prompt-version",      // 事件类型
  "apiVersion": "v1",            // API 版本
  "action": "created",           // 触发动作
  "user": {                      // 触发用户（可选）
    "id": "user_xyz",
    "name": "John Doe",
    "email": "john@example.com"
  },
  "prompt": {                    // Prompt 完整数据
    "id": "prompt_123",
    "name": "My Prompt",
    "version": 3,
    "prompt": {...},             // Prompt 内容
    "config": {...},             // 配置
    "tags": ["production"],
    "createdAt": "2024-01-15T10:00:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

### 8.2 请求头

```http
Content-Type: application/json
X-Langfuse-Signature: t=1705314600,v1=abcdef123456...
User-Agent: Langfuse-Webhook/v1
// + 自定义请求头
```

---

## 9. 关键环境变量配置

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `LANGFUSE_WEBHOOK_TIMEOUT_MS` | - | HTTP 请求超时（毫秒） |
| `LANGFUSE_WEBHOOK_MAX_REDIRECTS` | - | 最大重定向次数 |
| `LANGFUSE_WEBHOOK_WHITELISTED_HOST` | `[]` | 白名单主机列表 |
| `LANGFUSE_WEBHOOK_WHITELISTED_IPS` | `[]` | 白名单IP列表 |
| `LANGFUSE_WEBHOOK_WHITELISTED_IP_SEGMENTS` | `[]` | 白名单IP段 |

---

## 10. 监控与可观测性

### 10.1 日志关键字段

```typescript
logger.info("Webhook executed", {
  actionId: automation.action.id,
  projectId,
  executionId,
  httpStatus,
  redirectChain: redirectResult.redirectChain.length,
  finalUrl: redirectResult.finalUrl,
});
```

### 10.2 关键监控指标

- `webhook.executions.total` - 总执行次数
- `webhook.executions.success` - 成功次数
- `webhook.executions.error` - 失败次数
- `webhook.retries.count` - 重试次数（需区分HTTP级 vs BullMQ级）
- `webhook.bullmq_retries.count` - BullMQ队列级重试次数
- `webhook.http_retries.count` - HTTP内部重试次数
- `webhook.latency.ms` - 执行延迟
- `webhook.disabled_triggers` - 被禁用的触发器数量
- `webhook.disabled_by_type` - 按动作类型统计禁用次数

---

## 总结（最终版）

### 核心设计要点

1. **双层重试机制（适用范围不同）**：
   - **HTTP级重试（4次）**：Webhook/GitHub 的网络/HTTP错误，在 executeHttpAction 内部处理
   - **BullMQ队列级重试（5次）**：仅适用于 Webhook/GitHub 的特定内部错误（LangfuseNotFoundError、InternalServerError），Slack 完全无队列级重试保护

2. **深度安全防护**：
   - URL协议/端口/主机验证
   - 重定向安全检查
   - 敏感头自动剥离
   - HMAC-SHA256签名校验

3. **差异化熔断策略**：
   - **Webhook/GitHub**：外部错误（HTTP/网络）不触发队列重试，连续失败4次自动禁用触发器
   - **Slack**：任何错误都直接在内部吞掉，单次失败即禁用触发器，无任何重试缓冲

4. **完整可追溯性**：
   - 所有执行记录持久化存储
   - 包含完整输入输出快照
   - `lastFailingExecutionId` 标记失败基准点（重置计数窗口）

5. **灵活扩展架构**：
   - 统一的 Automation 框架
   - 支持 Webhook、Slack、GitHub 等多种动作类型

---

### 重试层级汇总表（最终口径）

| 重试层级 | Webhook/GitHub | Slack | 说明 |
|---------|---------------|-------|------|
| BullMQ 队列级 | ✅ **仅特定错误** (5次) | ❌ 完全不重试 | 仅 LangfuseNotFoundError、InternalServerError、actionConfig 不存在时触发 |
| HTTP 请求级 | ✅ 4次 | ❌ 无 | 网络错误、非2xx响应、超时等外部问题 |
| 连续失败计数 | ✅ 有 | ❌ 无 | 仅 Webhook/GitHub 统计历史失败次数 |
| 禁用触发器阈值 | >= 4次 | = 1次 | Slack 任意失败立即禁用，无容错窗口 |
| 错误吞掉范围 | 仅外部错误 | **全部错误** | Slack 在 catch 中处理所有异常，无 throw |

> **⚠️ 重要边界说明**：
>
> 1. Slack 动作进入处理器后，**任何错误都不会触发队列级重试**，直接标记为 ERROR 并禁用触发器。
>
> 2. Webhook/GitHub 动作中，**只有内部系统错误才会触发 BullMQ 重试**，所有 HTTP/网络/外部错误都会在 executeHttpAction 内部被吞掉，直接计入失败计数。
>
> 3. 队列重试配置（attempts=5）实际上对大部分外部失败场景不起作用，仅作为内部错误的兜底保护。
>
> 4. Slack 是"脆弱模式"，Webhook/GitHub 是"有限容错模式"。
