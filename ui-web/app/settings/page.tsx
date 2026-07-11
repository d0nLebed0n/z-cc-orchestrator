"use client";

import { SettingsModels } from "@/widgets/settings-models/SettingsModels";
import { SettingsRoles } from "@/widgets/settings-roles/SettingsRoles";

export default function SettingsPage() {
  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Settings</h1>
        <p style={{ color: "#6c7086", fontSize: 14, margin: "4px 0 0" }}>
          Модели и назначение ролей
        </p>
      </header>

      <SettingsModels />
      <SettingsRoles />
    </main>
  );
}
