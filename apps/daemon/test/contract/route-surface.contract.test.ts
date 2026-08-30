import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ERROR_CODES, errorSpec } from "@sorage/core";
import { createDomainRoutes } from "../../src/domain-routes";
import { configRoutes } from "../../src/server";
import { daemonRoutes } from "../../src/server";
import { matchRoute } from "../../src/route-kit";

/**
 * The TASK-046 contracts (API-011, API-012): the HTTP status mapping is verified
 * against every row of the section 15 matrix in both directions, and the routing
 * table covers the section 18 endpoint catalog with only the documented deferrals.
 */
const docsPath = fileURLToPath(new URL("../../../../docs/interfaces-and-operations.md", import.meta.url));

function parseSection15(): Map<string, number> {
  const text = readFileSync(docsPath, "utf8");
  const section = text.slice(text.indexOf("## 15. Symbolic error codes"), text.indexOf("## 16. Exit codes"));
  const rows = new Map<string, number>();
  for (const match of section.matchAll(/^\| `([A-Z_]+)` \| (\d+) \|/gm)) {
    rows.set(match[1] as string, Number(match[2]));
  }
  return rows;
}

function parseCatalogEndpoints(): Array<{ method: string; path: string }> {
  const text = readFileSync(docsPath, "utf8");
  const section = text.slice(text.indexOf("## 18. HTTP endpoint catalog"), text.indexOf("## 19. Pagination"));
  const endpoints: Array<{ method: string; path: string }> = [];
  for (const match of section.matchAll(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/v1\/\S+)/gm)) {
    const [, method, path] = match;
    if (path === undefined || method === undefined) continue;
    if (path.includes("{handoffId}")) {
      endpoints.push({ method, path: path.replace("{handoffId}", "{id}") });
    } else if (path.includes("{projectId}")) {
      endpoints.push({ method, path: path.replace("{projectId}", "{id}") });
    } else {
      endpoints.push({ method, path });
    }
  }
  return endpoints;
}

interface FlatRoute {
  method: string;
  pattern: string;
}

const routes: FlatRoute[] = [
  ...daemonRoutes({ endpoints: { installationId: "i", version: "v" }, readiness: () => ({ ready: true }) }).map(
    (route) => ({ method: route.method, pattern: route.path }),
  ),
  ...configRoutes({}).map((route) => ({ method: route.method, pattern: route.path })),
  ...createDomainRoutes({ vaultPath: () => null, config: undefined }).map((route) => ({
    method: route.method,
    pattern: route.pattern,
  })),
  { method: "POST", pattern: "/api/v1/session" },
  { method: "POST", pattern: "/api/v1/token/rotate" },
];

/** Routes that later tasks or milestones own; the catalog row exists, the route does not yet. */
const DEFERRED = new Set<string>([]);

describe("the symbolic error to HTTP status matrix (API-011)", () => {
  it("maps every catalogue code to the status the section 15 table documents", () => {
    const documented = parseSection15();
    for (const code of ERROR_CODES) {
      const spec = errorSpec(code);
      expect(documented.has(code), `${code} has a section 15 row`).toBe(true);
      expect(spec.httpStatus, `${code} HTTP status`).toBe(documented.get(code));
    }
    expect([...documented.keys()].length).toBe(ERROR_CODES.length);
  });
});

describe("the routing table against the endpoint catalog", () => {
  it("serves every catalog endpoint of milestone 0.2 except the documented deferrals", () => {
    const catalog = parseCatalogEndpoints();
    expect(catalog.length).toBeGreaterThan(20);
    const missing = catalog.filter(({ method, path }) => {
      const key = `${method} ${path}`;
      if (DEFERRED.has(key)) return false;
      return !routes.some((route) => route.method === method && route.pattern === path);
    });
    expect(missing, "catalog endpoints without a route").toEqual([]);
  });

  it("defers exactly the documented set and nothing else", () => {
    const catalog = parseCatalogEndpoints();
    const deferred = catalog.filter(({ method, path }) => DEFERRED.has(`${method} ${path}`));
    expect(deferred.map(({ method, path }) => `${method} ${path}`).sort()).toEqual([...DEFERRED].sort());
  });

  it("registers no route that the catalog does not define", () => {
    const catalog = parseCatalogEndpoints().map(({ method, path }) => `${method} ${path}`);
    const extra = routes
      .map((route) => `${route.method} ${route.pattern}`)
      .filter(
        (key) =>
          !catalog.includes(key) &&
          key !== "POST /api/v1/session" &&
          key !== "POST /api/v1/token/rotate" &&
          !key.startsWith("GET /settings") &&
          !key.startsWith("GET /assets/") &&
          key !== "GET /",
      );
    expect(extra).toEqual([]);
  });
});

describe("the shared route and CLI table", () => {
  const pairs: Array<{ route: string; cli: string; useCase: string }> = [
    { route: "POST /api/v1/projects", cli: "sorage project add", useCase: "addProject" },
    { route: "GET /api/v1/projects", cli: "sorage project list", useCase: "listProjects" },
    { route: "GET /api/v1/projects/{id}", cli: "sorage project show", useCase: "showProject" },
    { route: "PATCH /api/v1/projects/{id}", cli: "sorage project rename", useCase: "renameProject" },
    { route: "POST /api/v1/projects/{id}/archive", cli: "sorage project archive", useCase: "archiveProject" },
    { route: "POST /api/v1/projects/{id}/bindings", cli: "sorage project bind", useCase: "bindProject" },
    {
      route: "DELETE /api/v1/projects/{id}/bindings/{bindingId}",
      cli: "sorage project unbind",
      useCase: "unbindProject",
    },
    { route: "POST /api/v1/handoffs/import-path", cli: "sorage send", useCase: "sendHandoffs" },
    { route: "GET /api/v1/handoffs", cli: "sorage inbox / outbox", useCase: "listInbox / listOutbox" },
    { route: "GET /api/v1/handoffs/{id}", cli: "sorage get", useCase: "getHandoff" },
    { route: "GET /api/v1/handoffs/{id}/artifact/content", cli: "sorage fetch", useCase: "fetchHandoff" },
    { route: "PUT /api/v1/handoffs/{id}/review-note", cli: "sorage review set", useCase: "setReviewNote" },
    { route: "DELETE /api/v1/handoffs/{id}/review-note", cli: "sorage review remove", useCase: "removeReviewNote" },
    {
      route: "POST /api/v1/handoffs/{id}/review-note/withdraw",
      cli: "sorage review withdraw",
      useCase: "withdrawReviewNote",
    },
    { route: "POST /api/v1/handoffs/{id}/revise", cli: "sorage revise", useCase: "reviseHandoff" },
    { route: "POST /api/v1/handoffs/{id}/accept", cli: "sorage accept", useCase: "acceptHandoff" },
    { route: "POST /api/v1/handoffs/{id}/decline", cli: "sorage decline", useCase: "declineHandoff" },
    { route: "POST /api/v1/handoffs/{id}/withdraw", cli: "sorage withdraw", useCase: "withdrawHandoff" },
    { route: "POST /api/v1/handoffs/{id}/pin", cli: "sorage pin", useCase: "pinHandoff" },
    { route: "POST /api/v1/handoffs/{id}/archive", cli: "sorage archive", useCase: "archiveHandoff" },
    { route: "POST /api/v1/handoffs/{id}/deletion-request", cli: "sorage delete request", useCase: "requestDeletion" },
    { route: "POST /api/v1/handoffs/{id}/deletion-approve", cli: "sorage delete approve", useCase: "approveDeletion" },
    { route: "POST /api/v1/handoffs/{id}/deletion-reject", cli: "sorage delete reject", useCase: "rejectDeletion" },
    { route: "GET /api/v1/config", cli: "sorage config show", useCase: "showConfiguration" },
    { route: "PUT /api/v1/config", cli: "sorage config set", useCase: "setConfigurationValue" },
    { route: "POST /api/v1/token/rotate", cli: "sorage token rotate", useCase: "rotateApiToken" },
  ];

  it("pairs every route with the CLI command and core use case that owns it", () => {
    for (const pair of pairs) {
      const [method, path] = pair.route.split(" ") as [string, string];
      const [m, p] = [method, path];
      expect(
        routes.some((route) => route.method === m && route.pattern === p),
        `${pair.route} is routed`,
      ).toBe(true);
    }
    expect(pairs.length).toBeGreaterThanOrEqual(26);
  });
});
