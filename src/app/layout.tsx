import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "IntentGraph — AI Ad Eligibility Pipeline",
  description: "Real-time sell-side ad scoring for AI publishers",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
