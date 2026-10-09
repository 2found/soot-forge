/** Enter sends only when the host enables it. Preserve IME and modified Enter. */
export function shouldSubmitAgentMessage(event, enterToSend = true) {
    return enterToSend && event.key === 'Enter' && !event.defaultPrevented &&
        !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
        !event.isComposing && event.keyCode !== 229;
}
export function isAgentTranscriptAtEnd(element, threshold = 48) {
    return element.scrollHeight - element.clientHeight - element.scrollTop <= Math.max(0, threshold);
}
