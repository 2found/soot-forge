---
name: soot-create-pet
description: Create a new Soot pet or accessory variant using Codex imagegen, seven animated states, reproducible sprite assembly and visual review.
---

# Create a Soot pet

Produce a reusable Soot v3 pet: seven states × twelve generated drawings,
transparent state sheets, full atlas, manifest, contact sheets and animated
previews. Preserve Soot's identity while varying the requested prop/accessories.

## Available operations and generation boundary

- `soot_pet_preflight`: check Codex installation/login and return setup steps.
- `soot_pet_prepare`: create a brief and seven grounded imagegen jobs.
- `soot_pet_inspect`: list the supplied/missing source sheets.
- `soot_pet_assemble`: extract and assemble existing drawings. It does not
  create poses or approve visual quality.

**These operations do not generate images.** The current Soot runtime has no
built-in Codex imagegen tool. Generation is a handoff to a Codex session with
the `imagegen` skill/tool. Do not claim that configuring an OpenAI text model
enables imagegen, read its OAuth vault, or invent a `soot imagegen` command.
If the current host exposes a real image generation capability, inspect its
contract before using it; otherwise deliver the prepared job directory to Codex
and resume after the resulting PNGs are placed at their declared outputs.

## Check Codex before starting

First call `soot_pet_preflight({})`, before preparing a new pet or resuming image
generation. It needs no pet store binding and runs only `codex login status`.
The check applies to the OS account on the Soot host, not another user's laptop
or a browser session. For a remote deployment, make this scope clear.

If `canPrepare` is false, show the returned `message` and relevant `steps`, then
wait for the user. Do not call `prepare`, generate an image, install software,
start OAuth, ask for tokens or keep polling. Expected cases:

- `codex_not_installed`: “Tạo pet cần Codex để sinh ảnh. Bạn hãy cài Codex,
  đăng nhập tài khoản của mình, rồi quay lại đây để tiếp tục.” Include the
  returned official installation link, `codex login`, and `codex login status`.
- `codex_login_required`: “Codex đã được cài nhưng chưa đăng nhập. Bạn hãy chạy
  `codex login`, hoàn tất đăng nhập, rồi nhắn mình tiếp tục tạo pet.” If the user
  has no account, direct them to account creation in the sign-in flow.
- `codex_host_context_missing`: ask the operator to configure the pack's
  environment grants. Do not tell the user their account is signed out.
- `codex_status_unavailable`: ask them to inspect `codex login status` locally.
  A timeout, keychain/config error or unsupported command is not proof of logout.

When the user returns after installation/login, run preflight again in the new
turn and continue the existing brief. Don't invent a new operation name or
nonce to bypass a cached receipt. `prepare` checks again before writing files,
so respect the same blocked result if login changed after preflight.

`codex_authenticated` establishes stored login only. It does not verify remote
token validity, subscription/plan, imagegen availability or remaining usage.
Do not require a specific paid plan based on this check. If Codex later reports
an authentication, access or usage error, explain that actual error and preserve
the prepared job for resumption. The user logs in through Codex, never through
this pack or by pasting credentials into chat.

## Brief and preparation

Infer a short slug, display name, exact held object/accessories and a restrained
hand action from the request. Ask only for details that materially affect the
design. A new brief uses a new id, preserving existing jobs and shipped pets.

```json
{
  "id": "soot-astronaut",
  "name": "Soot · Phi hành gia",
  "accessories": "ONE cream-and-red toy satellite held in the hands; a small red space cap",
  "action": "the free hand gently adjusts the satellite antenna"
}
```

Call `soot_pet_prepare` with this object. An optional `reference` is an image
path relative to the operator-bound pet store, for example `inputs/soot.png`.
Without it, use the bundled Soot reference. The result returns `jobsFile` and
`jobDirectory`; every path inside `jobs.json` is relative to that directory.

Preparation is repeatable for the same brief/reference. It refuses a different
brief under an existing id. It does not overwrite an existing pet atlas.

## Imagegen handoff

In the Codex generation session, load its installed `imagegen` skill and use
the built-in tool. Start with **idle only** to establish the new prop identity
and motion; show that sample when the user requested a trial. Once selected,
use a crop of its open-eye, free-hand pose as the identity reference for the
remaining states, updating `jobs.json` to record the actual reference paths.
The preparation tool cannot select artwork or perform that visual decision.

For each job, read its prompt and attach every `inputImages` entry. Use the
closed-eye guide for sleeping. Generate a separate 1536×1024 transparent PNG,
four columns × three rows, and copy the selected result to the job's `output`.
Retain exact revised prompts and reference paths when repairing a row. Generated
originals stay under Codex's image storage unless the user requests cleanup.

Use real generated frames for eye and hand articulation. The bundled helpers
only crop, register, order and encode existing pixels; CSS wobble, interpolated
poses and duplicated stills do not replace generated animation.

### Motion rules learned from the approved Soot set

- Fixed pupils, gaze and eye centers. Dark upper lids cover the eyes; half,
  closed, half blink at frames 5–7. Sleeping eyes stay closed in all frames.
- Keep complete spectacle rims in front of eyelids, even on the closed frame.
- Exactly two connected hands. A lifting hand releases its previous grip.
  A free-hand reference prevents the common extra-hand failure.
- Identity reference controls the body; the motion guide controls animation.
  Replace the old held object instead of adding a second one.
- Keep body scale/feet steady and gestures small. Last pose should meet first.
- Empty gutters must be transparent: no white background, soft rectangular
  haze, detached particles, drawn grid or clipped limbs.

Read `references/motion.md` in this skill folder when repairing drift, loop
closure, gaze, anatomy or alpha problems. Use a host file reader if granted;
the essential rules above are sufficient for the normal workflow.

## Assemble and review

After all seven selected source sheets are present, call `soot_pet_assemble`
with `{"id":"soot-astronaut"}`. It returns an immutable build directory.
Same source hashes and build configuration reuse the existing build; repaired
sources produce a new build. On failure, inspect the named row before retrying.
An uncertain tool outcome should first be reconciled from the returned job and
build files, without changing the operation name to bypass its receipt fence.

Inspect contacts and animated previews at chat size (48px) and desktop size
(96–180px), on light and dark backgrounds. Confirm all 84 drawings, coherent
motion, full props, two hands, lid/rim continuity and loop closure. Pixel
differences only prove different drawings. If visual inspection is unavailable,
report **assembled, visual review pending**, not approved or ready to ship.

Return the manifest, atlas/state files, preview paths, exact prompts and any
remaining limitation. Save a visual review record with the reviewed atlas hash.
Installing/selecting/publishing the pet in another product is a separate user
action; creating files does not change a live pet or conversation configuration.
