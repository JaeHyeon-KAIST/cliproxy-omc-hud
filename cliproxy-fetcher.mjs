#!/usr/bin/env node

/**
 * cliproxy-fetcher.mjs
 *
 * Background fetcher — spawned by cliproxy-usage.mjs when cache is expired.
 * Runs detached from HUD process, immune to HUD timeout.
 * Fetches all accounts via Haiku probe, writes cache, then exits.
 */

import { readdir, readFile, writeFile, rename, unlink, open, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const MAX_LABEL_LEN = 15;

const CONFIG_DIR = join(homedir(), '.cli-proxy-api');
const CACHE_PATH = join(tmpdir(), 'cliproxy-usage-cache.json');
const LOCK_PATH = CACHE_PATH + '.lock';
const FETCH_TIMEOUT_MS = 5000; // no HUD pressure, can be generous
const STALE_MAX_MS = 30 * 60 * 1000;
const LOCK_MAX_AGE_MS = 30_000; // fetcher can take longer
const MESSAGES_API = 'https://api.anthropic.com/v1/messages';
const PROBE_MODEL = 'claude-haiku-4-5';

// --- Cache ---

async function readCacheBuckets() {
  try {
    const raw = await readFile(CACHE_PATH, 'utf-8');
    const cache = JSON.parse(raw);
    if (Date.now() - cache.timestamp < STALE_MAX_MS) return cache.buckets;
  } catch {}
  return null;
}

async function writeCache(buckets) {
  const tmp = CACHE_PATH + '.' + randomBytes(4).toString('hex');
  try {
    await writeFile(tmp, JSON.stringify({ timestamp: Date.now(), buckets }), { mode: 0o600 });
    await rename(tmp, CACHE_PATH);
  } catch {
    try { await unlink(tmp); } catch {}
  }
}

// --- Lock ---

async function acquireLock() {
  try {
    const fd = await open(LOCK_PATH, 'wx');
    await fd.close();
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') {
      try {
        const s = await stat(LOCK_PATH);
        if (Date.now() - s.mtimeMs > LOCK_MAX_AGE_MS) {
          await unlink(LOCK_PATH);
          try {
            const fd2 = await open(LOCK_PATH, 'wx');
            await fd2.close();
            return true;
          } catch { return false; }
        }
      } catch {}
    }
    return false;
  }
}

async function releaseLock() {
  try { await unlink(LOCK_PATH); } catch {}
}

// --- Account discovery ---

async function loadAccounts() {
  let files;
  try {
    files = await readdir(CONFIG_DIR);
  } catch {
    return [];
  }

  const accounts = [];
  for (const file of files) {
    if (!file.startsWith('claude-') || !file.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(CONFIG_DIR, file), 'utf-8');
      const data = JSON.parse(raw);
      if (data.type !== 'claude' || !data.access_token || !data.email) continue;
      accounts.push(data);
    } catch {}
  }
  return accounts;
}

// --- Haiku probe ---

async function fetchUsage(accessToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(MESSAGES_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'h' }],
      }),
      signal: controller.signal,
    });

    const utilization = res.headers.get('anthropic-ratelimit-unified-5h-utilization');
    if (utilization === null) return null;

    const parsed = parseFloat(utilization);
    if (isNaN(parsed)) return null;

    const resetTimestamp = res.headers.get('anthropic-ratelimit-unified-5h-reset');
    let resets_at;
    if (resetTimestamp) {
      const epoch = Number(resetTimestamp);
      if (!isNaN(epoch)) resets_at = new Date(epoch * 1000).toISOString();
    }

    return { utilization: parsed * 100, resets_at };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Main ---

async function main() {
  const gotLock = await acquireLock();
  if (!gotLock) return; // another fetcher is running

  try {
    const accounts = await loadAccounts();
    if (accounts.length === 0) return;

    const oldBuckets = await readCacheBuckets();
    const oldMap = new Map((oldBuckets ?? []).map((b) => [b.id, b]));

    // Parallel fetch
    const results = await Promise.allSettled(accounts.map(async (account) => {
      const localPart = account.email.split('@')[0];
      const label = localPart.length > MAX_LABEL_LEN ? localPart.slice(0, MAX_LABEL_LEN) : localPart;
      const data = await fetchUsage(account.access_token);

      if (!data) {
        // Fallback to stale cached value
        const old = oldMap.get(localPart);
        if (old?.usage?.type === 'percent') return old;
        return { id: localPart, label, usage: { type: 'string', value: 'err' } };
      }

      const bucket = {
        id: localPart,
        label,
        usage: { type: 'percent', value: Math.round(data.utilization ?? 0) },
      };
      if (data.resets_at) bucket.resetsAt = data.resets_at;
      return bucket;
    }));

    // Retry failed
    let buckets = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failed = buckets.filter((b) => b.usage.type === 'string' && b.usage.value === 'err');
    if (failed.length > 0) {
      const failedIds = new Set(failed.map((b) => b.id));
      const retryAccounts = accounts.filter((a) => failedIds.has(a.email.split('@')[0]));
      const retryResults = await Promise.allSettled(retryAccounts.map(async (account) => {
        const localPart = account.email.split('@')[0];
      const label = localPart.length > MAX_LABEL_LEN ? localPart.slice(0, MAX_LABEL_LEN) : localPart;
        const data = await fetchUsage(account.access_token);
        if (!data) return { id: localPart, label, usage: { type: 'string', value: 'err' } };
        const bucket = { id: localPart, label, usage: { type: 'percent', value: Math.round(data.utilization ?? 0) } };
        if (data.resets_at) bucket.resetsAt = data.resets_at;
        return bucket;
      }));
      const retryMap = new Map(retryResults.filter((r) => r.status === 'fulfilled').map((r) => [r.value.id, r.value]));
      buckets = buckets.map((b) => retryMap.get(b.id) ?? b);
    }

    // Final fallback for still-failed
    buckets = buckets.map((b) => {
      if (b.usage.type === 'string' && b.usage.value === 'err') {
        const old = oldMap.get(b.id);
        if (old?.usage?.type === 'percent') return old;
      }
      return b;
    });

    await writeCache(buckets);
  } finally {
    await releaseLock();
  }
}

main().catch(() => { releaseLock().catch(() => {}); });
