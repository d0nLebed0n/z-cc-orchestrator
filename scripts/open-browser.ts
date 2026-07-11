#!/usr/bin/env node
/**
 * Ждёт, пока веб-сервер оркестратора поднимется на :3000,
 * затем открывает http://localhost:3000 в браузере по умолчанию.
 *
 * Кроссплатформенный (macOS / Linux / Windows). Используется скриптом `npm run ui:full`.
 */
import { spawn } from "node:child_process";

const URL = "http://localhost:3000";
const PORT = 3000;
const POLL_MS = 800;
const TIMEOUT_MS = 60_000;

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${PORT}`, { method: "GET" });
    return res.ok || res.status === 200;
  } catch {
    return false;
  }
}

function open(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  spawn(cmd[0]!, cmd.slice(1), { stdio: "ignore", detached: true }).unref();
}

async function main(): Promise<void> {
  const start = Date.now();
  process.stdout.write(`[ui:open] ожидание ${URL} ...`);
  while (Date.now() - start < TIMEOUT_MS) {
    if (await isUp()) {
      process.stdout.write("\n");
      console.log(`[ui:open] сервер готов, открываю браузер -> ${URL}`);
      open(URL);
      return;
    }
    process.stdout.write(".");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  console.error(`\n[ui:open] сервер не поднялся за ${TIMEOUT_MS / 1000}s - открой ${URL} вручную.`);
  process.exit(0);
}

void main();
