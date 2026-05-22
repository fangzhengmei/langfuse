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

## 八、五项深度核对结果

### 8.1 问题一：前端staleTime在关闭挂载与窗口重取配置下是否会自动续签

**结论：❌ 不会自动续签，存在URL过期风险**

**详细分析**见第五章"续签机制原理与风险分析"。

**核心问题**:
- `staleTime` 仅标记数据是否过期，不主动触发重获取
- 所有自动重获取触发条件都被关闭（`refetchOnMount=false`, `refetchOnWindowFocus=false`, `refetchOnReconnect=false`）
- 未设置 `refetchInterval` 定时刷新
- 用户长时间停留在页面时，URL会在60分钟后过期，导致403错误

**修复建议**:
1. 新增 `refetchInterval: 50 * 60 * 1000` 实现定时自动续签
2. 或启用 `refetchOnMount: true` 在组件挂载时检查并刷新
3. 或在访问URL前检查过期时间，手动调用 `refetch()`

---

### 8.2 问题二：200与201在去重短路、状态回写、读取放行中的处理口径是否一致

**结论：❌ 不一致，存在两处逻辑缺陷**

#### 三个场景的口径对比

| 场景 | 代码位置 | 检查逻辑 | 200 | 201 | 一致性 |
|------|---------|---------|-----|-----|--------|
| **去重短路** | `media/index.ts:72-75` | `uploadHttpStatus === 200` | ✅ 通过 | ❌ 不通过 | ❌ 不一致 |
| **状态回写清空错误** | `[mediaId].ts:98` | `uploadHttpStatus === 200 ? null` | ✅ 清空错误 | ❌ 保留错误 | ❌ 不一致 |
| **读取放行** | `media.ts:41` 和 `[mediaId].ts:43` | `=== 200 \|\| === 201` | ✅ 通过 | ✅ 通过 | ✅ 一致 |

#### 缺陷1：去重短路漏掉201

**代码**:
```typescript
// web/src/pages/api/public/media/index.ts:72-75
if (
  existingMedia &&
  existingMedia.uploadHttpStatus === 200 &&  // ⚠️ 只判断200，漏掉201
  existingMedia.contentType === contentType
) {
  // 去重命中，直接返回
}
```

**影响**: S3 PUT成功通常返回201而非200。如果之前上传返回的是201，下次相同文件上传时无法命中去重，会：
1. 重新生成签名上传URL
2. 重新执行媒体记录upsert
3. 客户端重复上传相同文件到存储
4. 浪费存储和带宽资源

**修复**:
```typescript
existingMedia &&
(existingMedia.uploadHttpStatus === 200 || existingMedia.uploadHttpStatus === 201) &&  // ✅ 同时判断200和201
existingMedia.contentType === contentType
```

#### 缺陷2：状态回写时201不清空错误信息

**代码**:
```typescript
// web/src/pages/api/public/media/[mediaId].ts:95-99
data: {
  uploadedAt,
  uploadHttpStatus,
  uploadHttpError: uploadHttpStatus === 200 ? null : uploadHttpError,  // ⚠️ 只有200才清空
}
```

**影响**: 如果客户端回调传入 `uploadHttpStatus=201` 且 `uploadHttpError` 非空，错误信息会被错误保留。

**修复**:
```typescript
uploadHttpError: (uploadHttpStatus === 200 || uploadHttpStatus === 201) ? null : uploadHttpError,  // ✅ 200和201都清空
```

---

### 8.3 问题三：多bucket场景下存储客户端单例与批量签名是否存在隐含前提

**结论：❌ 存在严重设计缺陷，多bucket场景下会导致签名URL指向错误的bucket**

#### 单例模式实现

**代码**:
```typescript
// web/src/features/media/server/getMediaStorageClient.ts:7-24
let s3StorageServiceClient: StorageService;  // ⚠️ 模块级单例

export const getMediaStorageServiceClient = (
  bucketName: string,  // ⚠️ 参数传入，但仅第一次有效
): StorageService => {
  if (!s3StorageServiceClient) {
    s3StorageServiceClient = StorageServiceFactory.getInstance({
      bucketName,  // ⚠️ 只在第一次调用时使用！
      accessKeyId: env.LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID,
      secretAccessKey: env.LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY,
      endpoint: env.LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT,
      region: env.LANGFUSE_S3_MEDIA_UPLOAD_REGION,
      forcePathStyle: env.LANGFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE === "true",
      awsSse: env.LANGFUSE_S3_MEDIA_UPLOAD_SSE,
      awsSseKmsKeyId: env.LANGFUSE_S3_MEDIA_UPLOAD_SSE_KMS_KEY_ID,
    });
  }
  return s3StorageServiceClient;  // ⚠️ 后续调用忽略bucketName参数！
};
```

#### 批量签名场景的问题

**代码**:
```typescript
// web/src/server/api/routers/media.ts:147-169
const mediaStorageClient = getMediaStorageServiceClient(
  media[0].bucket_name,  // ⚠️ 只用第一个媒体的bucketName创建客户端
);
// ...
return await Promise.all(
  media.map<Promise<MediaReturnType>>(async (m) => {
    const url = await mediaStorageClient.getSignedUrl(  // ⚠️ 所有媒体都用同一个客户端！
      m.bucket_path,  // ⚠️ 如果m.bucket_name不同，URL会指向错误的bucket
      ttlSeconds,
      false,
    );
    // ...
  }),
);
```

#### 隐含前提与风险

**当前隐含前提**:
1. 所有媒体都存储在同一个 bucket 中（`LANGFUSE_S3_MEDIA_UPLOAD_BUCKET`）
2. media 表中所有记录的 `bucketName` 字段值相同

**风险场景**:
1. 未来支持按项目配置不同bucket
2. 数据迁移过程中存在新旧bucket并存
3. 手动修改了数据库中某些记录的 `bucketName`

**后果**:
- 签名URL会指向错误的bucket
- 客户端访问时出现404或权限错误
- 调试困难，因为代码逻辑看起来是正确的

#### 修复建议

**方案一：改为按bucket缓存客户端（推荐）**

```typescript
const storageServiceClients: Record<string, StorageService> = {};  // 按bucketName缓存

export const getMediaStorageServiceClient = (
  bucketName: string,
): StorageService => {
  if (!storageServiceClients[bucketName]) {
    storageServiceClients[bucketName] = StorageServiceFactory.getInstance({
      bucketName,
      // ... 其他配置
    });
  }
  return storageServiceClients[bucketName];
};
```

**方案二：批量签名时每个媒体使用正确的客户端**

```typescript
return await Promise.all(
  media.map<Promise<MediaReturnType>>(async (m) => {
    const client = getMediaStorageServiceClient(m.bucket_name);  // 每个媒体用自己的bucketName
    const url = await client.getSignedUrl(
      m.bucket_path,
      ttlSeconds,
      false,
    );
    // ...
  }),
);
```

---

### 8.4 问题四：各存储后端上传签名对sha256与内容长度校验是否等价

**结论：❌ 严重不等价，仅S3实现了完整的完整性校验**

#### 各后端实现对比

| 存储后端 | SHA256 校验 | Content-Length 校验 | 实现强度 |
|---------|------------|--------------------|---------|
| **AWS S3** | ✅ 强制签名校验<br>`ChecksumSHA256` + `unhoistableHeaders` | ✅ 强制签名校验<br>`ContentLength` + `signableHeaders` | 🔒🔒🔒🔒🔒 完整 |
| **Azure Blob** | ❌ 完全忽略参数 | ❌ 完全忽略参数 | 🔒 无 |
| **Google Cloud Storage** | ❌ 完全忽略参数 | ✅ 扩展头校验<br>`extensionHeaders["Content-Length"]` | 🔒🔒 部分 |
| **OCI Object Storage** | ❌ 完全忽略参数 | ❌ 完全忽略参数 | 🔒 无 |

#### 详细代码分析

**S3 实现**（唯一完整实现）:
```typescript
// packages/shared/src/server/services/StorageService.ts:766-792
public async getSignedUploadUrl(params: {
  path: string;
  ttlSeconds: number;
  sha256Hash: string;
  contentType: string;
  contentLength: number;
}): Promise<string> {
  const { path, ttlSeconds, contentType, contentLength, sha256Hash } = params;

  return getSignedUrl(
    this.signedUrlClient,
    new PutObjectCommand(
      this.addSSEToParams({
        Bucket: this.bucketName,
        Key: path,
        ContentType: contentType,
        ChecksumSHA256: sha256Hash,    // ✅ 包含在签名中
        ContentLength: contentLength,  // ✅ 包含在签名中
      }),
    ),
    {
      expiresIn: ttlSeconds,
      signableHeaders: new Set(["content-type", "content-length"]),  // ✅ 强制签名头
      unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),  // ✅ 防止篡改
    },
  );
}
```

**Azure Blob 实现**（完全忽略）:
```typescript
// packages/shared/src/server/services/StorageService.ts:441-475
public async getSignedUploadUrl(params: {
  path: string;
  ttlSeconds: number;
  sha256Hash: string;        // ❌ 解构但未使用
  contentType: string;
  contentLength: number;     // ❌ 解构但未使用
}): Promise<string> {
  const { path, ttlSeconds, contentType } = params;  // ⚠️ 只解构了三个参数
  // ...
  let url = await blockBlobClient.generateSasUrl({
    permissions: BlobSASPermissions.parse("w"),
    expiresOn: new Date(Date.now() + ttlSeconds * 1000),
    contentType: contentType,  // ✅ 只校验contentType
    // ❌ 缺少sha256Hash校验
    // ❌ 缺少contentLength校验
  });
  // ...
}
```

**GCS 实现**（只校验Content-Length）:
```typescript
// packages/shared/src/server/services/StorageService.ts:981-1015
public async getSignedUploadUrl(params: {
  path: string;
  ttlSeconds: number;
  sha256Hash: string;        // ❌ 解构但未使用
  contentType: string;
  contentLength: number;
}): Promise<string> {
  const { path, ttlSeconds, contentType } = params;  // ⚠️ 未解构sha256Hash

  const options: GetSignedUrlConfig = {
    version: "v4",
    action: "write",
    expires: Date.now() + ttlSeconds * 1000,
    contentType,
    extensionHeaders: {
      "Content-Length": params.contentLength.toString(),  // ✅ 包含在签名中
    },
    // ❌ 缺少sha256Hash校验
  };
  // ...
}
```

**OCI 实现**（完全忽略）:
```typescript
// packages/shared/src/server/services/StorageService.ts:1474-1518
public async getSignedUploadUrl(params: {
  path: string;
  ttlSeconds: number;
  sha256Hash: string;        // ❌ 解构但未使用
  contentType: string;       // ❌ 解构但未使用
  contentLength: number;     // ❌ 解构但未使用
}): Promise<string> {
  const { path, ttlSeconds } = params;  // ⚠️ 只解构了两个参数
  // PAR只控制访问权限，不校验任何内容属性
  // ...
}
```

#### 安全风险

| 风险 | S3 | Azure | GCS | OCI |
|------|----|-------|-----|-----|
| 上传不同内容的文件 | ❌ 被阻止 | ✅ 可能 | ✅ 可能 | ✅ 可能 |
| 上传不同大小的文件 | ❌ 被阻止 | ✅ 可能 | ❌ 被阻止 | ✅ 可能 |
| 上传不同类型的文件 | ❌ 被阻止 | ❌ 被阻止 | ❌ 被阻止 | ❌ 被阻止 |

**攻击场景**:
- 攻击者获取签名URL后，可以上传任意内容（非S3后端）
- 可以替换为恶意文件、更大的文件等
- SHA256去重机制失效（因为实际文件内容不同）

#### 修复建议

**方案一：在应用层增加校验（通用方案）**

在客户端上传完成后，后端验证文件完整性：
```typescript
// PATCH回调时增加校验逻辑
const s3Client = getMediaStorageServiceClient(media.bucketName);
const fileContent = await s3Client.download(media.bucketPath);
const actualHash = crypto.createHash('sha256').update(fileContent).digest('base64');
if (actualHash !== media.sha256Hash) {
  // 校验失败，删除文件并标记错误
  await s3Client.deleteFiles([media.bucketPath]);
  throw new Error("File integrity check failed");
}
```

**方案二：各存储后端原生支持（需要分别实现）**

- Azure Blob: 使用 `content-md5` 或 `x-ms-blob-content-md5` 头
- GCS: 研究是否支持 `x-goog-hash` 头的签名校验
- OCI: 研究 PAR 是否支持内容校验

---

### 8.5 问题五：PATCH异常分支的错误信息拼接是否正确

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

## 九、安全设计要点

### 9.1 现有安全措施

1. **权限隔离**: 所有操作通过 `projectId` 边界校验，防止跨项目访问
2. **签名过期**: URL 有效期严格限制（默认3600秒），降低泄露风险
3. **完整性校验（S3）**: 上传时强制校验 SHA256 哈希和 Content-Length
4. **去重机制**: 基于 SHA256 哈希实现文件去重，节省存储空间
5. **状态机**: `uploadHttpStatus` 确保只有上传成功的媒体才能被访问
6. **幂等性**: 高并发场景下使用原生 SQL + 重试机制保证数据一致性
7. **审计日志**: 所有上传操作记录指标，支持监控和审计

### 9.2 待修复的安全缺陷

1. **前端URL过期风险**（见8.1）- 需添加自动续签机制
2. **200/201状态不一致**（见8.2）- 需统一处理口径
3. **多bucket单例缺陷**（见8.3）- 需改为按bucket缓存客户端
4. **非S3后端完整性校验缺失**（见8.4）- 需增加应用层校验
5. **错误信息拼接bug**（见8.5）- 需修复运算符优先级问题
