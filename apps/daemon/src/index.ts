import { SORAGE_VERSION } from "@sorage/core";

/** Kept as a daemon-facing alias while the product version has one source. */
export const DAEMON_VERSION = SORAGE_VERSION;

export type {
  AuthenticatedContext,
  AuthResult,
  SessionService,
  SessionServiceOptions,
} from "./auth";
export { bearerValue, createSessionService } from "./auth";
export { serveDaemon } from "./runtime";

export type {
  DaemonConfigService,
  DaemonConfigSnapshot,
  DaemonEndpoints,
  DaemonRequestHandler,
  DaemonRouteHandler,
  DaemonServerOptions,
  ReadinessReport,
} from "./server";
export {
  createDaemonRequestHandler,
  createDaemonServer,
  daemonRoutes,
  isHostAllowed,
  isLoopbackBindAddress,
} from "./server";
export { CONTENT_SECURITY_POLICY, SECURITY_HEADERS, type DaemonRequestContext } from "./http-kit";
