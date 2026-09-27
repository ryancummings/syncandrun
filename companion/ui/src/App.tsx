import { DesktopApp } from "./DesktopApp";

export function App() {
  if (!window.syncandrunDesktop) {
    return <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>Open SyncAndRun on your computer to create music files.</main>;
  }
  return <DesktopApp />;
}
