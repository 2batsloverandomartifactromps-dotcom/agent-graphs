# Licensing & dependency policy

## Project license

Agent Graphs is dual-licensed under **MIT OR Apache-2.0**, at the licensee's option
(SPDX: `MIT OR Apache-2.0`). See [`LICENSE-MIT`](../LICENSE-MIT) and
[`LICENSE-APACHE`](../LICENSE-APACHE).

Why this choice:
- **Commercial use is unrestricted.** Both licenses allow use, modification, sublicensing, and
  sale, including inside closed-source products, with no copyleft obligations.
- **Licensing compatibility is as wide as possible.** MIT is compatible with essentially every
  license, including GPLv2. Apache-2.0 adds an explicit patent grant, which many companies'
  legal reviews prefer. Offering both lets every downstream user pick whichever fits.
- **The owner keeps full freedom.** As the copyright holder, the owner can also license the code
  under other terms (for example a commercial license or support agreement). Because every
  dependency is permissively licensed, nothing in the dependency tree imposes obligations on
  how the product is licensed.

> If outside contributions are accepted and you want to keep the option to relicense
> contributed code, add a CLA or require contributions under `MIT OR Apache-2.0` with a DCO
> sign-off. The current `CONTRIBUTING` note in the README asks for the latter.

## Dependency policy

### Shipped code (runtime dependencies of anything we distribute)
This covers the server, the CLI, the MCP server, the SDK, and the built web bundle. Allowed
licenses:

`MIT` · `MIT-0` · `ISC` · `BSD-2-Clause` · `BSD-3-Clause` · `0BSD` · `Apache-2.0` · `Zlib` ·
`Unlicense` · `CC0-1.0` · `BlueOak-1.0.0` · `Python-2.0` · and SPDX expressions that combine
only these (for example `MIT OR Apache-2.0`).

Fonts bundled into the UI may also be **`OFL-1.1`** (Inter, JetBrains Mono). OFL permits
bundling and commercial use; it only forbids selling the fonts on their own.

### Build-time only (devDependencies that are never distributed)
Everything above, plus:
- **`MPL-2.0`**, when used unmodified as tooling. Today that is `lightningcss`, a CSS minifier
  pulled in by Vite 8 and Tailwind v4. MPL-2.0 is a file-level copyleft that only applies when
  you distribute modified MPL files. Our build outputs are not covered, and we distribute
  nothing of it.
- **`CC-BY-4.0`** for data packages such as `caniuse-lite` (browser support data, attribution
  only).

### Never allowed (anywhere in the tree)
`GPL-*`, `AGPL-*`, `LGPL-*`, `SSPL-*`, `BUSL-*` / BSL, `EPL-*` (as a sole option), `CPAL`,
`OSL`, `EUPL`, Elastic License, the Commons Clause, any `CC-BY-NC*` / `CC-BY-ND*` / `CC-BY-SA*`,
"non-commercial" or "evaluation" licenses, and packages with **no license** or `UNLICENSED`.

For dual-licensed packages (`A OR B`), the package is allowed if at least one option is allowed.
Concretely, **`elkjs` (`EPL-2.0 OR GPL-3.0-or-later`) is rejected**, because neither option is
permissive. We use `@dagrejs/dagre` (MIT) for graph layout.

## Enforcement

- `pnpm check:licenses` runs `scripts/check-licenses.mjs`. It reads `pnpm licenses list --json`
  for production dependencies (the shipped policy) and for all dependencies (the build-time
  policy), and fails on any disallowed or unknown license. Exceptions require an entry in the
  script's reviewed `EXCEPTIONS` map, with a written reason.
- CI runs the check on every push and PR.
- **Before adding a dependency**, check its license (`npm view <pkg> license`) and its
  transitive tree. Prefer small, permissively licensed packages. Record any non-obvious choice in
  a `decision` note or in the PR.

## Notices

MIT, BSD, and Apache-2.0 require preserving copyright and license notices when distributing.
The release pipeline (M5) generates `THIRD-PARTY-NOTICES.md` from the production dependency tree
and ships it with the npm package, the Docker image, and the web bundle (served at
`/third-party-notices.txt`).
