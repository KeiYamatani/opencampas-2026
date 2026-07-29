import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "脳の意思決定ラボ",
  description: "時間判断Go/No-go課題で、脳の意思決定を体験しよう。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
