# Lohi blog

The publisher of the marketing pack's `blog-lohi` channel
([design](../../../../packs/marketing/README.md#publishing-without-a-hub)). It takes a signed
claim from `marketing_claim` and makes it live on `blog.lohi2.com`.

| Tool | Mode | What it does |
| --- | --- | --- |
| `publish` | write | Writes `blog/posts/<series>/<slug>.vi.md` in its own worktree, builds the blog with zero warnings, commits only that file (trailer `Soot-Intent: <intent_id>`), pushes fast-forward only, runs `blog/infra/gce/deploy.sh --env prod` from the worktree and polls the URL until 200 (5 minutes). |
| `unpublish` | write | Deletes the file in a commit, pushes, deploys and checks the URL is gone. |
| `find` | read | Crash recovery: is the intent's commit on `origin/main` with the file present and the URL live? |

## Rules it keeps

- **Never the founder's tree.** It keeps `$SOOT_PACK_STATE/blog-worktree`
  (`git worktree add --detach … origin/main`) and resets it to `origin/main`
  on every call, because `deploy.sh` uploads the directory it runs in.
- **Live stays unchanged on failure.** A build warning or error commits
  nothing; a push rejected twice pushes nothing; a failed deploy (or a URL not
  live in 5 minutes) is followed by a revert push so `main` matches live.
- **Once only.** `publish` first looks for a commit of the same intent on
  `origin/main`; a re-issued claim never makes a second commit.
- **Signed claims only.** An unsigned, forged, expired (10 minutes) or
  content-mismatched claim is refused before anything runs.
- **Vietnamese-only posts** render as `<series>/<slug>/vi/` (checked against
  the blog engine on 2026-11-08: listed in the index, sitemap and feed), so the
  tool writes only `<slug>.vi.md` and leaves the engine unchanged.

## Set up

- Host env (`needs.env`): `LOHI_REPO` = absolute path of the kiem-lai checkout
  on the Mac, plus `PATH`, `HOME` and `SSH_AUTH_SOCK` so git, Go, `gcloud` and
  the `2server` login work as they do for the founder. `LOHI_BLOG_URL` is
  optional (default `https://blog.lohi2.com`).
- Credential `MARKETING_CLAIM_KEY`: the same value as the marketing pack's.
- Recipe: [`examples/lohi-marketing`](../../README.md).
