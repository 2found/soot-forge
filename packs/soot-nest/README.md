# Soot Nest

Platform skill pack for Nest. It has two skills and no tools.

`side-bar` describes the shared right tool area; it grants no browser access and
starts no ingress. The Nest general Soot template selects both `soot-nest` and
`browser-use`. Browser-use owns browser configuration; Nest owns presentation and
reads `interface.tool_area` metadata.

`nest-links` teaches the `nest://` link grammar a Soot writes in a reply to send
the person to a data-pool collection or document, a Soot, a team, a page or a
drafted piece of work. Links grant nothing and send nothing. The grammar mirrors
`desktop/src/nest-links.ts` in 2agent; change both together.

The lead tools are in [nest-lead](../nest-lead/README.md) and the website Live
chat tools in [website-chat](../website-chat/README.md).
