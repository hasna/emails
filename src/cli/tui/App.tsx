import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  listMailbox, mailboxCounts, getMessageBody, getConversation,
  toggleStar, toggleRead, markRead, archiveMessage, replyDefaults, sendComposed, listProfiles,
  listSources, getSettings, setSetting,
  MAILBOXES, mailboxLabel, type Mailbox, type TuiMessage, type MailboxCounts, type ProfileInfo,
  type InboxSource, type TuiSettings,
} from "./data.js";
import { autoPull } from "./autopull.js";
import { truncate, senderName, relativeTime, formatDate, wrapText } from "./format.js";

type View = "list" | "reader" | "compose" | "profiles" | "settings";
type ComposeField = "to" | "subject" | "body";
interface ComposeState { to: string; subject: string; body: string; field: ComposeField; replyTo?: TuiMessage }
interface Status { text: string; tone: "info" | "ok" | "err" }

const REFRESH_MS = 4000;
const PULL_MS = 12000;      // S3 / real-time inbound
const GMAIL_PULL_MS = 45000; // Gmail incremental (heavier — slower cadence)

function useDimensions(): { cols: number; rows: number } {
  const { stdout } = useStdout();
  const [dims, setDims] = useState({ cols: stdout?.columns ?? 100, rows: stdout?.rows ?? 30 });
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setDims({ cols: stdout.columns ?? 100, rows: stdout.rows ?? 30 });
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);
  return dims;
}

export interface AppProps { initialMailbox?: Mailbox }

export function App({ initialMailbox }: AppProps) {
  const { exit } = useApp();
  const { cols, rows } = useDimensions();

  const sources = useMemo(() => listSources(), []);
  const [sourceIdx, setSourceIdx] = useState(0);
  const source = sources[sourceIdx] ?? sources[0]!;
  const [settings, setSettings] = useState<TuiSettings>(() => getSettings());
  const startMailbox = initialMailbox ?? settings.defaultMailbox;

  const [mailbox, setMailbox] = useState<Mailbox>(startMailbox);
  const [messages, setMessages] = useState<TuiMessage[]>(() => listMailbox(startMailbox));
  const [counts, setCounts] = useState<MailboxCounts>(() => mailboxCounts());
  const [selId, setSelId] = useState<string | null>(() => messages[0]?.id ?? null);
  const [view, setView] = useState<View>("list");
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState("");
  const [scroll, setScroll] = useState(0);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [status, setStatus] = useState<Status>({ text: "", tone: "info" });
  const [now, setNow] = useState(() => Date.now());

  const sel = Math.max(0, messages.findIndex((m) => m.id === selId));
  const selectedMsg = messages[sel] ?? null;
  const srcFilter = useMemo(() => ({ providerId: source.providerId, domain: source.domain }), [source.id]);

  // Reload from the local store, keeping the same message selected by id.
  const reload = useCallback(() => {
    const next = listMailbox(mailbox, { search: search || undefined, source: srcFilter });
    setMessages(next);
    setCounts(mailboxCounts());
    setSelId((cur) => (next.some((m) => m.id === cur) ? cur : next[0]?.id ?? null));
  }, [mailbox, search, srcFilter]);

  useEffect(() => { const next = listMailbox(mailbox, { search: search || undefined, source: srcFilter }); setMessages(next); setCounts(mailboxCounts()); setSelId(next[0]?.id ?? null); /* eslint-disable-next-line */ }, [mailbox, srcFilter]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [search]);

  useEffect(() => {
    const t = setInterval(() => { setNow(Date.now()); reload(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [reload]);

  useEffect(() => {
    if (!settings.autoPull) return;
    let alive = true;
    const tick = async (gmail: boolean) => {
      const r = await autoPull(gmail ? { s3: false, gmail: true } : undefined).catch(() => null);
      if (!alive) return;
      if (r?.pulled) { flash(`↓ ${r.pulled} new`, "ok"); reload(); }
      else if (r && !r.ok && r.reason && !/credential|profile|not configured|region|access key|connector|auth/i.test(r.reason)) flash(`pull: ${r.reason.slice(0, 36)}`, "err");
    };
    void tick(false);
    const s3 = setInterval(() => { void tick(false); }, PULL_MS);          // SES / S3 / real-time
    const gm = settings.gmailAutoPull ? setInterval(() => { void tick(true); }, GMAIL_PULL_MS) : null; // Gmail incremental
    return () => { alive = false; clearInterval(s3); if (gm) clearInterval(gm); };
  }, [reload, settings.autoPull, settings.gmailAutoPull]);

  const body = useMemo(() => (selectedMsg ? getMessageBody(selectedMsg) : null), [selectedMsg?.id, messages]);
  const conversation = useMemo(() => (selectedMsg ? getConversation(selectedMsg) : []), [selectedMsg?.id, messages]);
  const flash = (text: string, tone: Status["tone"] = "info") => setStatus({ text, tone });

  const move = (delta: number) => { if (!messages.length) return; const i = Math.min(messages.length - 1, Math.max(0, sel + delta)); setSelId(messages[i]!.id); };
  const switchMailbox = (delta: number) => setMailbox(MAILBOXES[(MAILBOXES.indexOf(mailbox) + delta + MAILBOXES.length) % MAILBOXES.length]!);
  const open = () => { if (selectedMsg) { markRead(selectedMsg); setView("reader"); setScroll(0); reload(); } };
  const doStar = () => { if (selectedMsg?.kind === "inbound") { const s = toggleStar(selectedMsg); flash(s ? "starred" : "unstarred", "ok"); reload(); } };
  const doRead = () => { if (selectedMsg?.kind === "inbound") { const r = toggleRead(selectedMsg); flash(r ? "read" : "unread", "ok"); reload(); } };
  const doArchive = () => { if (selectedMsg?.kind === "inbound") { archiveMessage(selectedMsg, mailbox !== "archived"); flash(mailbox === "archived" ? "unarchived" : "archived", "ok"); setView("list"); reload(); } };

  function deriveFrom(c: ComposeState): string {
    if (c.replyTo) return replyDefaults(c.replyTo).from;
    return messages.find((m) => m.kind === "sent")?.from ?? (body?.to.split(",")[0]?.trim() ?? "");
  }
  const startCompose = (replyTo?: TuiMessage) => {
    setCompose(replyTo ? { ...replyDefaults(replyTo), body: "", field: "body", replyTo } : { to: "", subject: "", body: "", field: "to" });
    setView("compose");
  };
  const sendCompose = async () => {
    if (!compose) return;
    flash("sending…");
    try {
      await sendComposed({ from: deriveFrom(compose), to: compose.to, subject: compose.subject, body: compose.body });
      setView("list"); setCompose(null); flash("✓ sent", "ok"); reload();
    } catch (e) { flash(`✗ ${e instanceof Error ? e.message : String(e)}`.slice(0, 56), "err"); }
  };

  const cycleSource = (delta: number) => {
    if (sources.length < 2) return;
    setSourceIdx((i) => (i + delta + sources.length) % sources.length);
  };
  const toggleSetting = (key: keyof TuiSettings) => {
    if (key === "defaultMailbox") return;
    const next = !settings[key];
    setSetting(key, next as never);
    setSettings((s) => ({ ...s, [key]: next }));
    flash(`${key}: ${next ? "on" : "off"}`, "ok");
  };
  const setDefaultMailbox = (m: Mailbox) => { setSetting("defaultMailbox", m); setSettings((s) => ({ ...s, defaultMailbox: m })); flash(`default folder: ${mailboxLabel(m)}`, "ok"); };

  useInput((input, key) => {
    if (view === "compose" && compose) return handleCompose(input, key);
    if (searching) return handleSearch(input, key);

    if (view === "settings") return handleSettings(input, key);
    if (view === "profiles") { if (input === "q" || key.escape || input === "p") setView("list"); return; }

    if (input === "q" || (key.ctrl && input === "c")) { if (view === "reader") { setView("list"); return; } exit(); return; }
    if (input === "c") { startCompose(); return; }
    if (input === "p") { setView("profiles"); return; }
    if (input === ",") { setView("settings"); return; }
    if (input === "a" || input === "A") { cycleSource(input === "a" ? 1 : -1); return; }
    if (input === "g") { flash("refreshing…"); void autoPull({ limit: 1000 }).then((r) => { reload(); flash(r?.pulled ? `↓ ${r.pulled} new` : "up to date", "ok"); }); return; }

    if (view === "reader") {
      if (key.upArrow || input === "k") setScroll((s) => Math.max(0, s - 1));
      else if (key.downArrow || input === "j") setScroll((s) => s + 1);
      else if (key.escape || key.leftArrow || input === "h") setView("list");
      else if (input === "J") { move(1); setScroll(0); }
      else if (input === "K") { move(-1); setScroll(0); }
      else if (input === "r" && selectedMsg) startCompose(selectedMsg);
      else if (input === "s") doStar();
      else if (input === "e") doArchive();
      else if (input === "u") doRead();
      return;
    }

    // list view
    if (key.upArrow || input === "k") move(-1);
    else if (key.downArrow || input === "j") move(1);
    else if (key.return || key.rightArrow || input === "l") open();
    else if (key.tab || input === "]") switchMailbox(1);
    else if (input === "[") switchMailbox(-1);
    else if (input >= "1" && input <= "5") setMailbox(MAILBOXES[Number(input) - 1]!);
    else if (input === "s") doStar();
    else if (input === "e") doArchive();
    else if (input === "u") doRead();
    else if (input === "r" && selectedMsg) startCompose(selectedMsg);
    else if (input === "/") { setSearching(true); }
  });

  function handleSearch(input: string, key: { return?: boolean; escape?: boolean; backspace?: boolean; delete?: boolean }) {
    if (key.escape) { setSearch(""); setSearching(false); return; }
    if (key.return) { setSearching(false); return; }
    if (key.backspace || key.delete) { setSearch((s) => s.slice(0, -1)); return; }
    if (input) setSearch((s) => s + input);
  }

  function handleSettings(input: string, key: { escape?: boolean }) {
    if (input === "q" || key.escape || input === ",") { setView("list"); return; }
    if (input === "1") { toggleSetting("autoPull"); return; }
    if (input === "2") { toggleSetting("gmailAutoPull"); return; }
    if (input === "3") { toggleSetting("dimRead"); return; }
    if (input === "4") { const i = MAILBOXES.indexOf(settings.defaultMailbox); setDefaultMailbox(MAILBOXES[(i + 1) % MAILBOXES.length]!); return; }
  }

  function handleCompose(input: string, key: { return?: boolean; escape?: boolean; tab?: boolean; shift?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean }) {
    if (!compose) return;
    if (key.escape) { setView("list"); setCompose(null); flash("compose cancelled"); return; }
    if (key.ctrl && input === "s") { void sendCompose(); return; }
    const order: ComposeField[] = ["to", "subject", "body"];
    if (key.tab) { const i = order.indexOf(compose.field); setCompose({ ...compose, field: key.shift ? order[(i + 2) % 3]! : order[(i + 1) % 3]! }); return; }
    const f = compose.field;
    if (key.backspace || key.delete) { setCompose({ ...compose, [f]: compose[f].slice(0, -1) }); return; }
    if (key.return) { if (f === "body") setCompose({ ...compose, body: compose.body + "\n" }); else { const i = order.indexOf(f); setCompose({ ...compose, field: order[Math.min(2, i + 1)]! }); } return; }
    if (input && !key.ctrl) setCompose({ ...compose, [f]: compose[f] + input });
  }

  // ── render ───────────────────────────────────────────────────────────────────
  const innerW = cols - 4;
  const contentH = Math.max(4, rows - 6);

  let content;
  if (view === "compose" && compose) content = <Compose compose={compose} from={deriveFrom(compose)} width={innerW} height={contentH} />;
  else if (view === "settings") content = <Settings settings={settings} width={innerW} height={contentH} />;
  else if (view === "profiles") content = <Profiles width={innerW} height={contentH} />;
  else if (view === "reader") content = <Reader body={body} conversation={conversation} scroll={scroll} width={innerW} height={contentH} />;
  else content = <List messages={messages} sel={sel} now={now} width={innerW} height={contentH} searching={searching} search={search} dimRead={settings.dimRead} emptyStore={counts.inbox === 0 && counts.sent === 0 && counts.archived === 0} />;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Tabs mailbox={mailbox} counts={counts} status={status} cols={cols} source={source} sourceCount={sources.length} />
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexGrow={1}>{content}</Box>
      <Footer view={view} searching={searching} />
    </Box>
  );
}

// ── components ──────────────────────────────────────────────────────────────────

function Tabs({ mailbox, counts, status, cols, source, sourceCount }: { mailbox: Mailbox; counts: MailboxCounts; status: Status; cols: number; source: InboxSource; sourceCount: number }) {
  const tone = status.tone === "ok" ? "greenBright" : status.tone === "err" ? "redBright" : "yellowBright";
  return (
    <Box flexDirection="column" width={cols}>
      <Box width={cols} paddingX={1} justifyContent="space-between">
        <Box>
          {MAILBOXES.map((m, i) => {
            const active = m === mailbox;
            const n = counts[m];
            return (
              <Text key={m}>
                {i > 0 ? <Text> </Text> : null}
                <Text color={active ? "black" : "whiteBright"} backgroundColor={active ? "cyanBright" : undefined} bold={active}>
                  {" "}{mailboxLabel(m)}{n ? ` ${n}` : ""}{" "}
                </Text>
              </Text>
            );
          })}
        </Box>
        <Text color={tone} bold>{status.text}</Text>
      </Box>
      <Box width={cols} paddingX={1}>
        <Text color="black" backgroundColor="magentaBright" bold>{" "}▾ {source.label}{" "}</Text>
        {sourceCount > 1 ? <Text color="white"> {" "}<Text color="gray">press</Text> a <Text color="gray">to switch inbox</Text></Text> : null}
      </Box>
    </Box>
  );
}

function List({ messages, sel, now, width, height, searching, search, dimRead, emptyStore }: { messages: TuiMessage[]; sel: number; now: number; width: number; height: number; searching: boolean; search: string; dimRead: boolean; emptyStore: boolean }) {
  const rowH = searching ? height - 1 : height;
  const start = Math.max(0, Math.min(sel - Math.floor(rowH / 2), Math.max(0, messages.length - rowH)));
  const win = messages.slice(start, start + rowH);
  const whoW = Math.min(22, Math.max(14, Math.floor(width * 0.22)));
  const timeW = 5;
  const subjW = Math.max(10, width - whoW - timeW - 5);
  return (
    <Box flexDirection="column" width={width}>
      {searching && <Text color="yellowBright">/ {search}<Text color="cyanBright">▌</Text></Text>}
      {messages.length === 0 ? (
        emptyStore ? (
          <Box flexDirection="column">
            <Text color="yellowBright" bold>No mail synced on this machine yet.</Text>
            <Text> </Text>
            <Text color="white">The local store is per-machine. To pull your mail here:</Text>
            <Text>  <Text color="cyanBright">emails inbox sync --all-profiles --all</Text><Text color="gray">   # from Gmail (needs connector auth)</Text></Text>
            <Text>  <Text color="cyanBright">emails inbox sync-s3 --bucket &lt;bucket&gt;</Text><Text color="gray">     # from SES-S3 inbound</Text></Text>
            <Text>  <Text color="cyanBright">emails cloud pull</Text><Text color="gray">                          # if RDS cloud sync is configured</Text></Text>
            <Text> </Text>
            <Text color="white">Press <Text color="cyanBright" bold>g</Text> to refresh after syncing · <Text color="cyanBright" bold>q</Text> to quit.</Text>
          </Box>
        ) : <Text color="white">No messages here.</Text>
      ) : win.map((m, i) => {
        const selected = start + i === sel;
        const who = (m.sentByMe ? "→ " : "") + senderName(m.sentByMe ? m.to : m.from);
        const subjCell = m.attachments > 0 ? `📎 ${m.subject}` : m.subject;
        const faded = dimRead && m.is_read && !selected;
        const primary = selected ? "whiteBright" : faded ? "gray" : "white";
        return (
          <Text key={m.id} wrap="truncate" backgroundColor={selected ? "blue" : undefined}>
            <Text color={m.is_starred ? "yellowBright" : selected ? "whiteBright" : "gray"}>{m.is_starred ? "★" : " "}</Text>
            <Text color={m.is_read ? (selected ? "white" : "gray") : "cyanBright"} bold={!m.is_read}>{m.is_read ? " " : "●"}</Text>{" "}
            <Text bold={!m.is_read} color={primary}>{truncate(who, whoW).padEnd(whoW)}</Text>{" "}
            <Text bold={!m.is_read} color={selected ? "whiteBright" : faded ? "gray" : "white"}>{truncate(subjCell, subjW).padEnd(subjW)}</Text>{" "}
            <Text color={selected ? "whiteBright" : "gray"}>{relativeTime(m.date, now).padStart(timeW)}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Reader({ body, conversation, scroll, width, height }: { body: ReturnType<typeof getMessageBody>; conversation: ReturnType<typeof getConversation>; scroll: number; width: number; height: number }) {
  if (!body) return <Text dimColor>No message selected.</Text>;
  const text = body.text ?? (body.html ? body.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "(no text content)");
  const atts = body.attachments ?? [];
  const attH = atts.length ? Math.min(atts.length, 6) + 1 : 0;
  const headerH = 4 + (conversation.length > 1 ? 1 : 0) + attH;
  const lines = wrapText(text, Math.max(20, width), 5000);
  const avail = Math.max(2, height - headerH - 1);
  const view = lines.slice(scroll, scroll + avail);
  const addr = body.from.replace(/.*</, "").replace(/>.*/, "");
  return (
    <Box flexDirection="column" width={width}>
      <Text bold color="whiteBright" wrap="truncate">{body.subject}</Text>
      <Text wrap="truncate"><Text dimColor>from </Text>{senderName(body.from)}{addr !== senderName(body.from) ? <Text dimColor> {addr}</Text> : null}</Text>
      <Text wrap="truncate"><Text dimColor>to   </Text>{truncate(body.to, width - 5)}</Text>
      <Text dimColor>{formatDate(body.date)} · {body.flags.join(", ")}</Text>
      {conversation.length > 1 && <Text color="magenta">🧵 {conversation.length} in thread</Text>}
      {atts.length > 0 && <Text color="yellow">📎 {atts.length} attachment{atts.length > 1 ? "s" : ""}:</Text>}
      {atts.slice(0, 6).map((a, i) => (
        <Text key={i} wrap="truncate"><Text dimColor> • </Text>{truncate(a.filename, width - 28)} <Text dimColor>{bytes(a.size)} · {a.content_type.split("/").pop()}{a.location ? " ✓saved" : ""}</Text></Text>
      ))}
      <Text> </Text>
      {view.map((l, i) => <Text key={i} wrap="truncate">{l || " "}</Text>)}
      {scroll + avail < lines.length && <Text dimColor>↓ {lines.length - scroll - avail} more — j/k to scroll</Text>}
    </Box>
  );
}

function Profiles({ width, height }: { width: number; height: number }) {
  const profiles = listProfiles();
  const byProvider = new Map<string, ProfileInfo[]>();
  for (const p of profiles) { const a = byProvider.get(p.provider) ?? []; a.push(p); byProvider.set(p.provider, a); }
  const rows: ReactNode[] = [];
  for (const [provider, list] of byProvider) {
    rows.push(<Text key={`h-${provider}`} bold color="magentaBright">{provider.toUpperCase()}</Text>);
    for (const p of list) {
      rows.push(<Text key={p.id} wrap="truncate">  <Text color="cyanBright">{p.name}</Text>{p.active ? "" : <Text dimColor> (inactive)</Text>}</Text>);
      if (p.domains.length) rows.push(<Text key={p.id + "d"} wrap="truncate"><Text dimColor>    domains:   </Text>{truncate(p.domains.join(", "), width - 14)}</Text>);
      if (p.addresses.length) rows.push(<Text key={p.id + "a"} wrap="truncate"><Text dimColor>    addresses: </Text>{truncate(p.addresses.join(", "), width - 14)} <Text dimColor>({p.addresses.length})</Text></Text>);
      if (!p.domains.length && !p.addresses.length) rows.push(<Text key={p.id + "e"} dimColor>    (no domains/addresses)</Text>);
    }
  }
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text bold color="whiteBright">Profiles — your configured accounts (provider = the service)</Text>
      <Text> </Text>
      {rows.slice(0, height - 3)}
    </Box>
  );
}

function Settings({ settings, width, height }: { settings: TuiSettings; width: number; height: number }) {
  const row = (keyChar: string, label: string, value: string, on: boolean) => (
    <Text wrap="truncate">
      <Text color="black" backgroundColor="cyanBright" bold>{" "}{keyChar}{" "}</Text>{"  "}
      <Text color="whiteBright">{label.padEnd(22)}</Text>
      <Text color={on ? "greenBright" : "gray"} bold>{value}</Text>
    </Text>
  );
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text bold color="whiteBright">Settings <Text color="gray">— press the number key to change, q/Esc to go back</Text></Text>
      <Text> </Text>
      {row("1", "Auto-pull inbound", settings.autoPull ? "ON" : "OFF", settings.autoPull)}
      {row("2", "Gmail auto-pull", settings.gmailAutoPull ? "ON" : "OFF", settings.gmailAutoPull)}
      {row("3", "Dim read messages", settings.dimRead ? "ON  (lower contrast)" : "OFF (high contrast)", !settings.dimRead)}
      {row("4", "Default folder", mailboxLabel(settings.defaultMailbox), true)}
      <Text> </Text>
      <Text color="gray">Auto-pull fetches new SES/S3 mail every 12s; Gmail every 45s. Switch inbox source with <Text color="cyanBright" bold>a</Text> on the list.</Text>
    </Box>
  );
}

function Compose({ compose, from, width, height }: { compose: ComposeState; from: string; width: number; height: number }) {
  const cur = (f: ComposeField) => (compose.field === f ? <Text color="cyan">▌</Text> : null);
  const field = (f: ComposeField, v: string) => (
    <Text wrap="truncate"><Text color={compose.field === f ? "cyanBright" : "gray"} bold>{f.padEnd(8)}</Text>{v}{cur(f)}</Text>
  );
  const bodyLines = (compose.body || "").split("\n");
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text color="magentaBright" bold>✎ {compose.replyTo ? "Reply" : "New message"} <Text dimColor>· markdown — **bold**, lists, etc. render in the sent email</Text></Text>
      <Text><Text color="gray" bold>{"from".padEnd(8)}</Text><Text dimColor>{from || "(no sender found — pass --from to the send command)"}</Text></Text>
      {field("to", compose.to)}
      {field("subject", compose.subject)}
      <Text dimColor>{"─".repeat(Math.min(width, 60))}</Text>
      {bodyLines.map((line, i) => (
        <Text key={i} wrap="truncate">{line || " "}{compose.field === "body" && i === bodyLines.length - 1 ? <Text color="cyan">▌</Text> : null}</Text>
      ))}
    </Box>
  );
}

function Footer({ view, searching }: { view: View; searching: boolean }) {
  const hint = searching ? "type to filter · Enter apply · Esc clear"
    : view === "compose" ? "Tab field · Enter blank/new line · Ctrl-S send (markdown→HTML) · Esc cancel"
    : view === "profiles" ? "your accounts & their domains/addresses · p or Esc back"
    : view === "settings" ? "1-4 toggle a setting · q or Esc back"
    : view === "reader" ? "j/k scroll · J/K next/prev · r reply · s star · e archive · Esc back"
    : "↑↓ move · Enter open · ]/[ 1-5 folders · a inbox · c compose · p profiles · , settings · / search · q quit";
  return <Box paddingX={1}><Text color="gray">{hint}</Text></Box>;
}
