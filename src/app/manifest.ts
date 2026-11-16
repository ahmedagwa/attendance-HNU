import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "University Attendance", short_name: "Attendance", description: "Check in to lectures and manage attendance.",
    start_url: "/", scope: "/", display: "standalone", orientation: "portrait",
    background_color: "#f1f5f4", theme_color: "#0f5c63",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
