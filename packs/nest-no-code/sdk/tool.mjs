import { stdin, stdout, stderr } from 'node:process';
import { decodeToolCall, encodeOutput, MAX_ENVELOPE_BYTES } from './contract.mjs';
// Fixed byte bound while reading, not only after stdin has already filled memory.
export async function readToolCall(source = stdin) {
    const chunks = [];
    let size = 0;
    for await (const raw of source) {
        const chunk = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
        size += chunk.byteLength;
        if (size > MAX_ENVELOPE_BYTES)
            throw new Error('Soot tool envelope exceeds byte limit');
        chunks.push(chunk);
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return decodeToolCall(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
}
// Exit success means invocation success. A DTO receipt does not change core effects.
// Fixed diagnostic avoids leaking secrets from thrown vendor/validation errors.
export async function runTool(handler) {
    try {
        stdout.write(encodeOutput(await handler(await readToolCall())));
    }
    catch {
        stderr.write('Soot tool invocation failed\n');
        process.exitCode = 1;
    }
}
