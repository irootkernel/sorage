// scripts/sot-check enforces the Source of Truth documentation rules of this
// repository: no hard-wrapped prose, a resolvable target for every relative link,
// unique Epic and Task identifiers, no forward or self dependency, no citation of a
// requirement identifier absent from required-specification.md, no requirement
// whose every citing Task belongs to a later milestone than the requirement itself,
// no requirement that is not Deferred with no citing Task, and a reverse index in
// traceability.md that matches the roadmap's Requirements column.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = process.argv[2] ?? ".";
const violations: string[] = [];

function fail(location: string, message: string): void {
  violations.push(`${location}: ${message}`);
}

function walkFiles(dir: string, visit: (path: string) => void): void {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walkFiles(path, visit);
    else if (path.endsWith(".md")) visit(path);
  }
}

const prosePrefixes = ["#", "-", "*", "|", ">", "```", "<!--", "!["];
const numberedPattern = /^\d+\./;

function isProse(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  return !prosePrefixes.some((prefix) => trimmed.startsWith(prefix)) && !numberedPattern.test(trimmed);
}

function checkHardWrap(path: string): void {
  const lines = readFileSync(path, "utf8").split("\n");
  let inFence = false;
  let previousProse = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      previousProse = false;
      continue;
    }
    if (inFence) continue;
    const prose = isProse(line);
    if (prose && previousProse) {
      fail(`${path}:${index + 1}`, "hard-wrapped prose: one paragraph must be one source line");
    }
    previousProse = prose;
  }
}

function checkLinks(path: string): void {
  const text = readFileSync(path, "utf8");
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1];
    if (target === undefined) continue;
    if (/^[a-z]+:\/\//i.test(target) || target.startsWith("#") || target.startsWith("mailto:")) continue;
    const clean = target.split("#")[0] ?? target;
    if (clean.length === 0) continue;
    const resolved = resolve(dirname(path), clean);
    if (!existsSync(resolved)) {
      const line = text.slice(0, match.index ?? 0).split("\n").length;
      fail(`${path}:${line}`, `unresolvable relative link '${target}'`);
    }
  }
}

interface TaskRow {
  id: string;
  milestone: string;
  dependencies: string[];
  requirements: string[];
  line: number;
}

const MILESTONE_ORDER = new Map([
  ["M1", 1],
  ["M2", 2],
  ["M3", 3],
  ["M4", 4],
]);
const MILESTONE_ALT = "M[1-4]|Deferred";

/** Expands range notation like `CFG-001 to CFG-009` into the full inclusive id set. */
function expandRanges(cell: string): string[] {
  const ids = new Set<string>();
  const rangePattern = /([A-Z]{3,6}-)(\d{3}) to ([A-Z]{3,6}-)(\d{3})/g;
  let rest = cell;
  for (const match of cell.matchAll(rangePattern)) {
    const startPrefix = match[1];
    const endPrefix = match[3];
    const start = Number(match[2]);
    const end = Number(match[4]);
    if (startPrefix === undefined || endPrefix === undefined || match[2] === undefined || match[4] === undefined) {
      continue;
    }
    if (startPrefix !== endPrefix || end < start || end - start > 200) continue;
    for (let index = start; index <= end; index++) {
      ids.add(`${startPrefix}${index.toString().padStart(3, "0")}`);
    }
    rest = rest.replace(match[0], " ");
  }
  for (const id of rest.match(/[A-Z]{3,6}-\d{3}/g) ?? []) ids.add(id);
  return [...ids];
}

function parseRoadmap(): {
  epics: Map<string, number>;
  tasks: Map<string, TaskRow>;
  taskLines: Array<[string, number]>;
} {
  const roadmapPath = join(root, "docs", "roadmap", "README.md");
  const lines = readFileSync(roadmapPath, "utf8").split("\n");
  const epics = new Map<string, number>();
  const tasks = new Map<string, TaskRow>();
  const taskLines: Array<[string, number]> = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    let match = line.match(/^\| `(EPIC-\d{3})` \|/);
    if (match !== null) {
      const id = match[1] as string;
      if (epics.has(id)) fail(`${roadmapPath}:${index + 1}`, `duplicate Epic identifier ${id}`);
      epics.set(id, index + 1);
      continue;
    }
    match = line.match(/^\| `(TASK-\d{3})` \| ([^|]+) \| ([^|]+) \|/);
    if (match !== null) {
      const id = match[1] as string;
      if (tasks.has(id)) {
        // Keep the first occurrence so its dependency and citation diagnostics survive.
        fail(`${roadmapPath}:${index + 1}`, `duplicate Task identifier ${id}`);
      }
      const milestone = (match[3] ?? "").trim();
      const cells = line.split("|").map((cell) => cell.trim());
      // Roadmap task rows: | ID | Status | Milestone | Deliverable | Gate | Dependencies | Requirements | Design Gate |
      const dependencyCell = cells[6] ?? "";
      const requirementCell = cells[7] ?? "";
      if (!tasks.has(id))
        tasks.set(id, {
          id,
          milestone,
          dependencies:
            dependencyCell === "None" || dependencyCell === ""
              ? []
              : (dependencyCell.match(/(EPIC|TASK)-\d{3}/g) ?? []),
          requirements: requirementCell === "None" || requirementCell === "" ? [] : expandRanges(requirementCell),
          line: index + 1,
        });
      taskLines.push([id, index + 1]);
    }
  }
  return { epics, tasks, taskLines };
}

function parseRequirements(): Map<string, string> {
  const specPath = join(root, "docs", "specs", "required-specification.md");
  const requirements = new Map<string, string>();
  for (const match of readFileSync(specPath, "utf8").matchAll(
    new RegExp(`^\\| ([A-Z]{3,6}-\\d{3}) \\| (${MILESTONE_ALT}) \\|`, "gm"),
  )) {
    requirements.set(match[1] as string, match[2] as string);
  }
  return requirements;
}

function checkIdentifiers(): void {
  const { epics, tasks } = parseRoadmap();
  const requirements = parseRequirements();

  for (const task of tasks.values()) {
    if (!MILESTONE_ORDER.has(task.milestone)) {
      fail(
        `docs/roadmap/README.md:${task.line}`,
        `Task ${task.id} has invalid milestone ${JSON.stringify(task.milestone)}; expected M1, M2, M3, or M4`,
      );
    }
    for (const dependency of task.dependencies) {
      if (dependency === task.id) {
        fail(`docs/roadmap/README.md:${task.line}`, `Task ${task.id} depends on itself`);
        continue;
      }
      if (dependency.startsWith("TASK-")) {
        const target = tasks.get(dependency);
        if (target === undefined) {
          fail(`docs/roadmap/README.md:${task.line}`, `Task ${task.id} depends on unknown Task ${dependency}`);
        } else if (Number(target.id.slice(5)) >= Number(task.id.slice(5))) {
          fail(`docs/roadmap/README.md:${task.line}`, `Task ${task.id} depends on later or equal Task ${dependency}`);
        }
      } else if (!epics.has(dependency)) {
        fail(`docs/roadmap/README.md:${task.line}`, `Task ${task.id} depends on unknown Epic ${dependency}`);
      }
    }
    for (const requirement of task.requirements) {
      if (!requirements.has(requirement)) {
        fail(`docs/roadmap/README.md:${task.line}`, `Task ${task.id} cites unknown requirement ${requirement}`);
      }
    }
  }

  // A requirement whose every citing Task lands after its own release gate cannot be
  // satisfied at that gate.
  const citingTasks = new Map<string, TaskRow[]>();
  for (const task of tasks.values()) {
    for (const requirement of task.requirements) {
      const list = citingTasks.get(requirement) ?? [];
      list.push(task);
      citingTasks.set(requirement, list);
    }
  }
  for (const [requirement, citers] of citingTasks) {
    const milestone = requirements.get(requirement);
    if (milestone === undefined || milestone === "Deferred") continue;
    const later = (a: string, b: string): boolean =>
      (MILESTONE_ORDER.get(a) ?? Number.POSITIVE_INFINITY) > (MILESTONE_ORDER.get(b) ?? Number.POSITIVE_INFINITY);
    if (citers.every((task) => later(task.milestone, milestone))) {
      const firstCiter = citers[0];
      fail(
        `docs/roadmap/README.md:${firstCiter?.line ?? 0}`,
        `requirement ${requirement} (milestone ${milestone}) is cited only by later-milestone Tasks`,
      );
    }
  }
}

function checkTraceability(): void {
  const { tasks } = parseRoadmap();
  const requirements = parseRequirements();
  const traceabilityPath = join(root, "docs", "specs", "traceability.md");

  // The reverse index is generated from the roadmap's Requirements column, so it
  // is compared against a freshly derived index rather than trusted.
  const expected = new Map<string, string[]>();
  for (const task of tasks.values()) {
    for (const requirement of task.requirements) {
      const list = expected.get(requirement) ?? [];
      list.push(task.id);
      expected.set(requirement, list);
    }
  }

  // A requirement that is not Deferred must have at least one citing Task.
  for (const [requirement, milestone] of requirements) {
    if (milestone !== "Deferred" && !expected.has(requirement)) {
      fail(traceabilityPath, `requirement ${requirement} (milestone ${milestone}) has no citing Task`);
    }
  }

  const rows = new Map<string, { milestone: string; tasks: string[]; line: number }>();
  if (!existsSync(traceabilityPath)) {
    fail(traceabilityPath, "the traceability reverse index is absent");
    return;
  }
  const lines = readFileSync(traceabilityPath, "utf8").split("\n");
  let inReverseIndex = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.startsWith("## ")) inReverseIndex = line.startsWith("## 3.");
    if (!inReverseIndex) continue;
    const match = line.match(new RegExp(`^\\| \`([A-Z]{3,6}-\\d{3})\` \\| (${MILESTONE_ALT}) \\| (.+) \\|$`));
    if (match === null) continue;
    const id = match[1] as string;
    if (rows.has(id)) fail(`${traceabilityPath}:${index + 1}`, `duplicate reverse-index row ${id}`);
    const citing = match[3] ?? "";
    rows.set(id, {
      milestone: match[2] as string,
      tasks: citing === "None" ? [] : (citing.match(/TASK-\d{3}/g) ?? []),
      line: index + 1,
    });
  }

  for (const [id, milestone] of requirements) {
    const row = rows.get(id);
    const expectedTasks = (expected.get(id) ?? []).sort();
    if (row === undefined) {
      fail(traceabilityPath, `the reverse index is missing its row for ${id}`);
      continue;
    }
    if (row.milestone !== milestone) {
      fail(
        `${traceabilityPath}:${row.line}`,
        `reverse-index milestone ${row.milestone} for ${id} disagrees with the specification's ${milestone}`,
      );
    }
    const actual = [...row.tasks].sort();
    if (actual.join(",") !== expectedTasks.join(",")) {
      fail(
        `${traceabilityPath}:${row.line}`,
        `reverse-index citing tasks for ${id} disagree with the roadmap's Requirements column`,
      );
    }
  }
  for (const id of rows.keys()) {
    if (!requirements.has(id)) {
      fail(traceabilityPath, `reverse-index row ${id} names a requirement absent from the specification`);
    }
  }
}

const docsRoot = join(root, "docs");
walkFiles(docsRoot, (path) => {
  checkHardWrap(path);
  checkLinks(path);
});
for (const topLevel of ["README.md", "AGENTS.md"]) {
  const path = join(root, topLevel);
  if (existsSync(path)) {
    checkHardWrap(path);
    checkLinks(path);
  }
}
checkIdentifiers();
checkTraceability();

if (violations.length > 0) {
  console.error("sot-check failed:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`sot-check passed: documentation rules and identifier consistency hold across ${root}.`);
