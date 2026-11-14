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
a screen is worth making, the three files it writes with the `files` tool
(`ui/<id>/index.html`, a script, and `piece.json` last), the `piece.json` fields,
the five query sources, the kit (`_kit/piece.css`, `_kit/piece.js` and the `soot`
global), what a save answers, the events a button sends back, and how to
propose a layout change. It grants nothing: the runtime gives every Soot the
`files` tool and decides what a screen may read; the person places a screen
before it is shown. The reference it mirrors is `docs/written-pieces.md` and
`docs/contracts/nest-extensions.md` in 2agent; change them together. The
skill's example is the guide's own, which the runtime's tests run.

The lead tools are in [nest-lead](../nest-lead/README.md) and the website Live
chat tools in [website-chat](../website-chat/README.md).
