# Soot Nest

Platform skill pack for Nest. It has three skills and no tools.

`side-bar` describes the shared right tool area; it grants no browser access and
starts no ingress. The Nest general Soot template selects both `soot-nest` and
`browser-use`. Browser-use owns browser configuration; Nest owns presentation and
reads `interface.tool_area` metadata.

`nest-links` teaches the `nest://` link grammar a Soot writes in a reply to send
the person to a data-pool collection or document, a Soot, a team, a screen (a
piece) or drafted work. Links grant nothing and send nothing. The grammar mirrors
`desktop/src/lib/nest-links.ts` in 2agent; change both together.

`nest-pieces` teaches a Soot to make a screen of its own in Nest (a piece): when
a screen is worth making, how to check that its Soot has written tools, what to
tell the person before writing, a tool that calls an outside service
(`tools/<id>/tool.json`: one declared HTTPS request; the person enters the key
in Nest, never in chat), the screen's files (`ui/<id>/index.html`, a script,
and `piece.json` last), its queries, named actions and questions, the kit
(`_kit/piece.css`, `_kit/piece.js` and the `soot` global, bridge levels 1 and
2), every refusal of a save or a call and its fix, the changes that need a new
approval, the limits, the events it receives, and how to propose a layout
change. It grants nothing: the runtime gives every Soot the `files` tool, runs
nothing a Soot writes, and decides what a screen may read and call; the person
approves a screen and its tools before they are shown or called. The reference
it mirrors is `docs/build-a-piece.md` (Path 1), `docs/written-pieces.md` and
`docs/contracts/nest-extensions.md` in 2agent; change them together. The
skill's translation example is the guide's own, file for file, and the
runtime's `TestTranslateGuideExample` runs it.

Written tools, named actions and `ask` need the Soot release after 0.18.0 and
a Nest at bridge level 2. On an older Soot the skill tells the Soot to notice
the missing `tool` note and say Soot needs an update; screens that only read
and send events still work there.

Evals: `evals/pieces.eval.json` (a translation screen; a key pasted in chat).
An eval run never changes the workspace, so the cases check what the Soot
says and calls, not what it saved.

The lead tools are in [nest-lead](../nest-lead/README.md) and the website Live
chat tools in [website-chat](../website-chat/README.md).
