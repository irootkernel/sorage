import {
  addProject,
  appError,
  archiveProject,
  bindProject,
  listProjects,
  renameProject,
  resolveWorkspaceActor,
  showProject,
  unarchiveProject,
  unbindProject,
} from "@sorage/core";
import { readJsonBody, respond, respondError } from "../http-kit";
import type { RouteContext } from "./context";
import type { RouteEntryInternal } from "../route-kit";

export function createProjectRoutes(context: RouteContext): RouteEntryInternal[] {
  const { userHome, withPorts, createNodeProjectPorts, refreshBoundMarker, resolveActor } = context;
  const routes: RouteEntryInternal[] = [];
  const add = (entry: RouteEntryInternal) => routes.push(entry);

  // ---- Projects ------------------------------------------------------------
  add({
    method: "GET",
    pattern: "/api/v1/projects",
    handler: async (_request, response, context) => {
      const result = withPorts(createNodeProjectPorts(), (ports) => listProjects(ports));
      return void respond(response, context, result);
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/projects",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const actor = await resolveActor(body);
      if (!actor.ok) return void respond(response, context, actor);
      const result = withPorts(createNodeProjectPorts(), (ports) =>
        addProject(ports, {
          name: String(body.name ?? ""),
          ...(typeof body.slug === "string" ? { slug: body.slug } : {}),
          dir: String(body.dir ?? ""),
          userHome,
          actor: actor.value,
        }),
      );
      if (result.ok) refreshBoundMarker(result.value.project.id);
      return void respond(response, context, result, 201);
    },
  });
  add({
    method: "GET",
    pattern: "/api/v1/projects/{id}",
    handler: async (_request, response, context) => {
      const result = withPorts(createNodeProjectPorts(), (ports) =>
        showProject(ports, (context.params?.id ?? "") as string),
      );
      return void respond(response, context, result);
    },
  });
  add({
    method: "PATCH",
    pattern: "/api/v1/projects/{id}",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const actor = await resolveActor(body);
      if (!actor.ok) return void respond(response, context, actor);
      const result = withPorts(createNodeProjectPorts(), (ports) =>
        renameProject(ports, {
          slug: (context.params?.id ?? "") as string,
          name: String(body.name ?? body.displayName ?? ""),
          actor: actor.value,
        }),
      );
      return void respond(response, context, result);
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/projects/{id}/archive",
    handler: async (_request, response, context) => {
      const result = withPorts(createNodeProjectPorts(), (ports) =>
        archiveProject(ports, {
          slug: (context.params?.id ?? "") as string,
        }),
      );
      return void respond(response, context, result);
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/projects/{id}/unarchive",
    handler: async (_request, response, context) => {
      const result = withPorts(createNodeProjectPorts(), (ports) =>
        unarchiveProject(ports, {
          slug: (context.params?.id ?? "") as string,
        }),
      );
      return void respond(response, context, result);
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/projects/{id}/bindings",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const actor = await resolveActor(body);
      if (!actor.ok) return void respond(response, context, actor);
      const result = withPorts(createNodeProjectPorts(), (ports) =>
        bindProject(ports, {
          slug: (context.params?.id ?? "") as string,
          dir: String(body.dir ?? ""),
          userHome,
          actor: actor.value,
        }),
      );
      if (result.ok) refreshBoundMarker(result.value.projectId);
      return void respond(response, context, result, 201);
    },
  });
  add({
    method: "DELETE",
    pattern: "/api/v1/projects/{id}/bindings/{bindingId}",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const actor = await resolveActor(body);
      if (!actor.ok) return void respond(response, context, actor);
      const result = withPorts(createNodeProjectPorts(), (ports) =>
        unbindProject(ports, {
          slug: (context.params?.id ?? "") as string,
          dir: url.searchParams.get("dir") ?? String(body.dir ?? ""),
          userHome,
          confirm: url.searchParams.get("confirm") === "true" || body.confirm === true,
          actor: actor.value,
        }),
      );
      return void respond(response, context, result);
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/projects/resolve",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const path = String(body.path ?? url.searchParams.get("path") ?? "");
      const as = typeof body.as === "string" ? body.as : (url.searchParams.get("as") ?? undefined);
      if (path === "" && as === undefined) {
        return void respondError(
          response,
          context,
          appError("FORBIDDEN_ACTOR", "resolve needs a path or an as=<project-slug>"),
        );
      }
      const resolved = withPorts(createNodeProjectPorts(), (ports) =>
        resolveWorkspaceActor(ports, {
          path,
          userHome,
          ...(as !== undefined ? { as } : {}),
        }),
      );
      return void respond(response, context, resolved);
    },
  });

  return routes;
}
