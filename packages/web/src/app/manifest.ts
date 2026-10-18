import type { MetadataRoute } from "next";

/** The web app manifest. What makes Needy installable — and, on iOS, what makes web push
 *  possible at all (Apple only delivers it to a site opened from the Home Screen). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Needy — verified help nearby",
    short_name: "Needy",
    description: "Immediate, verified help from ID-checked people near you.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#FAF7F2",
    theme_color: "#0F5C5C",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
