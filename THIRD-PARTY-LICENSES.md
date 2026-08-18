# Third-party licenses

A5E is licensed under the [Apache License 2.0](LICENSE). It depends on the following
third-party packages at runtime, each under a permissive license compatible with Apache-2.0.
MIT and ISC require preserving the original copyright/license notice in redistributions, which
this file exists to satisfy — see each package's own `LICENSE`/`package.json` under
`node_modules/` (or its npm registry page) for the full license text and copyright holders.

| Package | License |
|---|---|
| `@kubernetes/client-node` | Apache-2.0 |
| `elysia` | MIT |
| `@elysiajs/cors` | MIT |
| `jose` | MIT |
| `sshpk` | MIT |
| `yaml` | ISC |
| `undici` | MIT |
| `cron-parser` | MIT |
| `zod` | MIT |
| `zod-to-json-schema` | ISC |
| `vue` | MIT |
| `vue-router` | MIT |
| `pinia` | MIT |
| `element-plus` | MIT |
| `@element-plus/icons-vue` | MIT |
| `ansi_up` | MIT |

This list covers direct runtime dependencies declared in each package's `package.json`. It does
not enumerate the full transitive dependency tree; run `bun pm ls` or an equivalent SBOM tool for
a complete inventory if needed for a specific compliance requirement.
