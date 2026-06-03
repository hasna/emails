import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  listMailbox, mailboxCounts, getMessageBody, getConversation,
  toggleStar, toggleRead, markRead, archiveMessage, replyDefaults, sendComposed,
  MAILBOXES, mailboxLabel, type Mailbox, type TuiMessage, type MailboxCounts,
} from "./data.js";
import { autoPull } from "./autopull.js";
import { truncate, senderName, relativeTime, formatDate, wrapText } from "./format.js";

type Focus = "sidebar" | "list" | "reader";
type Mode = "browse" | "search" | "compose";
type ComposeField = "to" | "subject" | "body";

interface ComposeState { to: string; subject: string; body: string; field: ComposeField; replyTo?: TuiMessage }
interface Status { text: string; tone: "info" | "ok" | "err" }

const REFRESH_MS = 4000;
const PULL_MS = 12000;

function useDimensions(): { cols: number; rows: number } {
  const { stdout } = useStdout();
  const [dims, setDims] = useState({ cols: stdout?.columns ?? 120, rows: stdout?.rows ?? 32 });
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setDims({ cols: stdout.columns ?? 120, rows: stdout.rows ?? 32 });
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);
  return dims;
}

export interface AppProps { initialMailbox?: Mailbox }

export function App({ initialMailbox = "inbox" }: AppProps) {
  const { exit } = useApp();
  const { cols, rows } = useDimensions();

  const [mailbox, setMailbox] = useState<Mailbox>(initialMailbox);
  const [messages, setMessages] = useState<TuiMessage[]>(() => listMailbox(initialMailbox));
  const [counts, setCounts] = useState<MailboxCounts>(() => mailboxCounts());
  const [sel, setSel] = useState(0);
  const [focus, setFocus] = useState<Focus>("list");
  const [mode, setMode] = useState<Mode>("browse");
  const [search, setSearch] = useState("");
  const [readerScroll, setReaderScroll] = useState(0);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [status, setStatus] = useState<Status>({ text: "", tone: "info" });
  const [now, setNow] = useState(() => Date.now());
  const [pulling, setPulling] = useState(false);

  const selectedMsg = messages[sel] ?? null;

  const reload = useCallback((opts?: { keepSel?: boolean }) => {
    const next = listMailbox(mailbox, { search: search || undefined });
    setMessages(next);
    setCounts(mailboxCounts());
    if (!opts?.keepSel) setSel((s) => Math.min(s, Math.max(0, next.length - 1)));
  }, [mailbox, search]);

  // Reload when the mailbox or search changes.
  useEffect(() => { reload(); setSel(0); /* eslint-disable-next-line */ }, [mailbox]);
  useEffect(() => { reload({ keepSel: true }); /* eslint-disable-next-line */ }, [search]);

  // Auto-refresh from the local DB (reflects state changes + freshly pulled mail).
  useEffect(() => {
    const t = setInterval(() => { setNow(Date.now()); reload({ keepSel: true }); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [reload]);

  // Auto-pull (daemon): drain real-time inbound / sync S3 in the background.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      setPulling(true);
      const r = await autoPull().catch(() => null);
      if (!alive) return;
      setPulling(false);
      if (r?.pulled) { setStatus({ text: `↓ ${r.pulled} new`, tone: "ok" }); reload({ keepSel: true }); }
      else if (r && !r.ok && r.reason && !/credential|profile|not configured|region|access key/i.test(r.reason)) {
        // Surface real pull failures, but stay quiet about "no AWS creds here".
        setStatus({ text: `pull: ${r.reason.slice(0, 36)}`, tone: "err" });
      }
    };
    void tick();
    const t = setInterval(() => { void tick(); }, PULL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [reload]);

  const body = useMemo(() => (selectedMsg ? getMessageBody(selectedMsg) : null), [selectedMsg?.id, messages]);
  const conversation = useMemo(() => (selectedMsg ? getConversation(selectedMsg) : []), [selectedMsg?.id, messages]);

  const flash = (text: string, tone: Status["tone"] = "info") => setStatus({ text, tone });

  // ── actions ────────────────────────────────────────────────────────────────
  const openReader = () => { if (selectedMsg) { markRead(selectedMsg); setFocus("reader"); setReaderScroll(0); reload({ keepSel: true }); } };
  const doStar = () => { if (selectedMsg?.kind === "inbound") { toggleStar(selectedMsg); flash(selectedMsg.is_starred ? "unstarred" : "starred", "ok"); reload({ keepSel: true }); } };
  const doRead = () => { if (selectedMsg?.kind === "inbound") { toggleRead(selectedMsg); flash(selectedMsg.is_read ? "marked unread" : "marked read", "ok"); reload({ keepSel: true }); } };
  const doArchive = () => { if (selectedMsg?.kind === "inbound") { archiveMessage(selectedMsg, mailbox !== "archived"); flash(mailbox === "archived" ? "unarchived" : "archived", "ok"); reload(); } };

  const startCompose = (replyTo?: TuiMessage) => {
    if (replyTo) {
      const d = replyDefaults(replyTo);
      setCompose({ to: d.to, subject: d.subject, body: "", field: "body", replyTo });
    } else {
      setCompose({ to: "", subject: "", body: "", field: "to" });
    }
    setMode("compose");
  };

  const sendCompose = async () => {
    if (!compose) return;
    flash("sending…");
    try {
      await sendComposed({ from: deriveFrom(compose), to: compose.to, subject: compose.subject, body: compose.body });
      setMode("browse"); setCompose(null);
      flash("✓ sent", "ok");
      if (mailbox === "sent") reload();
    } catch (e) { flash(`✗ ${e instanceof Error ? e.message : String(e)}`.slice(0, 60), "err"); }
  };

  function deriveFrom(c: ComposeState): string {
    if (c.replyTo) return replyDefaults(c.replyTo).from;
    // New message: default From = the first owned/sender address we can find.
    return (messages.find((m) => m.kind === "sent")?.from) ?? (body?.to.split(",")[0]?.trim() ?? "");
  }

  // ── input ────────────────────────────────────────────────────────────────────
  useInput((input, key) => {
    if (mode === "compose" && compose) { handleComposeKey(input, key); return; }
    if (mode === "search") { handleSearchKey(input, key); return; }

    if (input === "q" || (key.ctrl && input === "c")) { exit(); return; }
    if (key.tab) { setFocus((f) => (f === "sidebar" ? "list" : f === "list" ? "reader" : "sidebar")); return; }
    if (input === "c") { startCompose(); return; }
    if (input === "/") { setMode("search"); return; }
    if (input === "g" || input === "R") { flash("refreshing…"); void autoPull().then((r) => { reload(); flash(r?.pulled ? `↓ ${r.pulled} new` : "up to date", "ok"); }); return; }

    if (focus === "sidebar") {
      if (key.upArrow || input === "k") setMailbox((m) => MAILBOXES[(MAILBOXES.indexOf(m) + MAILBOXES.length - 1) % MAILBOXES.length]!);
      else if (key.downArrow || input === "j") setMailbox((m) => MAILBOXES[(MAILBOXES.indexOf(m) + 1) % MAILBOXES.length]!);
      else if (key.return || key.rightArrow || input === "l") setFocus("list");
      return;
    }
    if (focus === "list") {
      if (key.upArrow || input === "k") setSel((s) => Math.max(0, s - 1));
      else if (key.downArrow || input === "j") setSel((s) => Math.min(messages.length - 1, s + 1));
      else if (key.return || key.rightArrow || input === "l") openReader();
      else if (key.leftArrow || input === "h") setFocus("sidebar");
      else if (input === "s") doStar();
      else if (input === "e") doArchive();
      else if (input === "u") doRead();
      else if (input === "r" && selectedMsg) startCompose(selectedMsg);
      return;
    }
    if (focus === "reader") {
      if (key.upArrow || input === "k") setReaderScroll((s) => Math.max(0, s - 1));
      else if (key.downArrow || input === "j") setReaderScroll((s) => s + 1);
      else if (key.escape || key.leftArrow || input === "h") setFocus("list");
      else if (input === "s") doStar();
      else if (input === "e") doArchive();
      else if (input === "r" && selectedMsg) startCompose(selectedMsg);
    }
  });

  function handleSearchKey(input: string, key: { return?: boolean; escape?: boolean; backspace?: boolean; delete?: boolean }) {
    if (key.escape) { setSearch(""); setMode("browse"); return; }
    if (key.return) { setMode("browse"); return; }
    if (key.backspace || key.delete) { setSearch((s) => s.slice(0, -1)); return; }
    if (input && !key.return) setSearch((s) => s + input);
  }

  function handleComposeKey(input: string, key: { return?: boolean; escape?: boolean; tab?: boolean; shift?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean }) {
    if (!compose) return;
    if (key.escape) { setMode("browse"); setCompose(null); flash("compose cancelled"); return; }
    if (key.ctrl && input === "s") { void sendCompose(); return; }
    const order: ComposeField[] = ["to", "subject", "body"];
    if (key.tab) {
      const i = order.indexOf(compose.field);
      const next = key.shift ? order[(i + order.length - 1) % order.length]! : order[(i + 1) % order.length]!;
      setCompose({ ...compose, field: next });
      return;
    }
    const f = compose.field;
    if (key.backspace || key.delete) { setCompose({ ...compose, [f]: compose[f].slice(0, -1) }); return; }
    if (key.return) {
      if (f === "body") setCompose({ ...compose, body: compose.body + "\n" });
      else { const i = order.indexOf(f); setCompose({ ...compose, field: order[Math.min(order.length - 1, i + 1)]! }); }
      return;
    }
    if (input && !key.ctrl) setCompose({ ...compose, [f]: compose[f] + input });
  }

  // ── layout ─────────────────────────────────────────────────────────────────
  const sidebarW = 18;
  const listW = Math.max(34, Math.min(54, Math.floor((cols - sidebarW) * 0.42)));
  const readerW = Math.max(20, cols - sidebarW - listW - 6);
  const bodyHeight = Math.max(6, rows - 6);

  // visible window for the list
  const listVisible = bodyHeight - 2;
  const start = Math.max(0, Math.min(sel - Math.floor(listVisible / 2), Math.max(0, messages.length - listVisible)));
  const windowed = messages.slice(start, start + listVisible);

  // The outer Box is always full-height so Ink reconciles/clears cleanly when
  // switching between the mailbox view and the compose overlay.
  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <HeaderBar mailbox={mailbox} counts={counts} status={status} pulling={pulling} cols={cols} />
      {mode === "compose" && compose ? (
        <ComposeView compose={compose} from={deriveFrom(compose)} status={status} />
      ) : (
        <Box flexGrow={1}>
          <Sidebar mailbox={mailbox} counts={counts} focused={focus === "sidebar"} width={sidebarW} />
          <Box flexDirection="column" width={listW} borderStyle="round" borderColor={focus === "list" ? "cyan" : "gray"} paddingX={1}>
            {mode === "search" && <Text color="yellow">/ {search}<Text color="cyan">▌</Text></Text>}
            {messages.length === 0 ? <Text dimColor>No messages.</Text> : windowed.map((m, i) => (
              <MessageRow key={m.id} m={m} selected={start + i === sel} width={listW - 4} now={now} />
            ))}
          </Box>
          <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={focus === "reader" ? "cyan" : "gray"} paddingX={1}>
            <Reader msg={selectedMsg} body={body} conversation={conversation} scroll={readerScroll} width={readerW} height={bodyHeight - 2} />
          </Box>
        </Box>
      )}
      <FooterBar focus={focus} mode={mode} />
    </Box>
  );
}

// ── components ──────────────────────────────────────────────────────────────────

function HeaderBar({ mailbox, counts, status, pulling, cols }: { mailbox: Mailbox; counts: MailboxCounts; status: Status; pulling: boolean; cols: number }) {
  const tone = status.tone === "ok" ? "green" : status.tone === "err" ? "red" : "yellow";
  return (
    <Box width={cols} justifyContent="space-between" paddingX={1}>
      <Text><Text color="magentaBright" bold>📬 emails</Text> <Text dimColor>·</Text> <Text bold>{mailboxLabel(mailbox)}</Text>  <Text color="cyan">{counts.unread}</Text> <Text dimColor>unread</Text></Text>
      <Text>{pulling ? <Text color="yellow">⟳ pulling </Text> : null}{status.text ? <Text color={tone}>{status.text}</Text> : <Text dimColor>auto-pull on</Text>}</Text>
    </Box>
  );
}

function Sidebar({ mailbox, counts, focused, width }: { mailbox: Mailbox; counts: MailboxCounts; focused: boolean; width: number }) {
  const icon: Record<Mailbox, string> = { inbox: "📥", unread: "●", starred: "★", sent: "➤", archived: "🗄" };
  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor={focused ? "cyan" : "gray"} paddingX={1}>
      {MAILBOXES.map((m) => {
        const active = m === mailbox;
        const n = counts[m];
        return (
          <Text key={m} wrap="truncate" color={active ? "cyanBright" : undefined} bold={active}>
            {active ? "▸" : " "}{icon[m]} {mailboxLabel(m)}{n ? <Text dimColor> {n}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

function MessageRow({ m, selected, width, now }: { m: TuiMessage; selected: boolean; width: number; now: number }) {
  const star = m.is_starred ? "★" : " ";
  const dot = m.is_read ? " " : "●";
  const who = senderName(m.kind === "sent" ? m.to : m.from);
  const time = relativeTime(m.date, now).padStart(4);
  const whoW = 16;
  const subjW = Math.max(8, width - whoW - 8);
  return (
    <Text backgroundColor={selected ? "blueBright" : undefined} color={selected ? "white" : undefined} wrap="truncate">
      <Text color={selected ? "white" : "yellow"}>{star}</Text>
      <Text color={selected ? "white" : "cyan"}>{dot}</Text>{" "}
      <Text bold={!m.is_read}>{truncate(who, whoW).padEnd(whoW)}</Text>{" "}
      <Text bold={!m.is_read} dimColor={m.is_read && !selected}>{truncate(m.subject, subjW).padEnd(subjW)}</Text>
      <Text dimColor={!selected}>{time}</Text>
    </Text>
  );
}

function Reader({ msg, body, conversation, scroll, width, height }: { msg: TuiMessage | null; body: ReturnType<typeof getMessageBody>; conversation: ReturnType<typeof getConversation>; scroll: number; width: number; height: number }) {
  if (!msg || !body) return <Text dimColor>Select a message to read.</Text>;
  const headerLines = 5;
  const text = body.text ?? (body.html ? body.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") : "(no text body)");
  const allLines = wrapText(text, Math.max(10, width), 1000);
  const avail = Math.max(2, height - headerLines - (conversation.length > 1 ? 2 : 0));
  const view = allLines.slice(scroll, scroll + avail);
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate">{body.subject}</Text>
      <Text wrap="truncate"><Text dimColor>From </Text>{senderName(body.from)} <Text dimColor>&lt;{body.from.replace(/.*<|>.*/g, "")}&gt;</Text></Text>
      <Text wrap="truncate"><Text dimColor>To   </Text>{truncate(body.to, width - 5)}</Text>
      <Text dimColor wrap="truncate">{formatDate(body.date)} · {body.flags.join(", ")}</Text>
      {conversation.length > 1 && <Text color="magenta">🧵 {conversation.length} messages in thread</Text>}
      <Text> </Text>
      {view.map((l, i) => <Text key={i}>{l || " "}</Text>)}
      {scroll + avail < allLines.length && <Text dimColor>… {allLines.length - scroll - avail} more lines (j/k)</Text>}
    </Box>
  );
}

function ComposeView({ compose, from, status }: { compose: ComposeState; from: string; status: Status }) {
  const cur = (f: ComposeField) => (compose.field === f ? <Text color="cyan">▌</Text> : null);
  const lbl = (f: ComposeField, v: string) => (
    <Text><Text color={compose.field === f ? "cyanBright" : "gray"} bold>{f.padEnd(8)}</Text>{v}{cur(f)}</Text>
  );
  return (
    <Box flexGrow={1} flexDirection="column" paddingX={1}>
      <Text color="magentaBright" bold>✎ Compose {compose.replyTo ? "(reply)" : ""}</Text>
      <Box flexGrow={1} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
        <Text><Text color="gray" bold>{"from".padEnd(8)}</Text><Text dimColor>{from || "(no sender address found — pass --from with the send command)"}</Text></Text>
        {lbl("to", compose.to)}
        {lbl("subject", compose.subject)}
        <Text dimColor>{"─".repeat(40)}</Text>
        {(compose.body || (compose.field === "body" ? "" : " ")).split("\n").map((line, i, arr) => (
          <Text key={i}>{line}{compose.field === "body" && i === arr.length - 1 ? <Text color="cyan">▌</Text> : null}</Text>
        ))}
      </Box>
      {status.text && <Box><Text color={status.tone === "err" ? "red" : status.tone === "ok" ? "green" : "yellow"}>{status.text}</Text></Box>}
    </Box>
  );
}

function FooterBar({ focus, mode }: { focus: Focus; mode: Mode }) {
  const hint = mode === "compose"
    ? "Tab next field · Enter newline (body) · Ctrl-S send · Esc cancel"
    : mode === "search"
    ? "type to filter · Enter apply · Esc clear"
    : focus === "sidebar" ? "↑↓ folder · → open · Tab pane · c compose · q quit"
    : focus === "reader" ? "j/k scroll · r reply · s star · e archive · Esc back · q quit"
    : "↑↓ move · Enter read · r reply · s star · e archive · u unread · c compose · / search · g refresh · Tab pane · q quit";
  return <Box paddingX={1}><Text dimColor>{hint}</Text></Box>;
}
