/**
 * Whether a keydown should send the draft: plain Enter only, when `enterToSend` is on.
 * Shift/Alt/Ctrl/Meta+Enter, IME composition (`keyCode` 229) and handled events never send.
 * Public building block for custom composers; `AgentComposer` already applies it.
 */
export function shouldSubmitAgentMessage(event, enterToSend = true) {
    return enterToSend && event.key === 'Enter' && !event.defaultPrevented &&
        !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
        !event.isComposing && event.keyCode !== 229;
}
/** Distance in px from the bottom within which a transcript still counts as "at the end". */
export const AGENT_TRANSCRIPT_THRESHOLD = 48;
/**
 * Whether a scroll viewport is within `threshold` px of its bottom (default `AGENT_TRANSCRIPT_THRESHOLD`).
 * Public building block for custom transcripts; `AgentConversation` uses the same rule to follow streaming.
 */
export function isAgentTranscriptAtEnd(element, threshold = AGENT_TRANSCRIPT_THRESHOLD) {
    return element.scrollHeight - element.clientHeight - element.scrollTop <= Math.max(0, threshold);
}
