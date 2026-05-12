# Webhook 发件箱机制报告

## 一、整体管线概述

Langfuse 的 Webhook 系统采用"先发件箱（Outbox）模式，确保事件的可靠投递。整个流程分为三个核心阶段：**发件箱写入**、**签名生成**、**异步投递与退避重试**。

---

## 二、发件箱写入机制

### 2.1 触发入口

**文件位置：`worker/src/features/entityChange/promptVersionProcessor.ts`

### 2.2 核心流程

```
事件触发 → 过滤器匹配 → 发件箱持久化 → 队列入队
```

### 2.3 发件箱表结构

数据库表：`automation_executions`（Prisma Schema 模型 `AutomationExecution`）

**关键字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String | 执行记录ID（UUID） |
| `projectId` | String | 项目ID |
| `automationId` | String | 自动化配置ID |
| `triggerId` | String | 触发器ID |
| `actionId` | String | 动作ID |
| `status` | Enum | 执行状态（PENDING/COMPLETED/ERROR/CANCELLED） |
| `sourceId` | String | 触发源ID（如 prompt ID） |
| `input` | Json | webhook 负载数据 |
| `output` | Json? | 执行结果（HTTP 响应等） |
| `startedAt` | DateTime? | 开始执行时间 |
| `finishedAt` | DateTime? | 完成时间 |
| `error` | String? | 错误信息 |

### 2.4 写入逻辑（`promptVersionProcessor.ts:164-237）

```typescript
// 1. 创建发件箱记录（原子写入数据库）
await prisma.automationExecution.create({
  data: {
    id: executionId,
    projectId,
    automationId: automations[0].id,
    triggerId,
    actionId,
    status: ActionExecutionStatus.PENDING,  // 初始状态为 PENDING
    sourceId: promptData.id,
    input: { ... },
  },
});

// 2. 加入 BullMQ 队列异步处理
await WebhookQueue.getInstance()?.add(QueueName.WebhookQueue, {
  timestamp: new Date(),
  id: v4(),
  payload: {
    projectId,
    automationId: automations[0].id,
    executionId,  // 关联发件箱记录ID
    payload: { ... },  // webhook 实际负载
  },
  name: QueueJobs.WebhookJob,
});
```

### 2.5 一致性保障

- **原子性**：先写数据库，再入队，保证即使队列服务故障，数据不会丢失
- **幂等性**：通过 `executionId` 关联，确保重复投递可追踪
- **可观测性**：所有执行历史永久保存在数据库中，支持审计

---

## 三、签名与时间戳机制

### 3.1 签名算法实现

**文件位置**：`packages/shared/src/encryption/signature.ts`

### 3.2 签名生成逻辑

采用 **HMAC-SHA256** 算法，包含时间戳防止重放攻击。

```typescript
// signature.ts:25-35
export function generateWebhookSignature(
  payload: string,
  timestamp: number,  // Unix 时间戳（秒）
  secret: string,
) {
  const signedPayload = `${timestamp}.${payload}`;
  return crypto
    .createHmac("sha256", secret)
    .update(signedPayload, "utf-8")
    .digest("hex");
}

// signature.ts:37-40
export function createSignatureHeader(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);  // 秒级时间戳
  const signature = generateWebhookSignature(payload, timestamp, secret);
  return `t=${timestamp},v1=${signature}`;  // 格式：t=123456,v1=abcdef
}
```

### 3.3 签名头格式

```
x-langfuse-signature: t=1715423456,v1=a1b2c3d4e5f6...
```

### 3.4 签名头注入位置（`webhooks.ts:415-425`）

```typescript
// webhooks.ts:415-425
try {
  const decryptedSecret = decrypt(webhookConfig.secretKey);
  const signature = createSignatureHeader(webhookPayload, decryptedSecret);
  requestHeaders["x-langfuse-signature"] = signature;  // 注入签名头
} catch (error) {
  logger.error("Failed to decrypt webhook secret or generate signature", error);
  throw new InternalServerError("Failed to generate webhook signature");
}
```

### 3.5 验证方验证逻辑（接收方）

接收方应按以下步骤验证：

1. 从 header 中提取 `t`（时间戳）和 `v1`（签名）
2. 用相同的 secret 重新计算 `HMAC(timestamp + "." + payload`
3. 比较计算结果与 header 中的签名
4. 验证时间戳是否在合理时间窗口内（如 5 分钟）防止重放

---

## 四、失败退避与重试机制

### 4.1 两层重试架构

Langfuse 采用 **BullMQ 队列层** + **HTTP 请求层** 双层重试保障：

```
BullMQ 队列重试（5次，指数退避）
    ↓
HTTP 请求内重试（exponential-backoff 库，4次）
```

### 4.2 BullMQ 队列层配置（`webhookQueue.ts:31-39`）

```typescript
defaultJobOptions: {
  removeOnComplete: true,      // 成功后删除
  removeOnFail: 100_000,           // 失败保留最近10万条
  attempts: 5,                     // 最多重试5次
  backoff: {
    type: "exponential",         // 指数退避
    delay: 5000,                   // 初始延迟5秒
  },
},
```

**退避公式**：`delay = 5000 * 2^(attempt-1) 毫秒

| 重试次数 | 延迟时间 |
|---------|---------|
| 第1次 | 5秒 |
| 第2次 | 10秒 |
| 第3次 | 20秒 |
| 第4次 | 40秒 |
| 第5次 | 80秒 |

### 4.3 HTTP 请求层重试（`webhooks.ts:136-223`）

使用 `exponential-backoff` 库，在单次队列任务内再做 4 次重试：

```typescript
await backOff(
  async () => {
    // 实际 HTTP 请求逻辑
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();  // 超时中止
    }, env.LANGFUSE_WEBHOOK_TIMEOUT_MS);  // 配置超时时间

    const redirectResult = await fetchWithSecureRedirects(
      url,
      {
        method: "POST",
        body: payload,
        headers,
        signal: abortController.signal,
      },
      redirectOptions,
    );

    if (!res.ok) {
      throw new Error("Webhook does not return 2xx status");
    }
  },
  {
    numOfAttempts: 4,  // 请求内重试4次
  },
);
```

### 4.4 熔断器机制（Circuit Breaker）

连续失败 4 次后，自动禁用触发器（Trigger）：

```typescript
// webhooks.ts:283-318
// 检查连续失败次数
const consecutiveFailures = await getConsecutiveAutomationFailures({
  automationId: automation.id,
  projectId,
});

if (consecutiveFailures >= 4) {
  // 禁用触发器
  await tx.trigger.update({
    where: { id: automation.trigger.id, projectId },
    data: { status: JobConfigState.INACTIVE },
  });

  // 记录最后一次失败的 executionId
  await setActionLastFailingExecutionId({
    tx,
    actionId: automation.action.id,
    projectId,
    executionId,
  });

  logger.warn(
    `Automation ${automation.trigger.id} disabled after ${consecutiveFailures} consecutive failures`,
  );
}
```

### 4.5 状态流转

```
PENDING → （队列消费 → startedAt 设置
    ↓
  发送成功 → COMPLETED + finishedAt + output
    ↓
  发送失败 → ERROR + finishedAt + error + output
    ↓
  连续失败≥4次 → Trigger 禁用
```

---

## 五、完整管线流程图

```
┌─────────────────────────────────────────────────────────────────┐
│                        事件触发阶段                              │
├─────────────────────────────────────────────────────────────────┤
│  1. Prompt 版本变更事件                                          │
│  2. promptVersionProcessor 接收事件                            │
│  3. InMemoryFilterService 过滤匹配触发器                        │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      发件箱写入阶段（原子操作）                       │
├─────────────────────────────────────────────────────────────────┤
│  4. 生成 executionId (UUID)                                   │
│  5. INSERT INTO automation_executions (status=PENDING)            │
│  6. WebhookQueue.add() 加入 BullMQ 队列                           │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Worker 异步消费阶段                                    │
├─────────────────────────────────────────────────────────────────┤
│  7. webhookProcessor 从队列取任务                              │
│  8. executeWebhook() 执行动作                                     │
│  9. UPDATE automation_executions (startedAt=now)                  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                     签名生成阶段                                  │
├─────────────────────────────────────────────────────────────────┤
│ 10. 解密 webhook secret (AES 解密)                                │
│ 11. timestamp = 当前 Unix 时间戳（秒）                                  │
│ 12. HMAC-SHA256(timestamp + "." + payload)                │
│ 13. x-langfuse-signature: t=...,v1=...                         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                     HTTP 投递阶段                                │
├─────────────────────────────────────────────────────────────────┤
│ 14. fetchWithSecureRedirects() 安全重定向                      │
│ 15. 超时控制 (LANGFUSE_WEBHOOK_TIMEOUT_MS)                     │
│ 16. URL 白名单校验                                                │
│ 17. HTTP 2xx 验证                                               │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                   重试与退避阶段                                 │
├─────────────────────────────────────────────────────────────────┤
│ 18. 请求内重试 (backOff, 4次)                                  │
│ 19. 队列层重试 (BullMQ, 5次, 指数退避)                      │
│ 20. 连续失败≥4次 → 禁用触发器                                  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      结果持久化                                      │
├─────────────────────────────────────────────────────────────────┤
│ 21. 成功: status=COMPLETED, finishedAt, output                │
│ 22. 失败: status=ERROR, finishedAt, error, output             │
└─────────────────────────────────────────────────────────────────┘
```

---

## 六、关键配置参数

| 配置项 | 值 | 位置 | 说明 |
|--------|-----|------|------|
| `LANGFUSE_WEBHOOK_TIMEOUT_MS` | 环境变量 | `env.ts` | 单次请求超时时间 |
| `LANGFUSE_WEBHOOK_MAX_REDIRECTS` | 环境变量 | `env.ts` | 最大重定向次数 |
| BullMQ attempts | 5 | `webhookQueue.ts:34` | 队列层最大重试次数 |
| BullMQ backoff delay | 5000ms | `webhookQueue.ts:37` | 队列层初始退避延迟 |
| HTTP backOff attempts | 4 | `webhooks.ts:221` | 请求内重试次数 |
| 连续失败熔断阈值 | 4 | `webhooks.ts:294` | 连续失败后禁用触发器 |
| 签名算法 | HMAC-SHA256 | `signature.ts:31` | 签名算法 |
| 时间戳精度 | 秒 | `signature.ts:38` | 签名时间戳精度 |

---

## 七、一致性保障总结

1. **数据一致性**：先发件箱后入队，数据库事务保证不丢事件

2. **投递一致性**：双层重试机制（队列层 + 请求层，最大化投递成功率

3. **防重放**：时间戳签名，接收方可验证时间窗口

4. **故障隔离**：熔断器机制，避免对故障接收方持续施压

5. **可观测性**：全链路日志 + 数据库持久化，支持审计和问题排查
