## What does this change?

<!-- A clear description of the change and why it's needed. -->

## How was this tested?

<!-- bun test / typecheck output, manual verification steps, screenshots for UI changes. -->

## Checklist

- [ ] `bun run lint` passes
- [ ] `bun run typecheck` passes in every changed package
- [ ] `bun test` passes in every changed package
- [ ] If CRD schemas changed: ran `bun run crds:generate` and committed the regenerated
      `crds/*.yaml` and `charts/a5e/templates/crds/*.yaml`
- [ ] If RBAC changed: updated both `crds/rbac/*.yaml` and `charts/a5e/templates/rbac-*.yaml`
