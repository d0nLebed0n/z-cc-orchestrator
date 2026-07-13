"use client";

import { useState } from "react";
import { api } from "@/shared/api";
import type { ModelDto, ModelKind, Family } from "@/entities";
import { KIND_LABELS, FAMILY_LABELS } from "@/entities";

interface Props {
  onClose: () => void;
  onSaved: () => void;
  editing?: ModelDto | null;
}

const cardStyle: React.CSSProperties = {
  background: "#181825",
  border: "1px solid #313244",
  borderRadius: 8,
  padding: 16,
  cursor: "pointer",
};
const cardActiveStyle: React.CSSProperties = {
  ...cardStyle,
  border: "1px solid #89b4fa",
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "#1e1e2e",
  border: "1px solid #313244",
  borderRadius: 6,
  padding: "8px 10px",
  color: "#cdd6f4",
  fontSize: 14,
};
const labelStyle: React.CSSProperties = {
  display: "block",
  color: "#a6adc8",
  fontSize: 12,
  marginBottom: 4,
};

export function AddModelModal({ onClose, onSaved, editing }: Props) {
  const [kind, setKind] = useState<ModelKind>(editing?.kind ?? "claude-binary");
  const [id, setId] = useState(editing?.id ?? "");
  const [label, setLabel] = useState(editing?.label ?? "");
  const [family, setFamily] = useState<Family>(editing?.family ?? "anthropic");
  const [provider, setProvider] = useState<"anthropic" | "openai">(editing?.provider ?? "anthropic");
  const [baseUrl, setBaseUrl] = useState(editing?.base_url ?? "");
  const [modelName, setModelName] = useState(editing?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [detectResult, setDetectResult] = useState<{ found: boolean; path?: string; version?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isBinary = kind === "claude-binary" || kind === "codex-binary";
  const isApi = kind === "api";
  const isOllama = kind === "ollama-http";

  async function detect() {
    setError(null);
    try {
      const r = await api.detectBinary(kind as "claude-binary" | "codex-binary");
      setDetectResult(r);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save() {
    setError(null);
    setSaving(true);
    try {
      // review #2 (review-2026-07-13): отдельный update-body без id/kind —
      // backend modelUpdateSchema их не принимает (kind неизменяем, id запрещён
      // менять #8). Раньше отправляли тот же body, что create → 400.
      if (editing) {
        const updateBody: Record<string, string> = { label };
        if (family) updateBody.family = family;
        if (isApi) {
          if (baseUrl) updateBody.base_url = baseUrl;
          if (modelName) updateBody.model = modelName;
          if (apiKey) updateBody.api_key = apiKey;
        }
        if (isOllama) {
          if (baseUrl) updateBody.base_url = baseUrl;
          if (modelName) updateBody.model = modelName;
        }
        await api.updateModel(editing.id, updateBody);
      } else {
        const createBody = {
          id: id || label.toLowerCase().replace(/\s+/g, "-"),
          label,
          kind,
          family,
          // review #32: API-модель тоже передаёт model (раньше терялось в create;
          // update уже отправлял). ollama передаёт model как и раньше.
          ...(isApi ? { provider, base_url: baseUrl, model: modelName || undefined, api_key: apiKey || undefined } : {}),
          ...(isOllama ? { base_url: baseUrl, model: modelName } : {}),
        };
        await api.createModel(createBody);
      }
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={editing ? "Редактировать модель" : "Добавить модель"}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#1e1e2e",
          border: "1px solid #313244",
          borderRadius: 12,
          padding: 24,
          width: 520,
          maxHeight: "85vh",
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {editing ? "Редактировать модель" : "Добавить модель"}
        </h2>

        {!editing && (
          <>
            <label style={labelStyle}>Тип</label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
              {(Object.keys(KIND_LABELS) as ModelKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  style={{ ...kind === k ? cardActiveStyle : cardStyle, border: "1px solid transparent", cursor: "pointer" }}
                  onClick={() => { setKind(k); setDetectResult(null); }}
                >
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{KIND_LABELS[k]}</div>
                </button>
              ))}
            </div>
          </>
        )}

        <label style={labelStyle}>Название (label)</label>
        <input style={{ ...inputStyle, marginBottom: 12 }} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Напр. Claude (local)" />

        {!editing && (
          <>
            <label style={labelStyle}>ID (slug)</label>
            <input style={{ ...inputStyle, marginBottom: 12 }} value={id} onChange={(e) => setId(e.target.value)} placeholder="auto из названия или вручную" />
          </>
        )}

        <label style={labelStyle}>Семья</label>
        <select style={{ ...inputStyle, marginBottom: 12 }} value={family} onChange={(e) => setFamily(e.target.value as Family)}>
          {(Object.keys(FAMILY_LABELS) as Family[]).map((f) => (
            <option key={f} value={f}>{FAMILY_LABELS[f]}</option>
          ))}
        </select>

        {isBinary && (
          <div style={{ marginBottom: 12 }}>
            <button onClick={detect} style={{ ...inputStyle, width: "auto", cursor: "pointer" }}>
              Проверить наличие {kind === "claude-binary" ? "claude" : "codex"}
            </button>
            {detectResult && (
              <div style={{ fontSize: 13, marginTop: 6, color: detectResult.found ? "#a6e3a1" : "#f38ba8" }}>
                {detectResult.found
                  ? `✓ Найден: ${detectResult.path}${detectResult.version ? ` (${detectResult.version})` : ""}`
                  : "✗ Бинарник не найден в PATH"}
              </div>
            )}
          </div>
        )}

        {isOllama && (
          <>
            <label style={labelStyle}>Base URL (Tailscale host:port)</label>
            <input style={{ ...inputStyle, marginBottom: 12 }} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://host.ts.net:11434" />
            <label style={labelStyle}>Имя модели</label>
            <input style={{ ...inputStyle, marginBottom: 12 }} value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="qwen3-coder:30b" />
          </>
        )}

        {isApi && (
          <>
            <label style={labelStyle}>Provider (формат)</label>
            <select style={{ ...inputStyle, marginBottom: 12 }} value={provider} onChange={(e) => setProvider(e.target.value as "anthropic" | "openai")}>
              <option value="anthropic">Anthropic (Messages API)</option>
              <option value="openai">OpenAI (Chat Completions)</option>
            </select>
            <label style={labelStyle}>Base URL</label>
            <input style={{ ...inputStyle, marginBottom: 12 }} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" />
            <label style={labelStyle}>Имя модели (optional для provider=openai)</label>
            <input style={{ ...inputStyle, marginBottom: 12 }} value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="напр. gpt-4o (если эндпоинт требует явно)" />
            <label style={labelStyle}>API Key</label>
            <input type="password" style={{ ...inputStyle, marginBottom: 12 }} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={editing ? "(оставить пустым = не менять)" : "sk-..."} />
          </>
        )}

        {error && (
          <div style={{ color: "#f38ba8", fontSize: 13, marginBottom: 12 }}>{error}</div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ ...inputStyle, width: "auto", cursor: "pointer" }}>Отмена</button>
          <button
            onClick={save}
            disabled={saving || !label}
            style={{ ...inputStyle, width: "auto", cursor: "pointer", background: saving ? "#313244" : "#89b4fa", color: saving ? "#6c7086" : "#1e1e2e" }}
          >
            {saving ? "Сохранение..." : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}
