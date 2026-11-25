import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { protocolVersion, RpcError } from '../mcp.mjs';

// Inherit the host's normal stdio launch environment. Callers opt into additional variables.
const baseVars = ['APPDATA', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'LOGNAME',
  'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'SHELL', 'SYSTEMDRIVE', 'SYSTEMROOT',
  'TEMP', 'TERM', 'TMP', 'TMPDIR', 'USER', 'USERNAME', 'USERPROFILE', 'WINDIR', 'XDG_CONFIG_HOME', 'NPM_CONFIG_PREFIX'];
function baseEnvironment() {
  return Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => baseVars.includes(key.toUpperCase()) && !value.startsWith('()')));
}

export class StdioClient {
  #child;
  #closed;
  #failure;
  #nextId = 1;
  #pending = new Map();
  #rpcVersion;

  constructor({ command, args, env = {}, codexAppServer = false }) {
    // Codex app-server uses the same request IDs and envelopes without a version field.
    this.#rpcVersion = codexAppServer ? undefined : '2.0';
    this.#child = spawn(command, args, {
      env: { ...baseEnvironment(), ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'],
    });
    const lines = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    const fail = error => {
      this.#failure ??= error;
      for (const request of this.#pending.values()) request.reject(this.#failure);
    };
    this.#child.on('error', fail);
    this.#child.stdin.on('error', fail);
    lines.once('close', () => fail(new Error('MCP server closed its output.')));
    this.#closed = new Promise(resolve => this.#child.once('close', resolve));
    lines.on('line', line => {
      let response;
      try { response = JSON.parse(line); }
      catch { return fail(new Error('Invalid JSON from MCP server.')); }
      const request = this.#pending.get(response?.id);
      if (!request) return;
      if (response.error) {
        const { code, message, data } = response.error;
        request.reject(new RpcError(code, message, data));
      } else if (response.jsonrpc === this.#rpcVersion && Object.hasOwn(response, 'result')) {
        request.resolve(response.result);
      } else {
        request.reject(new Error('Invalid JSON-RPC response.'));
      }
    });
  }

  #send(message) {
    this.#child.stdin.write(JSON.stringify({ jsonrpc: this.#rpcVersion, ...message }) + '\n');
  }

  notify(method, params) {
    this.#send({ method, params });
  }

  request(method, params, { signal, timeout = 60_000 } = {}) {
    if (this.#failure) return Promise.reject(this.#failure);
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const finish = callback => value => {
        this.#pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        callback(value);
      };
      const cancel = reason => {
        if (this.#rpcVersion && method !== 'initialize') this.notify('notifications/cancelled', { requestId: id });
        this.#pending.get(id).reject(reason);
      };
      const abort = () => cancel(signal.reason);
      const timer = setTimeout(() => cancel(new Error(method + ' timed out.')), timeout);
      this.#pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.#send({ id, method, params }); }
      catch (error) { this.#pending.get(id).reject(error); }
    });
  }

  async initialize(clientInfo) {
    const result = await this.request('initialize', { protocolVersion, clientInfo, capabilities: {} });
    this.notify('notifications/initialized');
    return result;
  }
  listTools() { return this.request('tools/list'); }
  callTool(params, options) { return this.request('tools/call', params, options); }

  async close() {
    this.#child.stdin.end();
    const terminate = setTimeout(() => this.#child.kill(), 2000);
    const kill = setTimeout(() => this.#child.kill('SIGKILL'), 5000);
    try { await this.#closed; }
    finally { clearTimeout(terminate); clearTimeout(kill); }
  }
}
