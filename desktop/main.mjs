import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway, privateLanAddresses } from "./network.mjs";
import { OwnerRepository } from "./companion/dist/persistence/owner-repository.js";
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
let gateway;
let window;
let tray;
let configuredAddress;
let quitting = false;
let restarting = false;
let bootstrapping = true;

function profilePaths() {
  const root = app.getPath("userData");
  return { root, config: join(root, "desktop.json"), secret: join(root, "secret"), data: join(root, "data") };
}

async function selectAddress(addresses, current) {
  if (addresses.length === 0) throw new Error("No private IPv4 LAN interface is available. Connect to the home LAN and retry.");
  if (current && addresses.includes(current)) return current;
  return await new Promise((resolve) => {
    const selector = new BrowserWindow({
      title: "SyncAndRun first run", width: 680, height: 590,
      resizable: false, webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        preload: join(packageDirectory, "bootstrap-preload.cjs")
      }
    });
    let completed = false;
    const finish = (address) => {
      if (completed) return;
      completed = true;
      ipcMain.removeListener("syncandrun:select-address", onChoice);
      selector.destroy();
      resolve(address);
    };
    const onChoice = (event, index) => {
      if (event.sender !== selector.webContents || !Number.isInteger(index)) return;
      finish(addresses[index]);
    };
    ipcMain.on("syncandrun:select-address", onChoice);
    selector.on("closed", () => finish(undefined));
    selector.webContents.on("did-finish-load", () => selector.webContents.send("syncandrun:addresses", {
      addresses: addresses.map((address) => `${address}:${LAN_PORT}`), changed: Boolean(current)
    }));
    void selector.loadFile(join(packageDirectory, "bootstrap.html")).catch(() => finish(undefined));
  });
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
  const address = await selectAddress(privateLanAddresses(), saved?.address);
  if (!address) return undefined;
  if (!existsSync(paths.secret)) {
    await writeFile(paths.secret, randomBytes(48).toString("base64url"), { mode: 0o600, flag: "wx" });
  }
  await chmod(paths.secret, 0o600);
  await mkdir(paths.data, { recursive: true, mode: 0o700 });
  const secret = await readFile(paths.secret, "utf8");
  return { paths, address, secret, changed: saved?.address !== address };
}

async function listen(server, address, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, address, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
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
    SYNCANDRUN_TRUST_PROXY: "false"
  });
  companion = await createRuntime(config);
  try {
    await companion.app.listen({ host: "127.0.0.1", port: 0 });
    const localPort = companion.app.server.address().port;
    gateway = createGateway(localPort);
    await listen(gateway, state.address, LAN_PORT);
    if (state.changed) {
      await writeFile(state.paths.config, JSON.stringify({ version: 1, address: state.address, port: LAN_PORT }) + "\n", { mode: 0o600 });
      await chmod(state.paths.config, 0o600);
    }
    configuredAddress = state.address;
    return origin;
  } catch (error) {
    gateway?.closeAllConnections();
    gateway?.close();
    gateway = undefined;
    await companion.app.close();
    companion = undefined;
    throw error;
  }
}

async function stopService() {
  if (gateway) {
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
    gateway = undefined;
  }
  if (companion) {
    companion.app.server.closeAllConnections();
    await companion.app.close();
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
    title: "SyncAndRun Companion", width: 1140, height: 820, minWidth: 800, minHeight: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  const origin = `http://${configuredAddress}:${LAN_PORT}`;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${origin}/`)) event.preventDefault();
  });
  window.on("close", (event) => {
    if (!quitting && tray) { event.preventDefault(); window.hide(); }
  });
  await window.loadURL(await managementUrl());
}

function linuxAutostartPath() {
  return join(process.env.XDG_CONFIG_HOME || join(app.getPath("home"), ".config"), "autostart", "syncandrun-companion.desktop");
}

async function setStartup(enabled) {
  if (process.platform !== "linux") {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return;
  }
  const path = linuxAutostartPath();
  if (!enabled) {
    const { rm } = await import("node:fs/promises");
    await rm(path, { force: true });
    return;
  }
  const executable = process.execPath.replaceAll('"', '\\"');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `[Desktop Entry]\nType=Application\nName=SyncAndRun Companion\nExec="${executable}"\nTerminal=false\nCategories=AudioVideo;\n`, { mode: 0o600 });
}

function startupEnabled() {
  return process.platform === "linux" ? existsSync(linuxAutostartPath()) : app.getLoginItemSettings().openAtLogin;
}

async function backup() {
  try {
    const choice = await dialog.showOpenDialog({ title: "Choose a private backup folder", properties: ["openDirectory", "createDirectory"] });
    if (choice.canceled || !choice.filePaths[0]) return;
    const state = profilePaths();
    const target = join(choice.filePaths[0], `syncandrun-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
    await mkdir(target, { mode: 0o700 });
    await stopService();
    for (const name of ["desktop.json", "secret"]) await copyFile(join(state.root, name), join(target, name));
    const { cp } = await import("node:fs/promises");
    await cp(state.data, join(target, "data"), { recursive: true });
    await writeFile(join(target, "version.txt"), `${app.getVersion()}\n`, { mode: 0o600 });
    await startService({ paths: state, address: configuredAddress, secret: await readFile(state.secret, "utf8"), changed: false });
    await dialog.showMessageBox({ type: "info", message: "Backup complete", detail: "Keep this folder private. It contains the database and encryption secret together." });
  } catch (error) {
    await dialog.showMessageBox({ type: "error", message: "Backup or restart failed", detail: String(error) });
    const state = profilePaths();
    if (!companion) await startService({ paths: state, address: configuredAddress, secret: await readFile(state.secret, "utf8"), changed: false }).catch(() => undefined);
  }
}

function installMenus(origin) {
  const icon = nativeImage.createFromPath(join(packageDirectory, "icon.png"));
  if (!tray) {
    try { tray = new Tray(icon); } catch { /* Desktop without a tray: the window close action quits. */ }
  }
  tray?.setToolTip("SyncAndRun Companion");
  const menu = () => Menu.buildFromTemplate([
    { label: "Open management", click: () => void openManagement() },
    { label: "Open in browser", click: () => void shell.openExternal(origin) },
    { label: "Start at login", type: "checkbox", checked: startupEnabled(), click: (item) => void setStartup(item.checked) },
    { label: "Back up data and secret", click: () => void backup() },
    { label: "Restart service", click: () => void restartService() },
    { type: "separator" },
    { label: "Quit SyncAndRun", click: () => app.quit() }
  ]);
  tray?.setContextMenu(menu());
  tray?.on("double-click", () => void openManagement());
  Menu.setApplicationMenu(menu());
}

async function restartService() {
  if (restarting) return;
  restarting = true;
  try {
    await stopService();
    const state = await readState();
    if (!state) { app.quit(); return; }
    const origin = await startService(state);
    installMenus(origin);
    if (window && !window.isDestroyed()) await window.loadURL(await managementUrl());
  } catch (error) {
    await dialog.showMessageBox({ type: "error", message: "Service restart failed", detail: String(error) });
  } finally { restarting = false; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  process.once("SIGTERM", () => app.quit());
  process.once("SIGINT", () => app.quit());
  app.on("second-instance", () => void openManagement());
  app.on("before-quit", () => { quitting = true; });
  app.on("window-all-closed", () => { if (!tray && !bootstrapping) app.quit(); });
  app.on("activate", () => void openManagement());
  app.on("will-quit", (event) => {
    if (companion || gateway) {
      event.preventDefault();
      void stopService().finally(() => { companion = undefined; gateway = undefined; app.quit(); });
    }
  });
  void app.whenReady().then(async () => {
    try {
      const state = await readState();
      if (!state) app.quit();
      else {
        const origin = await startService(state);
        installMenus(origin);
        await openManagement();
        bootstrapping = false;
      }
    } catch (error) {
      await dialog.showMessageBox({ type: "error", message: "SyncAndRun could not start", detail: String(error) });
      app.quit();
    }
  });
}
