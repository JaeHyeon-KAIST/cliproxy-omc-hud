#!/usr/bin/env node

/**
 * cliproxy-usage.mjs
 *
 * OMC HUD rateLimitsProvider script.
 * Always returns immediately from cache. When cache is expired,
 * spawns a detached background fetcher (cliproxy-fetcher.mjs)
 * that survives HUD timeout and writes fresh data for the next call.
 *
 * Usage: node cliproxy-usage.mjs
 * Config: settings.json → omcHud.rateLimitsProvider.command
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const HUD_CONFIG_PATH = join(import.meta.dirname, 'hud-config.json');
const FETCHER_PATH = join(import.meta.dirname, 'cliproxy-fetcher.mjs');
const CACHE_PATH = join(tmpdir(), 'cliproxy-usage-cache.json');
const STALE_MAX_MS = 30 * 60 * 1000; // 30 min max for stale display

// --- HUD config ---

async function loadHudConfig() {
  try {
    return JSON.parse(await readFile(HUD_CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function applyHudConfig(buckets, config) {
  const hidden = new Set(config.hidden ?? []);
  let filtered = buckets.filter((b) => !hidden.has(b.id));

  const labels = config.labels ?? {};
  const showResetTime = config.showResetTime === true;
  const resetTimeThreshold = config.resetTimeThreshold ?? 80;
  const resetTimeRemainingMinutes = config.resetTimeRemainingMinutes ?? 0;

  for (const b of filtered) {
    if (labels[b.id]) b.label = labels[b.id];
    if (b.resetsAt && !showResetTime) {
      const pct = b.usage?.type === 'percent' ? b.usage.value : 0;
      const showByUsage = pct >= resetTimeThreshold;
      const remainingMin = (new Date(b.resetsAt) - Date.now()) / 60000;
      const showByTime = resetTimeRemainingMinutes > 0 && remainingMin <= resetTimeRemainingMinutes;
      if (!showByUsage && !showByTime) delete b.resetsAt;
    }
  }

  const order = config.order;
  if (Array.isArray(order) && order.length > 0) {
    const orderMap = new Map(order.map((id, i) => [id, i]));
    filtered.sort((a, b) => {
      const ai = orderMap.get(a.id) ?? Infinity;
      const bi = orderMap.get(b.id) ?? Infinity;
      return ai - bi;
    });
  }

  return filtered;
}

// --- Cache read ---

function readCache(raw, maxAgeMs) {
  try {
    const cache = JSON.parse(raw);
    if (Date.now() - cache.timestamp < maxAgeMs) return cache.buckets;
  } catch {}
  return null;
}

// --- Main ---

async function main() {
  const hudConfig = await loadHudConfig();
  const cacheTtlMs = (hudConfig.cacheTtlMinutes ?? 5) * 60 * 1000;
  const refreshThresholdMs = (hudConfig.cacheRefreshThresholdMinutes ?? 2) * 60 * 1000;

  let raw;
  try {
    raw = await readFile(CACHE_PATH, 'utf-8');
  } catch {
    raw = null;
  }

  // Check if cache is fresh
  let buckets = null;
  let needsRefresh = true;

  if (raw) {
    try {
      const cache = JSON.parse(raw);
      const elapsed = Date.now() - cache.timestamp;
      const remaining = cacheTtlMs - elapsed;
      if (remaining > refreshThresholdMs) {
        buckets = cache.buckets;
        needsRefresh = false;
      } else if (elapsed < STALE_MAX_MS) {
        // Stale but usable — return it while fetcher refreshes
        buckets = cache.buckets;
      }
    } catch {}
  }

  // Spawn background fetcher if refresh needed
  if (needsRefresh) {
    const child = spawn('node', [FETCHER_PATH], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }

  // Output
  process.stdout.write(JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    buckets: applyHudConfig(buckets ?? [], hudConfig),
  }));
}

main().catch((err) => {
  process.stderr.write(`cliproxy-usage error: ${err.message}\n`);
  process.stdout.write(JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), buckets: [] }));
});
