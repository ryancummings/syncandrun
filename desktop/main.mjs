import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportMusic, readExportPlan } from "./export.mjs";
import { OwnerRepository } from "./companion/dist/persistence/owner-repository.js";
import { PlexSetupService } from "./companion/dist/plex/setup-service.js";
import { PlexMediaProxy } from "./companion/dist/plex/media-proxy.js";
import { loadConfig } from "./companion/dist/config.js";
import { createRuntime } from "./companion/dist/runtime.js";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const LAN_PORT = 31415;
const isolatedProfile = process.env.SYNCANDRUN_DESKTOP_TEST_PROFILE;
if (isolatedProfile) {
  if (!isAbsolute(isolatedProfile)) throw new Error("SYNCANDRUN_DESKTOP_TEST_PROFILE must be an absolute path");
  mkdirSync(isolatedProfile, { recursive: true, mode: 0o700 });
  app.setPath("userData", isolatedProfile);
}
let companion;
let window;
let configuredAddress;
let quitting = false;
let serviceOperation;
let shutdownComplete = false;
let shutdownPending = false;
let exportDestination;
let exportRunning = false;
let lastExportPath;

function profilePaths() {
  const root = app.getPath("userData");
  return { root, config: join(root, "desktop.json"), secret: join(root, "secret"), data: join(root, "data") };
}

async function readState() {
  const paths = profilePaths();
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700);
  let saved;
  if (existsSync(paths.config)) {
    saved = JSON.parse(await readFile(paths.config, "utf8"));
    if (saved.version !== 1 || typeof saved.address !== "string" || saved.port !== LAN_PORT) {
      throw new Error("The saved desktop configuration is unsupported. Restore the matching app version or backup.");
    }
  }
  const address = "127.0.0.1";
  if (!existsSync(paths.secret)) {
    await writeFile(paths.secret, randomBytes(48).toString("base64url"), { mode: 0o600, flag: "wx" });
  }
  await chmod(paths.secret, 0o600);
  await mkdir(paths.data, { recursive: true, mode: 0o700 });
  const secret = await readFile(paths.secret, "utf8");
  return { paths, address, secret, changed: saved?.address !== address };
}

async function startService(state) {
  const origin = `http://${state.address}:${LAN_PORT}`;
  const config = loadConfig({
    SYNCANDRUN_BASE_URL: origin,
    SYNCANDRUN_ALLOW_LAN_HTTP: "true",
    SYNCANDRUN_SECRET: state.secret,
    SYNCANDRUN_DATA_DIR: state.paths.data,
    SYNCANDRUN_HOST: "127.0.0.1",
    SYNCANDRUN_PORT: "3000",
    SYNCANDRUN_LOG_LEVEL: "warn",
    SYNCANDRUN_TRUST_PROXY: "127.0.0.1"
  });
  companion = await createRuntime(config);
  try {
    await companion.app.listen({ host: "127.0.0.1", port: LAN_PORT });
    if (state.changed) {
      await writeFile(state.paths.config, JSON.stringify({ version: 1, address: state.address, port: LAN_PORT }) + "\n", { mode: 0o600 });
      await chmod(state.paths.config, 0o600);
    }
    configuredAddress = state.address;
    return origin;
  } catch (error) {
    await companion.app.close();
    companion = undefined;
    throw error;
  }
}

async function stopService() {
  if (companion) {
    const closing = companion.app.close();
    companion.app.server.closeAllConnections();
    await closing;
    companion = undefined;
  }
}

async function managementUrl() {
  const origin = `http://${configuredAddress}:${LAN_PORT}`;
  if (new OwnerRepository(companion.database.connection).owner() !== undefined) return origin;
  const token = new OwnerRepository(companion.database.connection).issueInvitation();
  return `${origin}/#setup=${token}`;
}

async function openManagement() {
  if (!companion) return;
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    title: "SyncAndRun", width: 1180, height: 820, minWidth: 780, minHeight: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: join(packageDirectory, "export-preload.cjs") }
  });
  const origin = `http://${configuredAddress}:${LAN_PORT}`;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${origin}/`)) event.preventDefault();
  });
  await window.loadURL(await managementUrl());
}

function isManagementSender(event) {
  return window && !window.isDestroyed() && event.sender === window.webContents;
}

ipcMain.handle("syncandrun:choose-export-folder", async (event) => {
  if (!isManagementSender(event)) throw new Error("Invalid window.");
  const choice = await dialog.showOpenDialog(window, {
    title: "Choose where to save music",
    properties: ["openDirectory", "createDirectory"]
  });
  if (choice.canceled || !choice.filePaths[0]) return null;
  exportDestination = choice.filePaths[0];
  return exportDestination;
});

ipcMain.handle("syncandrun:export-music", async (event, options) => {
  if (!isManagementSender(event)) throw new Error("Invalid window.");
  if (!companion || !exportDestination || exportRunning) throw new Error("Choose a folder and try again.");
  exportRunning = true;
  try {
    const plan = readExportPlan(companion.database.connection, options?.playlistIds);
    const setup = new PlexSetupService(companion.database.connection, companion.config.secret);
    const proxy = new PlexMediaProxy(companion.database.connection, setup);
    let result;
    try {
      result = await exportMusic({
        plan, bitrate: options?.bitrate, route: options?.route, destination: exportDestination,
        openAudio: (trackId, bitrate) => proxy.openAudio(trackId, "desktop-export", undefined, bitrate),
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send("syncandrun:export-progress", progress);
        }
      });
    } catch (error) {
      if (error.exportPath) throw new Error(`Export stopped. Partial files are in ${error.exportPath}. ${error.message}`);
      throw error;
    }
    lastExportPath = result.path;
    return result;
  } finally { exportRunning = false; }
});

ipcMain.handle("syncandrun:show-export-folder", async (event, path) => {
  if (!isManagementSender(event) || path !== lastExportPath) throw new Error("Invalid export folder.");
  await shell.openPath(path);
});

async function backup() {
  if (serviceOperation || quitting) return;
  serviceOperation = backupService();
  try { await serviceOperation; } finally { serviceOperation = undefined; }
}

async function backupService() {
  try {
    const choice = await dialog.showOpenDialog({ title: "Choose a private backup folder", properties: ["openDirectory", "createDirectory"] });
    if (choice.canceled || !choice.filePaths[0]) return;
    const state = profilePaths();
    if (!existsSync(state.config)) throw new Error("Desktop configuration is missing. Restart the service before backing up.");
    const target = join(choice.filePaths[0], `syncandrun-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
    await mkdir(target, { mode: 0o700 });
    await stopService();
    for (const name of ["desktop.json", "secret"]) await copyFile(join(state.root, name), join(target, name));
    const { cp } = await import("node:fs/promises");
    await cp(state.data, join(target, "data"), { recursive: true });
    await writeFile(join(target, "version.txt"), `${app.getVersion()}\n`, { mode: 0o600 });
    if (!quitting) await startService({ paths: state, address: configuredAddress, secret: await readFile(state.secret, "utf8"), changed: false });
    await dialog.showMessageBox({ type: "info", message: "Backup complete", detail: "Keep this folder private. It contains the database and encryption secret together." });
  } catch (error) {
    await dialog.showMessageBox({ type: "error", message: "Backup or restart failed", detail: String(error) });
    const state = profilePaths();
    if (!quitting && !companion) await startService({ paths: state, address: configuredAddress, secret: await readFile(state.secret, "utf8"), changed: false }).catch(() => undefined);
  }
}

function installMenus() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "SyncAndRun", submenu: [
      { label: "Open SyncAndRun", click: () => void openManagement() },
      { label: "Back up app data", click: () => void backup() },
      { type: "separator" },
      { label: "Quit SyncAndRun", role: "quit" }
    ] }
  ]));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  process.once("SIGTERM", () => app.quit());
  process.once("SIGINT", () => app.quit());
  app.on("second-instance", () => void openManagement());
  app.on("before-quit", (event) => {
    quitting = true;
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownPending) return;
    shutdownPending = true;
    void Promise.resolve(serviceOperation).catch(() => undefined).then(() => stopService()).catch(() => {
      process.stderr.write("SyncAndRun shutdown failed.\n");
    }).finally(() => {
      shutdownComplete = true;
      window?.destroy();
      app.exit(0);
    });
  });
  app.on("window-all-closed", () => { if (!quitting) app.quit(); });
  app.on("activate", () => void openManagement());
  void app.whenReady().then(async () => {
    try {
      const state = await readState();
      if (!state) app.quit();
      else {
        await startService(state);
        installMenus();
        await openManagement();
      }
    } catch (error) {
      await dialog.showMessageBox({ type: "error", message: "SyncAndRun could not start", detail: String(error) });
      app.quit();
    }
  });
}
