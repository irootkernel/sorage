import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { createNodeHomePaths } from "./home";
import { createNodeApiTokenStore, createNodeTokenEntropy } from "./token-store";

export function probeHealthOnce(host: string, port: number): Promise<{ installationId: string } | null> {
  return new Promise((resolve) => {
    const outgoing = httpRequest(
      { host, port, path: "/api/v1/health", method: "GET", headers: { host: `127.0.0.1:${port}` } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data?: { installationId?: string } };
            resolve(
              typeof body.data?.installationId === "string" ? { installationId: body.data.installationId } : null,
            );
          } catch {
            resolve(null);
          }
        });
      },
    );
    outgoing.setTimeout(2000, () => {
      outgoing.destroy();
      resolve(null);
    });
    outgoing.on("error", () => resolve(null));
    outgoing.end();
  });
}

export interface ConfigPutOutcome {
  ok: boolean;
  body: unknown;
}

function readApiToken(stateDir: string): string | null {
  return createNodeApiTokenStore({ stateDir, entropy: createNodeTokenEntropy() }).read();
}

/**
 * The routed configuration change (CFG-016): a GET for the ETag, then the PUT.
 * After a rotation the read half retries exactly once with a re-read token; the
 * PUT never retries, so a rotation can never cause a write to run twice (SEC-020).
 */
export function configPutOnce(
  host: string,
  port: number,
  key: string,
  value: string,
  expectedRevision?: number,
): Promise<ConfigPutOutcome | null> {
  const stateDir = join(createNodeHomePaths().stateDir);
  const token = readApiToken(stateDir);
  if (token === null) {
    return Promise.resolve({
      ok: false,
      body: { ok: false, error: { code: "TOKEN_INVALID", message: "the Installation API token is missing" } },
    });
  }
  const hostHeader = host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;
  const headersFor = (bearer: string) => ({
    host: hostHeader,
    authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
  });
  return new Promise((resolve) => {
    // Section 17.1: after a rotation the CLI retries once, and only for the
    // read half of the routed change; the PUT never retries, so a rotation can
    // never cause a write to run twice.
    const issue = (bearer: string, retried: boolean): void => {
      const getOutgoing = httpRequest(
        { host, port, path: "/api/v1/config", method: "GET", headers: headersFor(bearer) },
        (getResponse) => {
          const chunks: Buffer[] = [];
          getResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
          getResponse.on("end", () => {
            if (getResponse.statusCode === 401 && !retried) {
              const fresh = readApiToken(stateDir);
              if (fresh !== null && fresh !== bearer) {
                issue(fresh, true);
                return;
              }
            }
            if (getResponse.statusCode !== 200) {
              try {
                resolve({
                  ok: false,
                  body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                });
              } catch {
                resolve(null);
              }
              return;
            }
            const etag = String(getResponse.headers.etag ?? "");
            const putOutgoing = httpRequest(
              {
                host,
                port,
                path: "/api/v1/config",
                method: "PUT",
                headers: { ...headersFor(bearer), "if-match": etag },
              },
              (putResponse) => {
                const putChunks: Buffer[] = [];
                putResponse.on("data", (chunk: Buffer) => putChunks.push(chunk));
                putResponse.on("end", () => {
                  try {
                    resolve({
                      ok: putResponse.statusCode === 200,
                      body: JSON.parse(Buffer.concat(putChunks).toString("utf8")),
                    });
                  } catch {
                    resolve(null);
                  }
                });
              },
            );
            putOutgoing.setTimeout(5000, () => {
              putOutgoing.destroy();
              resolve(null);
            });
            putOutgoing.on("error", () => resolve(null));
            putOutgoing.end(
              JSON.stringify({ key, value, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }),
            );
          });
        },
      );
      getOutgoing.setTimeout(5000, () => {
        getOutgoing.destroy();
        resolve(null);
      });
      getOutgoing.on("error", () => resolve(null));
      getOutgoing.end();
    };
    issue(token, false);
  });
}

export function portHeldOnce(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, host, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}
