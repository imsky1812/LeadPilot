import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "LeadPilot",
  description: "Agentic sales outreach — research leads, draft messages, track follow-ups.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="border-b border-neutral-200">
          <div className="mx-auto flex w-full max-w-4xl items-center px-6 py-4">
            <Link href="/" className="text-sm font-semibold tracking-tight text-neutral-900">
              LeadPilot
            </Link>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
