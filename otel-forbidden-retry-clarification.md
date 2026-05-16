# Langfuse OTEL ForbiddenError 重试行为校准报告

**校准日期**: 2026-05-16  
**校准范围**: OtelIngestionProcessor 内部 catch 与 Worker 外层 catch 的 ForbiddenError 控制流

---

## 一、完整控制流分析

### 1.1 层级 1: OtelIngestionProcessor 内部 catch

**函数位置**: `packages/shared/src/server/otel/OtelIngestionProcessor.ts:578-588`

```typescript
} catch (error) {
  // 分支 1: ForbiddenError
  if (error instanceof ForbiddenError) {
    traceException(error, span);
    throw error;    // ➡️ 重新抛出异常
  }

  // 分支 2: 其他所有错误
  logger.error("Error processing OTEL spans:", error);
  traceException(error, span);
  return [];       // ➡️ 静默继续，返回空数组
}
```

**本层级行为总结**:

| 错误类型 | 分支条件 | 本层级行为 |
|---------|---------|-----------|
| `ForbiddenError` | `error instanceof ForbiddenError` | ✅ 记录 Sentry，然后 `throw error` 重新抛出 |
| 其他所有异常 | 否则 | ✅ 记录日志，然后 `return []` 静默继续 |

---

### 1.2 层级 2: Worker 外层 catch

**调用位置**: `worker/src/queues/otelIngestionQueue.ts:300`

```typescript
const events = await processor.processToIngestionEvents(parsedSpans);
```

**外层 catch 位置**: `worker/src/queues/otelIngestionQueue.ts:527-544`

```typescript
} catch (e) {
  const fileKey = job.data.payload.data.fileKey;
  
  // 分支 1: ForbiddenError
  if (e instanceof ForbiddenError) {
    traceException(e);
    logger.warn(`Failed to parse otel observation: ${e.message}`, {
      error: e, fileKey,
    });
    return;    // ➡️ 正常返回，不触发重试
  }

  // 分支 2: 其他所有错误
  logger.error(`Failed job otel ingestion processing for ${projectId}`, { error: e, fileKey });
  traceException(e);
  throw e;     // ➡️ 抛出异常，触发 BullMQ 重试
}
```

**本层级行为总结**:

| 错误类型 | 分支条件 | 本层级行为 |
|---------|---------|-----------|
| `ForbiddenError` | `e instanceof ForbiddenError` | ✅ 记录 Sentry + WARN 日志，然后 `return` 正常结束 |
| 其他所有异常 | 否则 | ✅ 记录 ERROR 日志 + Sentry，然后 `throw e` 触发重试 |

---

## 二、最终结果结论表

| 错误类型 | Processor 内部行为 | Worker 外层行为 | **最终结果** | 是否重试 |
|---------|-------------------|----------------|-------------|---------|
| **ForbiddenError** | throw 重新抛出 | return 正常结束 | ✅ **静默终止** | ❌ **不重试** |
| 其他所有异常 | return [] 继续 | N/A (不会走到外层 catch) | ✅ 静默继续处理后续 | ❌ **不重试** |

---

## 三、控制流路径示意图

```
                        processor.processToIngestionEvents()
                                  |
                                  ▼
                      ┌──────────────────────────┐
                      │       try 块执行         │
                      └───────────┬──────────────┘
                                  |
                ┌─────────────────┴──────────────────┐
                ▼                                    ▼
        抛出 ForbiddenError                   抛出其他异常
                |                                    |
                ▼                                    ▼
      Processor catch 分支 1               Processor catch 分支 2
                |                                    |
          throw error                          return []
                |                                    |
                ▼                                    ▼
      传播到 Worker 外层 catch                后续代码继续执行
                |                                    |
                ▼                                    ▼
      Worker catch 分支 1                      正常完成
                |                                    |
            return 正常结束                      BullMQ 标记完成
                |                                    |
                ▼                                    ▼
          ✅ 静默终止，不重试                      ✅ 任务完成
```

---

## 四、口径冲突原因说明

### 为什么之前会出现"会重试"的误判？

**原因 1: 只看了半段代码**

在 `OtelIngestionProcessor.ts:581` 只看到 `throw error`，误以为这就是最终行为，实际上这个 throw 只是把异常**重新抛回给上层调用者**，而不是直接触发 BullMQ 重试。

**原因 2: 没追踪完整传播链路**

```
Processor 内部 throw → 被 Worker 外层 catch 捕获 → Worker 外层 return → BullMQ 认为任务成功完成
```

中间有一个 catch 拦截层，异常没有穿透到 BullMQ。

**原因 3: 与普通 Ingestion 管线的行为混淆**

普通 Ingestion 管线**没有**外层的 ForbiddenError 特殊分支，如果异常抛到最外层就会触发重试。OTEL 管线有特殊的 ForbiddenError 静默处理逻辑，两条管线行为不一致。

---

## 五、校准后最终结论

### ✅ 最终结论：ForbiddenError 在 OTEL 管线中**不会重试**

完整控制流：
1. Processor 内部遇到 ForbiddenError → throw 重新抛出
2. Worker 外层 catch 捕获 ForbiddenError → return 正常结束
3. BullMQ 收到正常返回 → 任务标记为完成，**不触发任何重试**

### 📌 关键提醒

ForbiddenError 属于**业务错误**（权限类、配置类），重试没有意义：
- 项目被暂停
- API Key 无效
- Feature Flag 未开启

这类问题重试多少次都不会解决，静默丢弃是合理设计。

---

## 六、代码索引

| 功能 | 文件路径 | 行号 |
|-----|---------|-----|
| Processor 内部 ForbiddenError 分支 | `packages/shared/src/server/otel/OtelIngestionProcessor.ts` | L579-581 |
| Processor 内部其他错误分支 | `packages/shared/src/server/otel/OtelIngestionProcessor.ts` | L584-588 |
| Worker 外层 ForbiddenError 分支 | `worker/src/queues/otelIngestionQueue.ts` | L529-535 |
| Worker 外层其他错误分支 | `worker/src/queues/otelIngestionQueue.ts` | L538-543 |
| Processor 方法调用点 | `worker/src/queues/otelIngestionQueue.ts` | L300 |

---

*校准基于 Langfuse v2.x 代码库，截止 2026-05-16*
