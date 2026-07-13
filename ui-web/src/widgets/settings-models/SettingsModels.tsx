"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/shared/api";
import type { ModelDto } from "@/entities";
import { KIND_LABELS, FAMILY_LABELS } from "@/entities";
import { AddModelModal } from "./AddModelModal";

/** review #33: подпись статуса модели из backend statusOf. */
function statusLabel(status: ModelDto["status"]): string {
  switch (status) {
    case "ready": return "● готов";
    case "not_found": return "○ не найден";
    case "missing_credentials": return "● нет ключа";
    case "invalid_config": return "● неверный конфиг";
    default: return "● неизвестно";
  }
}
/** review #33: цвет статуса. ready — зелёный, ошибки — красный/жёлтый. */
function statusColor(status: ModelDto["status"]): string {
  switch (status) {
    case "ready": return "#a6e3a1"; // зелёный
    case "missing_credentials":
    case "invalid_config": return "#f9e2af"; // жёлтый (недонастроено)
    default: return "#f38ba8"; // красный (not_found / unknown)
  }
}

const sectionStyle: React.CSSProperties = {
  background: "#181825",
  border: "1px solid #313244",
  borderRadius: 10,
  padding: 16,
  marginBottom: 20,
};

export function SettingsModels() {
  const [models, setModels] = useState<ModelDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ModelDto | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setModels(await api.listModels());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleDelete(id: string) {
    if (!confirm(`Удалить модель «${id}»?`)) return;
    try {
      await api.deleteModel(id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section style={sectionStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Модели</h2>
        <button
          onClick={() => { setEditing(null); setModalOpen(true); }}
          style={{
            background: "#89b4fa", color: "#1e1e2e", border: "none",
            borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600,
          }}
        >
          + Добавить
        </button>
      </div>

      {error && <div style={{ color: "#f38ba8", fontSize: 13, marginBottom: 8 }}>{error}</div>}
      {loading && <div style={{ color: "#6c7086", fontSize: 13 }}>Загрузка...</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {models.map((m) => (
          <div
            key={m.id}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: "#1e1e2e", borderRadius: 8, padding: "10px 14px",
              border: "1px solid #313244",
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{m.label}</div>
              <div style={{ color: "#6c7086", fontSize: 12 }}>
                {KIND_LABELS[m.kind]} · {FAMILY_LABELS[m.family]}
                {m.base_url ? ` · ${m.base_url}` : ""}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {/* review #33 (review-2026-07-13): явные подписи для каждого статуса
                  backend statusOf. Раньше unknown/missing_credentials/invalid_config
                  рисовались как «● готов» (с красным цветом — противоречие). */}
              <span style={{ fontSize: 12, color: statusColor(m.status) }}>
                {statusLabel(m.status)}
              </span>
              <button
                onClick={() => { setEditing(m); setModalOpen(true); }}
                style={{ background: "transparent", color: "#cdd6f4", border: "1px solid #313244", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12 }}
              >
                Изменить
              </button>
              <button
                onClick={() => handleDelete(m.id)}
                style={{ background: "transparent", color: "#f38ba8", border: "1px solid #313244", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12 }}
              >
                Удалить
              </button>
            </div>
          </div>
        ))}
      </div>

      {modalOpen && (
        <AddModelModal
          editing={editing}
          onClose={() => setModalOpen(false)}
          onSaved={refresh}
        />
      )}
    </section>
  );
}
