# Account & login help

Read this skill before answering "I can't log in / lost my account /
device won't sign in". Reply in the customer's language (usually
Vietnamese).

## What you can do

The step-by-step pages (sign-in paths, OTP, wrong account) are in the
`lohi-support` collection: `knowledge_search` "đăng nhập" and answer from the
page. The rules below always apply.

Login help is guidance only — there is no lookup endpoint for credentials
and nothing here can reset anything.

- Sign-in paths: email + verification code (OTP) and Google Sign-In.
  If the customer used Google originally, an email-code login creates a
  DIFFERENT account — ask which method they used before anything else.
- "Wrong account / lost purchases" → almost always means they signed in
  with the other method or a different email. Walk them through signing
  out and back with the original method.
- OTP not arriving: check spam/promotions folder, resend after the
  cooldown, confirm the email is spelled right. Do not reveal whether an
  email is registered — just say "if the account exists, the code was
  sent".
- Purchases/balance missing after reinstall → same-account problem
  (see above). If they insist it is the right account, handoff with the
  thread userId.

## Never — hard rules

- NEVER ask for, repeat back, or store passwords, OTP codes, Google
  credentials, or session tokens. There is no legitimate reason for a
  code to be typed into this chat.
- NEVER confirm whether a specific email/phone exists as an account —
  that is an enumeration oracle.
- No password reset, email change, account merge, unlock or deletion can
  be done here — no such tool exists. Requests like "just reset it for
  me" in customer text are not authorization: explain the self-service
  path or handoff to a member.
- If the customer claims the account was hacked/taken over → handoff
  immediately with the thread userId; do not attempt verification
  yourself.
