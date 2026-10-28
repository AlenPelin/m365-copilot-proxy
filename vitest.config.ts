import { configDefaults, defineConfig } from "vitest/config";

// The harness launchers keep isolated configs in the repo (.claude-local, .pi-local);
// Claude Code downloads plugins there, test files included. They aren't ours.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".claude-local/**", ".pi-local/**"],
  },
});
