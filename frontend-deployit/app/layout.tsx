import { Geist_Mono, Oxanium, Raleway } from "next/font/google";
import type { Metadata } from "next";

import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

const raleway = Raleway({subsets:['latin'],variable:'--font-sans'});

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "DeployIt – Deploy your projects instantly",
  description:
    "A Vercel-like deployment platform. Push a Git repo, get a live preview URL.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "antialiased",
        fontMono.variable,
        "font-sans",
        raleway.variable
      )}
    >
      <body>
        <ThemeProvider defaultTheme="light" enableSystem={false} storageKey="app-theme">
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
