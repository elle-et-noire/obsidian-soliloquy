# Performance testing

Generate a standalone synthetic vault with 10,000 posts across 100 daily notes:

```bash
npm run benchmark:generate
```

Run the parser, reply lookup, search, and initial-render work comparison:

```bash
npm run benchmark
```

The generated vault is written to `.performance-vault` and is ignored by Git. The generator refuses to overwrite an existing directory; remove or rename the previous fixture explicitly before generating another one.

## July 13, 2026 result

The 10,000-post fixture contains 1,999 replies and a mixture of tags and tasks. A single run on the development machine produced:

| Operation | Indexed/paged | Previous implementation |
| --- | ---: | ---: |
| Cold parse of 100 daily notes | 38.48 ms | 38.48 ms |
| Warm cached retrieval | 4.21 ms | 4.21 ms |
| Reply index build | 14.11 ms | n/a |
| Look up replies for all posts | 1.95 ms | 2,463.83 ms |
| Search all posts | 4.03 ms | 4,344.37 ms |
| Initial Markdown renders | 50 | 10,000 |

The indexed operations stayed close to linear as the fixture size increased:

| Posts | Index build | Indexed reply lookup | Previous reply lookup | Indexed search | Previous search |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.84 ms | 0.27 ms | 29.54 ms | 1.16 ms | 36.62 ms |
| 5,000 | 8.02 ms | 1.32 ms | 1,099.18 ms | 1.89 ms | 916.05 ms |
| 10,000 | 14.11 ms | 1.95 ms | 2,463.83 ms | 4.03 ms | 4,344.37 ms |

These numbers are diagnostic rather than fixed CI thresholds. The automated tests enforce the structural guarantees: coalesced and serialized settings saves, indexed reply semantics, and a 10,000-post index build under one second.

Full variable-height virtualization is intentionally deferred. Initial Markdown and DOM work is bounded to 50 cards, while the remaining all-post operations complete in tens of milliseconds. Virtualization should be reconsidered if real Obsidian profiling shows scroll degradation after users load hundreds of cards in one session, especially on mobile.
