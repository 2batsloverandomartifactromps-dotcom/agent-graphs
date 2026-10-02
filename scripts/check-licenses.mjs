#!/usr/bin/env node
/**
 * License gate. Enforces docs/licensing.md:
 *   - shipped policy for production dependencies (anything we distribute)
 *   - build-time policy for every installed dependency (dev tooling included)
 * Exits 1 on any disallowed or unknown license. Prints `license_violations=<n>` so agents can
 * report it as a metric.
 *
 * Usage: node scripts/check-licenses.mjs [--verbose]
 */
import { execFileSync } from 'node:child_process';

const verbose = process.argv.includes('--verbose');

/** Permissive licenses allowed in anything we ship. */
const SHIPPED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'Zlib',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Python-2.0',
]);

/** Extra licenses allowed only for unmodified, never-distributed build tooling and data. */
const BUILD_ONLY = new Set(['MPL-2.0', 'CC-BY-4.0']);

/** Fonts bundled into the web UI may be OFL-1.1 (bundling and commercial use permitted). */
const isFontPackage = (name) => name.startsWith('@fontsource');

/**
 * Reviewed exceptions: package name → { license, reason }. Every entry needs a written reason.
 * Use this for packages whose license field is non-SPDX but whose actual license was verified.
 */
const EXCEPTIONS = {};

function listLicenses(args) {
  const out = execFileSync('pnpm', ['licenses', 'list', '--json', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const byLicense = JSON.parse(out || '{}');
  const packages = [];
  for (const [license, entries] of Object.entries(byLicense)) {
    for (const entry of entries) {
      for (const version of entry.versions) packages.push({ name: entry.name, version, license });
    }
  }
  return packages;
}

/** Tiny SPDX expression evaluator: WITH binds tightest, then AND, then OR. */
function evaluate(expression, isAllowed) {
  const tokens = expression
    .replace(/[()]/g, (p) => ` ${p} `)
    .trim()
    .split(/\s+/);
  let index = 0;
  const peek = () => tokens[index];
  const next = () => tokens[index++];

  function primary() {
    const token = next();
    if (token === undefined) throw new Error(`Unexpected end of license expression: ${expression}`);
    if (token === '(') {
      const value = orExpr();
      if (next() !== ')') throw new Error(`Unbalanced parentheses: ${expression}`);
      return value;
    }
    // "X WITH some-exception": exceptions only add permissions, so judge the base license.
    if (peek() === 'WITH') {
      next();
      next();
    }
    return isAllowed(token.replace(/\+$/, ''));
  }
  function andExpr() {
    let value = primary();
    while (peek() === 'AND') {
      next();
      value = primary() && value;
    }
    return value;
  }
  function orExpr() {
    let value = andExpr();
    while (peek() === 'OR') {
      next();
      value = andExpr() || value;
    }
    return value;
  }

  const result = orExpr();
  if (index !== tokens.length) throw new Error(`Unparsed license expression: ${expression}`);
  return result;
}

function check(packages, policyName, allowed) {
  const violations = [];
  for (const pkg of packages) {
    const exception = EXCEPTIONS[pkg.name];
    if (exception) continue;
    let ok = false;
    try {
      ok = evaluate(pkg.license, (id) => allowed(id, pkg.name));
    } catch {
      ok = false;
    }
    if (!ok) violations.push(pkg);
  }
  console.log(
    `${policyName}: ${packages.length} packages checked, ${violations.length} violation(s)`,
  );
  for (const v of violations) console.log(`  ✗ ${v.name}@${v.version}  license: ${v.license}`);
  return violations;
}

const shippedAllowed = (id, name) => SHIPPED.has(id) || (id === 'OFL-1.1' && isFontPackage(name));
const buildAllowed = (id, name) =>
  shippedAllowed(id, name) || BUILD_ONLY.has(id) || id === 'OFL-1.1';

const prod = listLicenses(['--prod']);
const all = listLicenses([]);

const shippedViolations = check(prod, 'shipped (production dependencies)', shippedAllowed);
const buildViolations = check(all, 'build-time (all dependencies)', buildAllowed);

const prodNames = new Set(prod.map((p) => p.name));
const buildOnlyInUse = all.filter(
  (p) => !prodNames.has(p.name) && !evaluate(p.license, (id, n = p.name) => shippedAllowed(id, n)),
);
if (buildOnlyInUse.length || verbose) {
  console.log('build-time-only exceptions in use (allowed; never distributed):');
  for (const p of buildOnlyInUse) console.log(`  · ${p.name}@${p.version}  ${p.license}`);
}

const total = shippedViolations.length + buildViolations.length;
console.log(`license_violations=${total}`);
if (total > 0) {
  console.error(
    '\nLicense policy violated. See docs/licensing.md (replace the dependency, or add a',
  );
  console.error(
    'reviewed entry to EXCEPTIONS in scripts/check-licenses.mjs with a written reason).',
  );
  process.exit(1);
}
