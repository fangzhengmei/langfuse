# Webhook 发件箱机制报告

## 一、发件箱写入机制

### 1.1 整体流程

**注意：写库和入队是两步独立操作，非原子事务**

```
事件触发 → 过滤器匹配 → 写库（发件箱） → 入队（BullMQ）
     ↓ (若入队失败)
  数据已落库，需手动补偿重试
```

### 1.2 关键代码路径（`promptVersionProcessor.ts:194-237`）

```typescript
// 第一步：写发件箱数据库（原子操作）
await prisma.automationExecution.create({
  data: {
    id: executionId,
    projectId,
    automationId: automations[0].id,
    triggerId,
    actionId,
    status: ActionExecutionStatus.PENDING,  // 初始状态 PENDING
    sourceId: promptData.id,
    input: { ... },
  },
});

// 第二步：入队（独立操作，非事务性）
// 【风险点】：若写库成功但入队失败，数据会停留在 PENDING 状态，需后台补偿
await WebhookQueue.getInstance()?.add(QueueName.WebhookQueue, {
  timestamp: new Date(),
  id: v4(),
  payload: {
    projectId,
    automationId: automations[0].id,
    executionId,  // 关联发件箱记录ID
    payload: { ... },
  },
  name: QueueJobs.WebhookJob,
});
```

### 1.3 发件箱表结构

数据库表：`automation_executions`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String | 执行记录ID（UUID） |
| `status` | Enum | PENDING / COMPLETED / ERROR / CANCELLED |
| `startedAt` | DateTime? | Worker 开始消费时间 |
| `finishedAt` | DateTime? | 完成/失败时间 |
| `error` | String? | 错误信息 |
| `output` | Json? | HTTP 响应结果 |

### 1.4 一致性边界

| 阶段 | 一致性保证 |
|------|-----------|
| 写库阶段 | 数据库 ACID 保证，要么成功要么回滚 |
| 入队阶段 | 无事务保证，写库成功但入队失败会产生「孤儿记录」 |
| 建议补偿 | 定期扫描 `status=PENDING` 且 `createdAt < N分钟` 的记录 |

---

## 二、Worker 消费流程

### 2.1 队列处理器入口（`webhooks.ts:38-47`）

```typescript
export const webhookProcessor: Processor = async (
  job: Job<TQueueJobTypes[QueueName.WebhookQueue]>,
) => {
  try {
    return await executeWebhook(job.data.payload);
  } catch (error) {
    logger.error("Error executing WebhookJob", error);
    throw error;  // 异常透传给 BullMQ 触发队列层重试
  }
};
```

### 2.2 executeWebhook 主流程（`webhooks.ts:50-102`）

```
1. 查询 automation 配置
2. 根据 action.type 路由到对应处理器
   ├─ WEBHOOK → executeWebhookAction
   ├─ GITHUB_DISPATCH → executeGitHubDispatchAction
   └─ SLACK → executeSlackAction
3. 调用共享 HTTP 执行逻辑 executeHttpAction
```

### 2.3 状态更新时机

`startedAt` 在成功和失败两条路径都会更新，值为执行开始时间 `executionStart`：

- **成功路径**（`webhooks.ts:226-238`）：
  ```typescript
  data: {
    status: ActionExecutionStatus.COMPLETED,
    startedAt: executionStart,  // ✅ 更新
    finishedAt: new Date(),
  }
  ```

- **失败路径**（`webhooks.ts:262-281`）：
  ```typescript
  data: {
    status: ActionExecutionStatus.ERROR,
    startedAt: executionStart,  // ✅ 同样更新
    finishedAt: new Date(),
    error: ...,
    output: ...,
  }
  ```

| 字段 | 成功路径 | 失败路径 |
|------|---------|---------|
| `startedAt` | ✅ 更新 | ✅ 更新 |
| `finishedAt` | ✅ 更新 | ✅ 更新 |
| `status` | COMPLETED | ERROR |
| `error` | - | ✅ 设置 |
| `output` | - | ✅ 设置（HTTP 结果） |

---

## 三、签名与时间戳机制

### 3.1 签名算法实现（`signature.ts:25-40`）

```typescript
// 生成 HMAC-SHA256 签名
export function generateWebhookSignature(
  payload: string,
  timestamp: number,  // Unix 时间戳（秒）
  secret: string,
): string {
  const signedPayload = `${timestamp}.${payload}`;
  return crypto
    .createHmac("sha256", secret)
    .update(signedPayload, "utf-8")
    .digest("hex");
}

// 生成签名头
export function createSignatureHeader(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);  // 秒级时间戳
  const signature = generateWebhookSignature(payload, timestamp, secret);
  return `t=${timestamp},v1=${signature}`;
}
```

### 3.2 签名注入位置（`webhooks.ts:415-425`）

```typescript
try {
  const decryptedSecret = decrypt(webhookConfig.secretKey);
  const signature = createSignatureHeader(webhookPayload, decryptedSecret);
  requestHeaders["x-langfuse-signature"] = signature;  // 注入签名头
} catch (error) {
  logger.error("Failed to decrypt webhook secret or generate signature", error);
  throw new InternalServerError("Failed to generate webhook signature");
}
```

### 3.3 签名头格式

```
x-langfuse-signature: t=1715423456,v1=a1b2c3d4e5f6...
```

### 3.4 接收方验证建议

1. 从 header 提取 `t`（时间戳）和 `v1`（签名）
2. 用相同 secret 重新计算 `HMAC(timestamp + "." + payload)`
3. 比较计算结果与 header 中的签名
4. 验证时间戳是否在合理窗口内（如 5 分钟）防止重放

---

## 四、两层退避重试架构

### 4.1 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                   BullMQ 队列层重试（外层）                    │
│              attempts: 5 次，指数退避，间隔: 5s/10s/20s/40s/80s  │
└─────────────────────────────────────────────────────────────┘
                          ↓ （仅特定错误触发）
┌─────────────────────────────────────────────────────────────┐
│                HTTP 请求层重试（内层）                          │
│              attempts: 4 次，exponential-backoff 库             │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 队列层配置（`webhookQueue.ts:31-39`）

```typescript
defaultJobOptions: {
  removeOnComplete: true,
  removeOnFail: 100_000,
  attempts: 5,                     // 最多重试 5 次
  backoff: {
    type: "exponential",         // 指数退避
    delay: 5000,                   // 初始延迟 5 秒
  },
},
```

**退避公式**：`delay = 5000 * 2^(attempt-1)` 毫秒

| 重试次数 | 延迟时间 |
|---------|---------|
| 第 1 次 | 5 秒 |
| 第 2 次 | 10 秒 |
| 第 3 次 | 20 秒 |
| 第 4 次 | 40 秒 |
| 第 5 次 | 80 秒 |

### 4.3 HTTP 请求层重试（`webhooks.ts:136-223`）

```typescript
await backOff(
  async () => {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, env.LANGFUSE_WEBHOOK_TIMEOUT_MS);  // 超时中止

    try {
      const whitelist = whitelistFromEnv();
      if (!skipValidation) await validateWebhookURL(url, whitelist);  // URL 白名单

      const redirectResult = await fetchWithSecureRedirects(
        url,
        { method: "POST", body: payload, headers, signal: abortController.signal },
        redirectOptions,
      );

      if (!redirectResult.response.ok) {
        throw new Error("Webhook does not return 2xx status");
      }
    } finally {
      clearTimeout(timeoutId);
    }
  },
  {
    numOfAttempts: 4,  // 请求内重试 4 次
  },
);
```

**注意**：HTTP 层重试对所有异常都生效，包括：
- 网络超时（AbortError）
- 非 2xx 状态码
- 重定向校验失败
- DNS 解析失败等网络问题

---

## 五、失败分流策略与补偿建议

### 5.1 失败分流核心逻辑（`webhooks.ts:244-252`）

这是整个机制最关键的分流决策点：

```typescript
// 【关键判断】哪些错误触发队列层重试，哪些错误直接终止
const shouldRetryJob =
  error instanceof LangfuseNotFoundError ||
  error instanceof InternalServerError;

if (shouldRetryJob) {
  logger.warn(`Retrying BullMQ for action ${automation.action.id}`);
  throw error;  // ✅ 抛出异常 → 触发 BullMQ 队列层重试
}

// ❌ 不抛出异常 → 直接落库为 ERROR，终止重试
```

### 5.2 错误类型分类与处理策略

| 错误类型 | 触发队列重试？ | 落库状态 | 说明 |
|---------|---------------|---------|------|
| `LangfuseNotFoundError` | ✅ 是 | - | 配置未找到（如 automation/action 被删除），可能是临时一致性问题 |
| `InternalServerError` | ✅ 是 | - | 服务器内部错误（如签名生成失败、数据库异常），可重试 |
| HTTP 非 2xx 状态码 | ❌ 否 | ERROR | 接收方返回错误，不重试 |
| 网络超时（AbortError） | ❌ 否 | ERROR | 超时，不重试 |
| URL 白名单校验失败 | ❌ 否 | ERROR | 安全校验失败，不重试 |
| 重定向超过次数 | ❌ 否 | ERROR | 安全校验失败，不重试 |
| 其他网络异常 | ❌ 否 | ERROR | 网络问题，不重试 |

### 5.3 熔断器机制（`webhooks.ts:283-318`）

连续失败 4 次后，自动禁用触发器（Circuit Breaker）：

```typescript
// 查询该 automation 的连续失败次数
const consecutiveFailures = await getConsecutiveAutomationFailures({
  automationId: automation.id,
  projectId,
});

if (consecutiveFailures >= 4) {
  // 禁用触发器，停止后续事件触发
  await tx.trigger.update({
    where: { id: automation.trigger.id, projectId },
    data: { status: JobConfigState.INACTIVE },
  });

  // 记录最后一次失败的 executionId 用于排查
  await setActionLastFailingExecutionId({ tx, actionId, projectId, executionId });

  logger.warn(
    `Automation ${automation.trigger.id} disabled after ${consecutiveFailures} consecutive failures`,
  );
}
```

### 5.4 状态流转图

```
                     入队成功
PENDING ────────────────────────────────────→ Worker 消费
   │                                                │
   │ 入队失败                                       │
   └──→ 孤儿记录（需补偿）                          │
                                                    │
                        ┌───────────────────────────┴───────────────────────────┐
                        │                                                         │
                   执行成功                                                    执行失败
                        │                                                         │
                        ↓                                                         ↓
                  COMPLETED                                        ┌───────────────────────┐
                  finishedAt                                       │   判断错误类型         │
                  output                                           └───────────┬───────────┘
                                                                               │
                                                      ┌────────────────────────┴───────────────────────┐
                                                      │                                                │
                                          可重试错误（NotFound/Internal）                        不可重试错误
                                                      │                                                │
                                                      ↓                                                ↓
                                          throw error 触发队列重试                              落库 ERROR
                                                      │                                        finishedAt
                                                      │                                        error
                                            (重试 5 次后仍失败)                                output
                                                      │
                                                      └────────────→ 最终落库 ERROR
```

### 5.5 补偿与运维建议

#### 问题 1：写库成功但入队失败（孤儿记录）

**现象**：`status=PENDING` 且 `startedAt is null` 且 `createdAt` 超过 N 分钟

**建议补偿方案**：
```sql
-- 查询可能的孤儿记录
SELECT id, project_id, created_at
FROM automation_executions
WHERE status = 'PENDING'
  AND started_at IS NULL
  AND created_at < NOW() - INTERVAL '10 minutes';
```

**处理方式**：
1. 定时任务扫描上述记录
2. 对于有效的 execution，重新入队
3. 告警通知运维介入

#### 问题 2：队列重试耗尽后仍失败（死信）

**现象**：BullMQ 5 次重试全部失败，任务进入 failed 状态

**建议**：
1. 配置 BullMQ 的 dead letter queue
2. 定期检查死信队列
3. 对于可恢复的错误（如临时网络问题），手动重入队

#### 问题 3：熔断器触发后自动恢复

**当前实现**：熔断器一旦触发，触发器永久禁用，需手动重新启用

**建议改进**：
1. 增加半开状态（half-open）支持
2. 配置冷却期后自动尝试恢复
3. 增加告警通知机制

#### 问题 4：重试风暴风险

**当前风险**：
- HTTP 层 4 次重试 × 队列层 5 次 = 单任务最多 20 次请求
- 大量 webhook 同时失败可能导致重试风暴

**缓解建议**：
1. 增加 jitter（抖动）到退避算法
2. 配置队列并发度限制
3. 增加熔断器的快速失败机制

---

## 附录：关键配置参数汇总

| 配置项 | 值 | 位置 | 说明 |
|--------|-----|------|------|
| BullMQ attempts | 5 | `webhookQueue.ts:34` | 队列层最大重试次数 |
| BullMQ backoff delay | 5000ms | `webhookQueue.ts:37` | 队列层初始退避延迟 |
| HTTP backOff attempts | 4 | `webhooks.ts:221` | 请求内重试次数 |
| 连续失败熔断阈值 | 4 | `webhooks.ts:294` | 连续失败后禁用触发器 |
| 签名算法 | HMAC-SHA256 | `signature.ts:31` | 签名算法 |
| 时间戳精度 | 秒 | `signature.ts:38` | 签名时间戳精度 |
| 重试触发错误类型 | 2 种 | `webhooks.ts:245-247` | 仅 NotFound 和 InternalServerError 触发队列重试 |
