/* Mailery web UI — 3-pane mail client (folders → threads → reader).
 *
 * Dual-mode, exactly like open-notes:
 *   - In the native macOS app, the WKWebView host injects window.__BOOT__ =
 *     {threads, folders, thisAddress} at document-start and exposes the `mail` message
 *     handler. Mutations post to window.webkit.messageHandlers.mail; the host performs
 *     them via the `mailery` CLI and calls window.HasnaMail.hydrate(...) with fresh data.
 *   - In a plain browser (screenshots / dev), there is no bridge, so we fall back to
 *     sampleBoot() and apply mutations optimistically in-memory only.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- bridge
  function postMail(payload) {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.mail) {
        window.webkit.messageHandlers.mail.postMessage(payload);
        return true;
      }
    } catch (e) { /* not in native host */ }
    return false;
  }
  function postWindow(payload) {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.window) {
        window.webkit.messageHandlers.window.postMessage(payload);
        return true;
      }
    } catch (e) {}
    return false;
  }
  const NATIVE = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.mail);

  // ---------------------------------------------------------------- state
  const FOLDERS = [
    { id: "inbox", name: "Inbox" },
    { id: "starred", name: "Starred" },
    { id: "sent", name: "Sent" },
    { id: "archive", name: "Archive" },
    { id: "spam", name: "Spam" },
    { id: "trash", name: "Trash" },
  ];
  const FOLDER_ICONS = {
    inbox: '<path d="M3 11l2.4-6.2A2 2 0 017.3 3.5h5.4a2 2 0 011.9 1.3L17 11M3 11v4a2 2 0 002 2h10a2 2 0 002-2v-4M3 11h4l1 2h4l1-2h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    starred: '<path d="M10 2.6l2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 13.4 5.8 15.6l.8-4.7L3.2 7.6l4.7-.7L10 2.6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
    sent: '<path d="M17 3L3 9.2l5.6 2.1L11 17l6-14z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8.6 11.3L17 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    archive: '<rect x="3.2" y="4" width="13.6" height="3.4" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M4.6 7.4V15a1 1 0 001 1h8.8a1 1 0 001-1V7.4M8 10.4h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    spam: '<path d="M10 3l7 3.5v4C17 14 14 16.5 10 17.5 6 16.5 3 14 3 10.5v-4L10 3z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M10 7v3.4M10 12.8v.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    trash: '<path d="M4 5.5h12M8 5.5V4.2a1 1 0 011-1h2a1 1 0 011 1v1.3M6 5.5l.7 9a1 1 0 001 .94h4.6a1 1 0 001-.94l.7-9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  };

  const state = {
    threads: [],
    folders: [],
    thisAddress: "",
    dbExists: true,
    activeFolder: "inbox",
    activeThreadId: null,
    search: "",
    view: "list", // list | thread | compose
  };

  // ---------------------------------------------------------------- DOM refs
  const $ = (id) => document.getElementById(id);
  const els = {};
  function cacheEls() {
    [
      "window", "folders-list", "threads-list", "threads-title", "threads-count",
      "threads-empty", "threads-empty-title", "threads-empty-desc", "search-input",
      "compose-btn", "refresh-btn", "open-settings", "reader-empty", "thread-view",
      "compose-view", "reader-subject", "reader-messages", "reply-box", "reply-input",
      "reply-send", "act-star", "act-archive", "act-trash", "compose-form", "compose-to",
      "compose-cc", "compose-subject", "compose-body", "compose-send", "compose-from",
      "compose-close", "settings-back", "set-content", "about-address", "about-db",
      "about-count", "toast",
    ].forEach((id) => { els[id] = $(id); });
  }

  // ---------------------------------------------------------------- helpers
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function displayName(addr) {
    if (!addr) return "Unknown";
    const m = String(addr).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (m && m[1].trim()) return m[1].trim();
    const bare = (m ? m[2] : addr).trim();
    const local = bare.split("@")[0];
    return local || bare;
  }
  function bareEmail(addr) {
    const m = String(addr || "").match(/<([^>]+)>/);
    return (m ? m[1] : String(addr || "")).trim().toLowerCase();
  }
  function initialOf(addr) {
    const n = displayName(addr).trim();
    return (n[0] || "?").toUpperCase();
  }
  function relTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const diff = (now - d) / 86400000;
    if (diff < 7 && diff >= 0) return d.toLocaleDateString([], { weekday: "short" });
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
    return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }
  function fullDate(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function fmtSize(n) {
    if (!n) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return Math.round(n / 1024) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  let toastTimer = null;
  function toast(msg) {
    const t = els["toast"];
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    requestAnimationFrame(() => t.classList.add("toast-show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove("toast-show");
      setTimeout(() => { t.hidden = true; }, 220);
    }, 2600);
  }

  // ---------------------------------------------------------------- folder logic
  function threadInFolder(t, folder) {
    const f = t.folders || {};
    if (folder === "inbox") return !!f.inbox;
    if (folder === "starred") return !!t.starred && !f.trash;
    if (folder === "sent") return !!f.sent;
    if (folder === "archive") return !!f.archive;
    if (folder === "spam") return !!f.spam;
    if (folder === "trash") return !!f.trash;
    return false;
  }
  function recomputeFolders() {
    const inbox = state.threads.filter((t) => threadInFolder(t, "inbox"));
    state.folders = [
      { id: "inbox", name: "Inbox", count: inbox.length, unread: inbox.filter((t) => t.unread > 0).length },
      { id: "starred", name: "Starred", count: state.threads.filter((t) => threadInFolder(t, "starred")).length, unread: 0 },
      { id: "sent", name: "Sent", count: state.threads.filter((t) => threadInFolder(t, "sent")).length, unread: 0 },
      { id: "archive", name: "Archive", count: state.threads.filter((t) => threadInFolder(t, "archive")).length, unread: 0 },
      { id: "spam", name: "Spam", count: state.threads.filter((t) => threadInFolder(t, "spam")).length, unread: 0 },
      { id: "trash", name: "Trash", count: state.threads.filter((t) => threadInFolder(t, "trash")).length, unread: 0 },
    ];
  }
  function folderById(id) { return state.folders.find((f) => f.id === id); }
  function visibleThreads() {
    const q = state.search.trim().toLowerCase();
    return state.threads
      .filter((t) => threadInFolder(t, state.activeFolder))
      .filter((t) => {
        if (!q) return true;
        const hay = (t.subject + " " + t.snippet + " " + (t.participants || []).join(" ")).toLowerCase();
        return hay.indexOf(q) !== -1;
      })
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }
  function threadById(id) { return state.threads.find((t) => t.id === id); }
  function latestInbound(t) {
    const inbound = (t.messages || []).filter((m) => m.source !== "sent");
    return inbound.length ? inbound[inbound.length - 1] : (t.messages || [])[t.messages.length - 1];
  }

  // ---------------------------------------------------------------- render: folders
  function renderFolders() {
    const list = els["folders-list"];
    if (!list) return;
    list.innerHTML = "";
    FOLDERS.forEach((def) => {
      const f = folderById(def.id) || { count: 0, unread: 0 };
      const row = document.createElement("div");
      row.className = "folder-row" + (state.activeFolder === def.id ? " active" : "");
      row.setAttribute("data-folder", def.id);
      const badge = (def.id === "inbox" && f.unread > 0)
        ? `<span class="fr-badge">${f.unread}</span>`
        : `<span class="fr-count">${f.count || 0}</span>`;
      row.innerHTML =
        `<span class="fr-ico"><svg viewBox="0 0 20 20" fill="none">${FOLDER_ICONS[def.id]}</svg></span>` +
        `<span class="fr-name">${esc(def.name)}</span>` + badge;
      row.addEventListener("click", () => selectFolder(def.id));
      list.appendChild(row);
    });
  }

  // ---------------------------------------------------------------- render: threads
  function renderThreads() {
    const list = els["threads-list"];
    const def = FOLDERS.find((f) => f.id === state.activeFolder);
    els["threads-title"].textContent = def ? def.name : "Mail";
    const items = visibleThreads();
    els["threads-count"].textContent = items.length ? String(items.length) : "";
    list.innerHTML = "";
    if (!items.length) {
      els["threads-empty"].hidden = false;
      els["threads-empty-title"].textContent = state.search ? "No matches" : "No mail here";
      els["threads-empty-desc"].textContent = state.search
        ? "Nothing matches your search."
        : (state.activeFolder === "inbox" ? "Hit refresh to pull new mail." : "Nothing in this mailbox.");
      list.hidden = true;
      return;
    }
    els["threads-empty"].hidden = true;
    list.hidden = false;
    items.forEach((t) => {
      const row = document.createElement("div");
      row.className = "thread-row" + (t.unread > 0 ? " unread" : "") + (state.activeThreadId === t.id ? " active" : "");
      const who = state.activeFolder === "sent"
        ? "To " + (t.participants || []).slice(1).map(displayName).join(", ")
        : (t.participants || []).map(displayName).join(", ");
      const count = (t.messages || []).length > 1 ? `<span class="tr-count">${t.messages.length}</span>` : "";
      const star = t.starred ? `<span class="tr-star"><svg viewBox="0 0 18 18" fill="currentColor"><path d="M9 2.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L9 12.9 5.3 14.4l.7-4.3-3.1-3 4.3-.6L9 2.6z"/></svg></span>` : "";
      const attach = t.hasAttachments ? `<span class="tr-attach"><svg viewBox="0 0 16 16" fill="none"><path d="M11 5.5L6 10.5a2 2 0 01-2.8-2.8l5.3-5.3a3 3 0 014.3 4.3l-5.4 5.4a4 4 0 01-5.6-5.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></span>` : "";
      row.innerHTML =
        `<div class="tr-top"><span class="tr-from">${esc(who) || "(unknown)"}</span><span class="tr-date">${esc(relTime(t.ts))}</span></div>` +
        `<div class="tr-subject">${esc(t.subject || "(no subject)")}</div>` +
        `<div class="tr-snippet">${esc(t.snippet || "")}</div>` +
        `<div class="tr-meta">${star}${attach}${count}</div>`;
      row.addEventListener("click", () => openThread(t.id));
      list.appendChild(row);
    });
  }

  // ---------------------------------------------------------------- render: reader
  function showView(view) {
    state.view = view;
    els["reader-empty"].hidden = view !== "empty";
    els["thread-view"].hidden = view !== "thread";
    els["compose-view"].hidden = view !== "compose";
  }

  function renderReader() {
    const t = threadById(state.activeThreadId);
    if (!t) { showView("empty"); return; }
    showView("thread");
    els["reader-subject"].textContent = t.subject || "(no subject)";
    els["act-star"].classList.toggle("active", !!t.starred);
    const hasInbound = (t.messages || []).some((m) => m.source !== "sent");
    els["act-archive"].style.display = hasInbound ? "" : "none";
    els["reply-box"].style.display = hasInbound || NATIVE ? "flex" : "flex";

    const scroll = els["reader-messages"];
    scroll.innerHTML = "";
    const msgs = (t.messages || []).slice();
    msgs.forEach((m, idx) => {
      const collapsed = msgs.length > 1 && idx < msgs.length - 1 && m.isRead;
      const card = document.createElement("div");
      card.className = "msg" + (collapsed ? " collapsed" : "");
      const sentTag = m.source === "sent" || m.isSent ? `<span class="msg-sent-tag">Sent</span>` : "";
      const toLine = (m.to && m.to.length) ? "to " + m.to.map(displayName).join(", ") : "";
      const head = document.createElement("div");
      head.className = "msg-head";
      head.innerHTML =
        `<div class="msg-avatar">${esc(initialOf(m.from))}</div>` +
        `<div class="msg-headtext"><div class="msg-from">${esc(displayName(m.from))}${sentTag}</div>` +
        `<div class="msg-to">${esc(toLine)}</div></div>` +
        `<div class="msg-date">${esc(fullDate(m.ts))}</div>`;
      head.addEventListener("click", () => card.classList.toggle("collapsed"));
      card.appendChild(head);

      const bodyWrap = document.createElement("div");
      bodyWrap.className = "msg-body-wrap";
      if (m.htmlBody && m.htmlBody.trim()) {
        bodyWrap.appendChild(renderHtmlBody(m.htmlBody));
      } else {
        const text = document.createElement("div");
        text.className = "msg-text";
        text.textContent = m.textBody || m.snippet || "(no content)";
        bodyWrap.appendChild(text);
      }
      if (m.attachments && m.attachments.length) {
        bodyWrap.appendChild(renderAttachments(m.attachments));
      }
      card.appendChild(bodyWrap);
      scroll.appendChild(card);
    });
    scroll.scrollTop = scroll.scrollHeight;
  }

  function renderHtmlBody(html) {
    // Isolate email HTML in a sandboxed iframe (NO allow-scripts → the email's own
    // scripts never run). allow-same-origin lets us size it to its content.
    const iframe = document.createElement("iframe");
    iframe.className = "msg-html";
    iframe.setAttribute("sandbox", "allow-same-origin allow-popups");
    const doc =
      '<!doctype html><html><head><base target="_blank"><meta charset="utf-8">' +
      '<style>html,body{margin:0;padding:8px 4px;font-family:-apple-system,"SF Pro Text",Arial,sans-serif;' +
      'font-size:13.5px;line-height:1.6;color:#2A2D33;word-break:break-word;}' +
      'img{max-width:100%;height:auto;}a{color:#7C3AED;}table{max-width:100%;}</style></head><body>' +
      html + "</body></html>";
    iframe.srcdoc = doc;
    iframe.addEventListener("load", () => {
      try {
        const d = iframe.contentDocument;
        if (d && d.body) iframe.style.height = Math.min(d.body.scrollHeight + 28, 6000) + "px";
      } catch (e) { iframe.style.height = "320px"; }
    });
    return iframe;
  }

  function renderAttachments(atts) {
    const wrap = document.createElement("div");
    wrap.className = "msg-attachments";
    atts.forEach((a) => {
      const el = document.createElement("div");
      el.className = "msg-attach";
      const size = a.size ? ` · ${fmtSize(a.size)}` : "";
      el.innerHTML =
        `<span class="ma-ico"><svg viewBox="0 0 16 16" fill="none"><path d="M11 5.5L6 10.5a2 2 0 01-2.8-2.8l5.3-5.3a3 3 0 014.3 4.3l-5.4 5.4a4 4 0 01-5.6-5.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></span>` +
        `<span>${esc(a.filename)}${esc(size)}</span>`;
      if (a.path) {
        const share = document.createElement("button");
        share.className = "msg-attach-share";
        share.type = "button";
        share.textContent = "Share";
        share.addEventListener("click", (e) => { e.stopPropagation(); shareAttachment(a.path); });
        el.appendChild(share);
      }
      wrap.appendChild(el);
    });
    return wrap;
  }

  // ---------------------------------------------------------------- actions
  function selectFolder(id) {
    state.activeFolder = id;
    state.activeThreadId = null;
    state.view = "empty";
    renderAll();
    showView("empty");
  }

  function openThread(id) {
    state.activeThreadId = id;
    const t = threadById(id);
    if (t) {
      // Mark unread inbound messages as read (optimistic + bridge).
      (t.messages || []).forEach((m) => {
        if (m.source !== "sent" && !m.isRead) {
          m.isRead = true;
          send({ action: "markRead", id: m.id });
        }
      });
      t.unread = 0;
      recomputeFolders();
    }
    renderFolders();
    renderThreads();
    renderReader();
  }

  function toggleStar() {
    const t = threadById(state.activeThreadId);
    if (!t) return;
    const target = latestInbound(t);
    if (!target || target.source === "sent") { toast("Can't star a sent-only thread"); return; }
    const willStar = !t.starred;
    target.isStarred = willStar;
    t.starred = (t.messages || []).some((m) => m.isStarred);
    if (t.folders) t.folders.starred = t.starred;
    recomputeFolders();
    renderFolders(); renderThreads(); renderReader();
    send({ action: "star", id: target.id, undo: !willStar });
    toast(willStar ? "Starred" : "Unstarred");
  }

  function archiveThread() {
    const t = threadById(state.activeThreadId);
    if (!t) return;
    const target = latestInbound(t);
    if (!target || target.source === "sent") { toast("Nothing to archive"); return; }
    (t.messages || []).forEach((m) => { if (m.source !== "sent") m.isArchived = true; });
    if (t.folders) { t.folders.inbox = false; t.folders.archive = true; }
    recomputeFolders();
    state.activeThreadId = null;
    renderAll(); showView("empty");
    send({ action: "archive", id: target.id });
    toast("Archived");
  }

  function trashThread() {
    const t = threadById(state.activeThreadId);
    if (!t) return;
    const target = latestInbound(t);
    if (!target || target.source === "sent") { toast("Can't trash a sent-only thread"); return; }
    if (!window.confirm("Move this conversation to Trash?")) return;
    (t.messages || []).forEach((m) => { if (m.source !== "sent") m.isTrash = true; });
    if (t.folders) { t.folders.trash = true; t.folders.inbox = false; }
    recomputeFolders();
    state.activeThreadId = null;
    renderAll(); showView("empty");
    send({ action: "trash", id: target.id, confirmed: true });
    toast("Moved to Trash");
  }

  function sendReply() {
    const t = threadById(state.activeThreadId);
    if (!t) return;
    const body = els["reply-input"].value.trim();
    if (!body) return;
    const target = latestInbound(t);
    if (target && target.source !== "sent") {
      send({ action: "reply", id: target.id, body: body });
      toast("Sending reply…");
    } else {
      // Sent-only thread: fall back to a fresh send to the participants.
      const to = (t.participants || []).map(bareEmail).filter(Boolean);
      send({ action: "send", to: to, subject: "Re: " + (t.subject || ""), body: body, from: state.thisAddress });
      toast("Sending…");
    }
    els["reply-input"].value = "";
    autoGrow(els["reply-input"]);
  }

  function openCompose(prefill) {
    showView("compose");
    els["compose-to"].value = (prefill && prefill.to) || "";
    els["compose-cc"].value = "";
    els["compose-subject"].value = (prefill && prefill.subject) || "";
    els["compose-body"].value = (prefill && prefill.body) || "";
    els["compose-from"].textContent = state.thisAddress ? "From " + state.thisAddress : "";
    setTimeout(() => els["compose-to"].focus(), 30);
  }

  function submitCompose(e) {
    e.preventDefault();
    const to = els["compose-to"].value.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    const cc = els["compose-cc"].value.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    const subject = els["compose-subject"].value.trim();
    const body = els["compose-body"].value;
    if (!to.length) { toast("Add a recipient"); return; }
    send({ action: "send", to: to, cc: cc, subject: subject, body: body, from: state.thisAddress });
    toast("Sending…");
    state.activeThreadId = null;
    showView("empty");
  }

  function shareAttachment(path) {
    if (!postMail({ action: "shareAttachment", path: path, requestId: "share-" + Date.now() })) {
      toast("Sharing needs the desktop app");
      return;
    }
    toast("Uploading attachment…");
  }

  function refresh() {
    els["refresh-btn"].classList.add("spinning");
    if (!send({ action: "refresh" })) {
      setTimeout(() => els["refresh-btn"].classList.remove("spinning"), 600);
      toast("Refresh needs the desktop app");
    } else {
      toast("Pulling new mail…");
    }
  }

  // send a mutation; returns true if the native bridge accepted it
  function send(payload) { return postMail(payload); }

  // ---------------------------------------------------------------- bridge callbacks (Swift → JS)
  window.HasnaMail = {
    hydrate: function (data) {
      if (!data) return;
      ingest(data);
      // Keep selection if the thread still exists.
      if (state.activeThreadId && !threadById(state.activeThreadId)) {
        state.activeThreadId = null;
        if (state.view === "thread") state.view = "empty";
      }
      renderAll();
      if (state.view === "thread") renderReader();
      els["refresh-btn"].classList.remove("spinning");
    },
    actionResult: function (res) {
      if (!res) return;
      if (res.ok === false) {
        const msg = (res.message || "").split("\n").filter(Boolean).slice(-1)[0] || "Action failed";
        toast(msg.slice(0, 120));
      } else if (res.action === "send" || res.action === "reply") {
        toast("Sent ✓");
      } else if (res.action === "refresh") {
        toast("Inbox up to date");
      }
    },
    attachmentShared: function (res) {
      if (!res) return;
      if (res.ok && res.url) {
        try { navigator.clipboard && navigator.clipboard.writeText(res.url); } catch (e) {}
        toast("Link copied: " + res.url.slice(0, 60));
      } else {
        toast(res.ok ? "Uploaded" : "Upload failed");
      }
    },
    destroy: function () { /* nothing to tear down */ },
  };

  function ingest(data) {
    state.threads = Array.isArray(data.threads) ? data.threads : [];
    state.thisAddress = data.thisAddress || state.thisAddress || "";
    state.dbExists = data.dbExists !== false;
    if (Array.isArray(data.folders) && data.folders.length) {
      state.folders = data.folders;
    } else {
      recomputeFolders();
    }
  }

  // ---------------------------------------------------------------- render all
  function renderAll() {
    renderFolders();
    renderThreads();
    if (state.view === "thread") renderReader();
    updateAbout();
  }
  function updateAbout() {
    if (els["about-address"]) els["about-address"].textContent = state.thisAddress || "—";
    if (els["about-count"]) els["about-count"].textContent = String(state.threads.length);
  }

  // ---------------------------------------------------------------- theme
  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      // system
      const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    }
    document.querySelectorAll(".theme-card").forEach((c) => {
      c.classList.toggle("theme-selected", c.getAttribute("data-theme") === theme);
    });
  }
  function initTheme() {
    let saved = "system";
    try { saved = localStorage.getItem("mailery-theme") || "system"; } catch (e) {}
    applyTheme(saved);
    document.querySelectorAll(".theme-card").forEach((c) => {
      c.addEventListener("click", () => {
        const th = c.getAttribute("data-theme");
        try { localStorage.setItem("mailery-theme", th); } catch (e) {}
        applyTheme(th);
      });
    });
  }

  // ---------------------------------------------------------------- shells
  function setShell(name) { els["window"].setAttribute("data-active-shell", name); }

  // ---------------------------------------------------------------- misc UI
  function autoGrow(ta) {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }

  function wireEvents() {
    els["compose-btn"].addEventListener("click", () => openCompose());
    els["refresh-btn"].addEventListener("click", refresh);
    els["search-input"].addEventListener("input", (e) => { state.search = e.target.value; renderThreads(); });
    els["act-star"].addEventListener("click", toggleStar);
    els["act-archive"].addEventListener("click", archiveThread);
    els["act-trash"].addEventListener("click", trashThread);
    els["reply-box"].addEventListener("submit", (e) => { e.preventDefault(); sendReply(); });
    els["reply-input"].addEventListener("input", (e) => autoGrow(e.target));
    els["reply-input"].addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendReply(); }
    });
    els["compose-form"].addEventListener("submit", submitCompose);
    els["compose-close"].addEventListener("click", () => { state.activeThreadId ? renderReader() : showView("empty"); });
    els["open-settings"].addEventListener("click", () => setShell("settings"));
    els["settings-back"].addEventListener("click", (e) => { e.preventDefault(); setShell("app"); });
    document.querySelectorAll(".set-item").forEach((it) => {
      it.addEventListener("click", (e) => {
        e.preventDefault();
        const tab = it.getAttribute("data-tab");
        document.querySelectorAll(".set-item").forEach((x) => x.classList.toggle("active", x === it));
        document.querySelectorAll(".set-page").forEach((p) => p.classList.toggle("active", p.getAttribute("data-tab") === tab));
      });
    });
    if (els["about-db"]) {
      // dbPath filled from BOOT if present.
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.view === "compose") { state.activeThreadId ? renderReader() : showView("empty"); }
    });
  }

  // ---------------------------------------------------------------- sample boot (browser only)
  function sampleBoot() {
    const now = Date.now();
    const mk = (over) => Object.assign({
      id: "x", source: "inbound", from: "", to: [], cc: [], subject: "", snippet: "",
      textBody: "", htmlBody: "", date: "", ts: now, isRead: true, isStarred: false,
      isArchived: false, isSent: false, isSpam: false, isTrash: false, labels: [], attachments: [],
    }, over);
    const threads = [
      {
        id: "t1", subject: "Welcome to Mailery", participants: ["Alumia Team <team@alumia.co>", "andrei@hasna.com"],
        snippet: "Thanks for trying Mailery — here's how to get started with your inbox.",
        ts: now - 3600000, date: "", unread: 1, starred: false, hasAttachments: false,
        folders: { inbox: true, sent: false, archive: false, spam: false, trash: false, starred: false },
        messages: [mk({ id: "m1", from: "Alumia Team <team@alumia.co>", to: ["andrei@hasna.com"], subject: "Welcome to Mailery", textBody: "Thanks for trying Mailery — here's how to get started with your inbox.\n\nReply to this email to test the round-trip.", snippet: "Thanks for trying Mailery", ts: now - 3600000, isRead: false })],
      },
      {
        id: "t2", subject: "Invoice #1042", participants: ["Billing <billing@vendor.com>", "andrei@hasna.com"],
        snippet: "Your invoice for June is attached.", ts: now - 86400000, unread: 0, starred: true, hasAttachments: true,
        folders: { inbox: true, sent: false, archive: false, spam: false, trash: false, starred: true },
        messages: [mk({ id: "m2", from: "Billing <billing@vendor.com>", to: ["andrei@hasna.com"], subject: "Invoice #1042", textBody: "Your invoice for June is attached. Total due: $240.", isStarred: true, ts: now - 86400000, attachments: [{ filename: "invoice-1042.pdf", contentType: "application/pdf", size: 84213, path: "" }] })],
      },
      {
        id: "t3", subject: "Re: Roadmap sync", participants: ["andrei@hasna.com", "Dana <dana@hasna.com>"],
        snippet: "Sounds good, let's lock Thursday.", ts: now - 2 * 86400000, unread: 0, starred: false, hasAttachments: false,
        folders: { inbox: false, sent: true, archive: false, spam: false, trash: false, starred: false },
        messages: [mk({ id: "m3", source: "sent", isSent: true, from: "andrei@hasna.com", to: ["dana@hasna.com"], subject: "Re: Roadmap sync", textBody: "Sounds good, let's lock Thursday.", ts: now - 2 * 86400000 })],
      },
    ];
    return { threads: threads, folders: [], thisAddress: "andrei@hasna.com", dbExists: true };
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    cacheEls();
    wireEvents();
    initTheme();
    const data = (window.__BOOT__ && typeof window.__BOOT__ === "object") ? window.__BOOT__ : sampleBoot();
    ingest(data);
    if (els["about-db"] && data.dbPath) els["about-db"].textContent = data.dbPath;
    setShell("app");
    showView("empty");
    renderAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
