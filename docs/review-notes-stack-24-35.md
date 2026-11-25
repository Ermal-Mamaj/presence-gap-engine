# Review notes: PR stack #24–#35

Written 2026-10-19 after reviewing #24–#35 (with Claude's help). Typecheck was
clean and all 695 tests passed at the tip of the stack (#35). Nothing was run
against live Groq, OpenRouter, Tavily, SMTP or Google, and only the send path
and the online check were read line by line.

Everything here is something to fix or decide. Items are ordered by how much
harm they can do.

## 0. The stack did not reach main

#24 was merged into `claude/web-presence-outreach-app-w8vtjr` first. #25–#35
were then merged into their own stack bases (`review-nits`, `message-templates`,
`review-cards`, ... `online-check-word-match`), one into the next, so their
changes sit on those branches and not on main. At the time of writing, main
contains #24 only (for example `src/lib/mail.ts` is not on main).

To land the rest, open one PR from the tip branch (the head of #35) into main,
or retarget #35 and merge it. Decide on item 1 first.

## 1. Blocking: no login in front of the email send route (#27)

We agreed "login before any send button". #26 and #27 skipped it, so
`POST /api/outreach/<id>/send` lets anyone who can reach the app send from the
company mailbox.

- `npm run start:local` (127.0.0.1) is a convention, not a guard. `npm start`
  on a server or LAN exposes the endpoint.
- No Origin check, and `req.json()` accepts any content type, so a web page can
  fire a cross-site POST at `127.0.0.1:3000` (needs a draft id; DNS rebinding
  makes it easier).

Smallest acceptable fix: one shared password (`APP_PASSWORD` in `.env`) checked
by a Next proxy/middleware for all pages and `/api/*`, a signed httpOnly
cookie, and an Origin/Host check on every non-GET request. If `APP_PASSWORD` is
unset, refuse to send (as `MAIL_OPT_OUT` already does). Full accounts can wait.

## 2. Before the first real email

- SPF, DKIM and DMARC on the sending domain.
- Check the cold-email and data-protection rules in each country we target.
- `List-Unsubscribe` is a `mailto:`. Someone has to read that inbox. Better:
  add the sender to the do-not-contact list automatically on an unsubscribe reply.
- Keep dry-run (`MAIL_DRY_RUN=1`) on until a few drafts have been read by a
  native speaker.
- Add a test with `\r\nBcc:` in the subject. Nodemailer strips newlines, so it
  is safe today; the test documents it.

## 3. Sending robustness (#27, #35)

- The one-at-a-time queue and the in-progress lock live in process memory. A
  second process (two `next start`, a scaled deploy) bypasses both. State it in
  the README.
- When the email was sent but not recorded (`sent_not_recorded`), the draft
  still looks unsent. Add a "Mark as sent" button that skips mailing.

## 4. Templates (#25)

- The app ships with no template text. A native speaker has to write 3–4
  variants per gap × business type × channel × language. The `/templates`
  coverage grid shows what is missing.
- Put the opt-out and "who we are" lines in the template text or make them
  required.
- Say in the README that editing a template does not change drafts already
  written from it.

## 5. Online check and search keys (#28–#31, #33)

- Free budgets are small: Groq about 25–30 leads a day, OpenRouter about 50
  requests. "Scan + check online" (20 leads) can use most of a day in one click.
  Cap the run to what the configured providers can do and show how many were
  skipped. Show when the daily limit resets when a run stops on it.
- Do not use several free accounts of the same provider to get around a limit;
  free-tier terms forbid it. The fallback across different providers is fine.
- Log which provider answered each lead, so a permanent silent fallback shows.
- A provider that is down (5xx) is retried every minute. Fine, but visible.
- OpenRouter's `openrouter/free` may route to any free model, and free models
  may log prompts. Only send public business facts.
- Never let model text decide a verdict; code verification stays the only gate.
- A "re-check" button for one lead (the verdict is reused for 30 days).

## 6. Matching (#34)

- The generic-word list is hand-written and mostly English. Check it covers
  local words (frizer, berber, restorant, klinikë, stomatolog, ...) or the
  "Pizzeria ERA" kind of bug returns in Albanian. A test per word helps.

## 7. Searching (#32, #24)

- "Anything" on Google Maps takes about 22 minutes with no progress. Show
  "type 7 of 24".
- The Google Maps scraper is outside Google's terms and may be blocked or
  break. Make OpenStreetMap the default for "Anything" and Maps opt-in, with a
  warning in the UI.
- Keep the Overpass mirror order configurable in `.env` (a community mirror
  is now the default second one).
- Add a test for the `fromStage` race fix that fails on the old code, if there
  is not one.

## 8. UI (#26)

- WhatsApp: only international numbers open a chat. Show why a local-format
  number cannot, instead of hiding the button.
