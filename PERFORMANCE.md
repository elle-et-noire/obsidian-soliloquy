# Performance testing

Generate a standalone synthetic vault with 10,000 posts (1,999 replies, mixed tags and tasks) across 100 daily notes, then measure parsing, reply lookup, search, and initial rendering:

```bash
npm run benchmark:generate
npm run benchmark
```

The vault is written to `.performance-vault`, which Git ignores. The generator refuses to overwrite an existing directory; remove or rename the previous fixture first.

The benchmark stubs `moment`, so it does not include daily-note path detection. These numbers are diagnostic, not CI thresholds. The automated tests enforce the structural guarantees: coalesced and serialized settings saves, indexed reply semantics, and a 10,000-post index build under one second.

## Results

Single runs on the development machine with the 10,000-post fixture.

### Timeline snapshot (November 16, 2026)

The service caches the sorted posts and their index until a post changes, and every open display shares that snapshot. Vault events notify displays only when a note's posts changed, so edits outside the timeline section and the plugin's own writes do not re-render.

| Operation | Result |
| --- | ---: |
| Cold load (100 reads, sort, index) | 60.95 ms |
| Repeated retrieval without changes | 0.04 ms, 0 reads |
| Retrieval after editing one post | 19.96 ms, 1 read |

### Reply index and search (July 13, 2026)

Compared with the earlier per-post scan:

| Posts | Index build | Reply lookup (all posts) | Search (all posts) | Previous reply lookup | Previous search |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.84 ms | 0.27 ms | 1.16 ms | 29.54 ms | 36.62 ms |
| 5,000 | 8.02 ms | 1.32 ms | 1.89 ms | 1,099.18 ms | 916.05 ms |
| 10,000 | 14.11 ms | 1.95 ms | 4.03 ms | 2,463.83 ms | 4,344.37 ms |

Initial rendering is limited to 50 Markdown cards instead of all 10,000.

## Deferred: virtualization

Full variable-height virtualization is intentionally deferred. Initial Markdown and DOM work is bounded to 50 cards, and the remaining all-post operations complete in tens of milliseconds. Reconsider it if profiling in Obsidian shows scroll degradation after loading hundreds of cards, especially on mobile.
