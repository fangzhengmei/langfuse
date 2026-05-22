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
      staleTime: 50 * 60 * 1000,  // 50分钟后视为过期，触发重新获取
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

### 5.2 续签机制原理

前端使用 **TanStack Query (React Query)** 的缓存机制实现自动续签:

1. **staleTime 配置**: 50-55分钟（URL有效期为60分钟）
2. **缓存过期**: 当数据超过 `staleTime` 后，下一次访问该查询时自动触发后台重新获取
3. **透明续签**: 用户无感知，后台静默获取新的签名URL
4. **过期时间窗口**: 留有5-10分钟的缓冲期，避免URL过期导致访问失败

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

系统支持四种对象存储后端，每种后端有不同的签名鉴权机制:

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
  }): Promise<string>;
}
```

### 6.2 AWS S3 签名机制

**文件**: `packages/shared/src/server/services/StorageService.ts:701-722`

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

**文件**: `packages/shared/src/server/services/StorageService.ts:409-439`

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

**文件**: `packages/shared/src/server/services/StorageService.ts:952-979`

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

**文件**: `packages/shared/src/server/services/StorageService.ts:1410-1452`

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

## 八、安全设计要点

1. **权限隔离**: 所有操作通过 `projectId` 边界校验，防止跨项目访问
2. **签名过期**: URL 有效期严格限制，降低泄露风险
3. **完整性校验**: 上传时强制校验 SHA256 哈希和 Content-Length
4. **去重机制**: 基于 SHA256 哈希实现文件去重，节省存储空间
5. **状态机**: `uploadHttpStatus` 确保只有上传成功的媒体才能被访问
6. **幂等性**: 高并发场景下使用原生 SQL + 重试机制保证数据一致性
7. **审计日志**: 所有上传操作记录指标，支持监控和审计
