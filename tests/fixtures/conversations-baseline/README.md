# Frozen conversation producers

These repository-only snapshots preserve the original `helpers.ts`, `reads.ts` and `writes.ts` from `src/tools/conversations/` at accepted pre-domain commit `764e46695b7e936616538350b414d4f40a00811e`. That commit is provenance, not a test-time dependency.

| Snapshot | Original Git blob SHA-1 |
| --- | --- |
| `helpers.ts.txt` | `ecee0ed37ec7962494907e2b06acda5b72428fca` |
| `reads.ts.txt` | `6858229e6feb7ec6b9d8e4c9557226fa4311d98b` |
| `writes.ts.txt` | `3cea0c9a25d06375d2b4229f74ceb1ed10c8a1f9` |

The conversation suite verifies the exact bytes using Git's blob-header hash algorithm implemented with Node crypto, then rewrites imports only in a temporary execution copy to share current canonical runtime infrastructure. No Git command or historical checkout is required. `.gitattributes` disables line-ending conversion for these snapshots; their `.ts.txt` suffix prevents accidental source compilation or normal production imports.

These files are regression evidence, not maintained production implementations. Do not refresh them from current code or edit their expected hashes to make comparisons pass. Tests and these snapshots are excluded from the npm tarball.
