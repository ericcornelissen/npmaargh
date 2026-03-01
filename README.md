# npmaargh

The **npm** **a**udit **a**ssistant - the "rgh" is for dramatic effect,
capturing that all-too-familiar reaction to running npm audit: "aargh!" 😩

The `npmaargh` CLI is intended to help you resolve `npm audit` reports by
showing you where in the dependency hierarchy upgrades are blocked. This is
especially helpful when `npm audit fix` doesn't just solve the problem for you.

The report can be used to report blockers upstream or write more targeted
[override] rules.

[override]: https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides

## Usage

You can either install and run:

```shell
npm install --global npmaargh
npmaargh [flags...] [target]
```

Or use `npx`:

```shell
npx npmaargh [flags...] [target]
```

For example:

```text
$ npx npmaargh --compact my-project
=== npm audit assistant ===
I'm here to help audit 'project'.

=== setup ===
Initialized.
Obtained audit report.
Analyzed audit report.

=== https://github.com/advisories/GHSA-abcd-1234-e5f6 ===
 <project>@0.4.2          # Blocker [foo@1.2.3->1.2.4]
  foo@1.2.3               # Need 1.2.4 (for bar@3.1.4)
   bar@3.0.0              # Need 3.1.4
   world@1.0.0            # Upgradable (need 1.1.1)
  hello@3.2.1             # Blocker [world@0.1.0->1.1.1 (https://github.com/he/llo/issues)]
   world@0.1.0            # Need 1.1.1
```

Let's unpack that report:

- `<project>@0.4.2` is the project we're analyzing.
- `# Blocker [foo@1.2.3->1.2.4]` indicates a change is required, namely that the
  package `foo` must be upgraded from `1.2.3` to `1.2.4`.
- `foo@1.2.3` is a direct dependency of the project that we're using at v1.2.3.
- `# Need 1.2.4 (for bar@3.1.4)` indicates we need `foo@1.2.4` so that we can
  pull in `bar@3.1.4` transitively.
- `bar@3.0.0` is a transitive dependency of the project that is currently at
  v3.0.0.
- `# Need 3.1.4` indicates we need to bump it, because of a known vulnerability.
- `world@1.0.0` is another transitive dependency of `foo@1.2.3`.
- `# Upgradable (need 1.1.1)` indicates `world` can be upgraded to v1.1.1 now.
  It might currently not be installed because of a lockfile or deduplication.
- `hello@3.2.1` is another direct dependency of the project.
- `# Blocker [world@0.1.0->1.1.1 (...)]` indicates a change is required in
  `hello` to upgrade `world` to a non-vulnerable version. A link for the bug
  tracker of `hello` is included to make it easy to report the blocker.
- `world@0.1.0` is a transitive dependency of `hello@3.2.1`.
- `# Need 1.1.1` indicates we need to bump it, because of a known vulnerability.

## License

This software is available under the `AGPL-3.0-or-later` license, see [LICENSE]
for the full license text.

[LICENSE]: ./LICENSE
