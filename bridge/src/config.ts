/**
 * Configuration, from the environment.
 *
 * Everything has a default that works inside the Docker image: listen on 8080,
 * keep state under /data, accept clients from any origin (the tokens are the
 * access control; the origin check is for deployments that want belt and
 * braces). Only the admin token has no safe default — see `ADMIN_TOKEN` and
 * the first-start behaviour in `tokens.ts`.
 */

import { LOG_LEVELS, type LogLevel } from './log.js';

export interface BridgeConfig {
  /** TCP port to listen on. Default 8080. */
  port: number;
  /** Address to bind. Default 0.0.0.0. */
  host: string;
  /** Where `bridge.json` lives. Default /data. */
  dataDir: string;
  /**
   * The admin interface's bearer token. When unset, one is generated on first
   * start, its hash stored, and the token itself printed to the log once.
   */
  adminToken: string | undefined;
  /**
   * Origins allowed to use the WebSocket and the client API, or `['*']` for
   * any. Browsers send `Origin`; non-browser clients send none and are let
   * through — the bearer token is what admits them.
   */
  allowedOrigins: string[];
  /** PEM files; both set serves HTTPS and WSS directly. */
  tlsCertFile: string | undefined;
  tlsKeyFile: string | undefined;
  /** Milliseconds a connection may stay unauthenticated. Default 10000. */
  authTimeoutMs: number;
  /** Milliseconds to wait for a printer's port 9100 to accept. Default 5000. */
  connectTimeoutMs: number;
  /** Milliseconds to wait for an SNMP answer. Default 2000. */
  snmpTimeoutMs: number;
  /** Lowest level written to stdout; the in-memory buffer keeps every level. Default info. */
  logLevel: LogLevel;
  /** Log records kept in memory for the diagnostics bundle. Default 2000. */
  logBuffer: number;
  /** Finished print jobs kept and shown in the admin page. Default 5. */
  recentJobs: number;
  /** Milliseconds without frames after which an unreported job counts as sent. Default 3000. */
  jobIdleMs: number;
}

function integer(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${value}".`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const origins = (env.ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (origins.length === 0) origins.push('*');

  const tlsCertFile = env.TLS_CERT_FILE || undefined;
  const tlsKeyFile = env.TLS_KEY_FILE || undefined;
  if ((tlsCertFile === undefined) !== (tlsKeyFile === undefined)) {
    throw new Error('TLS_CERT_FILE and TLS_KEY_FILE must be set together.');
  }

  const logLevel = (env.LOG_LEVEL || 'info') as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${env.LOG_LEVEL}".`);
  }

  return {
    port: integer(env.PORT, 8080, 'PORT'),
    host: env.HOST || '0.0.0.0',
    dataDir: env.DATA_DIR || '/data',
    adminToken: env.ADMIN_TOKEN || undefined,
    allowedOrigins: origins,
    tlsCertFile,
    tlsKeyFile,
    authTimeoutMs: integer(env.AUTH_TIMEOUT_MS, 10_000, 'AUTH_TIMEOUT_MS'),
    connectTimeoutMs: integer(env.CONNECT_TIMEOUT_MS, 5_000, 'CONNECT_TIMEOUT_MS'),
    snmpTimeoutMs: integer(env.SNMP_TIMEOUT_MS, 2_000, 'SNMP_TIMEOUT_MS'),
    logLevel,
    logBuffer: integer(env.LOG_BUFFER, 2_000, 'LOG_BUFFER'),
    recentJobs: integer(env.RECENT_JOBS, 5, 'RECENT_JOBS'),
    jobIdleMs: integer(env.JOB_IDLE_MS, 3_000, 'JOB_IDLE_MS'),
  };
}

/** Whether a request's `Origin` header passes the allow list. */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.includes('*')) return true;
  if (origin === undefined) return true; // not a browser
  return allowed.includes(origin);
}
