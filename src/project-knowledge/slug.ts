import { basename } from "node:path";
import { createHash } from "node:crypto";

/**
 * Санитизировать basename пути в slug: lowercase, не-[a-z0-9] → '-', схлопывание.
 * Коллизии (разные пути дают один slug) не разрешаются здесь — registry отвечает
 * за добавление хэш-суффикса при коллизии (нужен доступ к существующим записям).
 */
function sanitize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "project";
}

/**
 * Короткий хэш абсолютного пути (первые 8 hex символов SHA-256).
 * Используется как суффикс при slug-коллизии (два разных пути → один basename).
 */
export function pathHash(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 8);
}

/**
 * Базовый slug из пути проекта (без коллизионного суффикса).
 */
export function baseSlug(projectPath: string): string {
  return sanitize(basename(projectPath));
}

/**
 * Slug с коллизионным суффиксом. Вызывается registry, когда baseSlug уже занят
 * другим путём. Суффикс = первые 8 hex символов SHA-256 абсолютного пути.
 */
export function slugFromPath(projectPath: string, collision = false): string {
  const base = baseSlug(projectPath);
  return collision ? `${base}-${pathHash(projectPath)}` : base;
}
