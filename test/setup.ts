// Preloaded before every test file (bunfig.toml). The suite gets its own HOME and omp agent
// directory before omp's modules load, so omp's discovery never sees this machine's user-level
// skills or settings, and omp's logs go to a temporary directory. A hook registered here runs once,
// after the last test file.
import { afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sg-home-"));
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = path.join(home, ".omp", "agent");
for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) delete process.env[key];
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
