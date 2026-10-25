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
| `requests.log` | JSON lines | API requests only |
| `audit.log` | JSON lines | Management audit and legacy account changes |
| `system.log` | JSON lines | Registration, health failures, wake results and failover |
| `master.key` | 32 raw bytes | Local AES-256-GCM encryption key |

`Store.state` merges these partitions in memory for existing application code.
`documents()` separates persistent fields. Add new runtime fields to
`RUNTIME_FIELDS` so they do not leak into account definitions. Event records
never belong in the JSON documents. Updating request counters must leave
`accounts.json` and `panel.json` untouched.

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
directory while the panel is stopped, together with deployment configuration.
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

## Verification

Use temporary directories for all tests. Never inspect or mutate the operator's
real `.env` or `data/`. Test restart round trips, encrypted credentials,
partition write isolation, genuine version 1 migration, independent log
retention, partial UTF-8 append recovery, completed append replay, interrupted
migration, and damaged/missing storage without silent data loss.
