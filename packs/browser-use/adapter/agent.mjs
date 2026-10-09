import {accessSync, constants, existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('./node_modules/agent-browser/bin/', import.meta.url));

// Resolve only the pinned dependency, never an unrelated global agent-browser.
// The official JS entrypoint remains the fallback on unsupported/musl targets.
export function agentInvocation(args, {directory=bin, platform=process.platform, arch=process.arch, musl=platform==='linux' && (existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1'))}={}) {
  const native = join(directory, `agent-browser-${platform}${musl ? '-musl' : ''}-${arch}${platform==='win32' ? '.exe' : ''}`);
  if (['darwin','linux','win32'].includes(platform) && ['arm64','x64'].includes(arch)) {
    try { accessSync(native, constants.X_OK); return {program:native,args}; } catch {}
  }
  return {program:process.execPath,args:[join(directory,'agent-browser.js'),...args]};
}
export function agent(args, options) {
  const call = agentInvocation(args);
  return exec(call.program, call.args, {...options, windowsHide:true});
}
