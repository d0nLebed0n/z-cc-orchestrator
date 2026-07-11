import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "ai-task — панель оркестратора",
  description: "Веб-интерфейс для z-cc-orchestrator",
};

const navLinkStyle: React.CSSProperties = {
  color: "#cdd6f4",
  textDecoration: "none",
  fontSize: 14,
  padding: "4px 10px",
  borderRadius: 6,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <nav
          style={{
            maxWidth: 1100,
            margin: "0 auto",
            padding: "12px 24px",
            display: "flex",
            gap: 8,
            borderBottom: "1px solid #313244",
          }}
        >
          <Link href="/" style={navLinkStyle}>
            Dashboard
          </Link>
          <Link href="/settings" style={navLinkStyle}>
            Settings
          </Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
