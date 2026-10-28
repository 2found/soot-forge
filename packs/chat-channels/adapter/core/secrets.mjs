// Shared secret detector (channel-adapter.v1 §6.6). Must stay identical to the
// contract's fixtures/secrets.json patterns; secrets.test.mjs enforces that.
export const SECRET_PATTERNS = [
  {id: 'provider_sk', regex: '\\bsk-[A-Za-z0-9_-]{20,}', flags: ''},
  {id: 'stripe', regex: '\\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}', flags: ''},
  {id: 'google_api_key', regex: 'AIza[0-9A-Za-z_-]{35}', flags: ''},
  {id: 'aws_access_key', regex: '\\b(AKIA|ASIA)[0-9A-Z]{16}\\b', flags: ''},
  {id: 'github_token', regex: '\\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})', flags: ''},
  {id: 'slack_token', regex: '\\bxox[abposr]-[A-Za-z0-9-]{10,}', flags: ''},
  {id: 'telegram_bot_token', regex: '\\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\\b', flags: ''},
  {id: 'discord_bot_token', regex: '\\b[A-Za-z0-9_-]{24,28}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,40}\\b', flags: ''},
  {id: 'private_key', regex: '-----BEGIN [A-Z ]*PRIVATE KEY-----', flags: ''},
  {id: 'jwt', regex: '\\beyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}', flags: ''},
  {id: 'soot_secret', regex: '\\b(sca|svs)_[A-Za-z0-9_-]{20,}', flags: ''},
  {id: 'password_assignment', regex: '(mật khẩu|mat khau|password|passwd|pwd|pass)\\s*[:=]\\s*\\S{6,}', flags: 'i'},
  {id: 'otp_code', regex: '(2fa|otp|mã xác thực|mã xác minh|ma xac thuc|ma xac minh|mã đăng nhập)[^0-9\\n]{0,12}[0-9]{6}\\b', flags: 'i'},
];

const compiled = SECRET_PATTERNS.map(pattern => ({id: pattern.id, re: new RegExp(pattern.regex, pattern.flags)}));

// The id of the first matching pattern, or null.
export function detectSecret(text) {
  if (!text) return null;
  for (const {id, re} of compiled) if (re.test(text)) return id;
  return null;
}
