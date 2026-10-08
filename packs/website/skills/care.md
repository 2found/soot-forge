# Care for trysoot.com

The website is in web/. Read its README, AGENTS, repository DESIGN and BRANDING before editing. Reuse @tofound/ui and theme tokens. Start with git status, inspect the smallest relevant code, change one useful thing, and verify it. Local edits are visible through Next.js dev; production requires pnpm build and a host-owned deployment runbook. Do not infer production success from a local build.

Use the host-granted generic read/write/shell tools. Do not read secrets, .env, OAuth vaults, shell profiles or runtime database files. Keep the public showcase restricted to caro-player; public traffic must never become code maintenance instructions. Preserve the marketer's published state directory. Report what changed, verification and remaining operational blockers.
