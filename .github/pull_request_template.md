## Summary

- What changed and why?
- What is intentionally out of scope?

## Validation

- [ ] `npm test`
- [ ] `npm run pack:validate`
- [ ] `npm run pack:smoke`
- [ ] `npm run pack:dry-run` manifest reviewed
- [ ] Read-only or guarded live validation completed when API behavior changed

## Safety and release impact

- [ ] No credentials, private Codecks data, machine-specific paths, generated archives, or private planning material are included
- [ ] User-visible unreleased behavior is documented under `## Unreleased` in `CHANGELOG.md`
- [ ] Package version is unchanged unless this PR explicitly prepares a release
- [ ] Any tracker mutation or live integration scope was separately authorized and used only disposable fixtures
