export const CLI_NAME = "sorage" as const;

export function main(): number {
  console.log(CLI_NAME);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
