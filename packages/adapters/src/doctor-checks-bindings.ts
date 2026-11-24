import type { CheckOutcome } from "@sorage/core";
import type { BindingRow, DoctorContext } from "./doctor-context";
import { ok, warning } from "./doctor-recoveries";

export const bindingsDoctorChecks: Record<
  "bindings.exist" | "bindings.nested" | "bindings.ambiguous",
  (context: DoctorContext) => CheckOutcome
> = {
  "bindings.exist"(context) {
    const registry = context.bindingRegistry();
    if (registry === "unavailable")
      return warning("Project bindings cannot be verified because the database history could not be inspected.");
    if (registry === null) return ok("No Project bindings are recorded yet on this installation.");
    const { projects, bindings } = registry;
    const boundProjectIds = new Set(bindings.map((binding) => binding.project_id));
    const slugByProjectId = new Map(projects.map((project) => [project.id, project.slug]));
    const problems: string[] = [];
    for (const project of projects) {
      if (project.status !== "active") continue;
      if (!boundProjectIds.has(project.id)) {
        problems.push(`Project '${project.slug}' has no directory binding on this installation.`);
      }
    }
    for (const binding of bindings) {
      const stats = context.statDirectory(binding.directory);
      if (!stats?.isDirectory()) {
        const slug = slugByProjectId.get(binding.project_id) ?? binding.project_id;
        problems.push(`Project '${slug}' binding '${binding.directory}' no longer exists.`);
      }
    }
    if (problems.length > 0) return warning(problems.join(" "));
    return ok("Every active Project has a binding and every binding directory exists.");
  },

  "bindings.nested"(context) {
    const registry = context.bindingRegistry();
    if (registry === "unavailable")
      return warning("Project bindings cannot be verified because the database history could not be inspected.");
    if (registry === null) return ok("No Project bindings are recorded yet on this installation.");
    const { projects, bindings } = registry;
    const slugByProjectId = new Map(projects.map((project) => [project.id, project.slug]));
    const indexed = bindings
      .filter((binding) => binding.binding_kind === "directory")
      .map((binding, idx) => ({ binding, idx, segments: binding.directory.split("/") }));
    // Path-segment sort guarantees every directory immediately precedes all
    // descendants without ASCII sibling traps (e.g. `'-' < '/'` putting
    // `/a-other` between `/a` and `/a/b`).
    indexed.sort((a, b) => {
      const len = Math.min(a.segments.length, b.segments.length);
      for (let k = 0; k < len; k++) {
        const sa = a.segments[k] as string;
        const sb = b.segments[k] as string;
        if (sa < sb) return -1;
        if (sa > sb) return 1;
      }
      return a.segments.length - b.segments.length || a.idx - b.idx;
    });
    const stack: typeof indexed = [];
    const emitted: Array<{ innerIdx: number; outerIdx: number; message: string }> = [];
    for (const current of indexed) {
      while (stack.length > 0) {
        const top = stack[stack.length - 1] as (typeof indexed)[number];
        if (
          current.binding.directory === top.binding.directory ||
          current.binding.directory.startsWith(`${top.binding.directory}/`)
        ) {
          break;
        }
        stack.pop();
      }
      for (const outer of stack) {
        if (outer.binding.id === current.binding.id || outer.binding.directory === current.binding.directory) {
          continue;
        }
        if (current.binding.directory.startsWith(`${outer.binding.directory}/`)) {
          const innerSlug = slugByProjectId.get(current.binding.project_id) ?? current.binding.project_id;
          const outerSlug = slugByProjectId.get(outer.binding.project_id) ?? outer.binding.project_id;
          emitted.push({
            innerIdx: current.idx,
            outerIdx: outer.idx,
            message: `'${current.binding.directory}' (${innerSlug}) is nested inside '${outer.binding.directory}' (${outerSlug}); the deepest match wins`,
          });
        }
      }
      stack.push(current);
    }
    emitted.sort((a, b) => a.innerIdx - b.innerIdx || a.outerIdx - b.outerIdx);
    if (emitted.length > 0) return warning([...new Set(emitted.map((entry) => entry.message))].join(" "));
    return ok("No directory binding is nested inside another.");
  },

  "bindings.ambiguous"(context) {
    const registry = context.bindingRegistry();
    if (registry === "unavailable")
      return warning("Project bindings cannot be verified because the database history could not be inspected.");
    if (registry === null) return ok("No Project bindings are recorded yet on this installation.");
    const { projects, bindings } = registry;
    const slugByProjectId = new Map(projects.map((project) => [project.id, project.slug]));
    type IndexedBinding = { binding: BindingRow; idx: number };
    const reachableBuckets = new Map<string, IndexedBinding[]>();
    const unreachableBuckets = new Map<string, IndexedBinding[]>();
    for (let idx = 0; idx < bindings.length; idx++) {
      const binding = bindings[idx] as BindingRow;
      const stats = context.statDirectory(binding.directory);
      if (stats !== null) {
        const key = `${binding.binding_kind}\0${stats.dev}:${stats.ino}`;
        const bucket = reachableBuckets.get(key);
        if (bucket !== undefined) bucket.push({ binding, idx });
        else reachableBuckets.set(key, [{ binding, idx }]);
      } else {
        const key = `${binding.binding_kind}\0${binding.directory}`;
        const bucket = unreachableBuckets.get(key);
        if (bucket !== undefined) bucket.push({ binding, idx });
        else unreachableBuckets.set(key, [{ binding, idx }]);
      }
    }
    const emitted: Array<{ firstIdx: number; secondIdx: number; message: string }> = [];
    for (const bucket of reachableBuckets.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          const first = bucket[i] as IndexedBinding;
          const second = bucket[j] as IndexedBinding;
          if (first.binding.project_id === second.binding.project_id) continue;
          const firstSlug = slugByProjectId.get(first.binding.project_id) ?? first.binding.project_id;
          const secondSlug = slugByProjectId.get(second.binding.project_id) ?? second.binding.project_id;
          emitted.push({
            firstIdx: first.idx,
            secondIdx: second.idx,
            message: `'${first.binding.directory}' (${firstSlug}) and '${second.binding.directory}' (${secondSlug}) alias one directory`,
          });
        }
      }
    }
    for (const bucket of unreachableBuckets.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          const first = bucket[i] as IndexedBinding;
          const second = bucket[j] as IndexedBinding;
          if (first.binding.project_id === second.binding.project_id) continue;
          emitted.push({
            firstIdx: first.idx,
            secondIdx: second.idx,
            message: `'${first.binding.directory}' cannot be physically compared while its directory is unreachable`,
          });
        }
      }
    }
    emitted.sort((a, b) => a.firstIdx - b.firstIdx || a.secondIdx - b.secondIdx);
    if (emitted.length > 0) return warning([...new Set(emitted.map((entry) => entry.message))].join(" "));
    return ok("No two bindings of the same kind alias one directory.");
  },
};
