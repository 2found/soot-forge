# Lohi blog

The publisher of the marketing pack's `blog-lohi` channel
([design](../../../../packs/marketing/README.md#publishing-without-a-hub)). It takes a signed
claim from `marketing_claim` and makes it live. The host env `LOHI_BLOG_TARGET` picks where:

- `cms` (the Lohi recipe's default): **lohi2.com/blog**. The post is saved and published to the 2found hub CMS, site
  `lohi`, language `vi`, and the answer is `https://lohi2.com/blog/<slug>`.
- `git` (the pack's default when the variable is unset): the old `blog.lohi2.com` repository, described below.
  Kept for a machine that still publishes there; the Lohi workspace no longer does.

## CMS target (`LOHI_BLOG_TARGET=cms`)

`publish` runs one deterministic sequence with the hub binding `MARKETING_HUB` (`{"service_url","service_token"}`, the
operator credential of the Soot that runs the chain, entered in Nest or `soot credential set lohi-editor MARKETING_HUB`):

1. `cms_read {site: lohi, slug}`: the post's latest revision, or none (`no post …`).
2. `cms_save` as a **draft** (`language: vi`, `title`, `summary` = the claim's meta, `body_markdown` = the claim's body
   unchanged, so internal `lohi2.com` links stay) with `expected_revision` = the current revision (0 for a new
   post) and a `request_id` derived from the content. Skipped when the CMS already holds exactly this content.
3. `cms_publish {site, slug, revision, title}` unless that revision is already live.
4. Verify: the public read API `GET <hub origin>/api/cms/v1/sites/lohi/posts/<slug>` returns the revision (5 tries, 2 s apart).
5. Answer `{status: published, url: https://lohi2.com/blog/<slug>, platform_id: cms:lohi/<slug>@<revision>}`; `marketing_record`
   writes the URL to `posts.url` and `publish_log`.

Rules it keeps: **the same slug is an update, never a second post** (a retry, a re-issued claim or a crash between save and
publish finds the content already there and saves nothing twice); nothing is written unless the signed claim verifies;
a token the hub refuses (401/403), a missing or malformed `MARKETING_HUB`, a slug the CMS rejects (lowercase words, single
hyphens, at most 96 characters), a meta over 500 characters or a body over 40000 bytes ends the step with one plain
reason and `retry: false`; an unreachable hub or a 5xx is `retry: true`. `unpublish` archives the CMS post and checks the public
API no longer returns it. `find` is true when the public post has the claim's title, summary and body. `ready` (the 06:30
`blog-ready` schedule) checks the credential, that it is accepted and that the token may publish for site `lohi` (a
`tool.preflight` of `cms_publish` on a post that does not exist: nothing is written), and raises one Cần bạn card with
the exact missing step. It needs no git, Go, 2server or gcloud. The hub token is the publisher's: the approval gate is
`marketing_claim` (the host's approval policy for it), not a second approval on the CMS write.

## Git target (`LOHI_BLOG_TARGET=git`), `blog.lohi2.com`

| Tool | Mode | What it does |
| --- | --- | --- |
| `publish` | write | Writes `blog/posts/<series>/<slug>.vi.md` in its own worktree, builds the blog with zero warnings, commits only that file (trailer `Soot-Intent: <intent_id>`), pushes fast-forward only, runs `blog/infra/gce/deploy.sh --env prod` from the worktree and polls the URL until 200 (5 minutes). |
| `unpublish` | write | Deletes the file in a commit, pushes, deploys and checks the URL is gone. |
| `catalog` | read | Real novels for the Writer: Lohi's public feed, genres and search, each with its `lohi2.com/truyen/<slug>` link. |
| `ready` | write | Names what the machine still lacks to publish (git, go, 2server, gcloud, SSH to the repo, connection file) as one Cần bạn item; quiet until the list changes. |
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

- No `LOHI_REPO`. The publisher clones `LOHI_BLOG_REMOTE` (no default: the
  recipe's `setup.mjs --blog-remote <url>` sets it; with neither, nothing is
  cloned or pushed and `blog-ready` raises one Cần bạn card) into its own state
  directory the first time; `LOHI_REPO` still works as an override. The 2server
  connection file is `LOHI_CONNECTION` or `~/.2server/connection.yaml`.
- Host env (`needs.env`): `LOHI_BLOG_TARGET` (`cms` or `git`), `LOHI_BLOG_REMOTE`, `LOHI_CONNECTION` and
  `LOHI_REPO` (all optional), plus `PATH`, `HOME` and `SSH_AUTH_SOCK` so git,
  Go, `gcloud` and the `2server` login work as they do for the founder.
  `LOHI_BLOG_URL` and `LOHI_API_URL` are optional.
- Credential `MARKETING_HUB` (optional, CMS target only): `{"service_url":"https://2found.dev/api/hub","service_token":"…"}`, a
  publisher token for site `lohi`.
- Credential `MARKETING_CLAIM_KEY`: the same value as the marketing pack's;
  `examples/lohi-marketing/setup.mjs` generates it once.
- Recipe: [`examples/lohi-marketing`](../../README.md).
