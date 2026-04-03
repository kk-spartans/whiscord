import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import esbuild, { type Plugin, type PluginBuild } from "esbuild";

type BuildArgs = {
  outfile?: string;
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const distDir = resolve("dist");
  const bundlePath = resolve(distDir, "whiscord.bundle.mjs");
  const configPath = resolve(distDir, "whiscord.sea.json");
  const outfile = resolve(args.outfile ?? defaultOutfile());

  await mkdir(dirname(outfile), { recursive: true });
  await mkdir(distDir, { recursive: true });

  try {
    await esbuild.build({
      entryPoints: [resolve("src/main.ts")],
      outfile: bundlePath,
      bundle: true,
      format: "esm",
      minify: true,
      platform: "node",
      target: "node25",
      jsx: "automatic",
      banner: {
        js: [
          'import { createRequire as __createRequire } from "node:module";',
          "const require = __createRequire(import.meta.url);",
        ].join("\n"),
      },
      plugins: [reactDevtoolsStubPlugin()],
    });

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          main: bundlePath,
          mainFormat: "module",
          output: outfile,
          disableExperimentalSEAWarning: true,
          useSnapshot: false,
          useCodeCache: false,
          execArgvExtension: "none",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await runSeaBuild(configPath);
  } finally {
    await rm(bundlePath, { force: true });
    await rm(configPath, { force: true });
  }
}

function parseArgs(argv: string[]): BuildArgs {
  const parsed: BuildArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (!arg) {
      continue;
    }

    if (arg === "--outfile" && next) {
      parsed.outfile = next;
      index += 1;
      continue;
    }

    if (arg.startsWith("--outfile=")) {
      parsed.outfile = arg.slice("--outfile=".length);
    }
  }

  return parsed;
}

function defaultOutfile(): string {
  return process.platform === "win32" ? "dist/whiscord.exe" : "dist/whiscord";
}

function reactDevtoolsStubPlugin(): Plugin {
  return {
    name: "react-devtools-core-stub",
    setup(build: PluginBuild) {
      build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
        path: "react-devtools-core",
        namespace: "react-devtools-core-stub",
      }));

      build.onLoad({ filter: /.*/, namespace: "react-devtools-core-stub" }, () => ({
        loader: "js",
        contents: [
          "module.exports = {",
          "  initialize() {},",
          "  connectToDevTools() {},",
          "};",
        ].join("\n"),
      }));
    },
  };
}

async function runSeaBuild(seaConfigPath: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--build-sea", seaConfigPath], {
      stdio: "inherit",
    });

    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(new Error(`Node SEA build failed with exit code ${code ?? "unknown"}`));
    });
  });
}
