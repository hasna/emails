import type { Database } from "./database.js";
import type {
  CreateMailFolderInput,
  CreateMailboxInput,
  MailFolder,
  MailFolderRow,
  Mailbox,
  MailboxRow,
} from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";

function normalizeMailboxAddress(address: string): string {
  const normalized = address.trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(normalized)) {
    throw new Error(`Invalid mailbox address: ${address}`);
  }
  return normalized;
}

function rowToMailbox(row: MailboxRow): Mailbox {
  return { ...row };
}

function rowToFolder(row: MailFolderRow): MailFolder {
  return { ...row };
}

const DEFAULT_FOLDERS: Array<{ role: MailFolder["role"]; name: string; path: string; sort_order: number }> = [
  { role: "inbox", name: "Inbox", path: "INBOX", sort_order: 10 },
  { role: "sent", name: "Sent", path: "SENT", sort_order: 20 },
  { role: "archive", name: "Archive", path: "ARCHIVE", sort_order: 30 },
  { role: "spam", name: "Spam", path: "SPAM", sort_order: 40 },
  { role: "trash", name: "Trash", path: "TRASH", sort_order: 50 },
];

export function ensureDefaultMailFolders(mailboxId: string, db?: Database): MailFolder[] {
  const d = db || getDatabase();
  const timestamp = now();
  for (const folder of DEFAULT_FOLDERS) {
    d.run(
      `INSERT OR IGNORE INTO mail_folders
        (id, mailbox_id, role, name, path, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `folder:${mailboxId}:${folder.role}`,
        mailboxId,
        folder.role,
        folder.name,
        folder.path,
        folder.sort_order,
        timestamp,
        timestamp,
      ],
    );
  }
  return listMailFolders(mailboxId, d);
}

export function createMailbox(input: CreateMailboxInput, db?: Database): Mailbox {
  const d = db || getDatabase();
  const address = normalizeMailboxAddress(input.address);
  const id = uuid();
  const timestamp = now();
  d.run(
    `INSERT INTO mailboxes (id, address, display_name, owner_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      address,
      input.display_name ?? null,
      input.owner_id ?? null,
      input.status ?? "active",
      timestamp,
      timestamp,
    ],
  );
  ensureDefaultMailFolders(id, d);
  return getMailbox(id, d)!;
}

export function getMailbox(id: string, db?: Database): Mailbox | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM mailboxes WHERE id = ?").get(id) as MailboxRow | null;
  return row ? rowToMailbox(row) : null;
}

export function getMailboxByAddress(address: string, db?: Database): Mailbox | null {
  const d = db || getDatabase();
  const row = d
    .query("SELECT * FROM mailboxes WHERE address = ?")
    .get(normalizeMailboxAddress(address)) as MailboxRow | null;
  return row ? rowToMailbox(row) : null;
}

export function listMailboxes(db?: Database): Mailbox[] {
  const d = db || getDatabase();
  const rows = d.query("SELECT * FROM mailboxes ORDER BY address ASC").all() as MailboxRow[];
  return rows.map(rowToMailbox);
}

export function createMailFolder(input: CreateMailFolderInput, db?: Database): MailFolder {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();
  d.run(
    `INSERT INTO mail_folders
      (id, mailbox_id, role, name, path, provider_folder_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.mailbox_id,
      input.role,
      input.name,
      input.path,
      input.provider_folder_id ?? null,
      input.sort_order ?? 0,
      timestamp,
      timestamp,
    ],
  );
  return getMailFolder(id, d)!;
}

export function getMailFolder(id: string, db?: Database): MailFolder | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM mail_folders WHERE id = ?").get(id) as MailFolderRow | null;
  return row ? rowToFolder(row) : null;
}

export function getMailboxFolderByRole(mailboxId: string, role: MailFolder["role"], db?: Database): MailFolder | null {
  const d = db || getDatabase();
  const row = d
    .query("SELECT * FROM mail_folders WHERE mailbox_id = ? AND role = ? ORDER BY sort_order ASC LIMIT 1")
    .get(mailboxId, role) as MailFolderRow | null;
  return row ? rowToFolder(row) : null;
}

export function listMailFolders(mailboxId: string, db?: Database): MailFolder[] {
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM mail_folders WHERE mailbox_id = ? ORDER BY sort_order ASC, name ASC")
    .all(mailboxId) as MailFolderRow[];
  return rows.map(rowToFolder);
}
