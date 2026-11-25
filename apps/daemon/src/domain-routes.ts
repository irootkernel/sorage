import { createMemoRoutes } from "./memo-routes";
import type { RouteEntryInternal } from "./route-kit";
import { createRouteContext, type DomainRouteDeps } from "./routes/context";
import { createHandoffMutationRoutes } from "./routes/handoff-mutation-routes";
import { createHandoffReadRoutes } from "./routes/handoff-read-routes";
import { createOpsRoutes } from "./routes/ops-routes";
import { createProjectRoutes } from "./routes/project-routes";

export type { DomainRouteDeps } from "./routes/context";

export function createDomainRoutes(deps: DomainRouteDeps): RouteEntryInternal[] {
  const context = createRouteContext(deps);
  return [
    ...createProjectRoutes(context),
    ...createHandoffReadRoutes(context),
    ...createHandoffMutationRoutes(context),
    ...createOpsRoutes(),
    ...createMemoRoutes({ ...context.databaseOptions, ...(deps.memoClock ? { clock: deps.memoClock } : {}) }),
  ];
}
