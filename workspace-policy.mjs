// Operator-controlled workspace ceiling shared by both bridge connectors.
// Each connector ships an identical copy of this file so either half installs on its own.
//
//   AGENT_BRIDGE_WORKSPACE_ROOTS  JSON array of absolute, existing directories. Default: the server
//                                 process cwd, unless that is a volume root (then it must be set).
//   AGENT_BRIDGE_ALLOW_EDITS      exactly "true" or "false". Default: false.
//
// Invalid configuration never widens access: it is reported in `errors`, and callers must refuse
// launches while errors are present.

import fs from 'node:fs';
import path from 'node:path';

export const ROOTS_ENV = 'AGENT_BRIDGE_WORKSPACE_ROOTS';
export const EDITS_ENV = 'AGENT_BRIDGE_ALLOW_EDITS';

// Absolute with an explicit drive or UNC share on Windows; rejects drive-relative forms like "\\x" or "C:x".
export function isFullyAbsolute(p) {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) return false;
  if (process.platform === 'win32') return /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/?.][^\\/]*[\\/][^\\/]+)/.test(p);
  return path.isAbsolute(p);
}

// Canonical (symlink/junction-free) directory path, or null when missing or not a directory.
export function canonicalDir(p) {
  let real;
  try { real = fs.realpathSync.native(p); } catch { return null; }
  try { return fs.statSync(real).isDirectory() ? real : null; } catch { return null; }
}

export function isVolumeRoot(p) {
  return path.dirname(p) === p;
}

export function isWithin(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false; // different drive or share
  return rel !== '..' && !rel.startsWith('..' + path.sep);
}

export function loadWorkspacePolicy({ env = process.env, cwd = process.cwd() } = {}) {
  const errors = [];

  let allowEdits = false;
  const rawEdits = env[EDITS_ENV];
  if (rawEdits !== undefined) {
    if (rawEdits === 'true') allowEdits = true;
    else if (rawEdits !== 'false') errors.push(`${EDITS_ENV}=${JSON.stringify(rawEdits)} must be exactly "true" or "false"`);
  }

  const roots = [];
  let source = 'env';
  const rawRoots = env[ROOTS_ENV];
  if (rawRoots === undefined) {
    source = 'server-cwd';
    const real = canonicalDir(cwd);
    if (!real) errors.push(`server working directory ${JSON.stringify(cwd)} is not an accessible directory; set ${ROOTS_ENV}`);
    else if (isVolumeRoot(real)) errors.push(`server working directory ${JSON.stringify(real)} is a volume root; set ${ROOTS_ENV} to explicit workspace directories`);
    else roots.push(real);
  } else {
    let parsed;
    try { parsed = JSON.parse(rawRoots); } catch { parsed = undefined; }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      errors.push(`${ROOTS_ENV} must be a non-empty JSON array of absolute directory paths`);
    } else {
      for (const entry of parsed) {
        if (!isFullyAbsolute(entry)) { errors.push(`${ROOTS_ENV} entry ${JSON.stringify(entry)} must be an absolute path`); continue; }
        const real = canonicalDir(entry);
        if (!real) { errors.push(`${ROOTS_ENV} entry ${JSON.stringify(entry)} is not an existing directory`); continue; }
        if (!roots.includes(real)) roots.push(real);
      }
    }
  }

  return { roots: errors.length ? [] : roots, allowEdits: errors.length ? false : allowEdits, source, errors };
}

// Returns the canonical directory for `p` if it is an existing directory contained (after resolving
// symlinks and junctions) in one of the policy roots. Throws otherwise.
export function resolveWorkspaceDir(policy, p, label = 'cwd') {
  if (policy.errors.length) {
    throw new Error(`Workspace policy is invalid (${policy.errors.join('; ')}); launches are refused until it is fixed.`);
  }
  if (!isFullyAbsolute(p)) throw new Error(`'${label}' must be an absolute directory path.`);
  const real = canonicalDir(p);
  if (!real) throw new Error(`'${label}' is not an existing directory: ${p}`);
  if (!policy.roots.some((root) => isWithin(root, real))) {
    const error = new Error(`'${label}' resolves to ${real}, which is outside the workspace roots (${policy.roots.join(', ')}). Set ${ROOTS_ENV} on the host to widen them.`);
    error.code = 'workspace_outside_roots';
    throw error;
  }
  return real;
}

export function describeWorkspacePolicy(policy) {
  return {
    roots: policy.roots,
    roots_source: policy.source,
    allow_edits: policy.allowEdits,
    errors: policy.errors.length ? policy.errors : undefined,
  };
}
