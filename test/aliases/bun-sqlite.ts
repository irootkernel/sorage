// Vitest alias: tests execute through Vitest's runner, which cannot resolve bun:
// schemes; Bun's node:sqlite is the same synchronous SQLite engine.
export { DatabaseSync as Database } from "node:sqlite";
