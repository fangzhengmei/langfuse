# 媒体附件入库与短期签名访问链路复盘

## 一、整体架构概览

```
客户端 (SDK/前端)                       Langfuse 后端                     对象存储 (S3/Azure/GCS/OCI)
      |                                     |                                     |
      | 1. 请求上传签名 URL                 |                                     |
      |------------------------------------>|                                     |
      |                                     | 2. 校验权限 + 生成媒体记录          |
      |                                     |    (media 表)                       |
      |                                     | 3. 调用存储服务生成签名上传 URL      |
      |                                     |------------------------------------>|
      |                                     |<------------------------------------|
      | 4. 返回 uploadUrl + mediaId         |                                     |
      |<------------------------------------|                                     |
      |                                     |                                     |
      | 5. 直传文件到签名 URL                |                                     |
      |-------------------------------------------------------------------------->|
      |                                     |                                     | 6. 存储鉴权 (签名验证)
      |                                     |                                     |<---------->|
      | 7. 回调更新上传状态                  |                                     |
      |------------------------------------>|                                     |
      |                                     | 8. 更新 media 表 uploadHttpStatus   |
      |                                     |                                     |
      |-----------------------------------------------------------------------------
      |                                     |                                     |
      | 9. 请求访问媒体 (前端展示)           |                                     |
      |------------------------------------>|                                     |
      |                                     | 10. 校验权限 + 查询 media 表         |
      |                                     | 11. 生成短期签名下载 URL             |
      |                                     |------------------------------------>|
      |                                     |<------------------------------------|
      | 12. 返回 url + urlExpiry             |                                     |
      |<------------------------------------|                                     |
      |                                     |                                     |
      | 13. 访问签名 URL                     |                                     |
      |-------------------------------------------------------------------------->|
      |                                     |                                     | 14. 存储鉴权 (签名验证)
      |                                     |                                     |<---------->|
```

---

## 二、数据库表结构

### 2.1 `media` 表（核心媒体元数据表）

**文件**: `packages/shared/prisma/schema.prisma:1242-1263`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String | 媒体ID，由 SHA256 哈希前22位生成 |
| `sha256Hash` | String(44) | 文件 SHA256 哈希（base64编码），用于去重 |
| `projectId` | String | 项目ID，权限隔离边界 |
| `bucketPath` | String | 对象存储中的完整路径 |
| `bucketName` | String | 存储桶名称 |
| `contentType` | String | MIME类型（如 image/png, video/mp4） |
| `contentLength` | BigInt | 文件大小（字节） |
| `uploadHttpStatus` | Int? | 上传状态（200/201=成功） |
| `uploadHttpError` | String? | 上传错误信息 |
| `uploadedAt` | DateTime? | 上传完成时间 |

**唯一约束**:
- `(projectId, id)` - 按项目的媒体ID唯一
- `(projectId, sha256Hash)` - 按项目的文件哈希唯一，实现去重

### 2.2 `trace_media` 关联表

**文件**: `packages/shared/prisma/schema.prisma:1265-1279`

关联 trace 与 media，支持一个 trace 关联多个媒体。

### 2.3 `observation_media` 关联表

**文件**: `packages/shared/prisma/schema.prisma:1281-1296`

关联 observation 与 media，支持一个 observation 关联多个媒体。`field` 字段标识媒体属于 input/output/metadata。

---

## 三、媒体附件入库流程（上传链路）

### 3.1 步骤1：获取上传签名 URL

**接口**: `POST /api/public/media`

**文件**: `web/src/pages/api/public/media/index.ts`

**请求参数**:
```typescript
{
  traceId: string;           // 关联的trace ID
  observationId?: string;    // 关联的observation ID（可选）
  contentType: MediaContentType;  // MIME类型
  contentLength: number;     // 文件大小（字节）
  sha256Hash: string;        // 文件SHA256哈希（44字符base64）
  field: "input" | "output" | "metadata";  // 所属字段
}
```

**核心逻辑**:
1. **权限校验**: 通过 `createAuthedProjectAPIRoute` 验证 API key 权限
2. **去重检查**: 按 `(projectId, sha256Hash)` 查询是否已存在相同文件
   - 若已存在且上传成功，直接返回 mediaId，无需重复上传
3. **生成 mediaId**: 取 SHA256 哈希前22位（132 bits），转换为 URL-safe base64
   ```typescript
   // web/src/pages/api/public/media/index.ts:223-231
   function getMediaId(params: { sha256Hash: string }) {
     const urlSafeHash = sha256Hash.replaceAll("+", "-").replaceAll("/", "_");
     return urlSafeHash.slice(0, 22);
   }
   ```
4. **生成存储路径**: `{prefix}{projectId}/{mediaId}.{extension}`
5. **调用存储服务生成签名上传 URL**:
   ```typescript
   // web/src/pages/api/public/media/index.ts:120-126
   const uploadUrl = await s3Client.getSignedUploadUrl({
     path: bucketPath,
     ttlSeconds: 60 * 60,  // 上传URL有效期1小时
     sha256Hash,
     contentType,
     contentLength,
   });
   ```
6. **写入 media 表**: 使用原生 SQL 避免高并发下的死锁，支持重试3次
7. **写入关联表**: `trace_media` 或 `observation_media`

**返回**:
```typescript
{
  mediaId: string;
  uploadUrl: string | null;  // 去重命中时为null
}
```

### 3.2 步骤2：客户端直传对象存储

客户端使用返回的 `uploadUrl` 直接 PUT 文件到对象存储，无需经过 Langfuse 后端。

### 3.3 步骤3：回调更新上传状态

**接口**: `PATCH /api/public/media/[mediaId]`

**文件**: `web/src/pages/api/public/media/[mediaId].ts:71-132`

**请求参数**:
```typescript
{
  uploadedAt: Date;
  uploadHttpStatus: number;   // 200/201=成功，其他=失败
  uploadHttpError?: string;
  uploadTimeMs?: number;
}
```

**核心逻辑**:
1. 校验 media 存在且属于当前项目
2. 更新 media 表的上传状态字段
3. 记录指标（Prometheus）:
   - `langfuse.media.upload_http_status` - 计数
   - `langfuse.media.upload_time_ms` - 直方图

---

## 四、后端颁发签名下载链接

### 4.1 tRPC 路由

**文件**: `web/src/server/api/routers/media.ts`

提供两个查询接口:

#### 4.1.1 `media.getById` - 按媒体ID获取

```typescript
// web/src/server/api/routers/media.ts:17-64
input: { mediaId: string, projectId: string }
return: {
  mediaId: string;
  contentType: string;
  contentLength: number;
  url: string;           // 签名URL
  urlExpiry: string;     // 过期时间ISO字符串
}
```

#### 4.1.2 `media.getByTraceOrObservationId` - 按关联ID批量获取

```typescript
// web/src/server/api/routers/media.ts:65-171
input: { traceId: string, observationId?: string, projectId: string }
return: Array<{
  mediaId: string;
  contentType: string;
  contentLength: number;
  field: "input" | "output" | "metadata";
  url: string;
  urlExpiry: string;
}>
```

### 4.2 核心颁发逻辑

**文件**: `web/src/server/api/routers/media.ts:47-63`

```typescript
const mediaStorageClient = getMediaStorageServiceClient(media.bucketName);
const ttlSeconds = env.LANGFUSE_S3_MEDIA_DOWNLOAD_URL_EXPIRY_SECONDS;  // 默认3600秒
const urlExpiry = new Date(Date.now() + ttlSeconds * 1000).toISOString();

const url = await mediaStorageClient.getSignedUrl(
  media.bucketPath,
  ttlSeconds,
  false,  // asAttachment=false, 浏览器内联显示
);
```

### 4.3 存储服务客户端

**文件**: `web/src/features/media/server/getMediaStorageClient.ts`

单例模式，使用环境变量配置的存储凭据:
- `LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID`
- `LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY`
- `LANGFUSE_S3_MEDIA_UPLOAD_BUCKET`
- `LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT`
- `LANGFUSE_S3_MEDIA_UPLOAD_REGION`

---

## 五、前端续签签名链接机制

### 5.1 前端 Hooks

#### 5.1.1 `useMedia` Hook - 批量获取 trace/observation 媒体

**文件**: `web/src/components/trace/api/useMedia.ts`

```typescript
// web/src/components/trace/api/useMedia.ts:16-33
export function useMedia({ projectId, traceId, observationId }: UseMediaParams) {
  return api.media.getByTraceOrObservationId.useQuery(
    { projectId, traceId, observationId },
    {
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
      staleTime: 50 * 60 * 1000,  // 50分钟后视为过期
    },
  );
}
```

#### 5.1.2 `LangfuseMediaView` 组件 - 单个媒体渲染

**文件**: `web/src/components/ui/LangfuseMediaView.tsx:68-80`

```typescript
const { data } = api.media.getById.useQuery(
  { mediaId: mediaData.id, projectId: projectId as string },
  {
    enabled: Boolean(projectId),
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    staleTime: 55 * 60 * 1000,  // 55分钟，略短于URL有效期1小时
  },
);
```

### 5.2 续签机制原理与风险分析

#### 5.2.1 TanStack Query 自动重获取触发条件

根据 TanStack Query 官方文档，stale 数据的自动重获取**仅在以下触发条件发生时**执行:
1. **新的查询实例挂载** (`refetchOnMount`) - 当前配置: `false`
2. **窗口重新获得焦点** (`refetchOnWindowFocus`) - 当前配置: `false`
3. **网络重新连接** (`refetchOnReconnect`) - 当前配置: `false`
4. **配置了定时刷新** (`refetchInterval`) - 当前配置: 未设置

#### 5.2.2 关键问题发现

**⚠️ 风险：当前配置下签名URL过期后不会自动续签！**

| 配置项 | 值 | 影响 |
|--------|----|------|
| `staleTime` | 50-55分钟 | 仅标记数据是否"过时"，不主动触发重获取 |
| `refetchOnMount` | `false` | 组件重新挂载时不重获取 |
| `refetchOnWindowFocus` | `false` | 窗口重获焦点时不重获取 |
| `refetchOnReconnect` | `false` | 网络重连时不重获取 |
| `refetchInterval` | 未设置 | 无定时刷新 |

**场景复现**:
- 用户打开页面，加载媒体（URL有效期60分钟）
- 用户保持页面打开，不切换标签、不刷新、不离开
- 55分钟后，数据标记为 stale，但无触发条件
- 60分钟后，URL实际过期
- 用户点击媒体 → 访问签名URL → 403 Forbidden 错误

#### 5.2.3 修复建议

**方案一：设置 refetchInterval（推荐）**

```typescript
// 每50分钟自动刷新一次，确保URL永远不会过期
staleTime: 50 * 60 * 1000,
refetchInterval: 50 * 60 * 1000,  // 新增：每50分钟自动重获取
refetchIntervalInBackground: true, // 后台静默刷新
```

**方案二：手动检测过期并调用 refetch()**

```typescript
const { data, refetch } = api.media.getById.useQuery(...);

// 在访问URL前检查是否即将过期
const isUrlExpiringSoon = data?.urlExpiry 
  ? new Date(data.urlExpiry).getTime() - Date.now() < 5 * 60 * 1000
  : false;

if (isUrlExpiringSoon) {
  refetch(); // 手动触发重新获取
}
```

**方案三：启用 refetchOnMount（最简单）**

```typescript
refetchOnMount: true,  // 组件挂载时检查并刷新过期数据
```

### 5.3 媒体引用字符串格式

**文件**: `packages/shared/src/utils/IORepresentation/chatML/types.ts:46-90`

媒体在 trace/observation 的 input/output 中以特殊字符串格式引用:

```
@@@langfuseMedia:type=image/jpeg|id=abc123xyz|source=storage@@@
```

解析逻辑使用 `MediaReferenceStringSchema` 进行验证和解析。

---

## 六、对象存储后端鉴权机制

**文件**: `packages/shared/src/server/services/StorageService.ts`

系统支持四种对象存储后端，每种后端有不同的签名鉴权机制。

### 6.1 统一接口

```typescript
// packages/shared/src/server/services/StorageService.ts:88-121
export interface StorageService {
  getSignedUrl(
    fileName: string,
    ttlSeconds: number,
    asAttachment?: boolean,
  ): Promise<string>;

  getSignedUploadUrl(params: {
    path: string;
    ttlSeconds: number;
    sha256Hash: string;
    contentType: string;
    contentLength: number;
  ): Promise<string>;
}
```

### 6.2 AWS S3 签名机制

**文件**: `packages/shared/src/server/services/StorageService.ts:701-792`

使用 **AWS Signature Version 4 (SigV4)**:

```typescript
// S3 下载签名URL
return getSignedUrl(
  this.signedUrlClient,
  new GetObjectCommand({
    Bucket: this.bucketName,
    Key: fileName,
    ResponseContentDisposition: asAttachment 
      ? `attachment; filename="${fileName}"` 
      : undefined,
  }),
  { expiresIn: ttlSeconds },  // 签名有效期
);

// S3 上传签名URL
return getSignedUrl(
  this.signedUrlClient,
  new PutObjectCommand({
    Bucket: this.bucketName,
    Key: path,
    ContentType: contentType,
    ChecksumSHA256: sha256Hash,    // 校验文件完整性
    ContentLength: contentLength,  // 校验文件大小
  }),
  {
    expiresIn: ttlSeconds,
    signableHeaders: new Set(["content-type", "content-length"]),
    unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
  },
);
```

**签名验证**: S3 服务端收到请求后，使用相同的密钥和算法重新计算签名，与URL中的签名对比。

### 6.3 Azure Blob 签名机制

**文件**: `packages/shared/src/server/services/StorageService.ts:409-475`

使用 **Shared Access Signature (SAS)**:

```typescript
const blockBlobClient = this.client.getBlockBlobClient(fileName);
let url = await blockBlobClient.generateSasUrl({
  permissions: BlobSASPermissions.parse("r"),  // 只读权限
  expiresOn: new Date(Date.now() + ttlSeconds * 1000),
  contentDisposition: asAttachment
    ? `attachment; filename="${fileName}"`
    : undefined,
});
```

**SAS Token 包含**:
- `sv` - 签名版本
- `st` - 开始时间
- `se` - 过期时间
- `sr` - 资源类型
- `sp` - 权限
- `sig` - 签名

### 6.4 Google Cloud Storage 签名机制

**文件**: `packages/shared/src/server/services/StorageService.ts:952-1015`

使用 **Signed URL (v4)**:

```typescript
const file = this.bucket.file(fileName);
const options: GetSignedUrlConfig = {
  version: "v4",
  action: "read",
  expires: Date.now() + ttlSeconds * 1000,
};
const [url] = await file.getSignedUrl(options);
```

### 6.5 OCI Object Storage 签名机制

**文件**: `packages/shared/src/server/services/StorageService.ts:1410-1518`

使用 **Pre-Authenticated Request (PAR)**:

```typescript
const req: objectstorage.requests.CreatePreauthenticatedRequestRequest = {
  namespaceName,
  bucketName: this.bucketName,
  createPreauthenticatedRequestDetails: {
    name: `read-${fileName}-${Date.now()}`,
    accessType: "ObjectRead",
    objectName: fileName,
    timeExpires: expiresOn,
  },
};
const resp = await client.createPreauthenticatedRequest(req);
const accessUri = resp.preauthenticatedRequest.accessUri;
```

### 6.6 外部端点支持

**文件**: `packages/shared/src/server/services/StorageService.ts:523-540`

支持内部/外部双端点配置:
- 内部端点: 用于服务端实际操作（上传、下载、删除）
- 外部端点: 用于生成签名URL（客户端可访问）
- 通过 `externalEndpoint` 参数配置

---

## 七、关键配置参数

**文件**: `web/src/env.mjs:316-336`

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `LANGFUSE_S3_MEDIA_UPLOAD_BUCKET` | - | 媒体存储桶名称 |
| `LANGFUSE_S3_MEDIA_UPLOAD_PREFIX` | "" | 存储路径前缀 |
| `LANGFUSE_S3_MEDIA_MAX_CONTENT_LENGTH` | - | 最大文件大小（字节） |
| `LANGFUSE_S3_MEDIA_DOWNLOAD_URL_EXPIRY_SECONDS` | 3600 | 下载URL有效期（秒） |
| `LANGFUSE_S3_MEDIA_UPLOAD_SSE` | - | 服务端加密（AES256/aws:kms） |
| `LANGFUSE_S3_MEDIA_UPLOAD_SSE_KMS_KEY_ID` | - | KMS密钥ID |

---

## 八、第四轮深度核对结果（四项精准核实）

### 8.1 问题一：200/201 行为结论与 E2E 用例逐条对齐，区分代码事实 vs 假设

**结论：✅ E2E测试全覆盖200场景，201为假设场景；代码事实与测试断言一致**

#### E2E 测试用例全景分析

**测试文件**: `web/src/__tests__/server/media.servertest.ts`

| 测试用例 | 期望 uploadHttpStatus | 代码位置 | 性质 |
|---------|----------------------|---------|------|
| PNG上传成功 | 200 | 第264行 | ✅ 代码事实 |
| PDF上传成功 | 200 | 第318行 | ✅ 代码事实 |
| 错误contentLength重试 | 第一次403，第二次200 | 第369、399行 | ✅ 代码事实 |
| 错误content重试 | 第一次403，第二次200 | 第452、482行 | ✅ 代码事实 |
| 错误contentType重试 | 第一次403，第二次200 | 第535、565行 | ✅ 代码事实 |
| 不同contentType重传 | 第一次200，第二次200 | 第618、665行 | ✅ 代码事实 |
| 去重短路验证 | 200 | 第717行 | ✅ 代码事实 |
| SHA256不匹配 | 400 | 第842行 | ✅ 代码事实 |

#### 代码事实 vs 假设边界

| 判断 | 代码事实 | 假设 | 证据 |
|------|---------|------|------|
| 去重短路只判断200 | ✅ 是 | ❌ | `index.ts:74` + E2E第717行断言 |
| 状态回写只判断200 | ✅ 是 | ❌ | `[mediaId].ts:98` + E2E第619行断言 |
| 读取放行接受200和201 | ✅ 是 | ❌ | `media.ts:41` + `[mediaId].ts:43` |
| S3 PUT成功返回201 | ❌ | ✅ 是 | 测试环境S3mock返回200（第256行），生产环境S3返回201是AWS行为常识 |
| 201导致去重失效 | ❌ | ✅ 是 | E2E测试未覆盖201场景，属于推断 |

#### E2E 测试中的关键断言

**去重短路测试**（第696-756行）:
```typescript
// 第一次上传成功，uploadHttpStatus=200
expect(firstResult.mediaRecord).toMatchObject({
  uploadHttpStatus: 200,  // 第717行
});

// 第二次相同文件上传，预期uploadUrl为null（去重命中）
expect(secondResult.getUploadUrlResponse?.body.uploadUrl).toBeNull();  // 第754行
```

**不同contentType重传测试**（第596-694行）:
```typescript
// 第一次上传PNG但声明contentType为image/jpeg，成功
expect(firstResult.mediaRecord).toMatchObject({
  sha256Hash: validPNG.sha256Hash,
  contentType: "image/jpeg",  // 第614行
  uploadHttpStatus: 200,      // 第618行
});

// 第二次上传相同PNG，声明正确的image/png，也成功（未去重）
expect(secondResult.getUploadUrlResponse?.body.uploadUrl).not.toBeNull();  // 隐含：去重未命中
```

#### 语义边界澄清

1. **"上传成功"的三重语义**:
   - 去重/回写口径：`uploadHttpStatus === 200`（严格）
   - 读取放行口径：`uploadHttpStatus === 200 || === 201`（宽松）
   - E2E测试口径：始终断言 `=== 200`（测试环境）

2. **201的真实来源**:
   - 不是代码中的硬编码值
   - 是AWS S3生产环境对PUT请求的标准响应
   - 当前测试环境（S3mock）返回200，因此E2E无法覆盖

---

### 8.2 问题二：允许不同 content type 重传的设计反证，重写去重与状态口径边界

**结论：✅ 允许不同contentType重传是明确的设计选择，而非缺陷；去重逻辑是"相同内容+相同类型"才短路**

#### 设计反证：E2E 用例明确验证

**测试用例**（`media.servertest.ts:596-694`）:
```
测试名称: "should allow reuploading with different content type"

步骤:
1. 上传PNG文件（真实内容），但声明 contentType = "image/jpeg"
   → 成功，uploadHttpStatus = 200
   → contentType 存储为 "image/jpeg"

2. 上传完全相同的PNG文件（相同SHA256），声明 contentType = "image/png"
   → 去重未命中（返回新的uploadUrl，非null）
   → 成功，uploadHttpStatus = 200
   → contentType 更新为 "image/png"

3. 断言：两次都成功，第二次未触发去重
```

#### 去重逻辑的完整边界

**代码**（`web/src/pages/api/public/media/index.ts:72-76`）:
```typescript
if (
  existingMedia &&
  existingMedia.uploadHttpStatus === 200 &&  // 条件1：状态成功
  existingMedia.contentType === contentType  // 条件2：类型相同
) {
  // 去重命中，返回 { mediaId, uploadUrl: null }
}
```

**去重短路的三个必要条件（缺一不可）**:
| 条件 | 说明 | 不满足时的行为 |
|------|------|---------------|
| `existingMedia` 存在 | 相同projectId+sha256Hash的记录存在 | 走完整上传流程 |
| `uploadHttpStatus === 200` | 之前上传成功 | 重新生成上传URL，允许重试 |
| `contentType === contentType` | 请求的contentType与已有记录相同 | 重新生成上传URL，允许用不同类型重传 |

#### UPSERT 更新语义边界

**代码**（`web/src/pages/api/public/media/index.ts:157-162`）:
```sql
ON CONFLICT ("project_id", "sha_256_hash")
DO UPDATE SET
  "bucket_name" = ${env.LANGFUSE_S3_MEDIA_UPLOAD_BUCKET},
  "bucket_path" = ${bucketPath},           -- 随contentType变化（扩展名不同）
  "content_type" = ${contentType},         -- 覆盖为新的contentType
  "content_length" = ${contentLength}      -- 覆盖为新的contentLength
```

**关键设计意图**:
- 唯一键是 `(projectId, sha256Hash)` —— 基于内容去重
- 但允许同一内容以不同 contentType 重新上传
- 重新上传时会更新 `contentType`、`bucketPath`、`contentLength`
- `bucketPath` 变化是因为扩展名由 contentType 决定（`.png` vs `.jpg`）

#### 状态口径的完整边界表

| 操作 | 状态判断口径 | 代码位置 |
|------|-------------|---------|
| **去重短路** | `uploadHttpStatus === 200` **且** `contentType === contentType` | `index.ts:72-76` |
| **状态回写清空错误** | `uploadHttpStatus === 200` | `[mediaId].ts:98` |
| **seed-media 去重** | `uploadHttpStatus === 200` | `seed-media.ts:179` |
| **读取放行（getById）** | `uploadHttpStatus === 200 \|\| === 201` | `media.ts:41` |
| **读取放行（GET API）** | `uploadHttpStatus === 200 \|\| === 201` | `[mediaId].ts:43` |
| **批量读取（当前）** | 无任何判断 | `media.ts:85-170` |

---

### 8.3 问题三：seed-media 脚本中的 uploadHttpStatus 判定并入同一语义口径

**结论：✅ seed-media 与公开 API 口径完全一致，统一语义为 `=== 200`**

#### 三处判定的代码对齐

| 判定位置 | 代码 | 口径 | 一致性 |
|---------|------|------|--------|
| 公开API去重 | `index.ts:74` | `existingMedia.uploadHttpStatus === 200` | ✅ 一致 |
| 公开API回写 | `[mediaId].ts:98` | `uploadHttpStatus === 200 ? null` | ✅ 一致 |
| seed-media去重 | `seed-media.ts:179` | `existingMedia.uploadHttpStatus === 200` | ✅ 一致 |
| seed-media写入 | `seed-media.ts:240, 249` | 硬编码 `200` | ✅ 一致 |

#### seed-media 脚本详细证据

**去重检查**（`seed-media.ts:179-181`）:
```typescript
if (existingMedia && existingMedia.uploadHttpStatus === 200) {
  logger.debug(
    `[seed-media] Media already exists for ${mediaFile.name}, creating TraceMedia link only`,
  );
  // 只创建关联，不重复上传
}
```

**写入数据库**（`seed-media.ts:218-250`）:
```sql
INSERT INTO "media" (
  ...
  "uploaded_at",
  "upload_http_status"
)
VALUES (
  ...
  ${new Date()},
  ${200}  -- 硬编码200
)
ON CONFLICT ("project_id", "sha_256_hash")
DO UPDATE SET
  ...
  "uploaded_at" = ${new Date()},
  "upload_http_status" = ${200}  -- 硬编码200
```

#### 统一语义口径

**"上传成功"的写入口径（全链路一致）**:
- 公开 API PATCH 回调：客户端传入 `uploadHttpStatus`（可以是200或201等）
- 公开 API POST 去重：`=== 200`
- 公开 API PATCH 清空错误：`=== 200`
- seed-media 脚本去重：`=== 200`
- seed-media 脚本写入：硬编码 `200`

**不一致之处（读取口径）**:
- 单条读取放行：`=== 200 || === 201`（比写入口径宽松）
- 批量读取：无判断

#### 语义澄清：为什么 seed-media 硬编码 200？

1. **内部脚本 vs 外部API**:
   - seed-media 是内部数据填充脚本，直接调用 `storageClient.uploadFile()`
   - 不经过公开API的"获取上传URL → 直传 → 回调"流程
   - 脚本内上传成功即意味成功，直接写入200

2. **无回调机制**:
   - 内部上传没有HTTP响应状态码的概念
   - 成功就是200，失败就跳过不写入

---

### 8.4 问题四：批量读取修复建议同时覆盖 trace 与 observation 两条查询分支

**结论：❌ 两条分支都未过滤，需同时修复**

#### 两条分支的代码证据

**Trace 分支**（`web/src/server/api/routers/media.ts:97-112`）:
```sql
SELECT
  tm.field,
  m.id,
  m.bucket_name,
  m.bucket_path,
  m.content_type,
  m.content_length
FROM
  trace_media tm
  LEFT JOIN media m 
    ON tm.media_id = m.id 
    AND tm.project_id = m.project_id
WHERE
  tm.project_id = ${projectId}
  AND tm.trace_id = ${traceId}
/* ⚠️ 缺少：AND m.upload_http_status IN (200, 201) */
```

**Observation 分支**（`web/src/server/api/routers/media.ts:124-140`）:
```sql
SELECT
  om.field,
  m.id,
  m.bucket_name,
  m.bucket_path,
  m.content_type,
  m.content_length
FROM
  observation_media om
  LEFT JOIN media m 
    ON om.media_id = m.id 
    AND om.project_id = m.project_id
WHERE
  om.project_id = ${projectId}
  AND om.trace_id = ${traceId}
  AND om.observation_id = ${input.observationId}
/* ⚠️ 缺少：AND m.upload_http_status IN (200, 201) */
```

#### 两条分支的共同问题

| 问题 | Trace分支 | Observation分支 |
|------|-----------|----------------|
| 使用 LEFT JOIN | ✅ 是 | ✅ 是 |
| 无 uploadHttpStatus 过滤 | ✅ 是 | ✅ 是 |
| SELECT 不含 uploadHttpStatus | ✅ 是 | ✅ 是 |
| 直接为所有结果生成签名URL | ✅ 是 | ✅ 是 |

#### 完整修复方案（同时覆盖两条分支）

**方案一：SQL层过滤（推荐，性能最优）**

```typescript
// Trace 分支
media = await ctx.prisma.$queryRaw<...>`
  SELECT
    tm.field,
    m.id,
    m.bucket_name,
    m.bucket_path,
    m.content_type,
    m.content_length
  FROM
    trace_media tm
    INNER JOIN media m  -- 改为INNER JOIN，排除关联不存在的情况
      ON tm.media_id = m.id 
      AND tm.project_id = m.project_id
  WHERE
    tm.project_id = ${projectId}
    AND tm.trace_id = ${traceId}
    AND m.upload_http_status IN (200, 201)  -- 新增：只返回上传成功的媒体
`;

// Observation 分支
media = await ctx.prisma.$queryRaw<...>`
  SELECT
    om.field,
    m.id,
    m.bucket_name,
    m.bucket_path,
    m.content_type,
    m.content_length
  FROM
    observation_media om
    INNER JOIN media m  -- 改为INNER JOIN
      ON om.media_id = m.id 
      AND om.project_id = m.project_id
  WHERE
    om.project_id = ${projectId}
    AND om.trace_id = ${traceId}
    AND om.observation_id = ${input.observationId}
    AND m.upload_http_status IN (200, 201)  -- 新增：只返回上传成功的媒体
`;
```

**方案二：应用层过滤（需要先查询uploadHttpStatus）**

```typescript
// 1. 修改SQL，增加upload_http_status字段
SELECT
  ...
  m.upload_http_status  -- 新增
FROM
  ...

// 2. 在Promise.all前过滤
const validMedia = media.filter(m => 
  m.upload_http_status === 200 || m.upload_http_status === 201
);

// 3. 只为有效媒体生成签名URL
return await Promise.all(
  validMedia.map<Promise<MediaReturnType>>(async (m) => {
    // ...
  }),
);
```

**方案三：混合方案（最健壮）**

```typescript
// SQL层过滤 + SELECT字段包含状态（用于应用层双重校验）
SELECT
  ...
  m.upload_http_status
FROM
  ...
WHERE
  ...
  AND m.upload_http_status IN (200, 201)

// 应用层二次校验（防御性编程）
const validMedia = media.filter(m => 
  m.upload_http_status === 200 || m.upload_http_status === 201
);

if (validMedia.length !== media.length) {
  logger.warn("Some media records were filtered out due to invalid upload status");
}
```

#### 修复验证清单

- [ ] Trace 分支 SQL 增加 `upload_http_status IN (200, 201)` 过滤
- [ ] Trace 分支 JOIN 改为 INNER JOIN
- [ ] Observation 分支 SQL 增加 `upload_http_status IN (200, 201)` 过滤
- [ ] Observation 分支 JOIN 改为 INNER JOIN
- [ ] 新增 E2E 测试用例验证未成功上传的媒体不被返回
- [ ] 新增 E2E 测试用例验证 observation 分支过滤逻辑


---

### 8.5 问题五：PATCH 异常分支的错误信息拼接是否正确

**结论：❌ 存在运算符优先级bug，错误信息会丢失上下文前缀**

#### 问题代码

```typescript
// web/src/pages/api/public/media/[mediaId].ts:124-129
throw new InternalServerError(
  `Error updating uploadedAt on media ID ${mediaId}` +
    (e instanceof Error ? e.message : "")
    ? (e as Error).message
    : "",
);
```

#### 运算符优先级分析

JavaScript 中 `+` 运算符优先级 **高于** `?:` 三元运算符。

**实际执行顺序**:
```typescript
// 先执行 + 连接，再执行三元判断
(
  `Error updating uploadedAt on media ID ${mediaId}` +
  (e instanceof Error ? e.message : "")
) ? (e as Error).message : ""
```

#### 两种场景的错误输出

| 场景 | 预期输出 | 实际输出 | 问题 |
|------|---------|---------|------|
| `e` 是 Error 对象 | `"Error updating uploadedAt on media ID m_123: Original error message"` | `"Original error message"` | ❌ 丢失上下文前缀 |
| `e` 不是 Error 对象 | `"Error updating uploadedAt on media ID m_123"` | `undefined` 或运行时错误 | ❌ 尝试访问 `(e as Error).message` |

#### 修复方案

**正确写法（加括号控制优先级）**:
```typescript
throw new InternalServerError(
  `Error updating uploadedAt on media ID ${mediaId}` +
    ((e instanceof Error ? e.message : "")
      ? `: ${(e as Error).message}`
      : "")
);
```

**更清晰的写法**:
```typescript
const errorMessage = e instanceof Error ? e.message : "";
throw new InternalServerError(
  `Error updating uploadedAt on media ID ${mediaId}${errorMessage ? `: ${errorMessage}` : ""}`
);
```

---

### 8.6 保留：多 bucket 相关结论（第三轮核对）

**结论：⚠️ 是当前明确的设计前提，而非意外缺陷；但存在未来扩展风险**

（详细分析见第三轮核对，此处保留作为历史参考）

---

### 8.7 保留：各存储后端上传签名的完整性约束差异（第三轮核对）

**结论：❌ 各后端实现差异显著，但需纠正过度推断，明确实际风险边界**

（详细分析见第三轮核对，此处保留作为历史参考）

---

## 九、第五轮深度核对结果（前端链路盲点复核）

### 9.1 问题一：useMedia、SectionMedia、LangfuseMediaView 与 getById 的实际调用顺序

**结论：✅ 批量结果一定会再经过 getById 的状态过滤，不存在直接泄漏未成功媒体URL的风险**

#### 完整调用链路图

```
TraceDetailView / ObservationDetailView
  │
  ├─ useMedia({ projectId, traceId, observationId? })
  │   └─ api.media.getByTraceOrObservationId.useQuery()
  │       └─ SQL查询：无状态过滤，返回 MediaReturnType[]（含 url, urlExpiry）
  │
  └─ IOPreview
       ├─ IOPreviewPretty（Pretty视图）
       │   └─ ChatMessageList
       │       ├─ 计算 remainingMedia（过滤已在内容中内联渲染的媒体）
       │       └─ SectionMedia
       │           └─ 对每个媒体调用 LangfuseMediaView(mediaAPIReturnValue={m})
       │               └─ api.media.getById.useQuery()  ✅ 状态过滤
       │
       ├─ IOPreviewJSONSimple（JSON视图）
       │   └─ PrettyJsonView
       │       ├─ 对每个字段渲染 MarkdownViewer（内联媒体）
       │       │   └─ LangfuseMediaView(mediaReferenceString="...")
       │       │       └─ api.media.getById.useQuery()  ✅ 状态过滤
       │       └─ SectionMedia（通过 media.filter 按 field 分组）
       │           └─ 同上
       │
       └─ IOPreviewJSON（JSON Beta视图）
           └─ MultiSectionJsonViewer
               ├─ Section Header: MediaButtonGroup(media)
               │   └─ MediaPreview(mediaItem)
               │       └─ api.media.getById.useQuery()  ✅ 状态过滤
               └─ 内容渲染：LangfuseMediaView
                   └─ api.media.getById.useQuery()  ✅ 状态过滤
```

#### 关键代码证据

**LangfuseMediaView 无条件调用 getById**（`LangfuseMediaView.tsx:68-80`）:
```typescript
// 无论传入的是 mediaAPIReturnValue 还是 mediaReferenceString，
// 最终都会调用 getById 获取签名URL
const { data } = api.media.getById.useQuery(
  {
    mediaId: mediaData.id,
    projectId: projectId as string,
  },
  {
    enabled: Boolean(projectId),
    // ...
  },
);

const mediaUrl = data?.url;  // 只使用 getById 返回的 url
if (!mediaUrl) return null;  // 未成功的媒体返回null，不渲染
```

**批量返回的 url 被完全忽略**:
- `MediaReturnType` 类型虽然包含 `url` 和 `urlExpiry` 字段
- 但所有消费方都不直接使用这些字段，而是**重新调用 getById 获取**
- 批量返回的 `url` 目前是死数据，没有任何代码路径使用

---

### 9.2 问题二：区分三层行为，重算批量查询未过滤的真实用户影响

**结论：⚠️ 安全影响为低，但性能影响为中；用户看不到未成功上传的媒体，但会产生无效的N+1查询**

#### 三层行为模型

| 层级 | 行为 | 状态过滤 | 结果 |
|------|------|---------|------|
| **第一层：预取** | `getByTraceOrObservationId` | ❌ 无过滤 | 返回所有关联媒体，包括未上传/失败的 |
| **第二层：二次查询** | `LangfuseMediaView` 中的 `getById` | ✅ 严格过滤 | 未成功的媒体返回 404 错误 |
| **第三层：渲染** | `LangfuseMediaView` 返回值 | ✅ 隐式过滤 | `data.url` 为 `undefined` 时返回 `null`，不渲染 |

#### 真实影响量化

| 影响类型 | 严重程度 | 详细说明 |
|---------|---------|---------|
| **安全影响** | 🟢 低 | 未成功媒体的签名URL从未被使用或暴露<br>最终渲染时100%被过滤 |
| **性能影响** | 🟡 中 | N+1查询问题：<br>- 批量查询返回 M 个媒体<br>- 每个触发 1 次 getById 查询<br>- 其中 K 个是无效的（返回404）<br>- 浪费 K 次数据库查询和网络往返 |
| **用户体验** | 🟢 低 | 用户看不到任何失效媒体<br>可能有轻微的加载延迟（无效查询的等待时间） |
| **日志污染** | 🟡 中 | 大量 404 错误会出现在后端日志中<br>干扰真实错误的排查 |

#### 场景示例

假设一个 trace 关联了 5 个媒体：
- 2 个上传成功（status=200）
- 2 个上传失败（status=403）
- 1 个从未上传（status=NULL）

**当前行为**:
1. 批量查询返回 5 个媒体（包含 3 个无效）
2. 前端发起 5 个 getById 查询
3. 3 个 getById 返回 404 错误（后端日志记录 3 条错误）
4. 前端只渲染 2 个成功的媒体

**修复后行为**:
1. 批量查询返回 2 个媒体（只返回成功的）
2. 前端发起 2 个 getById 查询
3. 全部成功，无错误日志
4. 前端渲染 2 个成功的媒体

**节省**: 3 次无效数据库查询 + 3 次网络往返 + 3 条错误日志

---

### 9.3 问题三：哪些页面或组件路径会直接消费批量结果而绕开 getById

**结论：✅ 不存在直接消费批量结果 URL 的路径；所有路径最终都会经过 getById**

#### 所有消费路径排查

| 组件 | 传入批量结果的字段 | 实际使用方式 | 是否绕开 getById |
|------|------------------|------------|----------------|
| **SectionMedia** | `mediaAPIReturnValue={m}` | 传入 LangfuseMediaView → getById | ❌ 不绕开 |
| **LangfuseMediaView** | `mediaReferenceString` | 解析 mediaId → getById | ❌ 不绕开 |
| **LangfuseMediaView** | `mediaAPIReturnValue` | 提取 mediaId → getById | ❌ 不绕开 |
| **MediaButtonGroup** | `media` 数组 | 分组显示按钮 → MediaPreview → getById | ❌ 不绕开 |
| **MediaPreview** | `mediaItem` | 提取 mediaId → getById | ❌ 不绕开 |
| **PrettyJsonView** | `media?.filter((m) => m.field === "input")` | 传入 SectionMedia → 同上 | ❌ 不绕开 |
| **ChatMessageList** | `remainingMedia` | 传入 SectionMedia → 同上 | ❌ 不绕开 |
| **MarkdownViewer** | 内联媒体标签 | 解析 mediaReferenceString → getById | ❌ 不绕开 |

#### 唯一"直接消费"的字段

批量返回的 `MediaReturnType` 中，只有以下字段被直接使用（不经过 getById）：
- `mediaId` - 用于后续 getById 查询的参数
- `contentType` - 用于判断渲染类型（图片/音频/视频/文件）
- `field` - 用于按 input/output/metadata 分组
- `url` 和 `urlExpiry` - **从未被使用**

#### 风险触达边界

**不存在安全风险边界**：
- 没有任何代码路径会将批量返回的 `url` 传递给浏览器进行网络请求
- 所有媒体访问都经过 `getById` 的状态校验
- 未成功上传的媒体永远无法获得可访问的签名URL

**存在性能风险边界**：
- `TraceDetailView` - trace 详情页（trace 级别媒体）
- `ObservationDetailView` - observation 详情页（observation 级别媒体）
- 所有包含媒体的 trace/observation 列表页面（如果未来有）

---

### 9.4 问题四：基于事实重写优先级建议

**结论：⚠️ 优先级从"高"调整为"中"；安全影响低，但性能和可维护性影响仍值得修复**

#### 优先级重估依据

| 维度 | 之前评估 | 当前评估 | 调整原因 |
|------|---------|---------|---------|
| **安全影响** | 🔴 高 | 🟢 低 | 所有路径最终经过 getById 过滤<br>未成功媒体URL从未暴露 |
| **性能影响** | 未评估 | 🟡 中 | N+1查询浪费，无效请求消耗资源<br>错误日志污染 |
| **用户体验** | 🔴 高 | 🟢 低 | 用户看不到无效媒体<br>仅可能有轻微加载延迟 |
| **数据一致性** | 未评估 | 🟡 中 | 前后端状态口径不一致<br>批量接口契约不准确 |
| **可维护性** | 未评估 | 🟡 中 | 批量返回的 `url` 字段是死代码<br>误导未来开发者 |
| **修复成本** | 低 | 低 | SQL层增加过滤条件，改动极小 |

#### 最终优先级建议

| 问题 | 原优先级 | 新优先级 | 调整理由 |
|------|---------|---------|---------|
| 批量查询未过滤 | 🔴 高 | 🟡 中 | 安全风险被前端二次查询消解<br>但性能和可维护性问题仍存在 |
| 非S3后端完整性校验缺失 | 🔴 高 | 🔴 高 | 缓存污染攻击风险真实存在<br>前端无法防御 |
| 200/201状态处理不一致 | 🟡 中 | 🟡 中 | 影响去重效率，但不影响功能正确性 |
| PATCH异常分支错误信息拼接 | 🟡 中 | 🟢 低 | 仅影响错误排查，不影响功能 |
| 前端URL过期无自动续签 | 🟡 中 | 🟡 中 | 影响用户体验，需要修复 |
| 多bucket参数名误导 | 🟢 低 | 🟢 低 | 单bucket场景下无实际影响 |

#### 是否仍应列为高优先的判断

**不建议列为高优先**，理由：
1. ✅ 不存在安全漏洞（用户数据安全未受威胁）
2. ✅ 不影响核心功能正确性（用户看不到无效媒体）
3. ⚠️ 但建议尽快修复，因为：
   - 修复成本极低（SQL增加一行过滤条件）
   - 性能收益明显（减少无效查询）
   - 消除日志污染，便于排查真实问题
   - 统一前后端契约，提升代码可维护性

**建议列入下一个迭代的技术债务修复**，而非紧急安全修复。

---

### 9.5 完整修复方案（覆盖 trace 与 observation 两条分支）

#### SQL层过滤（推荐，性能最优）

**Trace 分支**（`web/src/server/api/routers/media.ts:97-112`）:
```sql
SELECT
  tm.field,
  m.id,
  m.bucket_name,
  m.bucket_path,
  m.content_type,
  m.content_length
FROM
  trace_media tm
  INNER JOIN media m  -- ✅ 改为INNER JOIN，排除关联不存在的情况
    ON tm.media_id = m.id 
    AND tm.project_id = m.project_id
WHERE
  tm.project_id = ${projectId}
  AND tm.trace_id = ${traceId}
  AND m.upload_http_status IN (200, 201)  -- ✅ 新增：只返回上传成功的媒体
```

**Observation 分支**（`web/src/server/api/routers/media.ts:124-140`）:
```sql
SELECT
  om.field,
  m.id,
  m.bucket_name,
  m.bucket_path,
  m.content_type,
  m.content_length
FROM
  observation_media om
  INNER JOIN media m  -- ✅ 改为INNER JOIN
    ON om.media_id = m.id 
    AND om.project_id = m.project_id
WHERE
  om.project_id = ${projectId}
  AND om.trace_id = ${traceId}
  AND om.observation_id = ${input.observationId}
  AND m.upload_http_status IN (200, 201)  -- ✅ 新增：只返回上传成功的媒体
```

#### 额外优化：移除批量返回的死字段

由于 `url` 和 `urlExpiry` 从未被使用，可以考虑：
1. 从 SQL SELECT 中移除，减少数据传输
2. 或从 `MediaReturnType` 类型中移除，明确契约

#### 修复验证清单

- [ ] Trace 分支 SQL 增加 `upload_http_status IN (200, 201)` 过滤
- [ ] Trace 分支 JOIN 改为 INNER JOIN
- [ ] Observation 分支 SQL 增加 `upload_http_status IN (200, 201)` 过滤
- [ ] Observation 分支 JOIN 改为 INNER JOIN
- [ ] 新增 E2E 测试用例验证未成功上传的媒体不被返回
- [ ] 新增 E2E 测试用例验证 observation 分支过滤逻辑
- [ ] 验证错误日志中不再出现大量媒体404错误

---

## 十、安全设计要点

### 10.1 现有安全措施

1. **权限隔离**: 所有操作通过 `projectId` 边界校验，防止跨项目访问
2. **签名过期**: URL 有效期严格限制（默认3600秒），降低泄露风险
3. **完整性校验（S3）**: 上传时强制校验 SHA256 哈希和 Content-Length（存储层）
4. **去重机制**: 基于 SHA256 哈希 + contentType 实现"相同内容+相同类型"去重
5. **状态机（单条查询）**: `getById` 和 GET API 中 `uploadHttpStatus` 确保只有上传成功的媒体才能被访问
6. **状态机（前端兜底）**: `LangfuseMediaView` 无条件调用 `getById`，为批量查询提供二次过滤
7. **幂等性**: 高并发场景下使用原生 SQL + 重试机制保证数据一致性
8. **审计日志**: 所有上传操作记录指标，支持监控和审计
9. **应用层大小限制**: 获取上传URL时校验 `contentLength < MAX_CONTENT_LENGTH`
10. **允许重传**: 支持不同 contentType、不同 contentLength、不同 content 的重试上传

### 10.2 已核实的安全缺陷（按优先级，第五轮更新）

| 优先级 | 问题 | 影响 | 所在章节 |
|--------|------|------|---------|
| 🔴 高 | 非S3后端存储层完整性校验缺失 | 客户端可上传与声明的SHA256/Size不符的文件，存在缓存污染攻击 | 8.7（第三轮） |
| 🟡 中 | 批量查询（trace/observation）未过滤未成功上传的媒体 | N+1查询浪费，错误日志污染，前后端契约不一致<br>⚠️ 安全风险被前端二次查询消解 | 9.5（第五轮） |
| 🟡 中 | 200/201状态处理不一致 | S3 PUT成功返回201时去重失效，重复上传浪费资源 | 8.1（第四轮） |
| 🟡 中 | 前端URL过期无自动续签 | 用户长时间停留页面时URL过期，导致403错误 | 5.2 |
| 🟢 低 | PATCH异常分支错误信息拼接bug | 错误信息丢失上下文前缀，调试困难 | 8.5 |
| 🟢 低 | 多bucket参数名误导 | 当前单bucket设计下无影响，未来扩展需注意 | 8.6 |
| 🟢 低 | seed-media硬编码200 | 内部脚本，无实际影响 | 8.3 |
| 🟢 低 | 批量返回的url/urlExpiry是死字段 | 无代码路径使用，仅影响可维护性 | 9.1（第五轮） |

### 10.3 设计边界澄清（第五轮更新）

1. **单 bucket 部署**: 当前系统明确设计为单 bucket 部署，所有媒体共享一个存储桶。多 bucket 支持不在当前设计范围内。
2. **S3 为一等公民**: 完整性校验在 S3 后端得到完整实现，其他后端为兼容实现，安全级别不同。
3. **状态机双层防护**:
   - 第一层（后端）：单条查询（`getById`、GET API）严格校验 `uploadHttpStatus`
   - 第二层（前端）：`LangfuseMediaView` 无条件调用 `getById`，批量查询返回的 URL 从未被使用
4. **批量查询的真实定位**: 本质是"媒体元数据预取"，而非"签名URL批量获取"，返回的 `url`/`urlExpiry` 是死字段。
5. **客户端信任模型**: SHA256 哈希由客户端计算并提供，非 S3 后端无法在存储层验证其真实性。
6. **去重边界**: 去重是"相同内容（SHA256）+ 相同类型（contentType）+ 状态200"才短路，允许同一内容以不同类型重传。
7. **写入口径统一**: 公开API和seed-media脚本的写入/去重口径统一为 `uploadHttpStatus === 200`，读取口径更宽松（接受200和201）。
8. **N+1查询设计**: 前端媒体展示采用"批量预取元数据 + 逐条获取签名URL"的模式，是有意的设计选择（利用 TanStack Query 缓存）。
