import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { BunPlugin } from "bun";

type BuildTarget =
  | "bun-darwin-x64"
  | "bun-darwin-arm64"
  | "bun-linux-x64"
  | "bun-linux-arm64"
  | "bun-windows-x64"
  | "bun-windows-arm64";

type BuildResult = {
  success: boolean;
  logs: unknown[];
  outputs: Array<{ path: string }>;
};

const args = parseArgs(Bun.argv.slice(2));
const distDir = resolve("dist");
const bootstrapPath = resolve(distDir, "whiscord.bootstrap.ts");
const bootstrapSourceMapPath = resolve(distDir, "whiscord.bootstrap.js.map");
const target = args.target ?? defaultTarget();
const outfile = resolve(args.outfile ?? defaultOutfile(target));
const reactDevtoolsStubPlugin = createReactDevtoolsStubPlugin();

await mkdir(dirname(outfile), { recursive: true });
await mkdir(distDir, { recursive: true });

const bundlePath = await buildBundle(distDir);
const bundleFileName = basename(bundlePath);

await Bun.write(
  bootstrapPath,
  [
    `import appPath from "./${bundleFileName}" with { type: "file" };`,
    "",
    "void (async () => {",
    "  try {",
    "    await import(appPath);",
    "  } catch (error) {",
    "    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);",
    "    console.error(message);",
    "    process.exitCode = 1;",
    "  }",
    "})();",
    "",
  ].join("\n"),
);

try {
  await buildExecutable(bootstrapPath, outfile, target);
} finally {
  await rm(bootstrapPath, { force: true });
  await rm(bootstrapSourceMapPath, { force: true });
  await rm(bundlePath, { force: true });
}

async function buildBundle(outfile: string): Promise<string> {
  const result = await (Bun.build as unknown as (config: object) => Promise<BuildResult>)({
    entrypoints: [resolve("src/main.ts")],
    outdir: outfile,
    target: "bun",
    format: "esm",
    minify: true,
    naming: "whiscord.bundle.js",
    plugins: [reactDevtoolsStubPlugin],
  });

  if (!result.success) {
    throw new AggregateError(result.logs, "Failed to bundle app for executable build");
  }

  const [output] = result.outputs;
  if (!output?.path) {
    throw new Error("Bundle step did not emit an output file");
  }

  return output.path;
}

async function buildExecutable(
  entrypoint: string,
  outfile: string,
  target: BuildTarget,
): Promise<void> {
  const result = await (Bun.build as unknown as (config: object) => Promise<BuildResult>)({
    entrypoints: [entrypoint],
    compile: {
      target,
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
    naming: {
      asset: "[name].[ext]",
    },
    minify: true,
    sourcemap: "linked",
    bytecode: true,
  });

  if (!result.success) {
    throw new AggregateError(result.logs, "Failed to compile executable");
  }
}

function parseArgs(argv: string[]): { target?: BuildTarget; outfile?: string } {
  const parsed: { target?: BuildTarget; outfile?: string } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (!arg) {
      continue;
    }

    if (arg === "--target" && next) {
      parsed.target = next as BuildTarget;
      index += 1;
      continue;
    }

    if (arg.startsWith("--target=")) {
      parsed.target = arg.slice("--target=".length) as BuildTarget;
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

function defaultTarget(): BuildTarget {
  switch (process.platform) {
    case "darwin": {
      return process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64";
    }

    case "linux": {
      return process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64";
    }

    case "win32": {
      return process.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64";
    }

    default: {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
  }
}

function defaultOutfile(target: BuildTarget): string {
  return target.includes("windows") ? "dist/whiscord.exe" : "dist/whiscord";
}

function createReactDevtoolsStubPlugin(): BunPlugin {
  return {
    name: "react-devtools-core-stub",
    setup(build) {
      build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
        namespace: "react-devtools-core-stub",
        path: "react-devtools-core",
      }));

      build.onLoad({ filter: /.*/, namespace: "react-devtools-core-stub" }, () => ({
        loader: "js",
        contents: [
          "export default {",
          "  initialize() {},",
          "  connectToDevTools() {},",
          "};",
        ].join("\n"),
      }));
    },
  };
}
