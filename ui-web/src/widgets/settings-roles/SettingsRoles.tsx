"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/shared/api";
import type { ModelDto, Role } from "@/entities";
import { ROLE_LABELS, ROLE_DESCRIPTIONS } from "@/entities";

const sectionStyle: React.CSSProperties = {
  background: "#181825",
  border: "1px solid #313244",
  borderRadius: 10,
  padding: 16,
  marginBottom: 20,
};
const selectStyle: React.CSSProperties = {
  background: "#1e1e2e",
  border: "1px solid #313244",
  borderRadius: 6,
  padding: "8px 10px",
  color: "#cdd6f4",
  fontSize: 14,
  width: "100%",
};

const ALL_ROLES: Role[] = ["plan", "implement", "review", "refine", "fix", "final"];

export function SettingsRoles() {
  const [models, setModels] = useState<ModelDto[]>([]);
  const [roles, setRoles] = useState<Partial<Record<Role, string>>>({});
  const [threshold, setThreshold] = useState(65);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ms, roleData] = await Promise.all([api.listModels(), api.getRoles()]);
      setModels(ms);
      setRoles(roleData.roles as Partial<Record<Role, string>>);
      setThreshold(roleData.complexity_threshold);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateRoles({ roles: roles as Record<string, string>, complexity_threshold: threshold });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section style={sectionStyle}>
      <h2 style={{ margin: "0 0 4px", fontSize: 16 }}>Роли</h2>
      <p style={{ color: "#6c7086", fontSize: 13, margin: "0 0 16px" }}>
        Какая модель какую роль играет в воркфлоу
      </p>

      {error && <div style={{ color: "#f38ba8", fontSize: 13, marginBottom: 8 }}>{error}</div>}
      {loading && <div style={{ color: "#6c7086", fontSize: 13 }}>Загрузка...</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
        {ALL_ROLES.map((role) => (
          <div key={role} style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 12, alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{ROLE_LABELS[role]}</div>
              <div style={{ color: "#6c7086", fontSize: 11 }}>{ROLE_DESCRIPTIONS[role]}</div>
            </div>
            <select
              style={selectStyle}
              value={roles[role] ?? ""}
              onChange={(e) => setRoles((r) => ({ ...r, [role]: e.target.value }))}
            >
              <option value="">— не назначено —</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.family})
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div style={{ borderTop: "1px solid #313244", paddingTop: 16, marginBottom: 16 }}>
        <label style={{ display: "block", color: "#a6adc8", fontSize: 13, marginBottom: 4 }}>
          Порог лёгких задач: {threshold}
        </label>
        <input
          type="range"
          min={0}
          max={100}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          style={{ width: "100%" }}
        />
        <p style={{ color: "#6c7086", fontSize: 12, margin: "4px 0 0" }}>
          Подзадачи со сложностью ниже порога маршрутизируются на локальную семью (лёгкие задачи).
        </p>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button
          onClick={save}
          disabled={saving}
          style={{
            background: "#a6e3a1", color: "#1e1e2e", border: "none",
            borderRadius: 6, padding: "8px 20px", cursor: "pointer",
            fontSize: 14, fontWeight: 600,
          }}
        >
          {saving ? "Сохранение..." : "Сохранить"}
        </button>
        {saved && <span style={{ color: "#a6e3a1", fontSize: 13 }}>✓ Сохранено</span>}
      </div>
    </section>
  );
}
