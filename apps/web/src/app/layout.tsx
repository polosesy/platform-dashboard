import type { Metadata } from "next";
import { connection } from "next/server";
// Bundled font files (the geist package) — `next build` needs no font download (CI and on-prem builds without internet)
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { Providers } from "./providers";
import { AppShell } from "@/components/AppShell";
import { webRuntimeConfig } from "@/lib/runtimeConfig";

export const metadata: Metadata = {
  title: "Azure Unified Dashboard",
  description: "Unified Azure architecture, network, and delivery visibility",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Read the sign-in settings per request (not at build): the same image serves an on-prem host and an AKS pod
  await connection();
  const config = webRuntimeConfig(process.env);
  return (
    <html lang="ko">
      <body className={`${GeistSans.variable} ${GeistMono.variable}`}>
        <Providers config={config}>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
