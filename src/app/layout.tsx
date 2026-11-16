import type { Metadata, Viewport } from "next";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/public-sans";
import "./globals.css";
import { SwRegister } from "@/components/sw-register";
import { OfflineBanner } from "@/components/offline-banner";

export const metadata: Metadata = {
  title: { default: "Attendance", template: "%s · Attendance" },
  description: "University attendance for students, lecturers and administrators.",
  applicationName: "Attendance",
  appleWebApp: { capable: true, title: "Attendance", statusBarStyle: "default" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};
export const viewport: Viewport = { themeColor: "#0f5c63", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <OfflineBanner />
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
