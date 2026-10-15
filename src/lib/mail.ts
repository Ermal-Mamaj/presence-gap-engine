import nodemailer, { type Transporter } from "nodemailer";
import type { PrismaClient } from "@/generated/prisma/client";
import { normalizeEmail } from "./contacts";
import { markOutreachSent } from "./leads";

/**
 * Sending a drafted email from the app, through any SMTP mailbox. Every send
 * passes the same checks, in this order: the draft exists and is an unsent
 * email, the lead has a usable address, the address is not on the
 * do-not-contact list, sending is configured (including the opt-out line),
 * and the daily limit isn't reached.
 *
 * Configuration (see .env.example):
 * - SMTP_URL: e.g. smtps://user:password@smtp.example.com:465
 * - MAIL_FROM: e.g. "Naser <naser@outreach.example.al>"
 * - MAIL_OPT_OUT: the line appended to every email, in its language, telling
 *   the reader how to stop further messages. Required: no email goes out
 *   without one.
 * - MAIL_DAILY_LIMIT: emails per 24 hours, default 20. Low volume protects
 *   the sending domain's reputation.
 * - MAIL_DRY_RUN=1: build the email exactly as it would be sent, but don't
 *   send it or mark it sent.
 */

export interface MailConfig {
  smtpUrl: string | null;
  from: string | null;
  optOut: string | null;
  dailyLimit: number;
  dryRun: boolean;
}

export function mailConfig(): MailConfig {
  const limit = Number(process.env.MAIL_DAILY_LIMIT);
  return {
    smtpUrl: process.env.SMTP_URL?.trim() || null,
    from: process.env.MAIL_FROM?.trim() || null,
    optOut: process.env.MAIL_OPT_OUT?.trim() || null,
    dailyLimit: Number.isInteger(limit) && limit > 0 ? limit : 20,
    dryRun: process.env.MAIL_DRY_RUN === "1",
  };
}

/** What is still missing before the app may send, by setting name. */
function missingSettings(config: MailConfig): string[] {
  return [
    !config.dryRun && !config.smtpUrl && "SMTP_URL",
    !config.from && "MAIL_FROM",
    !config.optOut && "MAIL_OPT_OUT",
  ].filter((s): s is string => Boolean(s));
}

const DAY_MS = 24 * 60 * 60 * 1000;

function sentInLastDay(prisma: PrismaClient, now: Date) {
  return prisma.outreach.count({ where: { sentVia: "app_email", sentAt: { gt: new Date(now.getTime() - DAY_MS) } } });
}

export interface MailStatus {
  ready: boolean;
  dryRun: boolean;
  from: string | null;
  missing: string[];
  dailyLimit: number;
  sentLastDay: number;
}

/** Whether the app can send right now, and why not if it can't. */
export async function mailStatus(prisma: PrismaClient, now = new Date()): Promise<MailStatus> {
  const config = mailConfig();
  const missing = missingSettings(config);
  return {
    ready: missing.length === 0,
    dryRun: config.dryRun,
    from: config.from,
    missing,
    dailyLimit: config.dailyLimit,
    sentLastDay: await sentInLastDay(prisma, now),
  };
}

export type MailErrorKind =
  | "not_found"
  | "already_sent"
  | "in_progress"
  | "not_email"
  | "no_address"
  | "do_not_contact"
  | "not_configured"
  | "daily_limit"
  | "send_failed";

export class MailError extends Error {
  constructor(
    readonly kind: MailErrorKind,
    message: string
  ) {
    super(message);
    this.name = "MailError";
  }
}

/** A do-not-contact entry: an email address, or a whole domain. */
export function normalizeBlockValue(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const email = normalizeEmail(value);
  if (email) return email.toLowerCase();
  const domain = value.replace(/^@/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain) ? domain : null;
}

/** Whether an address, or its domain, is on the do-not-contact list. */
export async function isDoNotContact(prisma: PrismaClient, email: string): Promise<boolean> {
  const address = email.toLowerCase();
  const domain = address.split("@")[1] ?? "";
  return (await prisma.doNotContact.count({ where: { value: { in: [address, domain] } } })) > 0;
}

// Drafts being sent right now, for the whole process: a double click or a
// second tab must not send the same email twice.
const globalForMail = globalThis as unknown as { sendingDrafts?: Set<string> };
const sending = () => (globalForMail.sendingDrafts ??= new Set<string>());

export interface SendOutcome {
  dryRun: boolean;
  to: string;
  from: string;
  subject: string;
  text: string;
  messageId: string | null;
}

/** The address part of "Name <a@b>", for the unsubscribe header. */
function addressOf(from: string): string {
  return /<([^>]+)>/.exec(from)?.[1] ?? from;
}

/**
 * Sends one drafted email and records it as sent. A failed send leaves the
 * draft unsent and says why; a dry run builds the email and records nothing.
 */
export async function sendDraftEmail(
  prisma: PrismaClient,
  outreachId: string,
  options: { today?: string; now?: Date; transport?: Transporter } = {}
): Promise<SendOutcome> {
  const lock = sending();
  if (lock.has(outreachId)) throw new MailError("in_progress", "This email is already being sent.");
  lock.add(outreachId);
  try {
    const now = options.now ?? new Date();
    const draft = await prisma.outreach.findUnique({ where: { id: outreachId }, include: { business: true } });
    if (!draft) throw new MailError("not_found", "Draft not found");
    if (draft.sentAt) throw new MailError("already_sent", "This draft has already been sent.");
    if (draft.channel !== "email") throw new MailError("not_email", "Only an email draft can be sent from the app.");
    const to = normalizeEmail(draft.business.email);
    if (!to) throw new MailError("no_address", "This lead has no usable email address.");
    if (await isDoNotContact(prisma, to)) {
      throw new MailError("do_not_contact", `${to} is on the do-not-contact list.`);
    }

    const config = mailConfig();
    const missing = missingSettings(config);
    if (missing.length) {
      throw new MailError("not_configured", `Sending isn't set up. Set ${missing.join(", ")} in .env.`);
    }
    if ((await sentInLastDay(prisma, now)) >= config.dailyLimit) {
      throw new MailError(
        "daily_limit",
        `The limit of ${config.dailyLimit} emails per 24 hours is reached. Try again later, or raise MAIL_DAILY_LIMIT.`
      );
    }

    const subject = draft.subject ?? "";
    const text = `${draft.body}\n\n${config.optOut}`;
    const message = {
      from: config.from!,
      to,
      subject,
      text,
      headers: { "List-Unsubscribe": `<mailto:${addressOf(config.from!)}?subject=unsubscribe>` },
    };
    const outcome = { to, from: config.from!, subject, text };

    const transport =
      options.transport ?? nodemailer.createTransport(config.dryRun ? { jsonTransport: true } : config.smtpUrl!);
    let messageId: string | null;
    try {
      messageId = (await transport.sendMail(message)).messageId ?? null;
    } catch (err) {
      throw new MailError("send_failed", `The mail server refused it: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    if (config.dryRun) return { dryRun: true, ...outcome, messageId: null };

    await markOutreachSent(prisma, outreachId, { now, today: options.today });
    await prisma.outreach.update({ where: { id: outreachId }, data: { sentVia: "app_email", emailMessageId: messageId } });
    return { dryRun: false, ...outcome, messageId };
  } finally {
    lock.delete(outreachId);
  }
}

export function listDoNotContact(prisma: PrismaClient) {
  return prisma.doNotContact.findMany({ orderBy: { createdAt: "desc" } });
}

/** Adds an address or domain; adding one that is already listed just keeps it. */
export async function addDoNotContact(prisma: PrismaClient, raw: string, reason?: string | null) {
  const value = normalizeBlockValue(raw);
  if (!value) throw new MailError("no_address", `"${raw}" is not an email address or a domain.`);
  return prisma.doNotContact.upsert({ where: { value }, create: { value, reason: reason?.trim() || null }, update: {} });
}

export async function removeDoNotContact(prisma: PrismaClient, id: string) {
  const result = await prisma.doNotContact.deleteMany({ where: { id } });
  if (result.count === 0) throw new MailError("not_found", "Not on the list");
}
