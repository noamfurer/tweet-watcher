import { getStore } from "@netlify/blobs";

export interface RuntimeSecrets {
  sessionSecret: string;
  dataEncryptionKey: string;
  cronSecret: string;
  migrationSecret: string;
  passwordSalt: string;
  passwordHash: string;
}

const store = () => getStore({ name: "monitor-private", consistency: "strong" });
let cached: RuntimeSecrets | null = null;

export async function getRuntimeSecrets() {
  if (cached) return cached;
  const value = await store().get("runtime-secrets.v1", { type: "json" }) as RuntimeSecrets | null;
  if (!value) throw new Error("Runtime secrets are not initialized");
  cached = value;
  return value;
}

export async function runtimeSecretsExist() {
  return Boolean(await store().get("runtime-secrets.v1", { type: "text" }));
}

export async function writeRuntimeSecrets(value: RuntimeSecrets) {
  if (await runtimeSecretsExist()) throw new Error("Runtime secrets already initialized");
  await store().setJSON("runtime-secrets.v1", value, {
    metadata: { private: true, version: 1 },
  });
  cached = value;
}
