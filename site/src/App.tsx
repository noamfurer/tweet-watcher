import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Image as ImageIcon,
  Lock,
  LogOut,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { Board, SortMode, TweetRow, WatchDraft, WatchRow } from "./types";

const EMPTY: Board = { watches: [], tweets: [], runStatus: null };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "הפעולה נכשלה");
  return payload as T;
}

function timeIL(value: number | Date) {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function dateIL(value: number | Date) {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}

function ago(now: number, then: number) {
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return "עכשיו";
  if (minutes < 60) return `לפני ${minutes} דק׳`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `לפני ${hours} שעות`;
  return `לפני ${Math.round(hours / 24)} ימים`;
}

function nextAutomaticRun(now: number) {
  const d = new Date(now);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    minute: "2-digit",
  });
  const minute = Number(formatter.format(d));
  const wait = 15 - (minute % 15) || 15;
  return { at: now + wait * 60_000, wait };
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("");
}

export default function App() {
  const [auth, setAuth] = useState<"loading" | "locked" | "open">("loading");

  useEffect(() => {
    request<{ unlocked: boolean }>("/api/auth")
      .then((result) => setAuth(result.unlocked ? "open" : "locked"))
      .catch(() => setAuth("locked"));
  }, []);

  if (auth === "loading") return <div className="center-screen muted">טוען...</div>;
  if (auth === "locked") return <Login onOpen={() => setAuth("open")} />;
  return <Monitor onLock={() => setAuth("locked")} />;
}

function Login({ onOpen }: { onOpen: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await request("/api/auth", { method: "POST", body: JSON.stringify({ password }) });
      onOpen();
    } catch (e) {
      setError(e instanceof Error ? e.message : "סיסמה שגויה");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center-screen login-wrap" dir="rtl">
      <form className="login-card" onSubmit={submit}>
        <div className="login-icon"><Lock size={22} /></div>
        <h1>מוניטור X</h1>
        <p>הזן סיסמת גישה. המחשב הזה ייזכר לחודש.</p>
        <label htmlFor="password">סיסמה</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="form-error">{error}</div>}
        <button className="button brand full" disabled={busy || !password}>
          {busy ? "בודק..." : "כניסה"}
        </button>
      </form>
    </main>
  );
}

function Monitor({ onLock }: { onLock: () => void }) {
  const [board, setBoard] = useState<Board>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<"deck" | "manage">("deck");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("newest");
  const [mobileIndex, setMobileIndex] = useState(0);
  const [draft, setDraft] = useState<WatchDraft | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [runRequestedAt, setRunRequestedAt] = useState(0);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const data = await request<Board>("/api/board", { cache: "no-store" });
      setBoard(data);
      setError("");
    } catch (e) {
      const message = e instanceof Error ? e.message : "טעינת הלוח נכשלה";
      setError(message);
      if (/גישה|session|401/i.test(message)) onLock();
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [onLock]);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(true), 60_000);
    const clock = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [load]);

  useEffect(() => {
    if (!runRequestedAt) return;
    const poll = window.setInterval(() => void load(true), 5_000);
    const timeout = window.setTimeout(() => setRunRequestedAt(0), 3 * 60_000);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(timeout);
    };
  }, [load, runRequestedAt]);

  useEffect(() => {
    const status = board.runStatus;
    if (!runRequestedAt || !status || status.startedAt < runRequestedAt - 2_000) return;
    if (status.state === "running") {
      setNotice("הבדיקה מתבצעת כעת...");
      return;
    }
    if (status.state === "failed") {
      setNotice(status.message || "הבדיקה נכשלה. יתבצע ניסיון נוסף בעדכון הבא.");
      setRunRequestedAt(0);
      return;
    }
    const failures = status.failed ? ` · ${status.failed} מקורות לא היו זמינים` : "";
    setNotice(`הבדיקה הסתיימה: ${status.checked} מעקבים נבדקו, ${status.inserted} ציוצים חדשים נמצאו${failures}.`);
    setRunRequestedAt(0);
  }, [board.runStatus, runRequestedAt]);

  const action = useCallback(async (name: string, payload: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const result = await request<{ queued?: boolean; id?: string; mode?: string }>("/api/board", {
        method: "POST",
        body: JSON.stringify({ action: name, payload }),
      });
      await load(true);
      return result;
    } finally {
      setBusy(false);
    }
  }, [load]);

  const columns = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return board.watches.map((watch, index) => {
      let tweets = board.tweets.filter((tweet) => tweet.w === watch.id);
      if (needle) {
        tweets = tweets.filter((tweet) =>
          `${tweet.text} ${tweet.name} ${tweet.handle}`.toLowerCase().includes(needle),
        );
      }
      tweets = [...tweets].sort((a, b) => {
        if (sort === "oldest") return a.ts - b.ts;
        if (sort === "unread" && a.unread !== b.unread) return a.unread ? -1 : 1;
        return b.ts - a.ts;
      });
      return {
        ...watch,
        index,
        tweets,
        unread: board.tweets.filter((tweet) => tweet.w === watch.id && tweet.unread).length,
      };
    });
  }, [board, search, sort]);

  const stamps = board.watches.map((watch) => watch.lastCheck).filter(Boolean);
  const lastCheck = stamps.length ? Math.max(...stamps) : 0;
  const next = nextAutomaticRun(now);

  async function queueCheck(watchId?: string) {
    setNotice("");
    try {
      const result = await action("runCheck", watchId ? { watchId } : {});
      if (result.mode === "github-schedule") {
        setNotice("בקשת הרענון נקלטה. הנתונים יתעדכנו אוטומטית בבדיקה הקרובה.");
        return;
      }
      setRunRequestedAt(Date.now());
      setNotice("הבדיקה החלה ברקע. התוצאות יופיעו כאן בתוך זמן קצר.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "הפעלת הבדיקה נכשלה");
    }
  }

  async function saveDraft() {
    if (!draft?.query.trim()) return;
    const isUser = draft.type === "user";
    const cleanQuery = isUser
      ? `from:${draft.query.replace(/^@/, "").replace(/^from:/i, "").trim()}`
      : draft.query.trim();
    const cleanTitle = draft.title.trim() || (isUser ? `@${cleanQuery.replace(/^from:/, "")}` : cleanQuery);
    const exclude = draft.exclude.split(",").map((x) => x.trim()).filter(Boolean);
    const result = await action("saveWatch", {
      id: draft.id,
      type: draft.type,
      title: cleanTitle,
      query: cleanQuery,
      exclude,
      active: draft.active,
    });
    setDraft(null);
    if (!draft.id && result.id) await queueCheck(result.id);
  }

  async function logout() {
    await request("/api/auth", { method: "DELETE" });
    onLock();
  }

  const activeColumn = columns[Math.min(mobileIndex, Math.max(0, columns.length - 1))];

  return (
    <main className="app-shell" dir="rtl">
      <header className="topbar">
        <div className="brand-row">
          <div>
            <h1>מוניטור X</h1>
            <p>לוח ניטור ציוצים פרטי</p>
          </div>
          <div className="tabs">
            <button className={view === "deck" ? "active" : ""} onClick={() => setView("deck")}>לוח</button>
            <button className={view === "manage" ? "active" : ""} onClick={() => setView("manage")}>ניהול מעקבים</button>
          </div>
        </div>
        <div className="toolbar">
          <div className="status-block">
            <span>בדיקה אחרונה</span>
            <b>{lastCheck ? `${timeIL(lastCheck)} (${ago(now, lastCheck)})` : "טרם בוצעה"}</b>
          </div>
          <div className="status-block">
            <span>הבדיקה הבאה</span>
            <b>{timeIL(next.at)} (בעוד {next.wait} דק׳)</b>
          </div>
          <div className="search-box">
            <Search size={15} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="חיפוש בציוצים" />
          </div>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortMode)} aria-label="מיון ציוצים">
            <option value="newest">החדשים תחילה</option>
            <option value="oldest">הישנים תחילה</option>
            <option value="unread">לא נקראו תחילה</option>
          </select>
          <button className="button ghost" disabled={busy} onClick={() => void action("setManyUnread", { unread: false })}>
            <Check size={15} /> סמן הכל כנקרא
          </button>
          <button className="button dark" disabled={busy} onClick={() => void queueCheck()}>
            <RefreshCw size={15} className={busy ? "spin" : ""} /> רענון עכשיו
          </button>
          <button className="icon-button" title="יציאה" onClick={() => void logout()}><LogOut size={16} /></button>
        </div>
      </header>

      <div className="cadence">בדיקה אוטומטית כל כ-15 דקות בשעות הפעילות לפי שעון ישראל</div>
      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <div className="empty-state">טוען את לוח המעקב...</div>
      ) : view === "manage" ? (
        <Manage
          watches={board.watches}
          tweets={board.tweets}
          busy={busy}
          onAdd={() => setDraft({ type: "keyword", title: "", query: "", exclude: "", active: true })}
          onEdit={(watch) => setDraft({ ...watch, exclude: watch.exclude.join(", ") })}
          onAction={action}
        />
      ) : (
        <>
          <div className="mobile-watch-select">
            <select value={mobileIndex} onChange={(e) => setMobileIndex(Number(e.target.value))}>
              {columns.map((column, index) => <option key={column.id} value={index}>{column.title} ({column.unread})</option>)}
            </select>
            <button className="button brand" onClick={() => setDraft({ type: "keyword", title: "", query: "", exclude: "", active: true })}><Plus size={15} /> חדש</button>
          </div>
          <section className="desktop-deck">
            {columns.map((column) => (
              <ColumnCard key={column.id} column={column} now={now} onAction={action} onCheck={queueCheck} />
            ))}
            <button className="add-column" onClick={() => setDraft({ type: "keyword", title: "", query: "", exclude: "", active: true })}>
              <Plus size={22} /> הוספת מעקב
            </button>
          </section>
          <section className="mobile-deck">
            {activeColumn ? <ColumnCard column={activeColumn} now={now} onAction={action} onCheck={queueCheck} /> : <div className="empty-state">אין מעקבים</div>}
          </section>
        </>
      )}

      {draft && <WatchDialog draft={draft} setDraft={setDraft} onClose={() => setDraft(null)} onSave={saveDraft} busy={busy} />}
    </main>
  );
}

type ColumnData = WatchRow & { index: number; tweets: TweetRow[]; unread: number };

function ColumnCard({
  column,
  now,
  onAction,
  onCheck,
}: {
  column: ColumnData;
  now: number;
  onAction: (name: string, payload?: Record<string, unknown>) => Promise<unknown>;
  onCheck: (watchId?: string) => Promise<void>;
}) {
  return (
    <article className={`column-card ${column.active ? "" : "paused"}`}>
      <header className="column-head">
        <div className="column-title-row">
          <span className={`type-chip ${column.type}`}>{column.type === "user" ? "חשבון" : "מילת מפתח"}</span>
          <h2>{column.title}</h2>
          {column.unread > 0 && <span className="unread-badge">{column.unread}</span>}
        </div>
        <div className="column-query">{column.query}</div>
        <div className="column-meta">
          {column.active ? `נבדק ${ago(now, column.lastCheck)}` : "המעקב מושהה"}
          {column.lastError && <span className="danger">בעיה זמנית בשאיבה</span>}
        </div>
        <div className="column-actions">
          <button onClick={() => void onCheck(column.id)}><RefreshCw size={13} /> בדיקה</button>
          <button onClick={() => void onAction("setManyUnread", { unread: false, watchId: column.id })}><Check size={13} /> קראתי הכל</button>
        </div>
      </header>
      <div className="tweet-list">
        {column.tweets.length ? column.tweets.map((tweet) => (
          <TweetCard key={tweet.id} tweet={tweet} now={now} onToggle={() => void onAction("setTweetUnread", { id: tweet.id, unread: !tweet.unread })} />
        )) : (
          <div className="column-empty">{column.lastError ? `השאיבה נכשלה: ${column.lastError}` : "אין ציוצים חדשים במעקב הזה"}</div>
        )}
      </div>
    </article>
  );
}

function TweetCard({ tweet, now, onToggle }: { tweet: TweetRow; now: number; onToggle: () => void }) {
  return (
    <article className={`tweet ${tweet.unread ? "unread" : ""}`} onClick={onToggle}>
      <div className="avatar">{initials(tweet.name)}</div>
      <div className="tweet-body">
        <div className="tweet-author">
          <b>{tweet.name}</b><span>{tweet.handle}</span><time>{ago(now, tweet.ts)}</time>
        </div>
        <p>{tweet.text}</p>
        {tweet.media && <div className="media-placeholder"><ImageIcon size={16} /> מדיה מצורפת</div>}
        <div className="tweet-links">
          <a href={tweet.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><ExternalLink size={12} /> הציוץ המקורי</a>
          <span>{dateIL(tweet.ts)} · {timeIL(tweet.ts)}</span>
          {tweet.unread && <em>חדש</em>}
        </div>
      </div>
    </article>
  );
}

function Manage({
  watches,
  tweets,
  busy,
  onAdd,
  onEdit,
  onAction,
}: {
  watches: WatchRow[];
  tweets: TweetRow[];
  busy: boolean;
  onAdd: () => void;
  onEdit: (watch: WatchRow) => void;
  onAction: (name: string, payload?: Record<string, unknown>) => Promise<unknown>;
}) {
  return (
    <section className="manage-card">
      <div className="manage-head">
        <div><h2>ניהול מעקבים</h2><p>{watches.length} מעקבים · {watches.filter((w) => w.active).length} פעילים · {tweets.filter((t) => t.unread).length} ציוצים לא נקראו</p></div>
        <button className="button brand" onClick={onAdd}><Plus size={15} /> הוספת מעקב</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>מעקב</th><th>שאילתה</th><th>סטטוס</th><th>בדיקה אחרונה</th><th>ציוצים</th><th>פעולות</th></tr></thead>
          <tbody>
            {watches.map((watch, index) => (
              <tr key={watch.id}>
                <td><b>{watch.title}</b><small>{watch.type === "user" ? "חשבון" : "מילת מפתח"}</small></td>
                <td><code>{watch.query}</code><small>{watch.exclude.length ? `החרגות: ${watch.exclude.join(", ")}` : "אין החרגות"}</small></td>
                <td><span className={`status-pill ${watch.active ? "on" : "off"}`}>{watch.active ? "פעיל" : "מושהה"}</span></td>
                <td>{timeIL(watch.lastCheck)}<small>{ago(Date.now(), watch.lastCheck)}</small></td>
                <td>{tweets.filter((t) => t.w === watch.id).length}<small>{tweets.filter((t) => t.w === watch.id && t.unread).length} לא נקראו</small></td>
                <td>
                  <div className="row-actions">
                    <button disabled={index === 0 || busy} title="הזזה למעלה" onClick={() => void onAction("moveWatch", { id: watch.id, direction: -1 })}><ChevronRight size={15} /></button>
                    <button disabled={index === watches.length - 1 || busy} title="הזזה למטה" onClick={() => void onAction("moveWatch", { id: watch.id, direction: 1 })}><ChevronLeft size={15} /></button>
                    <button title="עריכה" onClick={() => onEdit(watch)}><Pencil size={15} /></button>
                    <button title={watch.active ? "השהיה" : "הפעלה"} onClick={() => void onAction("setWatchActive", { id: watch.id, active: !watch.active })}><Play size={15} /></button>
                    <button className="delete" title="מחיקה" onClick={() => { if (confirm(`למחוק את המעקב "${watch.title}"?`)) void onAction("deleteWatch", { id: watch.id }); }}><Trash2 size={15} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WatchDialog({
  draft,
  setDraft,
  onClose,
  onSave,
  busy,
}: {
  draft: WatchDraft;
  setDraft: (draft: WatchDraft) => void;
  onClose: () => void;
  onSave: () => Promise<void>;
  busy: boolean;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose}><X size={18} /></button>
        <h2>{draft.id ? "עריכת מעקב" : "הוספת מעקב"}</h2>
        <p>הפרטים נשמרים מוצפנים בצד השרת בלבד.</p>
        <label>סוג המעקב</label>
        <div className="segmented">
          <button className={draft.type === "keyword" ? "active" : ""} onClick={() => setDraft({ ...draft, type: "keyword" })}>מילת מפתח</button>
          <button className={draft.type === "user" ? "active" : ""} onClick={() => setDraft({ ...draft, type: "user" })}>חשבון X</button>
        </div>
        <label>שם לתצוגה</label>
        <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="למשל: יוקר המחיה" />
        <label>{draft.type === "user" ? "שם המשתמש" : "שאילתת החיפוש"}</label>
        <input value={draft.query} onChange={(e) => setDraft({ ...draft, query: e.target.value })} placeholder={draft.type === "user" ? "@username" : "מילים לחיפוש"} />
        <label>מילות החרגה, מופרדות בפסיקים</label>
        <input value={draft.exclude} onChange={(e) => setDraft({ ...draft, exclude: e.target.value })} placeholder="מילה אחת, מילה נוספת" />
        <label className="switch-row"><input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> מעקב פעיל</label>
        <div className="modal-actions">
          <button className="button ghost" onClick={onClose}>ביטול</button>
          <button className="button brand" disabled={busy || !draft.query.trim()} onClick={() => void onSave()}>{busy ? "שומר..." : "שמירה"}</button>
        </div>
      </section>
    </div>
  );
}
