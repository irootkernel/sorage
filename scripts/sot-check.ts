// scripts/sot-check enforces the Source of Truth documentation rules of this
// repository: no hard-wrapped prose, a resolvable target for every relative link,
// unique Epic and Task identifiers, no forward or self dependency, no citation of a
// requirement identifier absent from required-specification.md, no malformed or
// duplicate Task, requirement or reverse-index row, no such row with an unsupported
// milestone value, no requirement
// whose every citing Task belongs to a later milestone than the requirement itself,
// no requirement that is not Deferred with no citing Task, and a reverse index in
// traceability.md that matches the roadmap's Requirements column. The two shipped
// Exchange skills also carry exact copies of their canonical loop reference.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
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

function readExchangeSkillReference(path: string): Buffer | undefined {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) {
    fail(path, "Exchange loop reference must be a regular file");
    return undefined;
  }
  return readFileSync(path);
}

function checkExchangeSkillReferences(): void {
  const skills = join(root, "skills");
  const source = join(skills, "exchange-loop.md");
  const canonical = readExchangeSkillReference(source);
  for (const name of ["start-exchange", "join-exchange"]) {
    const directory = join(skills, name);
    const references = join(directory, "references");
    const invalidDirectory = [directory, references].find(
      (path) => !lstatSync(path, { throwIfNoEntry: false })?.isDirectory(),
    );
    if (invalidDirectory) {
      fail(invalidDirectory, "Exchange skill bundle must use local directories");
      continue;
    }
    const path = join(references, "exchange-loop.md");
    const bundled = readExchangeSkillReference(path);
    if (canonical && bundled && !canonical.equals(bundled))
      fail(path, `Exchange loop reference differs from ${source}`);
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
  ["M5", 5],
  ["M6", 6],
  ["M7", 7],
  ["M8", 8],
  ["M9", 9],
  ["M10", 10],
]);
const TASK_MILESTONES = [...MILESTONE_ORDER.keys()];
const REQUIREMENT_MILESTONES = [...TASK_MILESTONES, "Deferred"];

function expectedValues(values: string[]): string {
  return `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;
}

/**
 * Splits a table line into its trimmed cells. A Task, requirement or reverse-index
 * row is recognized by the identifier in its first cell alone; its shape, spelling
 * and remaining cells are validated afterwards, so a malformed row is reported
 * instead of disappearing from every later check.
 */
function tableRow(line: string): { cells: string[]; closed: boolean } | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return undefined;
  // As Markdown renders it, a pipe after an odd run of backslashes is cell content
  // and a pipe after an even run, including none, ends the cell.
  const parts: string[] = [];
  let current = "";
  let backslashes = 0;
  for (const char of trimmed) {
    if (char === "|" && backslashes % 2 === 0) {
      parts.push(current);
      current = "";
    } else current += char;
    backslashes = char === "\\" ? backslashes + 1 : 0;
  }
  const closed = parts.length >= 2 && current === "";
  if (!closed) parts.push(current);
  return { cells: parts.slice(1).map((cell) => cell.trim()), closed };
}

/** Returns the identifier a first cell names, whatever its code formatting or padding. */
function rowIdentifier(cell: string | undefined, pattern: string): string | undefined {
  return (cell ?? "").match(new RegExp(`^\`?\\s*(${pattern})\\s*\`?$`))?.[1];
}

const TASK_STATUSES = ["Planned", "In Progress", "In Review", "Completed", "Blocked", "Deferred"];

const REQUIREMENT_ID = "[A-Z]{3,6}-\\d{3}";
const REQUIREMENT_ITEM = `${REQUIREMENT_ID}(?: to ${REQUIREMENT_ID})?`;
const REQUIREMENT_LIST = new RegExp(`^${REQUIREMENT_ITEM}(?:, ${REQUIREMENT_ITEM})*$`);
const DEPENDENCY_LIST = /^`(?:EPIC|TASK)-\d{3}`(?:, `(?:EPIC|TASK)-\d{3}`)*$/;
const CITING_TASK_LIST = /^`TASK-\d{3}`(?:, `TASK-\d{3}`)*$/;

function checkRequirementMilestone(location: string, subject: string, milestone: string): void {
  if (REQUIREMENT_MILESTONES.includes(milestone)) return;
  fail(
    location,
    `${subject} has unsupported milestone ${JSON.stringify(milestone)}; expected ${expectedValues(REQUIREMENT_MILESTONES)}`,
  );
}

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

interface Roadmap {
  epics: Map<string, number>;
  tasks: Map<string, TaskRow>;
  taskLines: Array<[string, number]>;
}

let parsedRoadmap: Roadmap | undefined;

/** Names each range whose endpoints cannot bound one requirement series. */
function invalidRanges(cell: string): string[] {
  const invalid: string[] = [];
  for (const match of cell.matchAll(/([A-Z]{3,6}-)(\d{3}) to ([A-Z]{3,6}-)(\d{3})/g)) {
    const span = Number(match[4]) - Number(match[2]);
    if (match[1] !== match[3] || span < 0 || span > 200) invalid.push(match[0]);
  }
  return invalid;
}

function parseRoadmap(): Roadmap {
  // Identifier and traceability checks both need the rows; parse once so a row's
  // violation is reported once.
  if (parsedRoadmap !== undefined) return parsedRoadmap;
  const roadmapPath = join(root, "docs", "roadmap", "README.md");
  const lines = readFileSync(roadmapPath, "utf8").split("\n");
  const epics = new Map<string, number>();
  const tasks = new Map<string, TaskRow>();
  const taskLines: Array<[string, number]> = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const match = line.match(/^\| `(EPIC-\d{3})` \|/);
    if (match !== null) {
      const id = match[1] as string;
      if (epics.has(id)) fail(`${roadmapPath}:${index + 1}`, `duplicate Epic identifier ${id}`);
      epics.set(id, index + 1);
      continue;
    }
    const row = tableRow(line);
    const id = rowIdentifier(row?.cells[0], "TASK-\\d{3}");
    if (row === undefined || id === undefined) continue;
    const location = `${roadmapPath}:${index + 1}`;
    // Roadmap task rows: | ID | Status | Milestone | Deliverable | Gate | Dependencies | Requirements | Design Gate |
    const [idCell, status = "", milestone = "", , , dependencyCell = "", requirementCell = ""] = row.cells;
    if (!row.closed || row.cells.length !== 8 || row.cells.includes("") || idCell !== `\`${id}\``) {
      fail(location, `malformed Task row for ${id}: expected eight non-empty cells starting with \`${id}\``);
      continue;
    }
    if (!TASK_STATUSES.includes(status)) {
      fail(
        location,
        `Task ${id} has invalid status ${JSON.stringify(status)}; expected ${expectedValues(TASK_STATUSES)}`,
      );
    }
    if (dependencyCell !== "None" && !DEPENDENCY_LIST.test(dependencyCell)) {
      fail(
        location,
        `Task ${id} has a malformed Dependencies cell; expected None or code-formatted Epic and Task identifiers`,
      );
    }
    if (requirementCell !== "None" && !REQUIREMENT_LIST.test(requirementCell)) {
      fail(
        location,
        `Task ${id} has a malformed Requirements cell; expected None or requirement identifiers and ranges`,
      );
    }
    for (const range of invalidRanges(requirementCell)) {
      fail(location, `Task ${id} cites the invalid requirement range ${JSON.stringify(range)}`);
    }
    if (tasks.has(id)) {
      // Keep the first occurrence so its dependency and citation diagnostics survive.
      fail(location, `duplicate Task identifier ${id}`);
    } else {
      tasks.set(id, {
        id,
        milestone,
        dependencies: dependencyCell.match(/(EPIC|TASK)-\d{3}/g) ?? [],
        requirements: expandRanges(requirementCell),
        line: index + 1,
      });
    }
    taskLines.push([id, index + 1]);
  }
  parsedRoadmap = { epics, tasks, taskLines };
  return parsedRoadmap;
}

let parsedRequirements: Map<string, string> | undefined;

function parseRequirements(): Map<string, string> {
  const specPath = join(root, "docs", "specs", "required-specification.md");
  // Both identifier and traceability checks need the rows; parse once so a row's
  // milestone violation is reported once.
  if (parsedRequirements !== undefined) return parsedRequirements;
  const requirements = new Map<string, string>();
  parsedRequirements = requirements;
  const lines = readFileSync(specPath, "utf8").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const row = tableRow(lines[index] ?? "");
    const id = rowIdentifier(row?.cells[0], REQUIREMENT_ID);
    if (row === undefined || id === undefined) continue;
    const location = `${specPath}:${index + 1}`;
    // A requirement row is exactly: | ID | Milestone | Requirement |. A fourth cell
    // means an unescaped pipe cut the rendered requirement short.
    const [idCell, milestone, text = ""] = row.cells;
    if (!row.closed || idCell !== id || text === "" || row.cells.length !== 3) {
      fail(location, `malformed requirement row for ${id}: expected ${id}, a milestone, and the requirement text`);
    }
    // A row that still names its milestone stays known, so its one defect is the only diagnostic.
    if (milestone === undefined) continue;
    checkRequirementMilestone(location, `requirement ${id}`, milestone);
    if (requirements.has(id)) {
      // Keep the first definition so its citation and reverse-index diagnostics survive.
      fail(location, `duplicate requirement identifier ${id}`);
      continue;
    }
    requirements.set(id, milestone);
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
        `Task ${task.id} has invalid milestone ${JSON.stringify(task.milestone)}; expected ${expectedValues(TASK_MILESTONES)}`,
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
    const row = tableRow(line);
    const id = rowIdentifier(row?.cells[0], REQUIREMENT_ID);
    if (row === undefined || id === undefined) continue;
    const location = `${traceabilityPath}:${index + 1}`;
    // A reverse-index row is exactly: | `ID` | Milestone | Citing tasks |
    const [idCell, milestone = "", citing = ""] = row.cells;
    const citingIsExact = citing === "None" || CITING_TASK_LIST.test(citing);
    if (!row.closed || row.cells.length !== 3 || idCell !== `\`${id}\`` || !citingIsExact) {
      fail(
        location,
        `malformed reverse-index row for ${id}: expected \`${id}\`, a milestone, and None or code-formatted Task identifiers`,
      );
      continue;
    }
    checkRequirementMilestone(location, `reverse-index row ${id}`, milestone);
    if (rows.has(id)) {
      fail(location, `duplicate reverse-index row ${id}`);
      continue;
    }
    rows.set(id, { milestone, tasks: citing.match(/TASK-\d{3}/g) ?? [], line: index + 1 });
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
checkExchangeSkillReferences();

if (violations.length > 0) {
  console.error("sot-check failed:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`sot-check passed: documentation rules and identifier consistency hold across ${root}.`);
