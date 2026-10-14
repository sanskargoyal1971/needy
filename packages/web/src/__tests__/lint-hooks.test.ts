// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";

/**
 * The hook rules live in the root flat config, and nothing else would notice them going away:
 * the web build has not linted since Next 16 removed lint-during-build, and a deleted plugin
 * block leaves `eslint .` green. So this lints a known-bad component through the real config,
 * at a path inside the web package, and asserts the rule actually fires as an error.
 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const filePath = `${repoRoot}packages/web/src/components/__lint_probe__.tsx`;

async function lint(source: string) {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages;
}

describe("web lint — hook rules", () => {
  it("rejects a hook called conditionally, as an error rather than a warning", async () => {
    const messages = await lint(`
      import { useState } from "react";
      export function Probe({ on }: { on: boolean }) {
        if (on) {
          const [n] = useState(0);
          return <p>{n}</p>;
        }
        return null;
      }
    `);
    const hit = messages.find((m) => m.ruleId === "react-hooks/rules-of-hooks");
    expect(hit, JSON.stringify(messages)).toBeDefined();
    expect(hit?.severity).toBe(2);
  });

  it("accepts the same hook called unconditionally", async () => {
    const messages = await lint(`
      import { useState } from "react";
      export function Probe({ on }: { on: boolean }) {
        const [n] = useState(0);
        return on ? <p>{n}</p> : null;
      }
    `);
    expect(messages.filter((m) => m.severity === 2)).toEqual([]);
  });
});
