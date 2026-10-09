import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { runTool } from '../sdk/tool.mjs';

// Only the host can select the file. No path, URL or command comes from input.
await runTool(async call => {
  if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input) || Object.keys(call.input).length) {
    throw new Error('Expected empty input');
  }
  const path = process.env.ROUTER_CARE_STATUS_FILE;
  if (!path || !isAbsolute(path) || resolve(path) !== path) return { error: { code: 'binding_unavailable' } };

  let file;
  let raw;
  try {
    if ((await lstat(path)).isSymbolicLink()) return { error: { code: 'invalid_status' } };
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await file.stat()).isFile()) return { error: { code: 'invalid_status' } };
    const buffer = Buffer.alloc(16 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size === buffer.length) return { error: { code: 'invalid_status' } };
    raw = buffer.subarray(0, size);
  } catch {
    return { error: { code: 'status_unavailable' } };
  } finally {
    await file?.close();
  }

  try {
    const status = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    const patterns = {
      release_source: /^(npm|github)$/,
      npm_package: /^(?:@[a-z0-9_-]+\/)?[a-z0-9_.-]*$/,
      phase: /^[a-z][a-z0-9_]*$/,
      category: /^[a-z0-9_]*$/,
      current: /^(?:\d+\.\d+\.\d+)?$/,
      latest: /^(?:\d+\.\d+\.\d+)?$/,
      checked: /^\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})$/,
      digest: /^(?:(?:[a-zA-Z0-9._:/-]+@)?sha256:[a-f0-9]{64})?$/,
    };
    if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error('Invalid status');
    const observation = {};
    for (const [field, pattern] of Object.entries(patterns)) {
      const value = status[field];
      if (typeof value !== 'string' || value.length > 256 || !pattern.test(value)) throw new Error('Invalid status');
      observation[field] = value;
    }
    if (!Number.isFinite(Date.parse(observation.checked))) throw new Error('Invalid timestamp');
    // Never publish private journal fields or arbitrary additions to the file.
    return { status: observation };
  } catch {
    return { error: { code: 'invalid_status' } };
  }
});
