import { describe, expect, it } from "vitest";
import { compileRoutes, type RouteEntryInternal } from "../../src/route-kit";

describe("compileRoutes", () => {
  const read: RouteEntryInternal = { method: "GET", pattern: "/handoffs/{id}", handler: () => undefined };
  const change: RouteEntryInternal = { method: "PATCH", pattern: "/handoffs/{id}", handler: () => undefined };
  const listing: RouteEntryInternal = { method: "GET", pattern: "/handoffs", handler: () => undefined };
  const routes = compileRoutes([read, change, listing]);

  it("matches literal and decoded parameter paths by method and segment count", () => {
    expect(routes.match("GET", "/handoffs")).toEqual({ route: listing, params: {} });
    expect(routes.match("GET", "/handoffs/a%20b")).toEqual({ route: read, params: { id: "a b" } });
    expect(routes.match("PATCH", "/handoffs/a/b")).toBeNull();
    expect(routes.match("POST", "/handoffs/a")).toBeNull();
    expect(routes.allowedMethods("/handoffs/a")).toEqual(["GET", "PATCH"]);
  });

  it("rejects malformed percent encoding for matching and method discovery", () => {
    expect(routes.match("GET", "/handoffs/%ZZ")).toBeNull();
    expect(routes.allowedMethods("/handoffs/%ZZ")).toEqual([]);
  });
});
