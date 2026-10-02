/** NormalizedSpec → canonical SpecInput (what `GET /graphs/{g}/spec` emits). */
import { stringify } from 'yaml';
import type { NormalizedAim, NormalizedSpec } from './normalize';
import type { SpecInput } from './schema';

function aimOut(aim: NormalizedAim): Record<string, unknown> {
  const { ...rest } = aim;
  return rest;
}

export function toSpecInput(spec: NormalizedSpec): SpecInput {
  const out: Record<string, unknown> = {
    schema: spec.schema,
    title: spec.title,
  };
  if (spec.slug) out.slug = spec.slug;
  if (spec.description) out.description = spec.description;
  if (spec.tags.length) out.tags = spec.tags;
  if (spec.repository) out.repository = spec.repository;
  if (spec.context) out.context = spec.context;
  if (spec.constraints.length) out.constraints = spec.constraints;
  out.aims = spec.aims.map(aimOut);
  const { leaseTtlSec, ...policy } = spec.policy;
  out.policy = { ...policy, leaseTtl: leaseTtlSec };
  const { leaseTtlSec: dLease, ...defaults } = spec.defaults;
  if (Object.keys(spec.defaults).length)
    out.defaults = { ...defaults, ...(dLease !== undefined ? { leaseTtl: dLease } : {}) };
  if (spec.evolution.mode !== 'off') out.evolution = spec.evolution;
  if (spec.orchestrators.length)
    out.orchestrators = spec.orchestrators.map((o) => ({ ...o, aims: o.aims.map(aimOut) }));
  out.nodes = spec.nodes.map((n) => {
    const { leaseTtlSec: lease, timeoutSec, ...rest } = n;
    return {
      ...rest,
      aims: n.aims.map(aimOut),
      leaseTtl: lease,
      ...(timeoutSec !== undefined ? { timeout: timeoutSec } : {}),
    };
  });
  if (spec.loops.length) out.loops = spec.loops;
  if (Object.keys(spec.metadata).length) out.metadata = spec.metadata;
  return out as SpecInput;
}

export function toSpecYaml(spec: NormalizedSpec): string {
  return stringify(toSpecInput(spec), { lineWidth: 100 });
}
