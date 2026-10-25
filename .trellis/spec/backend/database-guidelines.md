# Database Guidelines

The panel uses local files through `Store` and `FileStorage`, with no external
database or ORM. One panel process owns a data directory. Do not share it between
multiple processes or containers.

## Storage partitions

| File | Format | Contents |
| --- | --- | --- |
| `panel.json` | Version 2 JSON | Panel/routing settings and SSO configuration |
| `accounts.json` | Version 1 JSON | Account definitions, endpoints, routing attributes and encrypted credentials |
| `stats.json` | Version 1 JSON | Hourly/aggregate usage and account runtime, health, quota and comparison state |
| `../logs/requests.log` | JSON lines | API requests only |
| `../logs/audit.log` | JSON lines | Management audit and legacy account changes |
| `../logs/system.log` | JSON lines | Registration, health failures, wake results and failover |
| `master.key` | 32 raw bytes | Local AES-256-GCM encryption key |

`Store.state` merges these partitions in memory for existing application code.
`documents()` separates persistent fields. Add new runtime fields to
`RUNTIME_FIELDS` so they do not leak into account definitions. Event records
never belong in the JSON documents. Updating request counters must leave
`accounts.json` and `panel.json` untouched.

Data and log directories are independent. Logs default to `../logs` relative to
the data directory, or use the explicit `logDir`/`PANEL_LOG_DIR` setting. Never
configure logs inside the data directory. Docker mounts each directory
separately. Test fixtures use one temporary root with sibling `data/` and `logs/`
directories, so concurrent fixtures cannot share logs accidentally.

## Writes and recovery

`commit()` clones state, applies a mutation, persists it and only then publishes
the new state. Serialization snapshots identify changed partitions. Account
credentials and the SSO client secret are encrypted before reaching the file
storage layer or its journal. Never print the semantic snapshots: they contain
plaintext secrets in memory.

`FileStorage.write()` records a durable `store.pending` intent, applies the
operations and removes the intent. JSON replacement uses a flushed temporary
file followed by rename. Log appends record the original byte offset. Startup
recovery checks completed/partial appended bytes to avoid duplicate records.
If applying a transaction fails, further commits remain blocked until restart
recovers the pending intent. Do not delete the intent to bypass an error.

Generated directories use mode `0700`; files use `0600`. Back up the whole data
directory and log directory while the panel is stopped, together with deployment configuration.
Account data without its original `master.key` cannot recover credentials.

## Legacy migration

On startup, version 1 monolithic `panel.json` is decrypted and validated before
any migration writes. Preserve its original bytes once as `panel.json.v1.bak`.
Then transactionally write the separated documents and logs. Keep existing
credentials, account IDs, configuration, usage totals and event categories.
Legacy `account` events become audit records. Do not rewrite the legacy backup
on later starts, and do not require users to empty or manually split their data.

Missing keys, damaged JSON, unsupported versions or mismatched log categories
must fail visibly without resetting saved accounts. Never generate a replacement
master key when saved account/configuration files already exist.

Before journal recovery, migrate the three legacy `data/*.log` files into the
log directory. Write a flushed temporary copy on the destination filesystem and
rename it before unlinking the source; Docker bind mounts may be on different
filesystems. Matching source/destination bytes let an interrupted copy resume.
Different destination contents must fail without overwriting either copy.
Preserve raw bytes, including incomplete pending UTF-8 appends, until recovery.

## Verification

Use temporary directories for all tests. Never inspect or mutate the operator's
real `.env`, `data/` or `logs/`. Test restart round trips, encrypted credentials,
partition write isolation, genuine version 1 migration, independent log
retention, partial UTF-8 append recovery, completed append replay, interrupted
migration, log-directory migration/copy interruption/conflicts, pending append
recovery across that migration, custom log paths, and damaged/missing storage
without silent data loss.
