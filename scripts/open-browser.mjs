#!/usr/bin/env node
/**
 * open-browser.mjs — ждёт, пока веб-сервер оркестратора поднимется на :3000,
 * затем открывает http://localhost:3000 в браузере по умолчанию.
 *
 * Кроссплатформенный (macOS / Linux / Windows). Используется скриптом `npm run ui:full`.
 */
import { spawn } from "node:child_process";

const URL = "http://localhost:3000";
const PORT = 3000;
const POLL_MS = 800;
const TIMEOUT_MS = 60_000;

/** Проверить, отвечает ли порт. */
async function isUp() {
  try {
    const res = await fetch(`http://localhost:${PORT}`, { method: "GET" });
    return res.ok || res.status === 200;
  } catch {
    return false;
  }
}

/** Открыть URL в браузере по умолчанию. */
function open(url) {
  const platform = process.platform;
  let cmd;
  if (platform === "darwin") cmd = ["open", url];
  else if (platform === "win32") cmd = ["cmd", "/c", "start", "", url];
  else cmd = ["xdg-open", url]; // linux
  spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true }).unref();
}

async function main() {
  const start = Date.now();
  process.stdout.write(`[ui:open] ожидание ${URL} …`);
  while (Date.now() - start < TIMEOUT_MS) {
    if (await isUp()) {
      process.stdout.write("\n");
      console.log(`[ui:open] сервер готов, открываю браузер → ${URL}`);
      open(URL);
      return;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.error(`\n[ui:open] сервер не поднялся за ${TIMEOUT_MS / 1000}s — открой ${URL} вручную.`);
  process.exit(0); // не валить основной процесс concurrently
}

main();
