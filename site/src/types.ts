export type WatchType = "keyword" | "user";
export type SortMode = "newest" | "oldest" | "unread";

export interface WatchRow {
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

export interface TweetRow {
  id: string;
  w: string;
  name: string;
  handle: string;
  text: string;
  ts: number;
  unread: boolean;
  media: boolean;
  url: string;
  tweetId?: string;
}

export interface Board {
  watches: WatchRow[];
  tweets: TweetRow[];
  runStatus?: {
    state: "running" | "completed" | "failed";
    startedAt: number;
    completedAt: number | null;
    checked: number;
    inserted: number;
    failed: number;
    message: string | null;
  } | null;
}

export interface WatchDraft {
  id?: string;
  type: WatchType;
  title: string;
  query: string;
  exclude: string;
  active: boolean;
}
