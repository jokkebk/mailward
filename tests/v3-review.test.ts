import { expect, test } from 'bun:test';

// The service fixture mocks Gmail and sets DATABASE_PATH. Keep that process
// isolated from the legacy tests, whose SQLite singleton also reads this env var.
test('v3 review service fixture', () => {
  const child = Bun.spawnSync(['bun', 'test', './tests/v3-review.case.ts'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  const output = Buffer.concat([child.stdout, child.stderr]).toString();
  expect(child.exitCode, output).toBe(0);
});
