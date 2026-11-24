import {
  type AppError,
  appError,
  classifyMimeType,
  err,
  type ExchangeBodyInput,
  type ExchangeBusinessInput,
  exchangeCount,
  exchangeInvalid,
  isUtf8ExactText,
  ok,
  type Result,
} from "@sorage/core";
import {
  type Actor,
  type BusinessCapture,
  type ContentCapture,
  type Context,
  storageFailure,
} from "./exchange-context";
import {
  type BoundExchangeSource,
  digestExchangeSource,
  exchangeSourceChunks,
  resolveExchangeSource,
  withExchangeSource,
} from "./exchange-sources";
import type { PreparedExchangeBody } from "./exchange-working-store";

export function captureContent(
  context: Context,
  actor: Actor,
  body: ExchangeBodyInput | { source: BoundExchangeSource; forceBinary: boolean },
  historical: boolean,
): Result<ContentCapture, AppError> {
  try {
    const maxBytes = historical ? Number.MAX_SAFE_INTEGER : context.config.artifact.maxBytes;
    let chunks: <T>(inspect: (chunks: Iterable<Uint8Array>) => T) => T;
    let textFile: boolean;
    if ("text" in body) {
      if (!isUtf8ExactText(body.text)) return err(exchangeInvalid("The body must contain exact Unicode text."));
      const bytes = Buffer.from(body.text, "utf8");
      textFile = true;
      chunks = (inspect) => inspect([bytes]);
    } else {
      const source =
        "source" in body ? body.source : resolveExchangeSource(actor.binding, context.cwd, body.file, 0, null);
      textFile =
        !("forceBinary" in body && body.forceBinary) &&
        classifyMimeType(source.relativePath) !== "application/octet-stream";
      chunks = (inspect) =>
        withExchangeSource(source, actor.binding, ({ fd, size }) =>
          inspect(exchangeSourceChunks(fd, source.offset, size)),
        );
    }
    const proof = chunks((bytes) => digestExchangeSource(bytes, maxBytes));
    const classification = textFile && proof.text ? "text" : "binary";
    return ok({
      sizeBytes: proof.sizeBytes,
      sha256: proof.sha256,
      classification,
      prepare(store, exchangeId) {
        let staged: PreparedExchangeBody | undefined;
        try {
          const prepared = chunks((bytes) => {
            const next = store.prepare({ exchangeId, classification, maxBytes, chunks: bytes });
            if (next.ok) staged = next.value;
            return next;
          });
          if (!prepared.ok) {
            if (staged) store.discard(staged);
            return prepared;
          }
          if (prepared.value.sizeBytes !== proof.sizeBytes || prepared.value.sha256 !== proof.sha256) {
            if (staged) store.discard(staged);
            return err(appError("ROW_VERSION_CONFLICT", "The Exchange source changed between capture and staging."));
          }
          return prepared;
        } catch (error) {
          if (staged) store.discard(staged);
          return err(storageFailure(error));
        }
      },
    });
  } catch (error) {
    return err(storageFailure(error));
  }
}

export function captureBusiness(
  context: Context,
  actor: Actor,
  input: ExchangeBusinessInput,
  historical: boolean,
): Result<BusinessCapture, AppError> {
  try {
    if (input.kind === "send" || input.kind === "report") {
      const content = captureContent(context, actor, input.body, historical);
      if (!content.ok) return content;
      const { sizeBytes, sha256, classification } = content.value;
      return ok({ actor, facts: { body: { sizeBytes, sha256, classification } }, content: content.value });
    }
    if (input.kind !== "material-register" || input.material.kind === "external") return ok({ actor, facts: {} });
    const { kind, path, offset, length } = input.material;
    if (!exchangeCount(offset) || (length !== null && (!exchangeCount(length) || !exchangeCount(offset + length))))
      return err(exchangeInvalid("Invalid source range."));
    const custody = resolveExchangeSource(actor.binding, context.cwd, path, offset, length);
    let content: ContentCapture | undefined;
    if (kind === "copy") {
      const captured = captureContent(context, actor, { source: custody, forceBinary: true }, historical);
      if (!captured.ok) return captured;
      content = captured.value;
    }
    let versionedObserved: { sizeBytes: number; sha256: string; observedVersion: string } | undefined;
    if (kind === "versioned") {
      versionedObserved = withExchangeSource(custody, actor.binding, ({ fd, size, observedVersion }) => ({
        ...digestExchangeSource(exchangeSourceChunks(fd, offset, size), Number.MAX_SAFE_INTEGER),
        observedVersion,
      }));
      custody.observedVersion = versionedObserved.observedVersion;
    }
    const observed = kind === "versioned" ? versionedObserved : content;
    if (kind === "live" && !historical) withExchangeSource(custody, actor.binding, () => undefined);
    return ok({
      actor,
      custody,
      ...(content === undefined ? {} : { content }),
      facts: {
        local: {
          relativePath: custody.relativePath,
          offset,
          length,
          sizeBytes: observed?.sizeBytes ?? null,
          sha256: observed?.sha256 ?? null,
        },
      },
    });
  } catch (error) {
    return err(storageFailure(error));
  }
}
