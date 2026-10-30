// This entrypoint deliberately imports no I/O, client, storage or runtime code.
import { packSchema, toolCallSchema } from './schemas.generated.mjs';
export * from './types.generated.mjs';
export { packSchema, toolCallSchema };
export const MAX_INPUT_BYTES = 16 * 1024;
export const MAX_PACK_BYTES = 64 * 1024;
export const MAX_ENVELOPE_BYTES = 128 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024;
export class ContractError extends Error {
    pointer;
    code;
    constructor(pointer, code) {
        // Never echo untrusted input, credential values or event text.
        super(`Invalid Soot contract at ${pointer || '/'} (${code})`);
        this.pointer = pointer;
        this.code = code;
        this.name = 'ContractError';
    }
}
function canonical(value) {
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    if (value !== null && typeof value === 'object')
        return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
    return JSON.stringify(value);
}
const bytes = (s) => new TextEncoder().encode(s).byteLength;
const fail = (path, code) => { throw new ContractError(path, code); };
const token = (s) => s.replaceAll('~', '~0').replaceAll('/', '~1');
// Only the subset emitted by the Go authoring/wire generators is needed.
function validate(value, schema, path = '', depth = 0) {
    if (depth > 64)
        fail(path, 'nesting_limit');
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const types = typeof schema.type === 'string' ? [schema.type] : schema.type;
    if (types && !types.some(t => t === kind || (t === 'integer' && typeof value === 'number' && Number.isInteger(value))))
        fail(path, 'type');
    if ('const' in schema && schema.const !== value)
        fail(path, 'unsupported_value');
    if (schema.enum && !schema.enum.includes(value))
        fail(path, 'unsupported_value');
    if (typeof value === 'string') {
        if (schema.pattern && !new RegExp(schema.pattern).test(value))
            fail(path, 'pattern');
        if (schema.minLength !== undefined && [...value].length < schema.minLength)
            fail(path, 'min_length');
        if (schema.maxLength !== undefined && [...value].length > schema.maxLength)
            fail(path, 'max_length');
    }
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum)
            fail(path, 'minimum');
        if (schema.maximum !== undefined && value > schema.maximum)
            fail(path, 'maximum');
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems)
            fail(path, 'min_items');
        if (schema.maxItems !== undefined && value.length > schema.maxItems)
            fail(path, 'max_items');
        if (schema.uniqueItems && new Set(value.map(canonical)).size !== value.length)
            fail(path, 'unique_items');
        if (schema.items)
            value.forEach((item, i) => validate(item, schema.items, `${path}/${i}`, depth + 1));
    }
    else if (value !== null && typeof value === 'object') {
        const obj = value;
        if (schema.maxProperties !== undefined && Object.keys(obj).length > schema.maxProperties)
            fail(path, 'max_properties');
        for (const key of schema.required ?? [])
            if (!Object.hasOwn(obj, key))
                fail(`${path}/${token(key)}`, 'required');
        for (const [key, item] of Object.entries(obj)) {
            const child = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties[key] : undefined;
            if (child)
                validate(item, child, `${path}/${token(key)}`, depth + 1);
            else if (schema.additionalProperties === false)
                fail(`${path}/${token(key)}`, 'unknown_field');
            else if (typeof schema.additionalProperties === 'object')
                validate(item, schema.additionalProperties, `${path}/${token(key)}`, depth + 1);
        }
    }
}
function jsonText(value, max) {
    // Reject JS-only values rather than silently dropping/coercing them in JSON.
    const walk = (v, depth) => {
        if (depth > 64)
            fail('', 'nesting_limit');
        if (v === null || typeof v === 'string' || typeof v === 'boolean')
            return;
        if (typeof v === 'number' && Number.isFinite(v))
            return;
        if (Array.isArray(v)) {
            for (const item of v)
                walk(item, depth + 1);
            return;
        }
        if (typeof v !== 'object' || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null))
            fail('', 'non_json');
        for (const item of Object.values(v))
            walk(item, depth + 1);
    };
    walk(value, 0);
    let result;
    try {
        result = JSON.stringify(value);
    }
    catch {
        return fail('', 'non_json');
    }
    if (bytes(result) > max)
        fail('', 'byte_limit');
    return result;
}
function parse(text, max) {
    if (bytes(text) > max)
        fail('', 'byte_limit');
    try {
        return JSON.parse(text);
    }
    catch {
        return fail('', 'json');
    }
}
export function validateToolCall(value) {
    jsonText(value, MAX_ENVELOPE_BYTES);
    validate(value, toolCallSchema);
    const call = value;
    if (Object.hasOwn(call, 'input'))
        jsonText(call.input, MAX_INPUT_BYTES);
    return call;
}
export function decodeToolCall(text) {
    return validateToolCall(parse(text, MAX_ENVELOPE_BYTES));
}
export function encodeToolCall(call) {
    validateToolCall(call);
    return jsonText(call, MAX_ENVELOPE_BYTES) + '\n';
}
// Authoring shape only. soot check owns cross-file grants and semantic validation.
export function validatePack(value) {
    jsonText(value, MAX_PACK_BYTES);
    validate(value, packSchema);
    return value;
}
export function decodePack(text) { return validatePack(parse(text, MAX_PACK_BYTES)); }
export function encodeOutput(value, maxBytes = MAX_OUTPUT_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_OUTPUT_BYTES)
        fail('', 'output_limit');
    return jsonText(value, maxBytes - 1) + '\n';
}
export function decodeInput(call, decode) {
    validateToolCall(call);
    return decode(call.input);
}
