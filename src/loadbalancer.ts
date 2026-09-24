import { ValidationError } from "./errors.js";
import type { AgentDescriptor, StrategyName } from "./types.js";

export type InflightLookup = (agentId: string) => number;

const STRATEGIES: readonly StrategyName[] = ["round-robin", "weighted-round-robin", "least-outstanding", "random"];

export function isStrategyName(value: unknown): value is StrategyName {
  return typeof value === "string" && (STRATEGIES as readonly string[]).includes(value);
}

/**
 * Stateless-per-call load balancer with internal rotation counters.
 * Candidates are assumed healthy and circuit-cleared; ordering matters for
 * round-robin so callers should pass registry-ordered lists.
 */
export class LoadBalancer {
  private counters = new Map<string, number>();

  pick(strategy: StrategyName, candidates: AgentDescriptor[], inflight?: InflightLookup): AgentDescriptor {
    if (!isStrategyName(strategy)) throw new ValidationError(`Unknown load-balancing strategy "${String(strategy)}"`);
    if (candidates.length === 0) throw new ValidationError("Cannot pick from an empty candidate list");
    switch (strategy) {
      case "round-robin":
        return this.roundRobin(candidates);
      case "weighted-round-robin":
        return this.weightedRoundRobin(candidates);
      case "least-outstanding":
        return this.leastOutstanding(candidates, inflight);
      case "random":
        return candidates[Math.floor(Math.random() * candidates.length)];
      default:
        return this.roundRobin(candidates);
    }
  }

  /** Fair rotation ignoring weights: every candidate is served in turn. */
  private roundRobin(candidates: AgentDescriptor[]): AgentDescriptor {
    const key = candidates.map((c) => c.id).join("|");
    const current = this.counters.get(key) ?? 0;
    const picked = candidates[current % candidates.length];
    this.counters.set(key, (current + 1) % candidates.length);
    return picked;
  }

  /** Weighted rotation: heavier agents receive proportionally more traffic. */
  private weightedRoundRobin(candidates: AgentDescriptor[]): AgentDescriptor {
    const total = candidates.reduce((sum, c) => sum + c.weight, 0);
    if (total <= 0) return this.roundRobin(candidates);
    const key = candidates.map((c) => c.id).join("|");
    let position = (this.counters.get(key) ?? 0) % total;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
    for (const candidate of candidates) {
      position -= candidate.weight;
      if (position < 0) return candidate;
    }
    return candidates[candidates.length - 1];
  }

  /** Prefers the candidate with the fewest requests currently in flight. */
  private leastOutstanding(candidates: AgentDescriptor[], inflight?: InflightLookup): AgentDescriptor {
    if (!inflight) return this.roundRobin(candidates);
    let best = candidates[0];
    let bestCount = inflight(best.id);
    for (const candidate of candidates.slice(1)) {
      const count = inflight(candidate.id);
      if (count < bestCount) {
        best = candidate;
        bestCount = count;
      }
    }
    return best;
  }
}
