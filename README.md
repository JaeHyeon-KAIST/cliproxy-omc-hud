# cliproxy-omc-hud

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Display multi-account Claude usage in OMC HUD status bar.

## Example

```
A1:35% A2:82%(1h20m) A3:4%
```

Each account shows its 5-hour usage percentage. Reset countdown appears when usage exceeds the configured threshold (default 80%).

## Prerequisites

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) — manages multiple Claude accounts locally
- [Claude Code](https://claude.ai/code) with [oh-my-claudecode (OMC)](https://github.com/Yeachan-Heo/oh-my-claudecode)
- Node.js 20.11+

## Installation

1. Clone the repo:
   ```sh
   git clone https://github.com/JaeHyeon-KAIST/cliproxy-omc-hud.git
   ```

2. Copy the example config:
   ```sh
   cp hud-config.example.json hud-config.json
   ```

3. Edit `hud-config.json` with your account identifiers (the local part of each account's email, e.g. `"myaccount"` for `myaccount@gmail.com`).

4. Add the following to `~/.claude/settings.json`:
   ```json
   "omcHud": {
     "elements": {
       "rateLimits": false
     },
     "rateLimitsProvider": {
       "type": "custom",
       "command": "node /path/to/cliproxy-omc-hud/cliproxy-usage.mjs",
       "timeoutMs": 2000
     }
   }
   ```
   Replace `/path/to/cliproxy-omc-hud` with the absolute path to this repo.

## Configuration

`hud-config.json` controls display order and visibility:

```json
{
  "order": ["account1", "account2"],
  "hidden": ["account3"],
  "labels": {
    "account1": "A1",
    "account2": "A2"
  },
  "showResetTime": false,
  "resetTimeThreshold": 80
}
```

| Field                | Type                     | Default | Description |
|----------------------|--------------------------|---------|-------------|
| `order`              | `string[]`               | `[]`    | Account IDs (email local part) in the order they appear in the HUD. Accounts not listed appear after. |
| `hidden`             | `string[]`               | `[]`    | Account IDs to suppress from the HUD entirely. |
| `labels`             | `Record<string, string>` | `{}`    | Short aliases for accounts. If not set, the email local part is used (truncated to 15 chars). |
| `showResetTime`      | `boolean`                | `false` | When `true`, always show the reset countdown for all accounts. |
| `resetTimeThreshold` | `number`                 | `80`    | When `showResetTime` is `false`, only show reset time for accounts at or above this usage %. |
| `cacheTtlMinutes`    | `number`                 | `5`     | How long (in minutes) to cache API results before refreshing. |
| `cacheRefreshThresholdMinutes` | `number`      | `2`     | If another session's cache has less than this many minutes remaining, re-fetch instead of reusing. Helps coordinate multiple Claude Code sessions. |

This file is gitignored — it stays local to your machine.

## How it works

1. `cliproxy-usage.mjs` (main) reads the cache and **returns immediately** (~50ms)
2. If cache is expired, it spawns `cliproxy-fetcher.mjs` as a **detached background process**
3. The fetcher sends a minimal Haiku probe (`max_tokens: 1`) per account directly to Anthropic
4. Reads 5-hour utilization from response headers (`anthropic-ratelimit-unified-5h-utilization`)
5. Writes results to `/tmp/cliproxy-usage-cache.json` (atomic write)
6. Next HUD call picks up the fresh data

The main script never blocks on API calls, so HUD timeout is never an issue. On failure, stale cached data (up to 30 min) is preserved instead of showing errors.

> **Note:** `rateLimits: false` hides the built-in OAuth rate limit display in OMC, since it does not work correctly with proxied accounts. This script replaces it.
