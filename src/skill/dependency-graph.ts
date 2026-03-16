import { getLogger } from '../core/logger.js';
import type { SkillSpec, RequestChain } from './types.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

interface DependencyEdge {
  from: string; // skill ID
  to: string;   // skill ID
  reason: 'chain_ref' | 'shared_auth';
}

export interface SkillDependencyGraph {
  edges: DependencyEdge[];
  adjacency: Map<string, string[]>; // from -> [to]
  reverseAdjacency: Map<string, string[]>; // to -> [from] (dependents)
}

// ─── Graph Construction ─────────────────────────────────────────

/**
 * Build a dependency graph from a list of skills.
 *
 * Edge inference rules:
 * 1. Chain references: if skill A's chainSpec references skill B via skillRef, A depends on B
 * 2. Shared auth: skills on the same site share auth dependencies
 */
export function buildDependencyGraph(skills: SkillSpec[]): SkillDependencyGraph {
  const edges: DependencyEdge[] = [];
  const adjacency = new Map<string, string[]>();
  const reverseAdjacency = new Map<string, string[]>();

  const skillIndex = new Map<string, SkillSpec>();
  for (const skill of skills) {
    skillIndex.set(skill.id, skill);
  }

  for (const skill of skills) {
    // Chain references
    if (skill.chainSpec?.steps) {
      for (const step of skill.chainSpec.steps) {
        if (step.skillRef && skillIndex.has(step.skillRef)) {
          edges.push({ from: skill.id, to: step.skillRef, reason: 'chain_ref' });

          if (!adjacency.has(skill.id)) adjacency.set(skill.id, []);
          adjacency.get(skill.id)!.push(step.skillRef);

          if (!reverseAdjacency.has(step.skillRef)) reverseAdjacency.set(step.skillRef, []);
          reverseAdjacency.get(step.skillRef)!.push(skill.id);
        }
      }
    }

    // Shared auth: skills on same site with same authType
    if (skill.authType) {
      for (const other of skills) {
        if (other.id === skill.id) continue;
        if (other.siteId === skill.siteId && other.authType === skill.authType) {
          // Only create edge in one direction (alphabetical) to avoid duplicates
          if (skill.id < other.id) {
            edges.push({ from: skill.id, to: other.id, reason: 'shared_auth' });

            if (!adjacency.has(skill.id)) adjacency.set(skill.id, []);
            adjacency.get(skill.id)!.push(other.id);

            if (!reverseAdjacency.has(other.id)) reverseAdjacency.set(other.id, []);
            reverseAdjacency.get(other.id)!.push(skill.id);
          }
        }
      }
    }
  }

  log.debug({ edges: edges.length, skills: skills.length }, 'Built skill dependency graph');
  return { edges, adjacency, reverseAdjacency };
}

// ─── Cascade Operations ─────────────────────────────────────────

/**
 * Given a broken skill, find all skills that transitively depend on it
 * and should be cascade-marked as potentially affected.
 *
 * Uses BFS from the broken skill through the reverse adjacency (dependents).
 */
export function getCascadeAffected(
  graph: SkillDependencyGraph,
  brokenSkillId: string,
): string[] {
  const affected = new Set<string>();
  const queue = [brokenSkillId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const dependents = graph.reverseAdjacency.get(current) ?? [];

    for (const dep of dependents) {
      if (!affected.has(dep) && dep !== brokenSkillId) {
        affected.add(dep);
        queue.push(dep);
      }
    }
  }

  return [...affected];
}

/**
 * Get direct dependencies of a skill (what it depends on).
 */
export function getDependencies(graph: SkillDependencyGraph, skillId: string): string[] {
  return graph.adjacency.get(skillId) ?? [];
}

/**
 * Get direct dependents of a skill (what depends on it).
 */
export function getDependents(graph: SkillDependencyGraph, skillId: string): string[] {
  return graph.reverseAdjacency.get(skillId) ?? [];
}
