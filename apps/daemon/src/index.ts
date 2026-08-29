export const DAEMON_VERSION = "0.1.0";

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
  DaemonRequestContext,
  DaemonRequestHandler,
  DaemonRouteHandler,
  DaemonServerOptions,
  ReadinessReport,
} from "./server";
export {
  CONTENT_SECURITY_POLICY,
  createDaemonRequestHandler,
  createDaemonServer,
  daemonRoutes,
  isHostAllowed,
  isLoopbackBindAddress,
  SECURITY_HEADERS,
} from "./server";
