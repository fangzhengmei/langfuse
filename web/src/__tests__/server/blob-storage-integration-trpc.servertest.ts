import type { Session } from "next-auth";
import { prisma } from "@langfuse/shared/src/db";
import { appRouter } from "@/src/server/api/root";
import { createInnerTRPCContext } from "@/src/server/api/trpc";
import { createOrgProjectAndApiKey } from "@langfuse/shared/src/server";
import { BLOB_EXPORT_FIELD_GROUPS } from "@langfuse/shared";

describe("blobStorageIntegration tRPC", () => {
  const originalEncryptionKey = process.env.ENCRYPTION_KEY;
  let projectId: string;
  let orgId: string;
  let caller: ReturnType<typeof appRouter.createCaller>;

  const baseConfig = {
    type: "S3" as const,
    bucketName: "test-bucket",
    endpoint: null,
    region: "us-east-1",
    accessKeyId: "AKIA123456789",
    secretAccessKey: "secret123456789",
    prefix: "exports/",
    exportFrequency: "daily" as const,
    enabled: true,
    forcePathStyle: false,
    fileType: "JSONL" as const,
    exportMode: "FULL_HISTORY" as const,
    exportStartDate: null,
    compressed: true,
  };

  beforeAll(() => {
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  });

  afterAll(() => {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
  });

  beforeEach(async () => {
    const setup = await createOrgProjectAndApiKey();
    projectId = setup.projectId;
    orgId = setup.orgId;

    const session: Session = {
      expires: "1",
      user: {
        id: "user-1",
        name: "Demo User",
        canCreateOrganizations: true,
        organizations: [
          {
            id: orgId,
            role: "OWNER",
            plan: "cloud:hobby",
            cloudConfig: undefined,
            name: "Test Org",
            metadata: {},
            projects: [
              {
                id: projectId,
                role: "ADMIN",
                name: "Test Project",
                deletedAt: null,
                retentionDays: null,
                metadata: {},
              },
            ],
          },
        ],
        featureFlags: {
          templateFlag: true,
          excludeClickhouseRead: false,
        },
        admin: true,
      },
      environment: {} as any,
    };

    const ctx = createInnerTRPCContext({ session });
    caller = appRouter.createCaller({ ...ctx, prisma });
  });

  afterEach(async () => {
    await prisma.blobStorageIntegration.deleteMany({ where: { projectId } });
  });

  describe("exportFieldGroups", () => {
    it("stores a custom subset and round-trips via get", async () => {
      await caller.blobStorageIntegration.update({
        projectId,
        ...baseConfig,
        exportFieldGroups: ["core", "io"],
      });

      const result = await caller.blobStorageIntegration.get({ projectId });
      expect(result?.exportFieldGroups).toStrictEqual(["core", "io"]);
    });

    it("defaults to all groups when exportFieldGroups is omitted", async () => {
      await caller.blobStorageIntegration.update({
        projectId,
        ...baseConfig,
      });

      const stored = await prisma.blobStorageIntegration.findUnique({
        where: { projectId },
      });
      expect(stored?.exportFieldGroups).toStrictEqual([
        ...BLOB_EXPORT_FIELD_GROUPS,
      ]);
    });

    it("rejects an empty exportFieldGroups array", async () => {
      await expect(
        caller.blobStorageIntegration.update({
          projectId,
          ...baseConfig,
          exportFieldGroups: [],
        }),
      ).rejects.toThrow();
    });

    it("overwrites stored subset when a new subset is submitted", async () => {
      await caller.blobStorageIntegration.update({
        projectId,
        ...baseConfig,
        exportFieldGroups: ["core", "basic"],
      });

      await caller.blobStorageIntegration.update({
        projectId,
        ...baseConfig,
        exportFieldGroups: ["core", "io", "metrics"],
      });

      const result = await caller.blobStorageIntegration.get({ projectId });
      expect(result?.exportFieldGroups).toStrictEqual([
        "core",
        "io",
        "metrics",
      ]);
    });
  });
});
