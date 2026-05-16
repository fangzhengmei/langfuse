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

### 2.2 队列级重试 vs HTTP级重试

| 层级 | 重试次数 | 触发条件 |
|------|---------|---------|
| BullMQ 队列级 | 5次 | 内部错误（如DB查询失败、配置错误） |
| HTTP 请求级 | 4次 | 网络错误、非2xx响应、超时 |

---

## 3. Webhook 处理器流程

**文件**: `worker/src/queues/webhooks.ts`

### 3.1 处理器入口

```typescript
export const webhookProcessor: Processor = async (job) => {
  return await executeWebhook(job.data.payload);
};

export const executeWebhook = async (input: WebhookInput) => {
  const automation = await getAutomationById({
    projectId: input.projectId,
    automationId: input.automationId,
  });

  // 根据动作类型分发
  switch (automation.action.type) {
    case "WEBHOOK":
      await executeWebhookAction({...});
      break;
    case "SLACK":
      await executeSlackAction({...});
      break;
    case "GITHUB_DISPATCH":
      await executeGitHubDispatchAction({...});
      break;
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
    additionalSensitiveHeaders: [...], // 需特殊处理的敏感头
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
          throw new Error(`Webhook returned ${res.status}`);
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

### 6.1 错误分类与处理策略

```typescript
catch (error) {
  // 1. 可重试错误：触发 BullMQ 队列级重试
  const shouldRetryJob = 
    error instanceof LangfuseNotFoundError ||  // 配置丢失（可能是并发删除）
    error instanceof InternalServerError;       // 内部服务错误

  if (shouldRetryJob) {
    logger.warn(`Retrying BullMQ for action ${automation.action.id}`);
    throw error;  // 重新抛出触发 BullMQ 重试
  }

  // 2. 不可重试错误：标记为 ERROR，不触发队列重试
  await prisma.$transaction(async (tx) => {
    // 更新执行记录
    await tx.automationExecution.update({
      where: {id: executionId, projectId},
      data: {
        status: ActionExecutionStatus.ERROR,
        startedAt: executionStart,
        finishedAt: new Date(),
        error: error.message,
        output: httpStatus ? {httpStatus, responseBody: responseBody?.substring(0, 1000)} : undefined,
      },
    });

    // 计算连续失败次数
    const consecutiveFailures = await getConsecutiveAutomationFailures({
      automationId: automation.id,
      projectId,
    });

    // 3. 连续失败阈值：4次后自动禁用触发器
    if (consecutiveFailures >= 4) {
      await tx.trigger.update({
        where: { id: automation.trigger.id, projectId },
        data: { status: JobConfigState.INACTIVE },
      });

      // 记录最后一次失败的执行ID（用于重置计数）
      await setActionLastFailingExecutionId({
        tx,
        actionId: automation.action.id,
        projectId,
        executionId,
      });

      logger.warn(`Automation disabled after ${consecutiveFailures} consecutive failures`);
    }
  });
}
```

### 6.2 连续失败计数逻辑

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

### 7.1 AutomationExecution 状态流转

```
                    +----------------+
                    |   PENDING      |  初始状态（入队前创建）
                    +-------+--------+
                            |
                    +-------v--------+
          +-------->|  PROCESSING    |  处理器开始执行（隐含状态）
          |         +-------+--------+
          |                 |
      成功 |             失败 |
          |                 |
  +-------v--------+  +-----v----------+
  |  COMPLETED     |  |     ERROR      |
  +----------------+  +----------------+
        |                    |
        |        连续失败 >=4 次，触发状态变更
        |                    |
        |             +------v-------+
        |             |  触发器禁用   |  status=INACTIVE
        |             +--------------+
        |
        v
    正常继续
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
- `webhook.retries.count` - 重试次数
- `webhook.latency.ms` - 执行延迟
- `webhook.disabled_triggers` - 被禁用的触发器数量

---

## 总结

Langfuse Webhook 系统设计要点：

1. **多层重试机制**：队列级（5次）+ HTTP级（4次），兼顾可靠性和效率
2. **深度安全防护**：URL验证、重定向检查、敏感头剥离、HMAC签名
3. **熔断保护**：连续失败4次自动禁用触发器，防止雪崩
4. **完整可追溯性**：所有执行记录持久化，包含完整输入输出快照
5. **灵活扩展**：统一的 Automation 框架，支持 Webhook、Slack、GitHub 等多种动作类型
