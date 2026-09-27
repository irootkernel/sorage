import { request as httpRequest } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { memoCliFixture } from "../../../cli/test/fixtures/memo-cli";
import { openNodeDaemonDatabase } from "@sorage/adapters/src/daemon-command-ports";
import {
  createNodeApiTokenStore,
  createNodeTokenEntropy,
  createNodeWebSecretStore,
} from "@sorage/adapters/src/token-store";
import type { Clock, Envelope, MemoReceipt } from "@sorage/core";
import { createSessionService } from "../../src/auth";
import { createDomainRoutes } from "../../src/domain-routes";
import { createDaemonServer } from "../../src/server";

export interface HttpResult<T = MemoReceipt> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Envelope<T>;
}
export function value<T>(result: HttpResult<T>): T {
  if (!result.body.ok) throw new Error(JSON.stringify(result.body));
  return result.body.data;
}
export function code(result: HttpResult<unknown>): string {
  if (result.body.ok) throw new Error("Expected an error response");
  return result.body.error.code;
}
export async function memoHttpFixture(clock?: Clock, cli = memoCliFixture()) {
  const previous = process.env.SORAGE_HOME;
  process.env.SORAGE_HOME = cli.home;
  const tokenStore = createNodeApiTokenStore({ stateDir: join(cli.home, "state") });
  tokenStore.ensure();
  const token = tokenStore.read() as string;
  const projectId = (cli.db.prepare("SELECT id FROM projects WHERE slug='memo'").get() as { id: string }).id;
  const otherId = (cli.db.prepare("SELECT id FROM projects WHERE slug='other'").get() as { id: string }).id;
  let db: ReturnType<typeof openNodeDaemonDatabase>;
  let server: ReturnType<typeof createDaemonServer>;
  let port = 0;
  const auth = createSessionService({
    token: tokenStore,
    webSecret: createNodeWebSecretStore({ stateDir: join(cli.home, "state"), clock: { now: () => new Date() } }),
    entropy: createNodeTokenEntropy(),
  });
  async function start() {
    port = await new Promise<number>((resolve) => {
      const probe = createNetServer();
      probe.listen(0, "127.0.0.1", () => {
        const selected = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(selected));
      });
    });
    db = openNodeDaemonDatabase(join(cli.home, "state"));
    server = createDaemonServer({
      host: "127.0.0.1",
      port,
      endpoints: { installationId: "memo-test", version: "test" },
      auth,
      domainRoutes: createDomainRoutes({
        vaultPath: () => join(cli.home, "vault"),
        config: undefined,
        database: db,
        ...(clock ? { memoClock: clock } : {}),
      }),
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  }
  async function stop() {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    db.close();
  }
  await start();
  return {
    ...cli,
    projectId,
    otherId,
    token,
    inventory: () =>
      ["project_memos", "events", "idempotency_keys"].map((table) =>
        cli.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ),
    async restart() {
      await stop();
      await start();
    },
    call<T = MemoReceipt>(
      path: string,
      options: {
        method?: string;
        body?: unknown;
        raw?: Buffer;
        chunks?: Buffer[];
        beforeEnd?: () => Promise<void>;
        headers?: Record<string, string | string[]>;
        bearer?: string | null;
      } = {},
    ): Promise<HttpResult<T>> {
      return new Promise((resolve, reject) => {
        const request = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path,
            method: options.method ?? "GET",
            headers: {
              host: `127.0.0.1:${port}`,
              ...(options.bearer === null ? {} : { authorization: `Bearer ${options.bearer ?? token}` }),
              "content-type": "application/json",
              ...options.headers,
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              try {
                resolve({
                  status: response.statusCode ?? 0,
                  headers: response.headers,
                  body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        request.on("error", reject);
        request.setTimeout(10_000, () => request.destroy(new Error("HTTP fixture timeout")));
        if (options.chunks) {
          let index = 0;
          const next = () => {
            const chunk = options.chunks?.[index++];
            if (chunk) request.write(chunk, () => setImmediate(next));
            else request.end();
          };
          next();
        } else {
          const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
          if (options.beforeEnd) {
            request.write(payload);
            void options.beforeEnd().then(() => request.end(), reject);
          } else request.end(payload);
        }
      });
    },
    async cleanup() {
      await stop();
      if (previous === undefined) delete process.env.SORAGE_HOME;
      else process.env.SORAGE_HOME = previous;
      cli.cleanup();
    },
  };
}
