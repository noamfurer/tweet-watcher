import { getStore } from "@netlify/blobs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getRuntimeSecrets } from "./runtime-secrets.mts";

export type WatchType = "keyword" | "user";

export interface StoredWatch {
  id: string;
  type: WatchType;
  title: string;
  query: string;
  exclude: string[];
  active: boolean;
  position: number;
  lastCheck: number;
  lastError: string | null;
}

export interface StoredTweet {
  id: string;
  w: string;
  tweetId: string;
  name: string;
  handle: string;
  text: string;
  ts: number;
  unread: boolean;
  media: boolean;
  url: string;
}

export interface IngestStatus {
  state: "running" | "completed" | "failed";
  startedAt: number;
  completedAt: number | null;
  checked: number;
  inserted: number;
  failed: number;
  message: string | null;
}

interface Envelope {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

const store = () => getStore({ name: "monitor-private", consistency: "strong" });

async function encryptionKey() {
  const { dataEncryptionKey } = await getRuntimeSecrets();
  const key = Buffer.from(dataEncryptionKey, "hex");
  if (key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes");
  return key;
}

async function encrypt(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: Envelope = {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return JSON.stringify(envelope);
}

async function decrypt<T>(text: string): Promise<T> {
  const envelope = JSON.parse(text) as Envelope;
  const decipher = createDecipheriv("aes-256-gcm", await encryptionKey(), Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

async function readEncrypted<T>(key: string, fallback: T): Promise<T> {
  const value = await store().get(key, { type: "text" });
  return value ? await decrypt<T>(value) : fallback;
}

async function writeEncrypted(key: string, value: unknown) {
  await store().set(key, await encrypt(value), { metadata: { encrypted: true, version: 1 } });
}

export const readWatches = () => readEncrypted<StoredWatch[]>("watches.v1", []);
export const writeWatches = (value: StoredWatch[]) => writeEncrypted("watches.v1", value);
export const readTweets = () => readEncrypted<StoredTweet[]>("tweets.v1", []);
export const writeTweets = (value: StoredTweet[]) => writeEncrypted("tweets.v1", value);
export const readIngestStatus = () => readEncrypted<IngestStatus | null>("ingest-status.v1", null);
export const writeIngestStatus = (value: IngestStatus) => writeEncrypted("ingest-status.v1", value);

export async function acquireLease(seconds: number) {
  const now = Date.now();
  const current = await readEncrypted<{ until: number }>("lease.v1", { until: 0 });
  if (current.until > now) return false;
  await writeEncrypted("lease.v1", { until: now + seconds * 1000 });
  return true;
}

export async function releaseLease() {
  await writeEncrypted("lease.v1", { until: 0 });
}
