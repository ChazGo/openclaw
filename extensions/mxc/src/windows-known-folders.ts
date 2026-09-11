import { execFileSync } from "node:child_process";
import path from "node:path";

export type WindowsStandardFolders = {
  documents?: string;
  downloads?: string;
  desktop?: string;
};

type ResolveWindowsStandardFoldersOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  queryRegistryValue?: (valueName: string) => string;
  warn?: (message: string) => void;
};

const USER_SHELL_FOLDERS_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";
const DOWNLOADS_VALUE = "{374DE290-123F-4565-9164-39C4925E467B}";
const CACHE_RETRY_MS = 60_000;

let cachedFolders: WindowsStandardFolders | undefined;
let cachedAt = 0;

function queryUserShellFolder(valueName: string): string {
  return execFileSync("reg.exe", ["query", USER_SHELL_FOLDERS_KEY, "/v", valueName], {
    encoding: "utf8",
    windowsHide: true,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expandEnvironmentVariables(value: string, env: NodeJS.ProcessEnv): string | undefined {
  let unresolved = false;
  const expanded = value.replace(/%([^%]+)%/g, (_match, name: string) => {
    const entry = Object.entries(env).find(
      ([key]) => key.toLowerCase() === name.toLowerCase(),
    )?.[1];
    if (!entry) {
      unresolved = true;
      return "";
    }
    return entry;
  });
  return unresolved ? undefined : expanded;
}

function parseRegistryPath(
  output: string,
  valueName: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const match = output.match(
    new RegExp(`^\\s*${escapeRegExp(valueName)}\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$`, "imu"),
  );
  const registryPath = match?.[1];
  if (!registryPath) {
    return undefined;
  }
  const expanded = expandEnvironmentVariables(registryPath, env);
  return expanded && path.win32.isAbsolute(expanded) ? path.win32.normalize(expanded) : undefined;
}

function resolveFolder(
  label: string,
  valueName: string,
  options: Required<
    Pick<ResolveWindowsStandardFoldersOptions, "env" | "queryRegistryValue" | "warn">
  >,
): string | undefined {
  try {
    const resolved = parseRegistryPath(
      options.queryRegistryValue(valueName),
      valueName,
      options.env,
    );
    if (!resolved) {
      options.warn(`[mxc] Could not resolve the ${label} known folder; omitting its preset grant.`);
    }
    return resolved;
  } catch {
    options.warn(`[mxc] Could not resolve the ${label} known folder; omitting its preset grant.`);
    return undefined;
  }
}

export function resolveWindowsStandardFolders(
  options: ResolveWindowsStandardFoldersOptions = {},
): WindowsStandardFolders {
  const useCache =
    options.platform === undefined &&
    options.env === undefined &&
    options.queryRegistryValue === undefined &&
    options.warn === undefined;
  if (
    useCache &&
    cachedFolders &&
    (Object.values(cachedFolders).every((folder) => folder !== undefined) ||
      Date.now() - cachedAt < CACHE_RETRY_MS)
  ) {
    return cachedFolders;
  }

  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {};
  }

  const resolverOptions = {
    env: options.env ?? process.env,
    queryRegistryValue: options.queryRegistryValue ?? queryUserShellFolder,
    warn: options.warn ?? console.warn,
  };
  const resolved = {
    documents: resolveFolder("Documents", "Personal", resolverOptions),
    downloads: resolveFolder("Downloads", DOWNLOADS_VALUE, resolverOptions),
    desktop: resolveFolder("Desktop", "Desktop", resolverOptions),
  };

  if (useCache) {
    cachedFolders = resolved;
    cachedAt = Date.now();
  }
  return resolved;
}
